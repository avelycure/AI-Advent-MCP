import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import * as z from "zod/v4";

import { MAX_PLAN_BYTES, PLAN_FILE_PATTERN } from "./planner.js";

const MAX_MCP_RESPONSE_BYTES = 1_000_000;
const MAX_TOOL_CATALOG_BYTES = 256_000;
const MAX_TRACE_BYTES = 750_000;

const CAPABILITIES = Object.freeze({
  search: {
    label: "найти кандидатов по теме",
    terms: ["search", "learning", "resource"],
    inputs: ["topic", "maxResults"],
  },
  rank: {
    label: "ранжировать кандидатов",
    terms: ["rank", "learning", "resource"],
    inputs: ["resources", "desiredCount"],
  },
  details: {
    label: "получить полные детали ресурса",
    terms: ["resource", "details"],
    inputs: ["resourceId"],
  },
  createPlan: {
    label: "создать учебный план",
    terms: ["create", "learning", "plan"],
    inputs: ["topic", "resources"],
  },
  savePlan: {
    label: "сохранить готовый план",
    terms: ["save", "learning", "plan"],
    inputs: ["fileName", "content"],
  },
});

const compactResourceSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,64}$/),
  title: z.string().min(1).max(200),
  kind: z.string().min(1).max(40),
  difficulty: z.enum(["beginner", "intermediate", "advanced"]),
  summary: z.string().max(500),
  matchedTerms: z.array(z.string().min(1).max(120)).max(20),
  relevanceScore: z.number().int().nonnegative().max(1_000),
});

const detailedResourceSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,64}$/),
  title: z.string().min(1).max(200),
  kind: z.string().min(1).max(40),
  difficulty: z.enum(["beginner", "intermediate", "advanced"]),
  durationMinutes: z.number().int().min(1).max(480),
  summary: z.string().max(500),
  topics: z.array(z.string().min(1).max(50)).max(20),
  modules: z.array(z.string().min(1).max(300)).min(1).max(20),
});

const OUTPUT_SCHEMAS = Object.freeze({
  search: z.object({
    topic: z.string().min(1).max(120),
    count: z.number().int().nonnegative().max(5),
    resources: z.array(compactResourceSchema).max(5),
  }),
  rank: z.object({
    candidateCount: z.number().int().positive().max(10),
    selectedIds: z.array(z.string().regex(/^[a-z0-9-]{1,64}$/)).min(1).max(5),
    rationale: z.string().min(1).max(500),
  }),
  details: detailedResourceSchema,
  createPlan: z.object({
    topic: z.string().min(1).max(120),
    resourceCount: z.number().int().min(1).max(5),
    totalMinutes: z.number().int().min(1).max(2_400),
    markdown: z.string().min(1).max(MAX_PLAN_BYTES).refine(
      (value) => Buffer.byteLength(value, "utf8") <= MAX_PLAN_BYTES,
    ),
  }),
  savePlan: z.object({
    fileName: z.string().regex(PLAN_FILE_PATTERN),
    outputPath: z.string().min(1).max(4_096),
    bytes: z.number().int().nonnegative().max(100_000),
  }),
});

export class OrchestrationError extends Error {
  constructor(message, { trace = [], cause } = {}) {
    super(message, { cause });
    this.name = "OrchestrationError";
    this.trace = trace;
  }
}

function textFromResult(result) {
  return result.content?.find((block) => block.type === "text")?.text;
}

function safeServerDefinition(definition) {
  if (!definition?.id || !/^[a-z][a-z0-9-]{0,31}$/.test(definition.id)) {
    throw new OrchestrationError("Every MCP server needs a safe, unique id");
  }
  let url;
  try {
    url = new URL(definition.url);
  } catch {
    throw new OrchestrationError(`Invalid MCP URL for ${definition.id}`);
  }
  if (!new Set(["http:", "https:"]).has(url.protocol)) {
    throw new OrchestrationError(`Unsupported MCP URL protocol for ${definition.id}`);
  }
  if (
    url.protocol !== "http:"
    || url.hostname !== "127.0.0.1"
    || url.pathname !== "/mcp"
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new OrchestrationError(
      `MCP URL for ${definition.id} must be an exact loopback http://127.0.0.1:<port>/mcp URL`,
    );
  }
  return { id: definition.id, url };
}

