import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

const serverPath = fileURLToPath(new URL("../src/server.js", import.meta.url));

function startServer() {
  const stateDirectory = mkdtempSync(join(tmpdir(), "ai-advent-mcp-server-"));
  const serverProcess = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      GITHUB_TOKEN: "test-token",
      MCP_PORT: "0",
      MCP_STATE_FILE: join(stateDirectory, "state.json"),
      MCP_OUTPUT_DIR: join(stateDirectory, "reports"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const output = createInterface({ input: serverProcess.stdout });
  const serverUrl = new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for the MCP server")),
      5_000,
    );

    output.once("line", (line) => {
      clearTimeout(timeout);
      resolve(new URL(line.replace("MCP server listening on ", "")));
    });

    serverProcess.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`MCP server exited early with code ${code}`));
    });
  });

  return { serverProcess, serverUrl, stateDirectory };
}

test("connects to a separately running MCP server and receives its tools", async () => {
  const { serverProcess, serverUrl, stateDirectory } = startServer();
  const client = new Client({ name: "integration-test-client", version: "1.0.0" });

  try {
    const url = await serverUrl;
    await client.connect(new StreamableHTTPClientTransport(url));

    const { tools } = await client.listTools();

    assert.equal(tools.length, 8);
    assert.deepEqual(
      tools.map((tool) => tool.name),
      [
        "hello",
        "github_repository_stats",
        "github_stats_schedule_upsert",
        "github_stats_summary",
        "search",
        "summarize",
        "save_to_file",
        "search_summary_pipeline",
      ],
    );
    assert.equal(
      tools[0].description,
      "Returns a greeting from the demo MCP server",
    );

    const greeting = await client.callTool({ name: "hello", arguments: {} });
    assert.equal(greeting.content[0].text, "Hello from MCP!");
  } finally {
    await client.close();
    if (serverProcess.exitCode === null) {
      const exited = once(serverProcess, "exit");
      serverProcess.kill("SIGTERM");
      await exited;
    }
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});
