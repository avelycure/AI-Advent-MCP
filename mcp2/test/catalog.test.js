import assert from "node:assert/strict";
import test from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import {
  buildCatalogMcpServer,
  RESOURCE_DETAILS_TOOL,
  SEARCH_RESOURCES_TOOL,
} from "../src/mcp.js";

async function connect(t) {
  const server = buildCatalogMcpServer();
  const client = new Client({ name: "catalog-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

test("catalog exposes discoverable search and detail tools", async (t) => {
  const client = await connect(t);
  const { tools } = await client.listTools();

  assert.deepEqual(tools.map((tool) => tool.name), [
    SEARCH_RESOURCES_TOOL,
    RESOURCE_DETAILS_TOOL,
  ]);
  assert.equal(tools[0].annotations.readOnlyHint, true);
});

test("search returns compact results and details expands an ID", async (t) => {
  const client = await connect(t);
  const search = await client.callTool({
    name: SEARCH_RESOURCES_TOOL,
    arguments: { topic: "MCP", maxResults: 3 },
  });

  assert.equal(search.isError, undefined);
  assert.equal(search.structuredContent.count, 3);
  assert.equal(search.structuredContent.resources[0].modules, undefined);
  assert.ok(search.structuredContent.resources[0].relevanceScore > 0);
  assert.deepEqual(search.structuredContent.resources[0].matchedTerms, ["mcp"]);

  const details = await client.callTool({
    name: RESOURCE_DETAILS_TOOL,
    arguments: { resourceId: search.structuredContent.resources[0].id },
  });
  assert.equal(details.isError, undefined);
  assert.ok(details.structuredContent.modules.length >= 3);

  const missing = await client.callTool({
    name: RESOURCE_DETAILS_TOOL,
    arguments: { resourceId: "does-not-exist" },
  });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /unknown resource/i);
});

test("search has a deterministic empty state", async (t) => {
  const client = await connect(t);
  const result = await client.callTool({
    name: SEARCH_RESOURCES_TOOL,
    arguments: { topic: "quantum-pottery", maxResults: 3 },
  });

  assert.deepEqual(result.structuredContent.resources, []);
  assert.equal(result.structuredContent.count, 0);
});
