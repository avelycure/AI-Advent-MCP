import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { collectRepositoryStats } from "./github.js";

export const HELLO_TOOL_NAME = "hello";
export const GITHUB_TOOL_NAME = "github_repository_stats";

const visibility = z
  .enum(["all", "public", "private"])
  .default("all")
  .describe("Which repository visibility to include.");

const affiliation = z.enum([
  "owner",
  "collaborator",
  "organization_member",
]);

export function buildMcpServer({
  githubAuth,
  fetchImpl = globalThis.fetch,
  apiUrl = process.env.GITHUB_API_URL,
} = {}) {
  const server = new McpServer({
    name: "ai-advent-mcp-server",
    version: "1.0.0",
  });

  server.registerTool(
    HELLO_TOOL_NAME,
    {
      description: "Returns a greeting from the demo MCP server",
    },
    async () => ({
      content: [{ type: "text", text: "Hello from MCP!" }],
    }),
  );

  server.registerTool(
    GITHUB_TOOL_NAME,
    {
      title: "GitHub repository statistics",
      description: (
        "Collect aggregate statistics for every GitHub repository accessible "
        + "to the configured token. Returns repository counts, stars, forks, "
        + "open issue/PR items, primary languages and a compact top list."
      ),
      inputSchema: z.object({
        visibility,
        affiliations: z
          .array(affiliation)
          .min(1)
          .default(["owner", "collaborator", "organization_member"])
          .describe("Relationships to the repositories that should be included."),
        includeForks: z
          .boolean()
          .default(true)
          .describe("Whether repositories forked from other projects are included."),
        includeArchived: z
          .boolean()
          .default(true)
          .describe("Whether archived repositories are included."),
        top: z
          .number()
          .int()
          .min(1)
          .max(20)
          .default(5)
          .describe("Number of repositories to include in the compact top list."),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (arguments_, context) => {
      try {
        const stats = await collectRepositoryStats({
          token: githubAuth,
          fetchImpl,
          apiUrl,
          signal: context.mcpReq.signal,
          ...arguments_,
        });

        return {
          content: [{ type: "text", text: JSON.stringify(stats) }],
          structuredContent: stats,
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: error instanceof Error
                ? error.message
                : "GitHub API request failed.",
            },
          ],
        };
      }
    },
  );

  return server;
}
