import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("CLI errors never expose credentials from MCP_URL", () => {
  const sensitiveUrl = (
    "http://user:sentinel-password@127.0.0.1:invalid/"
    + "path-secret?token=query-secret"
  );
  const result = spawnSync(
    process.execPath,
    ["src/client.js", "--list", "--json"],
    {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      env: { ...process.env, MCP_URL: sensitiveUrl },
    },
  );

  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: false,
    error: "MCP_URL is invalid",
  });
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /sentinel|path-secret|query-secret/,
  );
});