async function boundedLoopbackFetch(input, init = {}) {
  const response = await fetch(input, { ...init, redirect: "manual" });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {});
    throw new OrchestrationError("MCP HTTP redirects are not allowed");
  }
  const declaredBytes = Number.parseInt(
    response.headers.get("content-length") ?? "0",
    10,
  );
  if (declaredBytes > MAX_MCP_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new OrchestrationError("MCP HTTP response is too large");
  }
  if (!response.body) return response;

  let receivedBytes = 0;
  const limiter = new TransformStream({
    transform(chunk, controller) {
      receivedBytes += chunk.byteLength;
      if (receivedBytes > MAX_MCP_RESPONSE_BYTES) {
        throw new OrchestrationError("MCP HTTP response is too large");
      }
      controller.enqueue(chunk);
    },
  });
  return new Response(response.body.pipeThrough(limiter), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export class ToolRegistry {
  constructor(connections) {
    this.connections = connections;
    this.tools = [];
    this.byName = new Map();
  }

  static async fromClients(connections) {
    const registry = new ToolRegistry(connections);
    await registry.discover();
    return registry;
  }

  async discover() {
    const serverIds = new Set();
    for (const connection of this.connections) {
      if (serverIds.has(connection.id)) {
        throw new OrchestrationError(`Duplicate MCP server id: ${connection.id}`);
      }
      serverIds.add(connection.id);
      const listed = await connection.client.listTools();
      if (listed.tools.length > 50) {
        throw new OrchestrationError(`MCP server ${connection.id} exposes too many tools`);
      }
      if (Buffer.byteLength(JSON.stringify(listed.tools), "utf8") > MAX_TOOL_CATALOG_BYTES) {
        throw new OrchestrationError(`MCP server ${connection.id} tool catalog is too large`);
      }
      for (const tool of listed.tools) {
        if (this.byName.has(tool.name)) {
          const existing = this.byName.get(tool.name);
          throw new OrchestrationError(
            `Ambiguous tool ${tool.name}: exposed by ${existing.serverId} and ${connection.id}`,
          );
        }
        const entry = {
          serverId: connection.id,
          client: connection.client,
          tool,
        };
        this.tools.push(entry);
        this.byName.set(tool.name, entry);
      }
    }
    return this.summary();
  }

  summary() {
    return this.connections.map(({ id }) => ({
      serverId: id,
      tools: this.tools
        .filter((entry) => entry.serverId === id)
        .map((entry) => entry.tool.name),
    }));
  }

  select(capabilityName) {
    const capability = CAPABILITIES[capabilityName];
    if (!capability) throw new OrchestrationError(`Unknown capability: ${capabilityName}`);

    const candidates = this.tools.map((entry) => {
      const corpus = [
        entry.tool.name,
        entry.tool.title,
        entry.tool.description,
      ].filter(Boolean).join(" ").toLowerCase();
      const properties = entry.tool.inputSchema?.properties ?? {};
      const required = Array.isArray(entry.tool.inputSchema?.required)
        ? entry.tool.inputSchema.required
        : [];
      const matchedTerms = capability.terms.filter((term) => corpus.includes(term));
      const matchedInputs = capability.inputs.filter((input) => input in properties);
      const unsupportedRequired = required.filter(
        (input) => !capability.inputs.includes(input),
      );
      return {
        entry,
        matchedTerms,
        matchedInputs,
        unsupportedRequired,
        score: matchedTerms.length + matchedInputs.length * 4,
      };
    }).filter((candidate) => (
      candidate.matchedInputs.length === capability.inputs.length
      && candidate.matchedTerms.length > 0
      && candidate.unsupportedRequired.length === 0
    )).sort((left, right) => right.score - left.score);

    if (candidates.length === 0) {
      throw new OrchestrationError(`No discovered tool can ${capability.label}`);
    }
    if (candidates[1]?.score === candidates[0].score) {
      throw new OrchestrationError(`Tool selection is ambiguous for: ${capability.label}`);
    }
    const selected = candidates[0];
    return {
      capability: capabilityName,
      label: capability.label,
      serverId: selected.entry.serverId,
      toolName: selected.entry.tool.name,
      reason: (
        `совпали назначение (${selected.matchedTerms.join(", ")}) `
        + `и входы (${selected.matchedInputs.join(", ")})`
      ),
      entry: selected.entry,
    };
  }

  async call(selection, arguments_) {
    const result = await selection.entry.client.callTool({
      name: selection.toolName,
      arguments: arguments_,
    });
    if (result.isError) {
      throw new OrchestrationError(
        `${selection.serverId}.${selection.toolName} failed: ${textFromResult(result) ?? "unknown error"}`,
      );
    }
    if (!result.structuredContent) {
      throw new OrchestrationError(
        `${selection.serverId}.${selection.toolName} returned no structuredContent`,
      );
    }
    let serialized;
    try {
      serialized = JSON.stringify(result.structuredContent);
    } catch {
      throw new OrchestrationError(
        `${selection.serverId}.${selection.toolName} returned unserializable structuredContent`,
      );
    }
    if (Buffer.byteLength(serialized, "utf8") > MAX_MCP_RESPONSE_BYTES) {
      throw new OrchestrationError(
        `${selection.serverId}.${selection.toolName} returned too much structuredContent`,
      );
    }
    const validated = OUTPUT_SCHEMAS[selection.capability].safeParse(
      result.structuredContent,
    );
    if (!validated.success) {
      throw new OrchestrationError(
        `${selection.serverId}.${selection.toolName} returned invalid structuredContent`,
      );
    }
    return validated.data;
  }

  async close() {
    await Promise.allSettled(
      this.connections.map(({ client }) => client.close()),
    );
  }
}

export async function connectHttpToolRegistry(serverDefinitions) {
  const connections = [];
  try {
    for (const definition of serverDefinitions.map(safeServerDefinition)) {
      const client = new Client({
        name: `day20-orchestrator-${definition.id}`,
        version: "1.0.0",
      });
      await client.connect(new StreamableHTTPClientTransport(definition.url, {
        fetch: boundedLoopbackFetch,
      }));
      connections.push({ id: definition.id, client });
    }
    return await ToolRegistry.fromClients(connections);
  } catch (error) {
    await Promise.allSettled(connections.map(({ client }) => client.close()));
    if (error instanceof OrchestrationError) throw error;
    throw new OrchestrationError("Unable to register all MCP servers", { cause: error });
  }
}

export function parseOrchestrationRequest(request) {
  if (typeof request !== "string" || !request.trim()) {
    throw new OrchestrationError("Request must be a non-empty string");
  }
  if (!/(?:план|plan)/iu.test(request) || !/(?:сохрани|save)/iu.test(request)) {
    throw new OrchestrationError(
      "Supported scenario must ask to create and save a learning plan",
    );
  }

  const topicMarker = request.match(/(?:по теме|about|topic)\s+/iu);
  if (!topicMarker) {
    throw new OrchestrationError("Unable to recognize the topic after ‘по теме’");
  }
  const afterMarker = request.slice(topicMarker.index + topicMarker[0].length);
  const actionBoundary = /(?:\s*[,.;!?]\s*|\s+(?:и|and)\s+)(?=(?:ранжируй|изучи|уточни|составь|создай|сохрани|rank|inspect|create|build|save)(?:\s|$))/iu;
  const topic = afterMarker
    .split(actionBoundary, 1)[0]
    .replace(/^[«"']|[»"']$/gu, "")
    .replace(/[.,!?;:]+$/gu, "")
    .trim();
  if (!topic) throw new OrchestrationError("Learning topic must not be empty");
  const countMatch = request.match(
    /(?:найди|подбери|выбери|find|select|choose)\s+(\d+)\b/iu,
  );
  const desiredCount = countMatch ? Number.parseInt(countMatch[1], 10) : 3;
  if (!Number.isInteger(desiredCount) || desiredCount < 1 || desiredCount > 5) {
    throw new OrchestrationError("Requested resource count must be between 1 and 5");
  }
  const fileMatch = request.match(
    /\b([A-Za-z0-9][A-Za-z0-9._-]{0,120}\.md)\b/iu,
  );
  const fileName = fileMatch?.[1] ?? "learning-plan.md";
  if (!PLAN_FILE_PATTERN.test(fileName)) {
    throw new OrchestrationError("Output file name must end with lowercase .md");
  }

  const afterFileName = fileMatch
    ? request.slice(fileMatch.index + fileMatch[0].length)
    : "";

  return {
    topic,
    desiredCount,
    fileName,
    overwrite: (
      /^\s*(?:[,.;]\s*|и\s+)(?:при\s+наличии\s+)?перезапиши(?:\s+(?:его|файл))?\s*[.!?]*$/iu.test(afterFileName)
      || /^\s*(?:[,.;]\s*|and\s+)overwrite(?:\s+(?:it|the\s+file|file))?\s*[.!?]*$/iu.test(afterFileName)
    ),
  };
}

function publicSelection(selection) {
  return {
    capability: selection.capability,
    serverId: selection.serverId,
    tool: selection.toolName,
    reason: selection.reason,
  };
}

export class OrchestratorAgent {
  constructor(registry) {
    this.registry = registry;
  }

  createRoutingPlan() {
    const selected = {
      search: this.registry.select("search"),
      rank: this.registry.select("rank"),
      details: this.registry.select("details"),
      createPlan: this.registry.select("createPlan"),
      savePlan: this.registry.select("savePlan"),
    };
    return {
      selected,
      publicPlan: [
        selected.search,
        selected.rank,
        selected.details,
        selected.createPlan,
        selected.savePlan,
      ].map(publicSelection),
    };
  }

  async run(request, { onEvent = () => {} } = {}) {
    const parsed = parseOrchestrationRequest(request);
    const { selected, publicPlan } = this.createRoutingPlan();
    const trace = [];
    onEvent({ type: "plan", parsed, routing: publicPlan });

    const execute = async (selection, input) => {
      const event = {
        step: trace.length + 1,
        status: "started",
        serverId: selection.serverId,
        tool: selection.toolName,
        selectedBecause: selection.reason,
        input,
      };
      trace.push(event);
      try {
        event.output = await this.registry.call(selection, input);
        event.status = "succeeded";
      } catch (error) {
        event.status = "failed";
        event.error = error instanceof Error ? error.message : "Unknown tool failure";
        onEvent({ type: "tool", ...event });
        throw new OrchestrationError(error.message, { trace, cause: error });
      }
      if (Buffer.byteLength(JSON.stringify(trace), "utf8") > MAX_TRACE_BYTES) {
        throw new OrchestrationError("Orchestration trace is too large", { trace });
      }
      onEvent({ type: "tool", ...event });
      return event.output;
    };

    const search = await execute(selected.search, {
      topic: parsed.topic,
      maxResults: Math.max(parsed.desiredCount, 5),
    });
    if (search.count !== search.resources.length) {
      throw new OrchestrationError("Search result count does not match resources", { trace });
    }
    if (
      search.topic !== parsed.topic
      || new Set(search.resources.map(({ id }) => id)).size !== search.resources.length
    ) {
      throw new OrchestrationError("Search result does not match its request", { trace });
    }
    if (!Array.isArray(search.resources) || search.resources.length === 0) {
      throw new OrchestrationError(
        `No learning resources found for topic: ${parsed.topic}`,
        { trace },
      );
    }

    const ranking = await execute(selected.rank, {
      resources: search.resources,
      desiredCount: parsed.desiredCount,
    });
    const selectedIds = new Set(ranking.selectedIds);
    const candidateIds = new Set(search.resources.map(({ id }) => id));
    if (
      ranking.candidateCount !== search.resources.length
      || ranking.selectedIds.length !== parsed.desiredCount
      || selectedIds.size !== ranking.selectedIds.length
      || ranking.selectedIds.some((id) => !candidateIds.has(id))
    ) {
      throw new OrchestrationError(
        "Ranking returned an invalid selection",
        { trace },
      );
    }
    const resources = [];
    for (const resourceId of ranking.selectedIds) {
      const resource = await execute(selected.details, { resourceId });
      if (resource.id !== resourceId) {
        throw new OrchestrationError(
          `Details response does not match requested resource: ${resourceId}`,
          { trace },
        );
      }
      resources.push(resource);
    }

    const plan = await execute(selected.createPlan, {
      topic: parsed.topic,
      resources,
    });
    const expectedMinutes = resources.reduce(
      (total, resource) => total + resource.durationMinutes,
      0,
    );
    if (
      plan.topic !== parsed.topic
      || plan.resourceCount !== resources.length
      || plan.totalMinutes !== expectedMinutes
    ) {
      throw new OrchestrationError("Plan response does not match its inputs", { trace });
    }
    const saved = await execute(selected.savePlan, {
      fileName: parsed.fileName,
      content: plan.markdown,
      overwrite: parsed.overwrite,
    });
    if (
      saved.fileName !== parsed.fileName
      || saved.bytes !== Buffer.byteLength(plan.markdown, "utf8")
    ) {
      throw new OrchestrationError("Save response does not match the plan", { trace });
    }

    return {
      request,
      parsed,
      registeredServers: this.registry.summary(),
      routingPlan: publicPlan,
      trace,
      result: {
        selectedResourceIds: ranking.selectedIds,
        totalMinutes: plan.totalMinutes,
        markdown: plan.markdown,
        saved,
      },
    };
  }
}
