import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  connectHttpToolRegistry,
  OrchestratorAgent,
} from "../src/orchestrator.js";

const catalogServerPath = fileURLToPath(
  new URL("../../mcp2/src/server.js", import.meta.url),
);
const planningServerPath = fileURLToPath(
  new URL("../src/server.js", import.meta.url),
);

function startServer(scriptPath, env, prefix) {
  const child = spawn(process.execPath, [scriptPath], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = createInterface({ input: child.stdout });
  const url = new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out waiting for ${prefix}`)),
      5_000,
    );
    output.once("line", (line) => {
      clearTimeout(timeout);
      resolve(new URL(line.replace(prefix, "")));
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`${prefix} exited early with code ${code}`));
    });
  });
  return { child, url };
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
}

test("HTTP orchestration registers both processes and saves the final result", async (t) => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "day20-http-"));
  const catalog = startServer(
    catalogServerPath,
    { MCP_CATALOG_PORT: "0" },
    "Catalog MCP server listening on ",
  );
  const planning = startServer(
    planningServerPath,
    { MCP_PLANNING_PORT: "0", MCP_PLAN_OUTPUT_DIR: outputDirectory },
    "Planning MCP server listening on ",
  );
  t.after(async () => {
    await Promise.all([stopServer(catalog.child), stopServer(planning.child)]);
    await rm(outputDirectory, { recursive: true, force: true });
  });

  const registry = await connectHttpToolRegistry([
    { id: "catalog", url: (await catalog.url).href },
    { id: "planning", url: (await planning.url).href },
  ]);
  t.after(() => registry.close());
  const result = await new OrchestratorAgent(registry).run(
    "Подбери 2 ресурса по теме MCP, составь план и сохрани его в http-plan.md",
  );

  assert.deepEqual(
    result.trace.map(({ serverId, tool, status }) => `${serverId}.${tool}:${status}`),
    [
      "catalog.search_learning_resources:succeeded",
      "planning.rank_learning_resources:succeeded",
      "catalog.get_resource_details:succeeded",
      "catalog.get_resource_details:succeeded",
      "planning.create_learning_plan:succeeded",
      "planning.save_learning_plan:succeeded",
    ],
  );
  assert.deepEqual(
    result.trace.slice(2, 4).map(({ input }) => input.resourceId),
    result.trace[1].output.selectedIds,
  );
  assert.equal(result.trace[5].input.content, result.trace[4].output.markdown);
  assert.equal(
    await readFile(join(outputDirectory, "http-plan.md"), "utf8"),
    result.result.markdown,
  );
});
