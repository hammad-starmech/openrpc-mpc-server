#!/usr/bin/env node
import { RequestManager, HTTPTransport, Client } from "@open-rpc/client-js";
import $RefParser from "@apidevtools/json-schema-ref-parser";
import { readFileSync } from "fs";
import { resolve } from "path";
import fetch from "isomorphic-fetch";
import https from "https";

/**
 * This is an OpenRPC server that loads an OpenRPC spec file and provides
 * three tools for interacting with the defined methods:
 * - rpc_discover: Lists method names and summaries
 * - rpc_method_details: Returns detailed method information with resolved schemas
 * - rpc_call: Makes actual JSON-RPC calls using the spec
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// Global variables to store the loaded and dereferenced OpenRPC spec and auth data
let openRpcSpec: any = null;
let kerioCredentials: { username: string; password: string } | null = null;
let kerioSession: { sessionCookie: string; tokenCookie: string } | null = null;

// Create an HTTPS agent that ignores certificate errors (like curl -k)
const httpsAgent = new https.Agent({
  rejectUnauthorized: false
});

/**
 * Load and dereference the OpenRPC specification from a file path
 */
async function loadOpenRpcSpec(specPath: string): Promise<void> {
  try {
    const absolutePath = resolve(specPath);
    const rawSpec = JSON.parse(readFileSync(absolutePath, 'utf8'));

    // Dereference all $ref pointers in the spec
    openRpcSpec = await $RefParser.dereference(rawSpec);

    console.error(`Loaded OpenRPC spec: ${openRpcSpec.info?.title || 'Unknown'} v${openRpcSpec.info?.version || 'Unknown'}`);
  } catch (error) {
    console.error(`Failed to load OpenRPC spec from ${specPath}:`, error);
    process.exit(1);
  }
}

/**
 * Get the server URL from the OpenRPC spec
 */
function getServerUrl(): string {
  if (!openRpcSpec?.servers || openRpcSpec.servers.length === 0) {
    throw new Error("No servers defined in OpenRPC spec");
  }
  return openRpcSpec.servers[0].url;
}

/**
 * Parse Set-Cookie headers from response
 */
function parseSetCookies(setCookieHeaders: string[]): { [key: string]: string } {
  const cookies: { [key: string]: string } = {};

  setCookieHeaders.forEach(cookieHeader => {
    const [cookiePart] = cookieHeader.split(';');
    const [name, value] = cookiePart.split('=');
    if (name && value) {
      cookies[name.trim()] = value.trim();
    }
  });

  return cookies;
}

/**
 * Build cookie header string from cookie object
 */
function buildCookieHeader(cookies: { [key: string]: string }): string {
  return Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

/**
 * Make HTTPS request using Node.js native module for better cookie handling
 */
function makeHttpsRequest(url: string, options: any, postData?: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const urlParts = new URL(url);
    const requestOptions = {
      hostname: urlParts.hostname,
      port: urlParts.port || 443,
      path: urlParts.pathname + urlParts.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      rejectUnauthorized: false // Equivalent to curl -k
    };

    const req = https.request(requestOptions, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          data
        });
      });
    });
    
    req.on('error', (error) => {
      reject(error);
    });
    
    if (postData) {
      req.write(postData);
    }
    
    req.end();
  });
}

/**
 * Authenticate with Kerio Control and store session cookies
 */
async function authenticateKerio(): Promise<void> {
  if (!kerioCredentials) {
    throw new Error("Kerio credentials not provided");
  }

  const serverUrl = getServerUrl();
  // Extract base URL without JSON-RPC path if present
  let baseUrl = serverUrl;
  if (serverUrl.includes('/admin/api/jsonrpc')) {
    // Remove the JSON-RPC path to get the base URL
    baseUrl = serverUrl.substring(0, serverUrl.indexOf('/admin/api/jsonrpc'));
  }
  const loginUrl = `${baseUrl}/admin/internal/dologin.php?hash=dashboard`;

  // Prepare form data for login
  const formData = new URLSearchParams();
  formData.append('kerio_username', kerioCredentials.username);
  formData.append('kerio_password', kerioCredentials.password);

  try {
    console.error(`Authenticating with Kerio at: ${loginUrl}`);
    
    // Use native HTTPS module for better cookie handling
    const response = await makeHttpsRequest(loginUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'OpenRPC-MCP-Server'
      }
    }, formData.toString());

    console.error(`Auth response status: ${response.statusCode}`);
    
    // Extract cookies from Set-Cookie headers
    const setCookieHeaders: string[] = [];
    if (response.headers['set-cookie']) {
      // Node.js https module properly returns Set-Cookie as an array
      setCookieHeaders.push(...(Array.isArray(response.headers['set-cookie']) 
        ? response.headers['set-cookie'] 
        : [response.headers['set-cookie']]));
    }
    
    console.error(`Found ${setCookieHeaders.length} Set-Cookie headers`);
    if (setCookieHeaders.length > 0) {
      console.error("Set-Cookie headers:", setCookieHeaders);
    }
    
    const cookies = parseSetCookies(setCookieHeaders);
    console.error("Parsed cookies:", Object.keys(cookies));

    if (cookies.SESSION_CONTROL_WEBADMIN && cookies.TOKEN_CONTROL_WEBADMIN) {
      kerioSession = {
        sessionCookie: cookies.SESSION_CONTROL_WEBADMIN,
        tokenCookie: cookies.TOKEN_CONTROL_WEBADMIN
      };
      console.error("Kerio authentication successful");
      console.error(`Session cookie: ${kerioSession.sessionCookie.substring(0, 10)}...`);
      console.error(`Token cookie: ${kerioSession.tokenCookie.substring(0, 10)}...`);
    } else {
      console.error("Required cookies not found. Available cookies:", cookies);
      throw new Error("Authentication failed - required cookies not received");
    }

  } catch (error) {
    console.error("Kerio authentication failed:", error);
    throw new Error(`Failed to authenticate with Kerio Control: ${error}`);
  }
}

