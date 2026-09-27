import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

const serverPath = fileURLToPath(new URL("../src/server.js", import.meta.url));

function startServer() {
  const serverProcess = spawn(process.execPath, [serverPath], {
    env: { ...process.env, MCP_PORT: "0" },
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

  return { serverProcess, serverUrl };
}

test("connects to a separately running MCP server and receives its tools", async () => {
  const { serverProcess, serverUrl } = startServer();
  const client = new Client({ name: "day-16-test-client", version: "1.0.0" });

  try {
    const url = await serverUrl;
    await client.connect(new StreamableHTTPClientTransport(url));

    const { tools } = await client.listTools();

    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, "hello");
    assert.equal(
      tools[0].description,
      "Returns a greeting from the demo MCP server",
    );
  } finally {
    await client.close();
    serverProcess.kill("SIGTERM");
  }
});
