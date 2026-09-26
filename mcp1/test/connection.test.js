import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const serverPath = fileURLToPath(new URL("../src/server.js", import.meta.url));

test("connects to the MCP server and receives its tools", async () => {
  const client = new Client({ name: "day-16-test-client", version: "1.0.0" });

  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [serverPath],
      }),
    );

    const { tools } = await client.listTools();

    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, "hello");
    assert.equal(
      tools[0].description,
      "Returns a greeting from the demo MCP server",
    );
  } finally {
    await client.close();
  }
});
