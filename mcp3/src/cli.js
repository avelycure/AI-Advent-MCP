import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";

import {
  connectHttpToolRegistry,
  OrchestrationError,
  OrchestratorAgent,
} from "./orchestrator.js";

const jsonOutput = process.argv.includes("--json");
const requestParts = process.argv.slice(2).filter((argument) => argument !== "--json");
const configuredServers = JSON.parse(await readFile(
  new URL("../config/servers.json", import.meta.url),
  "utf8",
));
const urlOverrides = {
  catalog: process.env.MCP_CATALOG_URL,
  planning: process.env.MCP_PLANNING_URL,
};
const servers = configuredServers.map((server) => ({
  ...server,
  url: urlOverrides[server.id] ?? server.url,
}));

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

async function readUserRequest() {
  const commandLineRequest = requestParts.join(" ").trim();
  if (commandLineRequest) return commandLineRequest;
  if (jsonOutput) {
    throw new OrchestrationError(
      "Pass the request as a command argument when using --json",
    );
  }

  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const request = await terminal.question(
      "\nВведите текстовую команду для агента и нажмите Enter:\n> ",
    );
    if (!request.trim()) {
      throw new OrchestrationError("Текстовая команда не должна быть пустой");
    }
    return request.trim();
  } finally {
    terminal.close();
  }
}

function printEvent(event) {
  if (jsonOutput) return;
  if (event.type === "plan") {
    console.log("\nАГЕНТ ПОСТРОИЛ МАРШРУТ:");
    event.routing.forEach((stage, index) => {
      console.log(
        `${index + 1}. ${stage.serverId}.${stage.tool} — ${stage.reason}`,
      );
    });
    return;
  }
  console.log(`\nШАГ ${event.step}: ${event.serverId}.${event.tool}`);
  console.log(`Статус: ${event.status}`);
  console.log(`Почему выбран: ${event.selectedBecause}`);
  console.log("Вход:");
  printJson(event.input);
  if (event.status === "failed") {
    console.log(`Ошибка: ${event.error}`);
    return;
  }
  console.log("Результат:");
  printJson(event.output);
}

let registry;
try {
  registry = await connectHttpToolRegistry(servers);
  if (!jsonOutput) {
    console.log("ЗАРЕГИСТРИРОВАННЫЕ MCP-СЕРВЕРЫ:");
    registry.summary().forEach(({ serverId, tools }) => {
      console.log(`- ${serverId}: ${tools.join(", ")}`);
    });
  }

  const request = await readUserRequest();
  if (!jsonOutput) console.log(`\nЗАПРОС ПОЛЬЗОВАТЕЛЯ:\n${request}`);

  const agent = new OrchestratorAgent(registry);
  const result = await agent.run(request, { onEvent: printEvent });
  if (jsonOutput) {
    printJson({ ok: true, ...result });
  } else {
    console.log("\nИТОГ:");
    console.log(`Файл: ${result.result.saved.outputPath}`);
    console.log(`Ресурсы: ${result.result.selectedResourceIds.join(", ")}`);
    console.log(`Общее время: ${result.result.totalMinutes} минут`);
    console.log("\nСОДЕРЖИМОЕ СОХРАНЁННОГО ПЛАНА:\n");
    console.log(result.result.markdown);
  }
} catch (error) {
  const message = error instanceof OrchestrationError
    ? error.message
    : "Unexpected orchestration failure";
  if (jsonOutput) printJson({ ok: false, error: message, trace: error.trace ?? [] });
  else console.error(`Оркестрация остановлена: ${message}`);
  process.exitCode = 1;
} finally {
  await registry?.close();
}
