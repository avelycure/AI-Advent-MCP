import { createServer } from "node:http";

import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";

const host = process.env.MCP_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.MCP_PORT ?? "3000", 10);

if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  throw new Error(`Invalid MCP_PORT: ${process.env.MCP_PORT}`);
}

const mcpHandler = createMcpHandler(() => {
  const server = new McpServer({
    name: "day-16-demo-server",
    version: "1.0.0",
  });

  server.registerTool(
    "hello",
    {
      description: "Returns a greeting from the demo MCP server",
    },
    async () => ({
      content: [
        {
          type: "text",
          text: "Hello from MCP!",
        },
      ],
    }),
  );

  return server;
});

const nodeHandler = toNodeHandler(mcpHandler);
const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();

const httpServer = createServer((request, response) => {
  if (request.url !== "/mcp") {
    response.writeHead(404).end("Not found");
    return;
  }

  if (!validateHost(request, response) || !validateOrigin(request, response)) {
    return;
  }

  void nodeHandler(request, response);
});

httpServer.listen(port, host, () => {
  const address = httpServer.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  console.log(`MCP server listening on http://${host}:${actualPort}/mcp`);
});

let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  httpServer.close();
  await mcpHandler.close();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
