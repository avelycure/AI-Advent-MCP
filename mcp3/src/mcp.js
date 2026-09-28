import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import {
  createLearningPlan,
  MAX_PLAN_BYTES,
  PLAN_FILE_PATTERN,
  PlanAlreadyExistsError,
  rankLearningResources,
  saveLearningPlan,
} from "./planner.js";

export const RANK_RESOURCES_TOOL = "rank_learning_resources";
export const CREATE_PLAN_TOOL = "create_learning_plan";
export const SAVE_PLAN_TOOL = "save_learning_plan";

const resourceIdentitySchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  kind: z.string().min(1).max(40),
  difficulty: z.enum(["beginner", "intermediate", "advanced"]),
  summary: z.string().max(500),
});

const compactResourceSchema = resourceIdentitySchema.extend({
  matchedTerms: z.array(z.string().min(1).max(120)).max(20),
  relevanceScore: z.number().int().nonnegative().max(1_000),
});

const detailedResourceSchema = resourceIdentitySchema.extend({
  durationMinutes: z.number().int().min(1).max(480),
  topics: z.array(z.string().max(50)).max(20),
  modules: z.array(z.string().min(1).max(300)).min(1).max(20),
});

function success(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function safeSaveError(error) {
  if (
    error instanceof PlanAlreadyExistsError
    || error instanceof TypeError
    || error instanceof RangeError
  ) return error.message;
  return "Unable to save the learning plan.";
}

export function buildPlanningMcpServer({ outputDirectory } = {}) {
  const server = new McpServer({
    name: "day20-planning-server",
    version: "1.0.0",
  });

  server.registerTool(
    RANK_RESOURCES_TOOL,
    {
      title: "Rank learning resources",
      description: (
        "Rank compact learning resource candidates and select the requested count. "
        + "Use after catalog search and before loading full resource details."
      ),
      inputSchema: z.object({
        resources: z.array(compactResourceSchema).min(1).max(10),
        desiredCount: z.number().int().min(1).max(5),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (arguments_) => success(rankLearningResources(arguments_)),
  );

  server.registerTool(
    CREATE_PLAN_TOOL,
    {
      title: "Create a learning plan",
      description: (
        "Create a Markdown learning plan from fully detailed learning resources. "
        + "Use after every selected resource ID has been expanded."
      ),
      inputSchema: z.object({
        topic: z.string().trim().min(1).max(120),
        resources: z.array(detailedResourceSchema).min(1).max(5),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (arguments_) => success(createLearningPlan(arguments_)),
  );

  server.registerTool(
    SAVE_PLAN_TOOL,
    {
      title: "Save a learning plan",
      description: (
        "Save finished Markdown learning plan content to a safe local .md file. "
        + "Use only after create_learning_plan succeeds."
      ),
      inputSchema: z.object({
        fileName: z.string().regex(PLAN_FILE_PATTERN),
        content: z.string().refine(
          (value) => Buffer.byteLength(value, "utf8") <= MAX_PLAN_BYTES,
          `Content must not exceed ${MAX_PLAN_BYTES} UTF-8 bytes.`,
        ),
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
        return success(await saveLearningPlan({ outputDirectory, ...arguments_ }));
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: safeSaveError(error) }],
        };
      }
    },
  );

  return server;
}
