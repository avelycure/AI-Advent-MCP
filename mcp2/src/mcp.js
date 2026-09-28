import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import {
  getLearningResource,
  searchLearningResources,
} from "./catalog.js";

export const SEARCH_RESOURCES_TOOL = "search_learning_resources";
export const RESOURCE_DETAILS_TOOL = "get_resource_details";

function success(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

export function buildCatalogMcpServer() {
  const server = new McpServer({
    name: "day20-catalog-server",
    version: "1.0.0",
  });

  server.registerTool(
    SEARCH_RESOURCES_TOOL,
    {
      title: "Search learning resources",
      description: (
        "Search the learning catalog by topic. Use this first when a user asks "
        + "to find or select educational resources. Returns compact resource IDs."
      ),
      inputSchema: z.object({
        topic: z.string().trim().min(1).max(120),
        maxResults: z.number().int().min(1).max(5).default(3),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (arguments_) => success(searchLearningResources(arguments_)),
  );

  server.registerTool(
    RESOURCE_DETAILS_TOOL,
    {
      title: "Get learning resource details",
      description: (
        "Load full details for one resource ID returned by search_learning_resources. "
        + "Use before building a learning plan that needs duration and modules."
      ),
      inputSchema: z.object({
        resourceId: z.string().regex(/^[a-z0-9-]{1,64}$/),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ resourceId }) => {
      const resource = getLearningResource(resourceId);
      if (!resource) {
        return {
          isError: true,
          content: [{ type: "text", text: `Unknown resource: ${resourceId}` }],
        };
      }
      return success(resource);
    },
  );

  return server;
}
