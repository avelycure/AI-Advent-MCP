import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const serverPath = fileURLToPath(new URL("./server.js", import.meta.url));
const client = new Client({
  name: "day-16-demo-client",
  version: "1.0.0",
});

try {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
  });

  await client.connect(transport);
  console.log("MCP connection established successfully.\n");

  const { tools } = await client.listTools();

  console.log(`Available tools (${tools.length}):`);
  console.log(JSON.stringify(tools, null, 2));

  if (tools.length === 0) {
    throw new Error("The MCP server returned an empty tool list");
  }
} catch (error) {
  console.error("MCP check failed:", error);
  process.exitCode = 1;
} finally {
  await client.close();
}
