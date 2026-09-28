import assert from "node:assert/strict";
import test from "node:test";

import {
  parsePipelineCommand,
  runPipelineCommand,
} from "../src/pipeline-cli.js";

const naturalLanguageTask = (
  "найти 3 публичных GitHub-репозитория по теме model context protocol, "
  + "сделать Markdown-отчёт и сохранить его в файл"
);

test("parses the Day 19 natural-language task into pipeline arguments", () => {
  assert.deepEqual(parsePipelineCommand(naturalLanguageTask), {
    query: "model context protocol",
    limit: 3,
    fileName: "model-context-protocol-report.md",
    overwrite: true,
    trace: true,
  });
  assert.throws(
    () => parsePipelineCommand("просто найди что-нибудь"),
    /Не удалось распознать задачу/,
  );
  assert.throws(
    () => parsePipelineCommand(naturalLanguageTask.replace("3", "11")),
    /от 1 до 10/,
  );
});

test("natural-language command launches the composed MCP pipeline", async () => {
  const requests = [];
  const client = {
    callTool: async (request) => {
      requests.push(request);
      return {
        structuredContent: {
          stages: [
            { tool: "search", produced: { itemCount: 3 } },
            { tool: "summarize", produced: { bytes: 320 } },
            { tool: "save_to_file", produced: { bytes: 320 } },
          ],
          saved: {
            fileName: "model-context-protocol-report.md",
            bytes: 320,
          },
        },
      };
    },
  };
  const lines = [];

  await runPipelineCommand({
    client,
    command: naturalLanguageTask,
    write: (line) => lines.push(line),
  });

  assert.deepEqual(requests, [
    {
      name: "search_summary_pipeline",
      arguments: {
        query: "model context protocol",
        limit: 3,
        fileName: "model-context-protocol-report.md",
        overwrite: true,
        trace: true,
      },
    },
  ]);
  const terminal = lines.join("\n");
  assert.match(terminal, /Распознана задача/);
  assert.match(terminal, /Запускаем MCP-инструмент search_summary_pipeline/);
  assert.match(terminal, /✓ search/);
  assert.match(terminal, /reports\/model-context-protocol-report\.md/);
});
