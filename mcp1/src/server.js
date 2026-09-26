import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const server = new McpServer({
  name: "day-16-demo-server",
  version: "1.0.0",
});

server.registerTool(
  "hello",
  {
    description: "Returns a greeting from the demo MCP server",
  },
  async () => ({
    content: [
      {
        type: "text",
        text: "Hello from MCP!",
      },
    ],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
