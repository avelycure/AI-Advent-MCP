import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import {
  buildMcpServer,
  PIPELINE_TOOL_NAME,
  SAVE_TO_FILE_TOOL_NAME,
  SEARCH_TOOL_NAME,
  SUMMARIZE_TOOL_NAME,
} from "../src/mcp.js";
import {
  PipelineStageError,
  ReportAlreadyExistsError,
  runSearchSummaryPipeline,
  saveToFile,
} from "../src/pipeline.js";

function repositorySearchResult() {
  return {
    query: "model context protocol",
    searchedAt: "2026-09-28T10:00:00.000Z",
    totalCount: 2,
    items: [
      {
        fullName: "example/alpha",
        description: "MCP tools with Unicode: привет",
        url: "https://github.com/example/alpha",
        language: "JavaScript",
        stars: 42,
        forks: 7,
        updatedAt: "2026-09-28T09:00:00Z",
      },
      {
        fullName: "example/beta",
        description: null,
        url: "https://github.com/example/beta",
        language: null,
        stars: 10,
        forks: 2,
        updatedAt: null,
      },
    ],
  };
}

async function temporaryDirectory(t) {
  const folder = await mkdtemp(join(tmpdir(), "ai-advent-pipeline-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return folder;
}

async function connect(options) {
  const server = buildMcpServer(options);
  const client = new Client({ name: "pipeline-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

test("primitive tools pass structured search data into summary and file", async (t) => {
  const outputDirectory = await temporaryDirectory(t);
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({
      total_count: 2,
      items: [
        {
          full_name: "example/alpha",
          private: false,
          description: "MCP tools\nwith whitespace",
          html_url: "https://github.com/example/alpha",
          language: "JavaScript",
          stargazers_count: 42,
          forks_count: 7,
          updated_at: "2026-09-28T09:00:00Z",
        },
        {
          full_name: "example/beta",
          private: false,
          description: null,
          html_url: "https://github.com/example/beta",
          language: null,
          stargazers_count: 10,
          forks_count: 2,
          updated_at: null,
        },
      ],
    }), { status: 200 });
  };
  const { client, server } = await connect({
    githubAuth: "test-token",
    fetchImpl,
    apiUrl: "https://api.github.test",
    outputDirectory,
  });
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const listed = await client.listTools();
  const searchTool = listed.tools.find((tool) => tool.name === SEARCH_TOOL_NAME);
  const saveTool = listed.tools.find(
    (tool) => tool.name === SAVE_TO_FILE_TOOL_NAME,
  );
  assert.equal(searchTool.annotations.readOnlyHint, true);
  assert.equal(saveTool.annotations.destructiveHint, true);

  const oversizedQuery = await client.callTool({
    name: SEARCH_TOOL_NAME,
    arguments: { query: "q".repeat(247) },
  });
  assert.equal(oversizedQuery.isError, true);
  assert.equal(requests.length, 0);

  const oversizedUtf8 = await client.callTool({
    name: SAVE_TO_FILE_TOOL_NAME,
    arguments: {
      fileName: "too-large.md",
      content: "💾".repeat(26_000),
    },
  });
  assert.equal(oversizedUtf8.isError, true);

  const searched = await client.callTool({
    name: SEARCH_TOOL_NAME,
    arguments: { query: "model context protocol", limit: 2 },
  });
  assert.equal(searched.isError, undefined);
  assert.equal(searched.structuredContent.items.length, 2);
  assert.equal(
    searched.structuredContent.items[0].description,
    "MCP tools with whitespace",
  );
  assert.equal(requests[0].url.pathname, "/search/repositories");
  assert.equal(
    requests[0].url.searchParams.get("q"),
    "model context protocol is:public",
  );
  assert.equal(requests[0].options.headers.Authorization, undefined);
  assert.ok(requests[0].options.signal instanceof AbortSignal);

  const summarized = await client.callTool({
    name: SUMMARIZE_TOOL_NAME,
    arguments: { searchResult: searched.structuredContent },
  });
  assert.equal(summarized.isError, undefined);
  assert.equal(summarized.structuredContent.itemCount, 2);
  assert.match(summarized.structuredContent.summary, /example\/alpha/);

  const saved = await client.callTool({
    name: SAVE_TO_FILE_TOOL_NAME,
    arguments: {
      fileName: "manual.md",
      content: summarized.structuredContent.summary,
    },
  });
  assert.equal(saved.isError, undefined);
  assert.equal(saved.structuredContent.fileName, "manual.md");
  assert.equal(
    await readFile(join(outputDirectory, "manual.md"), "utf8"),
    summarized.structuredContent.summary,
  );

  const automatic = await client.callTool({
    name: PIPELINE_TOOL_NAME,
    arguments: {
      query: "model context protocol",
      limit: 2,
      fileName: "automatic-defaults.md",
    },
  });
  assert.equal(automatic.isError, undefined);
  assert.deepEqual(
    automatic.structuredContent.stages.map((stage) => stage.tool),
    ["search", "summarize", "save_to_file"],
  );
  assert.equal(
    await readFile(join(outputDirectory, "automatic-defaults.md"), "utf8"),
    automatic.structuredContent.summary.summary,
  );
});

test("pipeline runs search -> summarize -> save with exact handoffs", async (t) => {
  const outputDirectory = await temporaryDirectory(t);
  const searchResult = repositorySearchResult();
  const summaryResult = {
    query: searchResult.query,
    itemCount: searchResult.items.length,
    summary: "# Exact summary\n\nPipeline handoff.\n",
  };
  const calls = [];
  const traceMessages = [];
  const searchImpl = async ({ token, query, limit, signal }) => {
    calls.push({ stage: "search", token, query, limit });
    assert.ok(signal instanceof AbortSignal);
    return searchResult;
  };
  const summarizeImpl = async (received) => {
    calls.push({ stage: "summarize", received });
    assert.deepEqual(received, searchResult);
    return summaryResult;
  };
  const saveImpl = async (arguments_) => {
    calls.push({ stage: "save_to_file", arguments_ });
    assert.equal(arguments_.content, summaryResult.summary);
    return saveToFile(arguments_);
  };
  const { client, server } = await connect({
    githubAuth: "test-token",
    outputDirectory,
    searchImpl,
    summarizeImpl,
    saveImpl,
    pipelineLogger: {
      log: (message) => traceMessages.push(message),
    },
  });
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: PIPELINE_TOOL_NAME,
    arguments: {
      query: searchResult.query,
      limit: 2,
      fileName: "automatic.md",
      trace: true,
    },
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(calls.map((call) => call.stage), [
    "search",
    "summarize",
    "save_to_file",
  ]);
  assert.deepEqual(result.structuredContent.search, searchResult);
  assert.deepEqual(result.structuredContent.summary, summaryResult);
  assert.deepEqual(
    result.structuredContent.stages.map((stage) => stage.tool),
    ["search", "summarize", "save_to_file"],
  );
  assert.deepEqual(
    traceMessages.map((message) => (
      message.match(/INPUT -> ([^\n]+)/)?.[1]
    )),
    ["search", "summarize", "save_to_file"],
  );
  assert.match(traceMessages[1], /"searchResult"/);
  assert.match(traceMessages[1], /example\/alpha/);
  assert.match(traceMessages[2], /# Exact summary/);
  assert.equal(
    await readFile(join(outputDirectory, "automatic.md"), "utf8"),
    summaryResult.summary,
  );

  calls.length = 0;
  const duplicate = await client.callTool({
    name: PIPELINE_TOOL_NAME,
    arguments: {
      query: searchResult.query,
      limit: 2,
      fileName: "automatic.md",
    },
  });
  assert.equal(duplicate.isError, true);
  assert.match(duplicate.content[0].text, /failed at save_to_file.*already exists/i);
  assert.deepEqual(calls.map((call) => call.stage), [
    "search",
    "summarize",
    "save_to_file",
  ]);
  assert.equal(
    await readFile(join(outputDirectory, "automatic.md"), "utf8"),
    summaryResult.summary,
  );
});

test("automatic pipeline saves a valid report for an empty search", async (t) => {
  const outputDirectory = await temporaryDirectory(t);
  const { client, server } = await connect({
    githubAuth: "test-token",
    outputDirectory,
    apiUrl: "https://api.github.test",
    fetchImpl: async () => new Response(JSON.stringify({
      total_count: 0,
      items: [],
    }), { status: 200 }),
  });
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: PIPELINE_TOOL_NAME,
    arguments: { query: "no matches", fileName: "empty.md" },
  });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.search.items.length, 0);
  assert.match(result.structuredContent.summary.summary, /No repositories matched/);
  assert.match(
    await readFile(join(outputDirectory, "empty.md"), "utf8"),
    /No repositories matched/,
  );
});

test("pipeline stops after the stage that failed", async () => {
  const events = [];
  const dependencies = {
    signal: new AbortController().signal,
    search: async () => {
      events.push("search");
      throw new Error("search failed");
    },
    summarize: async () => events.push("summarize"),
    save: async () => events.push("save_to_file"),
  };
  await assert.rejects(
    runSearchSummaryPipeline({
      query: "mcp",
      limit: 1,
      fileName: "failed.md",
      overwrite: false,
    }, dependencies),
    (error) => error instanceof PipelineStageError && error.stage === "search",
  );
  assert.deepEqual(events, ["search"]);

  events.length = 0;
  dependencies.search = async () => {
    events.push("search");
    return repositorySearchResult();
  };
  dependencies.summarize = async () => {
    events.push("summarize");
    throw new Error("summary failed");
  };
  await assert.rejects(
    runSearchSummaryPipeline({
      query: "mcp",
      limit: 1,
      fileName: "failed.md",
      overwrite: false,
    }, dependencies),
    (error) => (
      error instanceof PipelineStageError && error.stage === "summarize"
    ),
  );
  assert.deepEqual(events, ["search", "summarize"]);

  events.length = 0;
  const controller = new AbortController();
  dependencies.signal = controller.signal;
  dependencies.summarize = async () => {
    events.push("summarize");
    controller.abort();
    return {
      query: "mcp",
      itemCount: 1,
      summary: "must not be saved",
    };
  };
  await assert.rejects(
    runSearchSummaryPipeline({
      query: "mcp",
      limit: 1,
      fileName: "cancelled.md",
      overwrite: false,
    }, dependencies),
    (error) => error?.name === "AbortError",
  );
  assert.deepEqual(events, ["search", "summarize"]);
});

test("file saving rejects traversal and cannot follow an output symlink", async (t) => {
  const folder = await temporaryDirectory(t);
  const outputDirectory = join(folder, "reports");
  for (const fileName of [
    "../escape.md",
    "/tmp/escape.md",
    "nested/escape.md",
    "..\\escape.md",
    ".env",
    "report.json",
  ]) {
    await assert.rejects(
      saveToFile({ outputDirectory, fileName, content: "unsafe" }),
      TypeError,
    );
  }

  await mkdir(outputDirectory, { mode: 0o700 });
  const outside = join(folder, "outside.md");
  const destination = join(outputDirectory, "safe.md");
  await writeFile(outside, "sentinel", "utf8");
  await symlink(outside, destination);
  await saveToFile({
    outputDirectory,
    fileName: "safe.md",
    content: "replacement",
    overwrite: true,
  });
  assert.equal(await readFile(outside, "utf8"), "sentinel");
  assert.equal(await readFile(destination, "utf8"), "replacement");
  assert.equal((await stat(outputDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(destination)).mode & 0o777, 0o600);

  await assert.rejects(
    saveToFile({
      outputDirectory,
      fileName: "safe.md",
      content: "do not replace",
    }),
    ReportAlreadyExistsError,
  );
  assert.equal(await readFile(destination, "utf8"), "replacement");

  const sharedDirectory = join(folder, "shared");
  await mkdir(sharedDirectory, { mode: 0o755 });
  const modeBefore = (await stat(sharedDirectory)).mode & 0o777;
  await saveToFile({
    outputDirectory: sharedDirectory,
    fileName: "shared.md",
    content: "shared directory permissions stay unchanged",
  });
  assert.equal((await stat(sharedDirectory)).mode & 0o777, modeBefore);

  const realDirectory = join(folder, "real-reports");
  const linkedDirectory = join(folder, "linked-reports");
  await mkdir(realDirectory);
  await symlink(realDirectory, linkedDirectory);
  await assert.rejects(
    saveToFile({
      outputDirectory: linkedDirectory,
      fileName: "outside.md",
      content: "must not follow the report-root symlink",
    }),
    /real directory/,
  );
});

test("search never sends credentials or returns private repository data", async (t) => {
  const outputDirectory = await temporaryDirectory(t);
  const requests = [];
  const { client, server } = await connect({
    githubAuth: "must-not-leak",
    outputDirectory,
    apiUrl: "https://api.github.test",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response(JSON.stringify({
        total_count: 2,
        items: [
          {
            full_name: "private/secret",
            private: true,
            description: "secret description",
            html_url: "https://github.com/private/secret",
            language: "JavaScript",
            stargazers_count: 1,
            forks_count: 0,
            updated_at: "2026-09-28T09:00:00Z",
          },
          {
            full_name: "public/example",
            private: false,
            description: "public description",
            html_url: "https://github.com/public/example",
            language: "JavaScript",
            stargazers_count: 2,
            forks_count: 1,
            updated_at: "2026-09-28T09:00:00Z",
          },
        ],
      }), { status: 200 });
    },
  });
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: SEARCH_TOOL_NAME,
    arguments: { query: "is:private OR mcp", limit: 10 },
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(
    result.structuredContent.items.map((item) => item.fullName),
    ["public/example"],
  );
  assert.equal(requests[0].options.headers.Authorization, undefined);
  assert.doesNotMatch(JSON.stringify(result), /secret description|private\/secret/);
});
