# OpenRPC MCP Server (Updated)

A Model Context Protocol (MCP) server that provides JSON-RPC functionality through [OpenRPC](https://open-rpc.org).

> **Note:** This is an updated fork of the original [openrpc-mcp-server](https://github.com/shanejonas/openrpc-mpc-server) by [shanejonas](https://github.com/shanejonas). The primary improvement is the updated `@modelcontextprotocol/sdk` dependency (v1.18.1) for compatibility with newer MCP clients.

## Original Work

This package is based on the excellent work by:
- **Original Author:** [shanejonas](https://github.com/shanejonas)
- **Original Repository:** [https://github.com/shanejonas/openrpc-mpc-server](https://github.com/shanejonas/openrpc-mpc-server)
- **Original npm Package:** [openrpc-mcp-server](https://www.npmjs.com/package/openrpc-mcp-server)

## What's Updated

- ✅ Updated `@modelcontextprotocol/sdk` from v0.6.0 to v1.18.1 for compatibility with newer MCP clients
- ✅ Maintained full backward compatibility with existing features

https://github.com/user-attachments/assets/3447175a-f921-4ded-8250-b611edb2fb67

## Features

### Tools

- `rpc_call` - Call arbitrary JSON-RPC methods
  - Specify server URL, method name, and parameters
  - Returns JSON-formatted results
- `rpc_discover` - Discover available JSON-RPC methods
  - Uses OpenRPC's `rpc.discover` specification
  - Lists all methods on a given server

## Development

Install dependencies:

```bash
npm install
```

Build the server:

```bash
npm run build
```

For development with auto-rebuild:

```bash
npm run watch
```

## Installation

### npm

Install the updated package:

```bash
npm install -g openrpc-mcp-server-updated
```

Or use with npx:

```bash
npx openrpc-mcp-server-updated
```

### Claude Desktop Configuration

To use with Claude Desktop, add the server config:

On MacOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
On Windows: `%APPDATA%/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "openrpc": {
      "command": "npx",
      "args": ["-y", "openrpc-mcp-server-updated"]
    }
  }
}
```

### Debugging

Since MCP servers communicate over stdio, debugging can be challenging. We recommend using the [MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```bash
npm run inspector
```

The Inspector will provide a URL to access debugging tools in your browser.
