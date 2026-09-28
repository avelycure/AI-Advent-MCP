import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import {
  buildPlanningMcpServer,
  CREATE_PLAN_TOOL,
  RANK_RESOURCES_TOOL,
  SAVE_PLAN_TOOL,
} from "../src/mcp.js";

const resources = [
  {
    id: "advanced-lab",
    title: "Advanced lab",
    kind: "lab",
    difficulty: "advanced",
    summary: "Advanced work",
    matchedTerms: ["mcp"],
    relevanceScore: 8,
  },
  {
    id: "beginner-guide",
    title: "Beginner guide",
    kind: "guide",
    difficulty: "beginner",
    summary: "Start here",
    matchedTerms: ["mcp"],
    relevanceScore: 8,
  },
];

async function connect(t) {
  const outputDirectory = await mkdtemp(join(tmpdir(), "day20-planning-"));
  const server = buildPlanningMcpServer({ outputDirectory });
  const client = new Client({ name: "planning-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
    await rm(outputDirectory, { recursive: true, force: true });
  });
  return { client, outputDirectory };
}

test("planning server exposes ranking, creation and saving tools", async (t) => {
  const { client } = await connect(t);
  const { tools } = await client.listTools();

  assert.deepEqual(tools.map((tool) => tool.name), [
    RANK_RESOURCES_TOOL,
    CREATE_PLAN_TOOL,
    SAVE_PLAN_TOOL,
  ]);
  assert.equal(tools[0].annotations.readOnlyHint, true);
  assert.equal(tools[2].annotations.destructiveHint, true);
});

test("planning tools rank, create and safely save Markdown", async (t) => {
  const { client, outputDirectory } = await connect(t);
  const ranked = await client.callTool({
    name: RANK_RESOURCES_TOOL,
    arguments: { resources, desiredCount: 2 },
  });
  assert.deepEqual(ranked.structuredContent.selectedIds, [
    "beginner-guide",
    "advanced-lab",
  ]);

  const detailed = ranked.structuredContent.selectedIds.map((id) => ({
    ...resources.find((resource) => resource.id === id),
    durationMinutes: 30,
    topics: ["mcp"],
    modules: [`Complete ${id}`],
  }));
  const created = await client.callTool({
    name: CREATE_PLAN_TOOL,
    arguments: { topic: "MCP", resources: detailed },
  });
  assert.equal(created.structuredContent.totalMinutes, 60);
  assert.match(created.structuredContent.markdown, /Этап 1\. Beginner guide/);

  const saved = await client.callTool({
    name: SAVE_PLAN_TOOL,
    arguments: {
      fileName: "plan.md",
      content: created.structuredContent.markdown,
    },
  });
  assert.equal(saved.isError, undefined);
  assert.equal(
    await readFile(join(outputDirectory, "plan.md"), "utf8"),
    created.structuredContent.markdown,
  );

  const traversal = await client.callTool({
    name: SAVE_PLAN_TOOL,
    arguments: { fileName: "../escape.md", content: "bad" },
  });
  assert.equal(traversal.isError, true);

  const duplicate = await client.callTool({
    name: SAVE_PLAN_TOOL,
    arguments: { fileName: "plan.md", content: "replacement" },
  });
  assert.equal(duplicate.isError, true);
  assert.match(duplicate.content[0].text, /already exists/i);
});
