import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { config as loadEnvironment } from "dotenv";

import {
  collectRepositoryStatsWithAuth,
  formatGitHubError,
} from "./github.js";
import { buildMcpServer } from "./mcp.js";
import { GitHubStatsScheduler } from "./scheduler.js";

loadEnvironment({
  path: fileURLToPath(new URL("../../secrets/.env", import.meta.url)),
  quiet: true,
});

function githubAuthentication() {
  return process.env.GITHUB_TOKEN;
}

const host = "127.0.0.1";
const port = Number.parseInt(process.env.MCP_PORT ?? "3000", 10);

if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  throw new Error(`Invalid MCP_PORT: ${process.env.MCP_PORT}`);
}

if (!githubAuthentication()) {
  throw new Error("GITHUB_TOKEN is missing in secrets/.env");
}

const schedulerFile = process.env.MCP_STATE_FILE
  ? resolve(process.env.MCP_STATE_FILE)
  : fileURLToPath(new URL("../data/github-stats-scheduler.json", import.meta.url));
const scheduler = new GitHubStatsScheduler({
  storePath: schedulerFile,
  collectStats: (parameters, { signal }) => collectRepositoryStatsWithAuth(
    githubAuthentication(),
    {
      apiUrl: process.env.GITHUB_API_URL,
      signal,
      ...parameters,
    },
  ),
  formatError: formatGitHubError,
});
await scheduler.start();

const mcpHandler = createMcpHandler(() => buildMcpServer({
  githubAuth: githubAuthentication(),
  scheduler,
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
  await scheduler.stop();
  await mcpHandler.close();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
