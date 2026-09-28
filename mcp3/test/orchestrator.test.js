import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { buildCatalogMcpServer } from "../../mcp2/src/mcp.js";
import { buildPlanningMcpServer } from "../src/mcp.js";
import {
  connectHttpToolRegistry,
  OrchestrationError,
  OrchestratorAgent,
  parseOrchestrationRequest,
  ToolRegistry,
} from "../src/orchestrator.js";

async function connectServer(t, id, server) {
  const client = new Client({ name: `${id}-test-client`, version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  return { id, client };
}

async function orchestrationFixture(t) {
  const outputDirectory = await mkdtemp(join(tmpdir(), "day20-orchestrator-"));
  t.after(() => rm(outputDirectory, { recursive: true, force: true }));
  const catalog = await connectServer(t, "catalog", buildCatalogMcpServer());
  const planning = await connectServer(
    t,
    "planning",
    buildPlanningMcpServer({ outputDirectory }),
  );
  const registry = await ToolRegistry.fromClients([catalog, planning]);
  return { registry, outputDirectory };
}

test("agent routes a seven-call flow across two discovered MCP servers", async (t) => {
  const { registry, outputDirectory } = await orchestrationFixture(t);
  const agent = new OrchestratorAgent(registry);
  const request = (
    "Подбери 3 учебных ресурса по теме MCP, ранжируй их, изучи детали каждого, "
    + "составь практический план обучения и сохрани его в test-plan.md"
  );

  const result = await agent.run(request);

  assert.deepEqual(result.registeredServers, [
    {
      serverId: "catalog",
      tools: ["search_learning_resources", "get_resource_details"],
    },
    {
      serverId: "planning",
      tools: [
        "rank_learning_resources",
        "create_learning_plan",
        "save_learning_plan",
      ],
    },
  ]);
  assert.deepEqual(
    result.trace.map(({ serverId, tool }) => `${serverId}.${tool}`),
    [
      "catalog.search_learning_resources",
      "planning.rank_learning_resources",
      "catalog.get_resource_details",
      "catalog.get_resource_details",
      "catalog.get_resource_details",
      "planning.create_learning_plan",
      "planning.save_learning_plan",
    ],
  );

  assert.deepEqual(
    result.trace.slice(2, 5).map(({ input }) => input.resourceId),
    result.trace[1].output.selectedIds,
  );
  assert.deepEqual(
    result.trace[5].input.resources.map(({ id }) => id),
    result.trace[1].output.selectedIds,
  );
  assert.equal(result.trace[6].input.content, result.trace[5].output.markdown);
  assert.equal(result.trace[6].input.overwrite, false);
  assert.equal(
    await readFile(join(outputDirectory, "test-plan.md"), "utf8"),
    result.result.markdown,
  );
});

test("unrelated or empty-result requests stop before downstream tools", async (t) => {
  const { registry } = await orchestrationFixture(t);
  const agent = new OrchestratorAgent(registry);

  assert.throws(
    () => parseOrchestrationRequest("Какая сегодня погода?"),
    OrchestrationError,
  );

  await assert.rejects(
    agent.run(
      "Подбери 3 ресурса по теме quantum-pottery, составь план и сохрани его в empty.md",
    ),
    (error) => {
      assert.match(error.message, /no learning resources/i);
      assert.deepEqual(error.trace.map(({ tool }) => tool), [
        "search_learning_resources",
      ]);
      return true;
    },
  );
});

test("parser handles punctuation, English actions and overwrite intent", () => {
  assert.deepEqual(
    parseOrchestrationRequest(
      "Подбери 3 ресурса по теме MCP. Составь план и сохрани его в punctuation.md",
    ),
    {
      topic: "MCP",
      desiredCount: 3,
      fileName: "punctuation.md",
      overwrite: false,
    },
  );
  assert.deepEqual(
    parseOrchestrationRequest(
      "Find 2 resources about MCP, rank them, create a plan and save it to english.md and overwrite",
    ),
    {
      topic: "MCP",
      desiredCount: 2,
      fileName: "english.md",
      overwrite: true,
    },
  );
  assert.throws(
    () => parseOrchestrationRequest(
      "Подбери 2 ресурса по теме MCP, составь план и сохрани его в PLAN.MD",
    ),
    /lowercase \.md/i,
  );
  assert.equal(
    parseOrchestrationRequest(
      "Подбери 1 ресурс по теме overwrite safety, составь план и сохрани его в safe.md",
    ).overwrite,
    false,
  );
  assert.equal(
    parseOrchestrationRequest(
      "Подбери 1 ресурс по теме MCP, составь план, но не overwrite файл и сохрани его в safe.md",
    ).overwrite,
    false,
  );
  assert.deepEqual(
    parseOrchestrationRequest(
      "Find 2 resources about file creation and overwrite safety, create a plan and save it to existing.md",
    ),
    {
      topic: "file creation and overwrite safety",
      desiredCount: 2,
      fileName: "existing.md",
      overwrite: false,
    },
  );
});

test("ranking keeps cross-server relevance ahead of difficulty", async (t) => {
  const { registry } = await orchestrationFixture(t);
  const result = await new OrchestratorAgent(registry).run(
    "Подбери 1 ресурс по теме MCP orchestration, составь план и сохрани его в relevant.md",
  );

  assert.deepEqual(result.result.selectedResourceIds, ["mcp-orchestration"]);
});

test("malformed rank output is traced and cannot fan out detail calls", async (t) => {
  const { registry } = await orchestrationFixture(t);
  const rankClient = registry.byName.get("rank_learning_resources").client;
  const originalCallTool = rankClient.callTool.bind(rankClient);
  rankClient.callTool = async (request, options) => {
    if (request.name === "rank_learning_resources") {
      return {
        content: [{ type: "text", text: "malformed" }],
        structuredContent: {
          candidateCount: 4,
          selectedIds: Array.from({ length: 20 }, (_, index) => `resource-${index}`),
          rationale: "malicious fan-out",
        },
      };
    }
    return originalCallTool(request, options);
  };

  await assert.rejects(
    new OrchestratorAgent(registry).run(
      "Подбери 1 ресурс по теме MCP, составь план и сохрани его в malformed.md",
    ),
    (error) => {
      assert.match(error.message, /invalid structuredcontent/i);
      assert.deepEqual(error.trace.map(({ tool, status }) => [tool, status]), [
        ["search_learning_resources", "succeeded"],
        ["rank_learning_resources", "failed"],
      ]);
      return true;
    },
  );
});

test("selection rejects tools with unsupported required inputs", async () => {
  const registry = await ToolRegistry.fromClients([{
    id: "distractor",
    client: {
      listTools: async () => ({
        tools: [{
          name: "search_learning_resources_for_tenant",
          description: "Search learning resources",
          inputSchema: {
            type: "object",
            properties: {
              topic: { type: "string" },
              maxResults: { type: "number" },
              tenantId: { type: "string" },
            },
            required: ["topic", "tenantId"],
          },
        }],
      }),
      close: async () => {},
    },
  }]);

  assert.throws(() => registry.select("search"), /no discovered tool/i);
});

test("HTTP registration only accepts exact IPv4 loopback MCP URLs", async () => {
  await assert.rejects(
    connectHttpToolRegistry([{ id: "remote", url: "http://169.254.169.254/mcp" }]),
    /exact loopback/i,
  );
  await assert.rejects(
    connectHttpToolRegistry([{ id: "redirect", url: "http://127.0.0.1:3102/elsewhere" }]),
    /exact loopback/i,
  );
});

test("registry rejects duplicate tool ownership", async (t) => {
  const first = await connectServer(t, "catalog-a", buildCatalogMcpServer());
  const second = await connectServer(t, "catalog-b", buildCatalogMcpServer());

  await assert.rejects(
    ToolRegistry.fromClients([first, second]),
    /ambiguous tool search_learning_resources/i,
  );
});
