import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { collectRepositoryStats, formatGitHubError } from "./github.js";
import {
  MAX_INTERVAL_MINUTES,
  MIN_INTERVAL_MINUTES,
  ScheduleLimitError,
  ScheduleNotFoundError,
} from "./scheduler.js";

export const HELLO_TOOL_NAME = "hello";
export const GITHUB_TOOL_NAME = "github_repository_stats";
export const SCHEDULE_UPSERT_TOOL_NAME = "github_stats_schedule_upsert";
export const SUMMARY_TOOL_NAME = "github_stats_summary";

const visibility = z
  .enum(["all", "public", "private"])
  .default("all")
  .describe("Which repository visibility to include.");

const affiliation = z.enum([
  "owner",
  "collaborator",
  "organization_member",
]);

const taskId = z
  .string()
  .regex(/^[A-Za-z0-9_.-]{1,64}$/)
  .default("default")
  .describe("Stable identifier used to create or update one recurring task.");

const statsInputShape = {
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
};

function errorResult(message) {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

export function buildMcpServer({
  githubAuth,
  fetchImpl = globalThis.fetch,
  apiUrl = process.env.GITHUB_API_URL,
  scheduler,
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
      inputSchema: z.object(statsInputShape),
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
              text: formatGitHubError(error),
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    SCHEDULE_UPSERT_TOOL_NAME,
    {
      title: "Create or update a GitHub statistics schedule",
      description: (
        "Persist a recurring GitHub statistics task. The schedule survives MCP "
        + "server restarts and, by default, performs its first collection now."
      ),
      inputSchema: z.object({
        taskId,
        intervalMinutes: z
          .number()
          .int()
          .min(MIN_INTERVAL_MINUTES)
          .max(MAX_INTERVAL_MINUTES)
          .describe("Collection interval. Production minimum is five minutes."),
        enabled: z.boolean().default(true),
        runImmediately: z
          .boolean()
          .default(true)
          .describe("Collect once before returning, then continue in background."),
        ...statsInputShape,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({
      taskId: scheduleId,
      intervalMinutes,
      enabled,
      runImmediately,
      ...parameters
    }) => {
      if (!scheduler) return errorResult("GitHub scheduler is not configured.");
      try {
        const task = await scheduler.upsertTask({
          taskId: scheduleId,
          intervalMinutes,
          enabled,
          runImmediately,
          parameters,
        });
        const result = { task };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        if (error instanceof ScheduleLimitError) {
          return errorResult(error.message);
        }
        return errorResult("Unable to save the GitHub statistics schedule.");
      }
    },
  );

  server.registerTool(
    SUMMARY_TOOL_NAME,
    {
      title: "Read scheduled GitHub statistics",
      description: (
        "Return the latest successful scheduled collection, bounded history and "
        + "the numeric delta from the previous successful collection."
      ),
      inputSchema: z.object({
        taskId,
        historyLimit: z.number().int().min(1).max(50).default(10),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ taskId: scheduleId, historyLimit }) => {
      if (!scheduler) return errorResult("GitHub scheduler is not configured.");
      try {
        const result = await scheduler.summary(scheduleId, historyLimit);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        if (error instanceof ScheduleNotFoundError) {
          return errorResult(error.message);
        }
        return errorResult("Unable to read the GitHub statistics schedule.");
      }
    },
  );

  return server;
}
