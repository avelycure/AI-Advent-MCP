import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import {
  collectRepositoryStats,
  formatGitHubError,
  MAX_SEARCH_QUERY_LENGTH,
  searchRepositories,
} from "./github.js";
import {
  MAX_SEARCH_RESULTS,
  MAX_SUMMARY_BYTES,
  PipelineStageError,
  REPORT_FILE_PATTERN,
  ReportAlreadyExistsError,
  runSearchSummaryPipeline,
  saveToFile,
  summarizeSearchResults,
} from "./pipeline.js";
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
export const SEARCH_TOOL_NAME = "search";
export const SUMMARIZE_TOOL_NAME = "summarize";
export const SAVE_TO_FILE_TOOL_NAME = "save_to_file";
export const PIPELINE_TOOL_NAME = "search_summary_pipeline";

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

const searchInputShape = {
  query: z
    .string()
    .trim()
    .min(1)
    .max(MAX_SEARCH_QUERY_LENGTH)
    .describe("GitHub repository search query."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_SEARCH_RESULTS)
    .default(5)
    .describe("Maximum number of compact repository results."),
};

const searchItemSchema = z.object({
  fullName: z.string().min(1).max(200),
  description: z.string().max(500).nullable(),
  url: z.string().url().max(2_048),
  language: z.string().max(100).nullable(),
  stars: z.number().nonnegative(),
  forks: z.number().nonnegative(),
  updatedAt: z.string().max(64).nullable(),
});

const searchResultSchema = z.object({
  query: z.string().min(1).max(MAX_SEARCH_QUERY_LENGTH),
  searchedAt: z.string().min(1).max(64),
  totalCount: z.number().int().nonnegative(),
  items: z.array(searchItemSchema).max(MAX_SEARCH_RESULTS),
});

const fileNameSchema = z
  .string()
  .regex(
    REPORT_FILE_PATTERN,
    "Use a simple .md or .txt file name without directories.",
  );

const fileContentSchema = z
  .string()
  .max(MAX_SUMMARY_BYTES)
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= MAX_SUMMARY_BYTES,
    `Content must not exceed ${MAX_SUMMARY_BYTES} UTF-8 bytes.`,
  );

function errorResult(message) {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

function successResult(result) {
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

function formatSaveError(error) {
  if (error instanceof ReportAlreadyExistsError) return error.message;
  if (error instanceof RangeError || error instanceof TypeError) {
    return error.message;
  }
  return "Unable to save the report.";
}

function formatPipelineError(error) {
  if (!(error instanceof PipelineStageError)) {
    return "Pipeline failed.";
  }

  let detail;
  if (error.stage === SEARCH_TOOL_NAME) {
    detail = formatGitHubError(error.cause);
  } else if (error.stage === SAVE_TO_FILE_TOOL_NAME) {
    detail = formatSaveError(error.cause);
  } else {
    detail = "Unable to summarize the search results.";
  }
  return `Pipeline failed at ${error.stage}: ${detail}`;
}

export function buildMcpServer({
  githubAuth,
  fetchImpl = globalThis.fetch,
  apiUrl = process.env.GITHUB_API_URL,
  scheduler,
  outputDirectory,
  searchImpl = searchRepositories,
  summarizeImpl = summarizeSearchResults,
  saveImpl = saveToFile,
  pipelineLogger = console,
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

  const search = ({ query, limit, signal }) => searchImpl({
    token: githubAuth,
    query,
    limit,
    fetchImpl,
    apiUrl,
    signal,
  });
  const summarize = async ({ searchResult }) => summarizeImpl(searchResult);
  const save = ({ fileName, content, overwrite }) => saveImpl({
    outputDirectory,
    fileName,
    content,
    overwrite,
  });

  server.registerTool(
    SEARCH_TOOL_NAME,
    {
      title: "Search GitHub repositories",
      description: (
        "Search public GitHub repositories and return a compact structured "
        + "result for the next pipeline stage."
      ),
      inputSchema: z.object(searchInputShape),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (arguments_, context) => {
      try {
        return successResult(await search({
          ...arguments_,
          signal: context.mcpReq.signal,
        }));
      } catch (error) {
        return errorResult(formatGitHubError(error));
      }
    },
  );

  server.registerTool(
    SUMMARIZE_TOOL_NAME,
    {
      title: "Summarize repository search results",
      description: (
        "Turn the structured output of search into deterministic Markdown "
        + "without calling another external service."
      ),
      inputSchema: z.object({ searchResult: searchResultSchema }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (arguments_) => {
      try {
        return successResult(await summarize(arguments_));
      } catch {
        return errorResult("Unable to summarize the search results.");
      }
    },
  );

  server.registerTool(
    SAVE_TO_FILE_TOOL_NAME,
    {
      title: "Save pipeline output to a file",
      description: (
        "Atomically save text to a simple .md or .txt file in the server's "
        + "configured reports directory."
      ),
      inputSchema: z.object({
        fileName: fileNameSchema,
        content: fileContentSchema,
        overwrite: z.boolean().default(false),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (arguments_) => {
      try {
        return successResult(await save(arguments_));
      } catch (error) {
        return errorResult(formatSaveError(error));
      }
    },
  );

  server.registerTool(
    PIPELINE_TOOL_NAME,
    {
      title: "Search, summarize and save",
      description: (
        "Automatically execute search -> summarize -> save_to_file and "
        + "return the output and handoff metadata from every stage."
      ),
      inputSchema: z.object({
        ...searchInputShape,
        fileName: fileNameSchema,
        overwrite: z.boolean().default(false),
        trace: z
          .boolean()
          .default(false)
          .describe("Print every pipeline handoff in the MCP server terminal."),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (arguments_, context) => {
      try {
        const result = await runSearchSummaryPipeline(arguments_, {
          search,
          summarize,
          save,
          signal: context.mcpReq.signal,
          onTrace: arguments_.trace
            ? (stage, payload) => pipelineLogger.log(
              `\n[Day 19 pipeline] INPUT -> ${stage}\n${JSON.stringify(payload, null, 2)}`,
            )
            : undefined,
        });
        return successResult(result);
      } catch (error) {
        return errorResult(formatPipelineError(error));
      }
    },
  );

  return server;
}
