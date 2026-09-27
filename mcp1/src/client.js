import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

const serverUrl = new URL(
  process.env.MCP_URL ?? "http://127.0.0.1:3000/mcp",
);
const client = new Client({
  name: "day-16-demo-client",
  version: "1.0.0",
});

try {
  const transport = new StreamableHTTPClientTransport(serverUrl);

  await client.connect(transport);
  console.log(`MCP connection established: ${serverUrl}\n`);

  const { tools } = await client.listTools();

  console.log(`Available tools (${tools.length}):`);
  console.log(JSON.stringify(tools, null, 2));

  if (tools.length === 0) {
    throw new Error("The MCP server returned an empty tool list");
  }
} catch (error) {
  console.error("MCP check failed:", error);
  console.error("Start the server first with: npm run server");
  process.exitCode = 1;
} finally {
  await client.close();
}