/**
 * Create an MCP server with capabilities for tools
 * to interact with OpenRPC-defined methods
 */
const server = new Server(
  {
    name: "openrpc-spec",
    version: "0.2.0",
  },
  {
    capabilities: {
      resources: {},
      tools: {},
      prompts: {},
    },
  }
);

/**
 * Handler that lists available tools.
 * Exposes three tools based on the loaded OpenRPC spec:
 * - rpc_discover: Lists method names and summaries
 * - rpc_method_details: Returns detailed method information
 * - rpc_call: Calls methods using the loaded spec
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "rpc_discover",
        description: "Discover available JSON-RPC methods from the loaded OpenRPC spec. Returns method names and summaries.",
        inputSchema: {
          type: "object",
          properties: {},
          required: []
        }
      },
      {
        name: "rpc_method_details",
        description: "Get detailed information about specific JSON-RPC methods including parameters and schemas. Note: Method details can be very long, so only fetch details for methods you actually need to use.",
        inputSchema: {
          type: "object",
          properties: {
            methods: {
              type: "array",
              items: {
                type: "string"
              },
              description: "Array of JSON-RPC method names to get details for"
            }
          },
          required: ["methods"]
        }
      },
      {
        name: "rpc_call",
        description: "Call a JSON-RPC method using the loaded OpenRPC spec. Parameters should be provided as a JSON object.",
        inputSchema: {
          type: "object",
          properties: {
            method: {
              type: "string",
              description: "JSON-RPC method name to call"
            },
            params: {
              type: "string",
              description: "JSON stringified parameters to pass to the method"
            }
          },
          required: ["method"]
        }
      }
    ]
  };
});

/**
 * Handler for OpenRPC tools.
 * Handles method discovery, detailed method information, and method calls.
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (!openRpcSpec) {
    throw new Error("OpenRPC spec not loaded");
  }

  switch (request.params.name) {
    case "rpc_discover": {
      const methods = openRpcSpec.methods || [];
      const methodSummaries = methods.map((method: any) => ({
        name: method.name,
        summary: method.summary || method.description || "No summary available"
      }));

      return {
        content: [
          { type: "text", text: JSON.stringify(methodSummaries, null, 2) }
        ],
        isError: false
      };
    }

    case "rpc_method_details": {
      const requestedMethods = request.params.arguments?.methods;
      if (!requestedMethods || !Array.isArray(requestedMethods)) {
        throw new Error("Methods array is required");
      }

      if (requestedMethods.length === 0) {
        throw new Error("At least one method name must be provided");
      }

      const availableMethods = openRpcSpec.methods || [];
      const methodDetailsList: any[] = [];
      const notFoundMethods: string[] = [];

      // Process each requested method
      for (const methodName of requestedMethods) {
        const method = availableMethods.find((m: any) => m.name === methodName);
        
        if (!method) {
          notFoundMethods.push(methodName);
          continue;
        }

        // Add the complete method information with all schemas resolved
        methodDetailsList.push({
          name: method.name,
          summary: method.summary,
          description: method.description,
          params: method.params || [],
          result: method.result,
          examples: method.examples || []
        });
      }

      // Prepare the response
      const response: any = {
        methods: methodDetailsList
      };

      // Add warning about methods that weren't found
      if (notFoundMethods.length > 0) {
        response.notFound = notFoundMethods;
        response.warning = `The following methods were not found in the OpenRPC spec: ${notFoundMethods.join(', ')}`;
      }

      return {
        content: [
          { type: "text", text: JSON.stringify(response, null, 2) }
        ],
        isError: false
      };
    }

    case "rpc_call": {
      const methodName = String(request.params.arguments?.method);
      const paramsRaw = request.params.arguments?.params;
      const params = paramsRaw != null ? JSON.parse(String(paramsRaw)) : undefined;

      if (!methodName) {
        throw new Error("Method name is required");
      }

      // Verify the method exists in the spec
      const methods = openRpcSpec.methods || [];
      const methodSpec = methods.find((m: any) => m.name === methodName);

      if (!methodSpec) {
        throw new Error(`Method '${methodName}' not found in OpenRPC spec`);
      }

      // Authenticate if Kerio credentials are provided and we don't have a session
      if (kerioCredentials && !kerioSession) {
        await authenticateKerio();
      }

      // Make the actual JSON-RPC call
      const serverUrl = getServerUrl();

      // Prepare transport and client based on whether we have Kerio session
      let transport: HTTPTransport;
      let client: Client;
      let results: any;

      if (kerioSession) {
        // Authenticated request to Kerio Control
        const cookieHeader = buildCookieHeader({
          'SESSION_CONTROL_WEBADMIN': kerioSession.sessionCookie,
          'TOKEN_CONTROL_WEBADMIN': kerioSession.tokenCookie
        });

        const headers: Record<string, string> = {
          'Cookie': cookieHeader,
          'X-Token': kerioSession.tokenCookie,
          'Accept': 'application/json-rpc',
          'X-Requested-With': 'XMLHttpRequest'
        };

        // Use the server URL as-is - it should already point to the JSON-RPC endpoint
        // If it doesn't contain the JSON-RPC path, append it
        let jsonRpcUrl = serverUrl;
        if (!serverUrl.includes('/admin/api/jsonrpc')) {
          jsonRpcUrl = `${serverUrl}/admin/api/jsonrpc/`;
        }
        const fetchOptions: any = { 
          headers,
          agent: jsonRpcUrl.startsWith('https') ? httpsAgent : undefined
        };
        transport = new HTTPTransport(jsonRpcUrl, fetchOptions);
        client = new Client(new RequestManager([transport]));
      } else {
        // No authentication needed - use original implementation
        const fetchOptions: any = serverUrl.startsWith('https') ? { agent: httpsAgent } : {};
        transport = new HTTPTransport(serverUrl, fetchOptions);
        client = new Client(new RequestManager([transport]));
      }

      try {
        results = await client.request({ method: methodName, params: params as any });
        return {
          content: [
            { type: "text", text: JSON.stringify(results, null, 2) }
          ],
          isError: false
        };
      } catch (error) {
        // If we have Kerio credentials and the error might be auth-related, try re-authenticating
        if (kerioCredentials && kerioSession && (
          error?.toString().includes('401') ||
          error?.toString().includes('403') ||
          error?.toString().includes('Unauthorized') ||
          error?.toString().includes('Forbidden')
        )) {
          console.error("Authentication may have expired, attempting to re-authenticate...");

          try {
            // Clear the existing session and re-authenticate
            kerioSession = null;
            await authenticateKerio();

            // Retry the request with fresh authentication
            const retryHeaders: Record<string, string> = {
              'Cookie': buildCookieHeader({
                'SESSION_CONTROL_WEBADMIN': kerioSession!.sessionCookie,
                'TOKEN_CONTROL_WEBADMIN': kerioSession!.tokenCookie
              }),
              'X-Token': kerioSession!.tokenCookie,
              'Accept': 'application/json-rpc',
              'X-Requested-With': 'XMLHttpRequest'
            };

            // Use the server URL as-is - it should already point to the JSON-RPC endpoint
            let jsonRpcUrl = serverUrl;
            if (!serverUrl.includes('/admin/api/jsonrpc')) {
              jsonRpcUrl = `${serverUrl}/admin/api/jsonrpc/`;
            }
            const retryFetchOptions: any = {
              headers: retryHeaders,
              agent: jsonRpcUrl.startsWith('https') ? httpsAgent : undefined
            };
            const retryTransport = new HTTPTransport(jsonRpcUrl, retryFetchOptions);
            const retryClient = new Client(new RequestManager([retryTransport]));

            const retryResults = await retryClient.request({ method: methodName, params: params as any });
            return {
              content: [
                { type: "text", text: JSON.stringify(retryResults, null, 2) }
              ],
              isError: false
            };
          } catch (retryError) {
            return {
              content: [
                { type: "text", text: `Error calling method '${methodName}' after re-authentication: ${retryError}` }
              ],
              isError: true
            };
          }
        }

        return {
          content: [
            { type: "text", text: `Error calling method '${methodName}': ${error}` }
          ],
          isError: true
        };
      }
    }

    default:
      throw new Error("Unknown tool");
  }
});

/**
 * Start the server using stdio transport.
 * This allows the server to communicate via standard input/output streams.
 * First loads the OpenRPC spec from the command line argument.
 */
async function main() {
  // Get the OpenRPC spec file path and optional credentials from command line arguments
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("Usage: openrpc-mcp-server <path-to-openrpc-spec.json> [kerio_username] [kerio_password]");
    console.error("Example: openrpc-mcp-server ./my-api-spec.json admin mypassword");
    console.error("Note: If username and password are provided, the server will authenticate with Kerio Control");
    process.exit(1);
  }

  const specPath = args[0];

  // Store Kerio credentials if provided
  if (args.length >= 3) {
    kerioCredentials = {
      username: args[1],
      password: args[2]
    };
    console.error(`Kerio authentication enabled for user: ${kerioCredentials.username}`);
  }

  // Load and parse the OpenRPC spec
  await loadOpenRpcSpec(specPath);

  // Start the MCP server
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
