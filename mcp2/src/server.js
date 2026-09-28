import { createServer } from "node:http";

import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";

import { buildCatalogMcpServer } from "./mcp.js";

const host = "127.0.0.1";
const port = Number.parseInt(process.env.MCP_CATALOG_PORT ?? "3102", 10);

if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  throw new Error(`Invalid MCP_CATALOG_PORT: ${process.env.MCP_CATALOG_PORT}`);
}

const mcpHandler = createMcpHandler(() => buildCatalogMcpServer());
const nodeHandler = toNodeHandler(mcpHandler);
const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();

const httpServer = createServer((request, response) => {
  if (request.url !== "/mcp") {
    response.writeHead(404).end("Not found");
    return;
  }
  if (!validateHost(request, response) || !validateOrigin(request, response)) return;
  void nodeHandler(request, response);
});

httpServer.listen(port, host, () => {
  const address = httpServer.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  console.log(`Catalog MCP server listening on http://${host}:${actualPort}/mcp`);
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
