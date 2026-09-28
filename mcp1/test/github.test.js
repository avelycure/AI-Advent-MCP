import assert from "node:assert/strict";
import test from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { buildMcpServer, GITHUB_TOOL_NAME } from "../src/mcp.js";

function repository(name, changes = {}) {
  return {
    full_name: `avelycure/${name}`,
    owner: { login: "avelycure" },
    private: false,
    fork: false,
    archived: false,
    language: "JavaScript",
    stargazers_count: 0,
    forks_count: 0,
    open_issues_count: 0,
    size: 100,
    html_url: `https://github.com/avelycure/${name}`,
    updated_at: "2026-09-28T00:00:00Z",
    ...changes,
  };
}

test("MCP tool describes its input and returns paginated GitHub statistics", async () => {
  const requests = [];
  const pages = [
    [
      repository("alpha", { stargazers_count: 3, forks_count: 1 }),
      repository("fork", { fork: true, language: "Python" }),
    ],
    [
      repository("private", {
        private: true,
        archived: true,
        language: null,
        open_issues_count: 2,
      }),
    ],
  ];
  const fetchImpl = async (url, options) => {
    requests.push({ url, headers: options.headers, signal: options.signal });
    const page = requests.length;
    return new Response(JSON.stringify(pages[page - 1]), {
      status: 200,
      headers: {
        link: page === 1
          ? '<https://api.github.test/user/repos?page=2>; rel="next"'
          : "",
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": "4998",
        "x-ratelimit-reset": "1790553600",
      },
    });
  };

  const server = buildMcpServer({
    githubAuth: "test-token",
    fetchImpl,
    apiUrl: "https://api.github.test",
  });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const listed = await client.listTools();
    assert.equal(listed.tools.length, 8);
    const githubTool = listed.tools.find(
      (tool) => tool.name === GITHUB_TOOL_NAME,
    );
    assert.ok(githubTool);
    assert.equal(client.getServerVersion().name, "ai-advent-mcp-server");
    assert.deepEqual(
      githubTool.inputSchema.properties.visibility.enum,
      ["all", "public", "private"],
    );
    assert.equal(
      githubTool.inputSchema.properties.includeForks.description,
      "Whether repositories forked from other projects are included.",
    );

    const called = await client.callTool({
      name: GITHUB_TOOL_NAME,
      arguments: {
        visibility: "all",
        includeForks: false,
        includeArchived: true,
        top: 2,
      },
    });

    assert.equal(called.isError, undefined);
    assert.equal(called.structuredContent.repositories.total, 2);
    assert.equal(called.structuredContent.repositories.private, 1);
    assert.equal(called.structuredContent.totals.stars, 3);
    assert.equal(called.structuredContent.totals.openItems, 2);
    assert.deepEqual(called.structuredContent.languages, {
      JavaScript: 1,
      Unknown: 1,
    });
    assert.equal(called.structuredContent.topRepositories.length, 2);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].headers.Authorization, "Bearer test-token");
    assert.equal(requests[0].headers["X-GitHub-Api-Version"], "2026-03-10");
    assert.equal(requests[0].url.origin, "https://api.github.test");
    assert.ok(requests[0].signal instanceof AbortSignal);
  } finally {
    await client.close();
    await server.close();
  }
});

test("pagination never forwards the token to another origin", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return new Response("[]", {
      status: 200,
      headers: {
        link: '<https://attacker.example/repos?page=2>; rel="next"',
      },
    });
  };

  const server = buildMcpServer({
    githubAuth: "must-not-leak",
    fetchImpl,
    apiUrl: "https://api.github.test",
  });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const called = await client.callTool({
      name: GITHUB_TOOL_NAME,
      arguments: {},
    });

    assert.equal(called.isError, true);
    assert.match(called.content[0].text, /unexpected origin/);
    assert.equal(requests.length, 1);
  } finally {
    await client.close();
    await server.close();
  }
});
