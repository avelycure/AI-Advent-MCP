import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { config as loadEnvironment } from "dotenv";

import { buildMcpServer } from "./mcp.js";

loadEnvironment({
  path: fileURLToPath(new URL("../../secrets/.env", import.meta.url)),
  quiet: true,
});

const host = "127.0.0.1";
const port = Number.parseInt(process.env.MCP_PORT ?? "3000", 10);

if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  throw new Error(`Invalid MCP_PORT: ${process.env.MCP_PORT}`);
}

if (!process.env.GITHUB_TOKEN) {
  throw new Error("GITHUB_TOKEN is missing in secrets/.env");
}

const mcpHandler = createMcpHandler(() => buildMcpServer({
  githubAuth: process.env.GITHUB_TOKEN,
}));

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
