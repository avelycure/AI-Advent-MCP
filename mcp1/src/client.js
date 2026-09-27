import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { readFileSync } from "node:fs";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const jsonOutput = process.argv.includes("--json");
const listOnly = process.argv.includes("--list");
const toolName = option("--tool");
const configuredServerUrl = process.env.MCP_URL ?? "http://127.0.0.1:3000/mcp";
const MAX_OUTPUT_BYTES = 1_000_000;
const MAX_TOOLS = 100;

class SafeClientError extends Error {}

function write(payload) {
  const output = JSON.stringify(payload, null, jsonOutput ? 0 : 2);
  if (Buffer.byteLength(output, "utf8") > MAX_OUTPUT_BYTES) {
    throw new SafeClientError("MCP response is too large");
  }
  console.log(output);
}

function safeServerUrl(url) {
  return url.origin;
}

function safeError(error, serverUrl) {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof SafeClientError) return message;
  if (!serverUrl) return "MCP_URL is invalid";
  return `MCP client request failed for ${safeServerUrl(serverUrl)}`;
}

const client = new Client({
  name: "ai-advent-mcp-client",
  version: "1.0.0",
});

let serverUrl;
try {
  serverUrl = new URL(configuredServerUrl);
  const rawArguments = process.argv.includes("--arguments-stdin")
    ? readFileSync(0, "utf8")
    : option("--arguments") ?? "{}";
  let arguments_;
  try {
    arguments_ = JSON.parse(rawArguments);
  } catch {
    throw new SafeClientError("--arguments must contain a JSON object");
  }

  if (!arguments_ || Array.isArray(arguments_) || typeof arguments_ !== "object") {
    throw new SafeClientError("--arguments must contain a JSON object");
  }

  await client.connect(new StreamableHTTPClientTransport(serverUrl));
  const { tools } = await client.listTools();
  if (tools.length > MAX_TOOLS) {
    throw new SafeClientError(`MCP server exposes more than ${MAX_TOOLS} tools`);
  }

  if (listOnly || !toolName) {
    write({
      ok: true,
      serverUrl: safeServerUrl(serverUrl),
      server: client.getServerVersion() ?? null,
      tools,
    });
  } else {
    if (!tools.some((tool) => tool.name === toolName)) {
      throw new SafeClientError("MCP server does not expose the requested tool");
    }

    const result = await client.callTool({
      name: toolName,
      arguments: arguments_,
    });
    const error = result.isError
      ? result.content.find((block) => block.type === "text")?.text
        ?? "MCP tool returned an error"
      : undefined;
    write({
      ok: !result.isError,
      tool: toolName,
      result: result.structuredContent ?? null,
      content: result.content,
      ...(error ? { error } : {}),
    });
    if (result.isError) process.exitCode = 1;
  }
} catch (error) {
  const message = safeError(error, serverUrl);
  if (jsonOutput) write({ ok: false, error: message });
  else console.error(`MCP client failed: ${message}`);
  process.exitCode = 1;
} finally {
  await client.close();
}
