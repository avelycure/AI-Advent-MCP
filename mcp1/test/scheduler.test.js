import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import {
  buildMcpServer,
  SCHEDULE_UPSERT_TOOL_NAME,
  SUMMARY_TOOL_NAME,
} from "../src/mcp.js";
import { GitHubStatsScheduler, MAX_TASKS } from "../src/scheduler.js";

function snapshot({ repositories, stars, python = 0 }) {
  return {
    generatedAt: new Date().toISOString(),
    repositories: {
      total: repositories,
      public: repositories,
      private: 0,
      forks: 0,
      archived: 0,
    },
    totals: {
      stars,
      forks: 0,
      openItems: 0,
      sizeKb: repositories * 10,
    },
    languages: { JavaScript: repositories - python, Python: python },
    topRepositories: [],
    rateLimit: { limit: 5000, remaining: 4999, resetAt: null },
  };
}

async function temporaryStore(t) {
  const folder = await mkdtemp(join(tmpdir(), "ai-advent-scheduler-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return join(folder, "state.json");
}

async function waitFor(check, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Timed out waiting for the scheduler");
}

test("scheduled history, latest result and delta survive a restart", async (t) => {
  const storePath = await temporaryStore(t);
  const snapshots = [
    snapshot({ repositories: 2, stars: 3, python: 0 }),
    snapshot({ repositories: 3, stars: 8, python: 1 }),
  ];
  const scheduler = new GitHubStatsScheduler({
    storePath,
    collectStats: async () => snapshots.shift(),
    minimumIntervalMinutes: 1,
  });
  await scheduler.start();

  await scheduler.upsertTask({
    taskId: "daily",
    intervalMinutes: 60,
    runImmediately: true,
    parameters: { visibility: "public", top: 5 },
  });
  await scheduler.runNow("daily");

  const beforeRestart = await scheduler.summary("daily", 10);
  assert.equal(beforeRestart.latest.stats.repositories.total, 3);
  assert.equal(beforeRestart.history.length, 2);
  assert.deepEqual(beforeRestart.delta.repositories, {
    archived: 0,
    forks: 0,
    private: 0,
    public: 1,
    total: 1,
  });
  assert.equal(beforeRestart.delta.totals.stars, 5);
  assert.equal(beforeRestart.delta.languages.Python, 1);
  await scheduler.stop();

  assert.equal((await stat(storePath)).mode & 0o777, 0o600);
  const restored = new GitHubStatsScheduler({
    storePath,
    collectStats: async () => {
      throw new Error("boom");
    },
    minimumIntervalMinutes: 1,
  });
  await restored.start();
  t.after(() => restored.stop());

  await restored.runNow("daily");
  const afterRestart = await restored.summary("daily", 2);
  assert.equal(afterRestart.task.parameters.visibility, "public");
  assert.equal(afterRestart.latest.stats.totals.stars, 8);
  assert.equal(afterRestart.history.length, 2);
  assert.equal(
    afterRestart.history[0].error,
    "GitHub statistics collection failed",
  );
});

test("background timer is recursive and never overlaps collections", async (t) => {
  const storePath = await temporaryStore(t);
  let calls = 0;
  let active = 0;
  let maximumActive = 0;
  const scheduler = new GitHubStatsScheduler({
    storePath,
    minimumIntervalMinutes: 1,
    millisecondsPerMinute: 10,
    collectStats: async () => {
      calls += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return snapshot({ repositories: calls, stars: calls });
    },
  });
  await scheduler.start();
  t.after(() => scheduler.stop());

  await scheduler.upsertTask({
    taskId: "fast-test",
    intervalMinutes: 1,
    runImmediately: false,
    parameters: { visibility: "public" },
  });
  await waitFor(() => calls >= 2);
  await scheduler.stop();

  assert.equal(maximumActive, 1);
  const report = await scheduler.summary("fast-test", 10);
  assert.ok(report.history.length >= 2);
});

test("a scheduled persist failure retries after bounded delay", async (t) => {
  const storePath = await temporaryStore(t);
  let calls = 0;
  let active = 0;
  let maximumActive = 0;
  let loggedFailure;
  const failureLogged = new Promise((resolve) => {
    loggedFailure = resolve;
  });
  const scheduler = new GitHubStatsScheduler({
    storePath,
    minimumIntervalMinutes: 1,
    millisecondsPerMinute: 100,
    retryDelayMs: 50,
    maxRetryDelayMs: 50,
    logger: { error: () => loggedFailure() },
    collectStats: async () => {
      calls += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        if (calls === 1) {
          await rm(storePath);
          await mkdir(storePath);
        }
        return snapshot({ repositories: calls, stars: calls });
      } finally {
        active -= 1;
      }
    },
  });
  await scheduler.start();
  await scheduler.upsertTask({
    taskId: "retry-storage",
    intervalMinutes: 1,
    runImmediately: false,
    parameters: { visibility: "public" },
  });

  await failureLogged;
  assert.equal(calls, 1);
  await rm(storePath, { recursive: true });
  await waitFor(async () => (
    (await scheduler.summary("retry-storage", 10)).history.length === 1
  ));
  await scheduler.stop();

  assert.equal(calls, 2);
  assert.equal(maximumActive, 1);
  const persisted = JSON.parse(await readFile(storePath, "utf8"));
  assert.equal(persisted.tasks[0].history.length, 1);
});

test("a task that missed several intervals is coalesced into one restart run", async (t) => {
  const storePath = await temporaryStore(t);
  let current = new Date("2026-09-28T10:00:00.000Z");
  const initial = new GitHubStatsScheduler({
    storePath,
    now: () => current,
    collectStats: async () => snapshot({ repositories: 1, stars: 1 }),
  });
  await initial.start();
  await initial.upsertTask({
    taskId: "overdue",
    intervalMinutes: 5,
    runImmediately: false,
    parameters: { visibility: "public" },
  });
  await initial.stop();

  current = new Date("2026-09-28T10:30:00.000Z");
  let calls = 0;
  const restarted = new GitHubStatsScheduler({
    storePath,
    now: () => current,
    collectStats: async () => {
      calls += 1;
      return snapshot({ repositories: calls, stars: calls });
    },
  });
  await restarted.start();
  await waitFor(() => calls === 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await restarted.stop();

  assert.equal(calls, 1);
  assert.equal((await restarted.summary("overdue", 10)).history.length, 1);
});

test("history retention is bounded and corrupt JSON fails closed", async (t) => {
  const storePath = await temporaryStore(t);
  let calls = 0;
  const scheduler = new GitHubStatsScheduler({
    storePath,
    maxHistoryEntries: 3,
    minimumIntervalMinutes: 1,
    collectStats: async () => snapshot({
      repositories: ++calls,
      stars: calls,
    }),
  });
  await scheduler.start();
  await scheduler.upsertTask({
    taskId: "bounded",
    intervalMinutes: 60,
    runImmediately: true,
    parameters: { visibility: "public" },
  });
  for (let index = 0; index < 4; index += 1) {
    await scheduler.runNow("bounded");
  }
  assert.equal((await scheduler.summary("bounded", 50)).history.length, 3);
  await scheduler.stop();

  await writeFile(storePath, "not JSON", "utf8");
  const corrupt = new GitHubStatsScheduler({
    storePath,
    collectStats: async () => snapshot({ repositories: 1, stars: 1 }),
  });
  await assert.rejects(corrupt.start(), SyntaxError);
  assert.equal(await readFile(storePath, "utf8"), "not JSON");
});

test("stop aborts and flushes an active collection", async (t) => {
  const storePath = await temporaryStore(t);
  let collectionStarted;
  const started = new Promise((resolve) => {
    collectionStarted = resolve;
  });
  const scheduler = new GitHubStatsScheduler({
    storePath,
    collectStats: (_parameters, { signal }) => new Promise((resolve, reject) => {
      collectionStarted();
      signal.addEventListener("abort", () => reject(new Error("aborted")), {
        once: true,
      });
    }),
  });
  await scheduler.start();

  const update = scheduler.upsertTask({
    taskId: "shutdown",
    intervalMinutes: 60,
    runImmediately: true,
    parameters: { visibility: "public" },
  });
  await started;
  await scheduler.stop();
  await update;

  const report = await scheduler.summary("shutdown", 10);
  assert.equal(report.history.length, 1);
  assert.equal(report.history[0].ok, false);
  assert.equal(report.history[0].error, "GitHub statistics collection failed");
});

test("stop prevents a queued immediate collection from starting", async (t) => {
  const storePath = await temporaryStore(t);
  let firstStarted;
  const started = new Promise((resolve) => {
    firstStarted = resolve;
  });
  let calls = 0;
  const scheduler = new GitHubStatsScheduler({
    storePath,
    collectStats: (_parameters, { signal }) => new Promise((resolve, reject) => {
      calls += 1;
      firstStarted();
      signal.addEventListener("abort", () => reject(new Error("aborted")), {
        once: true,
      });
    }),
  });
  await scheduler.start();

  const first = scheduler.upsertTask({
    taskId: "first",
    intervalMinutes: 60,
    runImmediately: true,
    parameters: { visibility: "public" },
  });
  await started;
  const queued = scheduler.upsertTask({
    taskId: "queued",
    intervalMinutes: 60,
    runImmediately: true,
    parameters: { visibility: "public" },
  });
  const stopping = scheduler.stop();
  const [, queuedResult, stopResult] = await Promise.allSettled([
    first,
    queued,
    stopping,
  ]);

  assert.equal(calls, 1);
  assert.equal(queuedResult.status, "rejected");
  assert.equal(stopResult.status, "fulfilled");
});

test("a failed atomic write does not publish the candidate state", async (t) => {
  const storePath = await temporaryStore(t);
  const scheduler = new GitHubStatsScheduler({
    storePath,
    collectStats: async () => snapshot({ repositories: 1, stars: 1 }),
  });
  await scheduler.start();
  await mkdir(storePath);

  await assert.rejects(scheduler.upsertTask({
    taskId: "failed",
    intervalMinutes: 60,
    runImmediately: false,
    parameters: { visibility: "public" },
  }));
  await assert.rejects(scheduler.summary("failed", 10), /does not exist/);

  await rm(storePath, { recursive: true });
  await scheduler.upsertTask({
    taskId: "later",
    intervalMinutes: 60,
    runImmediately: false,
    parameters: { visibility: "public" },
  });
  const persisted = JSON.parse(await readFile(storePath, "utf8"));
  assert.deepEqual(persisted.tasks.map((task) => task.id), ["later"]);
  await scheduler.stop();
});

test("an immediate create and its first run commit atomically", async (t) => {
  const storePath = await temporaryStore(t);
  const scheduler = new GitHubStatsScheduler({
    storePath,
    collectStats: async () => {
      await mkdir(storePath);
      return snapshot({ repositories: 1, stars: 1 });
    },
  });
  await scheduler.start();

  await assert.rejects(scheduler.upsertTask({
    taskId: "partial",
    intervalMinutes: 60,
    runImmediately: true,
    parameters: { visibility: "public" },
  }));
  await assert.rejects(scheduler.summary("partial", 10), /does not exist/);

  await rm(storePath, { recursive: true });
  await scheduler.stop();
});

test("MCP tools create a schedule and return its persisted summary", async (t) => {
  const storePath = await temporaryStore(t);
  const received = [];
  const scheduler = new GitHubStatsScheduler({
    storePath,
    collectStats: async (parameters) => {
      received.push(parameters);
      return snapshot({ repositories: 4, stars: 12, python: 2 });
    },
  });
  await scheduler.start();
  t.after(() => scheduler.stop());

  const server = buildMcpServer({ scheduler });
  const client = new Client({ name: "scheduler-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const listed = await client.listTools();
  const upsertTool = listed.tools.find(
    (tool) => tool.name === SCHEDULE_UPSERT_TOOL_NAME,
  );
  assert.equal(upsertTool.annotations.destructiveHint, true);
  assert.equal(upsertTool.inputSchema.properties.intervalMinutes.minimum, 5);

  const tooFrequent = await client.callTool({
    name: SCHEDULE_UPSERT_TOOL_NAME,
    arguments: { taskId: "unsafe", intervalMinutes: 1 },
  });
  assert.equal(tooFrequent.isError, true);
  assert.equal(received.length, 0);

  const created = await client.callTool({
    name: SCHEDULE_UPSERT_TOOL_NAME,
    arguments: {
      taskId: "work",
      intervalMinutes: 15,
      visibility: "public",
      top: 3,
    },
  });
  assert.equal(created.isError, undefined);
  assert.equal(created.structuredContent.task.id, "work");
  assert.equal(received.length, 1);
  assert.equal(received[0].visibility, "public");
  assert.equal(received[0].top, 3);

  const report = await client.callTool({
    name: SUMMARY_TOOL_NAME,
    arguments: { taskId: "work", historyLimit: 5 },
  });
  assert.equal(report.isError, undefined);
  assert.equal(report.structuredContent.latest.stats.repositories.total, 4);
  assert.equal(report.structuredContent.history.length, 1);
  assert.equal(report.structuredContent.delta, null);

  for (let index = 1; index < MAX_TASKS; index += 1) {
    await scheduler.upsertTask({
      taskId: `extra-${index}`,
      intervalMinutes: 15,
      enabled: false,
      runImmediately: false,
      parameters: { visibility: "public" },
    });
  }
  const overLimit = await client.callTool({
    name: SCHEDULE_UPSERT_TOOL_NAME,
    arguments: {
      taskId: "twenty-first",
      intervalMinutes: 15,
      enabled: false,
    },
  });
  assert.equal(overLimit.isError, true);
  assert.match(overLimit.content[0].text, /at most 20 tasks/);
  assert.doesNotMatch(overLimit.content[0].text, /Unable to save/);
  const persisted = JSON.parse(await readFile(storePath, "utf8"));
  assert.equal(persisted.tasks.length, MAX_TASKS);
  assert.equal(
    persisted.tasks.some((task) => task.id === "twenty-first"),
    false,
  );
});
