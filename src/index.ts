#!/usr/bin/env node
import { RequestManager, HTTPTransport, Client } from "@open-rpc/client-js";
import $RefParser from "@apidevtools/json-schema-ref-parser";
import { readFileSync } from "fs";
import { resolve } from "path";

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

// Global variable to store the loaded and dereferenced OpenRPC spec
let openRpcSpec: any = null;

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
        description: "Get detailed information about a specific JSON-RPC method including parameters and schemas.",
        inputSchema: {
          type: "object",
          properties: {
            method: {
              type: "string",
              description: "The name of the JSON-RPC method to get details for"
            }
          },
          required: ["method"]
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
      const methodName = String(request.params.arguments?.method);
      if (!methodName) {
        throw new Error("Method name is required");
      }

      const methods = openRpcSpec.methods || [];
      const method = methods.find((m: any) => m.name === methodName);

      if (!method) {
        throw new Error(`Method '${methodName}' not found in OpenRPC spec`);
      }

      // Return the complete method information with all schemas resolved
      const methodDetails = {
        name: method.name,
        summary: method.summary,
        description: method.description,
        params: method.params || [],
        result: method.result,
        examples: method.examples || []
      };

      return {
        content: [
          { type: "text", text: JSON.stringify(methodDetails, null, 2) }
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

      // Make the actual JSON-RPC call
      const serverUrl = getServerUrl();
      const transport = new HTTPTransport(serverUrl);
      const client = new Client(new RequestManager([transport]));

      try {
        const results = await client.request({ method: methodName, params: params as any });
        return {
          content: [
            { type: "text", text: JSON.stringify(results, null, 2) }
          ],
          isError: false
        };
      } catch (error) {
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
  // Get the OpenRPC spec file path from command line arguments
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("Usage: openrpc-mcp-server <path-to-openrpc-spec.json>");
    console.error("Example: openrpc-mcp-server ./my-api-spec.json");
    process.exit(1);
  }

  const specPath = args[0];

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
