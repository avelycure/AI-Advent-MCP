import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";

import { buildPlanningMcpServer } from "./mcp.js";

const host = "127.0.0.1";
const port = Number.parseInt(process.env.MCP_PLANNING_PORT ?? "3103", 10);
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  throw new Error(`Invalid MCP_PLANNING_PORT: ${process.env.MCP_PLANNING_PORT}`);
}
const outputDirectory = process.env.MCP_PLAN_OUTPUT_DIR
  ? resolve(process.env.MCP_PLAN_OUTPUT_DIR)
  : fileURLToPath(new URL("../output", import.meta.url));

const mcpHandler = createMcpHandler(() => buildPlanningMcpServer({ outputDirectory }));
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
  console.log(`Planning MCP server listening on http://${host}:${actualPort}/mcp`);
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
