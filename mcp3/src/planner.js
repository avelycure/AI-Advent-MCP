import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

export const MAX_PLAN_BYTES = 100_000;
export const PLAN_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.md$/;

export class PlanAlreadyExistsError extends Error {
  constructor(fileName) {
    super(`Learning plan already exists: ${fileName}`);
    this.name = "PlanAlreadyExistsError";
  }
}

const DIFFICULTY_ORDER = new Map([
  ["beginner", 0],
  ["intermediate", 1],
  ["advanced", 2],
]);

export function rankLearningResources({ resources, desiredCount }) {
  const selected = [...resources]
    .sort((left, right) => (
      right.relevanceScore - left.relevanceScore
      || (DIFFICULTY_ORDER.get(left.difficulty) ?? 99)
      - (DIFFICULTY_ORDER.get(right.difficulty) ?? 99)
      || left.title.localeCompare(right.title, "ru")
    ))
    .slice(0, desiredCount);

  return {
    candidateCount: resources.length,
    selectedIds: selected.map((resource) => resource.id),
    rationale: (
      "Ресурсы упорядочены по релевантности, затем от базового уровня к продвинутому; "
      + `выбрано ${selected.length} из ${resources.length}.`
    ),
  };
}

function markdownText(value) {
  return String(value).replace(/[\\`*_{}[\]<>]/g, "\\$&");
}

export function createLearningPlan({ topic, resources }) {
  const totalMinutes = resources.reduce(
    (sum, resource) => sum + resource.durationMinutes,
    0,
  );
  const lines = [
    `# План обучения: ${markdownText(topic)}`,
    "",
    `Ресурсов: ${resources.length}. Общая длительность: ${totalMinutes} минут.`,
    "",
  ];

  resources.forEach((resource, index) => {
    lines.push(
      `## Этап ${index + 1}. ${markdownText(resource.title)}`,
      "",
      `Тип: ${markdownText(resource.kind)}. Уровень: ${markdownText(resource.difficulty)}. `
        + `Время: ${resource.durationMinutes} минут.`,
      "",
      markdownText(resource.summary),
      "",
      ...resource.modules.map((module) => `- [ ] ${markdownText(module)}`),
      "",
    );
  });

  lines.push(
    "## Критерий завершения",
    "",
    "- [ ] Запустить два MCP-сервера и выполнить сквозной сценарий без ручной передачи данных.",
    "- [ ] Сверить trace с ожидаемым порядком маршрутизации.",
    "",
  );

  return {
    topic,
    resourceCount: resources.length,
    totalMinutes,
    markdown: lines.join("\n"),
  };
}

export async function saveLearningPlan({
  outputDirectory,
  fileName,
  content,
  overwrite = false,
}) {
  if (!outputDirectory) throw new TypeError("outputDirectory is required");
  if (!PLAN_FILE_PATTERN.test(fileName)) {
    throw new TypeError("fileName must be a simple .md file name");
  }
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_PLAN_BYTES) {
    throw new RangeError(`content must not exceed ${MAX_PLAN_BYTES} bytes`);
  }

  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const outputStats = await lstat(outputDirectory);
  if (outputStats.isSymbolicLink() || !outputStats.isDirectory()) {
    throw new TypeError("outputDirectory must be a real directory");
  }

  const destination = join(outputDirectory, fileName);
  const temporary = join(
    outputDirectory,
    `.${fileName}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, content, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    if (overwrite) {
      await rename(temporary, destination);
    } else {
      try {
        await link(temporary, destination);
      } catch (error) {
        if (error?.code === "EEXIST") throw new PlanAlreadyExistsError(fileName);
        throw error;
      }
      await rm(temporary);
    }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }

  return {
    fileName,
    outputPath: destination,
    bytes,
  };
}
