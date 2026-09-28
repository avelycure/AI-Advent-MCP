import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { fileURLToPath } from "node:url";

const PIPELINE_TOOL = "search_summary_pipeline";

function reportFileName(query) {
  const slug = query
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return `${slug || "github-search"}-report.md`;
}

export function parsePipelineCommand(command) {
  const normalized = String(command).replace(/\s+/g, " ").trim();
  const count = normalized.match(/найти\s+(\d+)/iu);
  const topic = normalized.match(
    /по\s+теме\s+(.+?)(?:,\s*|\s+)сделать\s+markdown[- ]отч[её]т/iu,
  );
  const destination = normalized.match(
    /сохранить\s+его\s+в\s+файл(?:\s+([A-Za-z0-9][A-Za-z0-9._-]{0,120}\.(?:md|txt)))?[.!?]*$/iu,
  );
  if (
    !count
    || !topic
    || !destination
    || !/публичн/iu.test(normalized)
    || !/github[- ]репозитор/iu.test(normalized)
  ) {
    throw new Error(
      "Не удалось распознать задачу. Ожидается: «найти N публичных "
      + "GitHub-репозиториев по теме ..., сделать Markdown-отчёт и сохранить "
      + "его в файл».",
    );
  }

  const limit = Number.parseInt(count[1], 10);
  if (limit < 1 || limit > 10) {
    throw new Error("Количество репозиториев должно быть от 1 до 10.");
  }
  const query = topic[1].trim().replace(/^["'«]|["'»]$/g, "");
  if (!query) throw new Error("Тема поиска не должна быть пустой.");

  return {
    query,
    limit,
    fileName: destination[1] ?? reportFileName(query),
    overwrite: true,
    trace: true,
  };
}

function resultOrThrow(result) {
  if (!result?.isError && result?.structuredContent) {
    return result.structuredContent;
  }
  const message = result?.content?.find((block) => block.type === "text")?.text;
  throw new Error(message ?? "MCP pipeline returned an error");
}

export async function runPipelineCommand({
  client,
  command,
  write = console.log,
}) {
  const arguments_ = parsePipelineCommand(command);
  write(`Команда пользователя: ${command}`);
  write("");
  write("Распознана задача:");
  write(`  1. Найти публичные GitHub-репозитории: ${arguments_.query}`);
  write(`  2. Взять первые ${arguments_.limit} результатов`);
  write("  3. Преобразовать результаты в Markdown");
  write(`  4. Сохранить отчёт в reports/${arguments_.fileName}`);
  write("");
  write(`Запускаем MCP-инструмент ${PIPELINE_TOOL}...`);

  const result = resultOrThrow(await client.callTool({
    name: PIPELINE_TOOL,
    arguments: arguments_,
  }));

  write("");
  write("Пайплайн завершён:");
  for (const stage of result.stages) {
    write(`  ✓ ${stage.tool}: ${JSON.stringify(stage.produced)}`);
  }
  write(`  ✓ Итоговый файл: reports/${result.saved.fileName}`);
  write(`  ✓ Размер: ${result.saved.bytes} байт`);
  write("");
  write("Полные входы стадий напечатаны в терминале MCP-сервера (trace=true). ");

  return result;
}

async function main() {
  const command = process.argv.slice(2).join(" ").trim();
  if (!command) {
    throw new Error("Передайте задачу одной строкой после --.");
  }

  const serverUrl = new URL(
    process.env.MCP_URL ?? "http://127.0.0.1:3000/mcp",
  );
  const client = new Client({
    name: "ai-advent-natural-language-pipeline",
    version: "1.0.0",
  });
  try {
    await client.connect(new StreamableHTTPClientTransport(serverUrl));
    await runPipelineCommand({ client, command });
  } finally {
    await client.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Ошибка: ${error.message}`);
    process.exitCode = 1;
  });
}
