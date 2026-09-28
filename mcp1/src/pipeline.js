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

export const MAX_SEARCH_RESULTS = 10;
export const MAX_SUMMARY_BYTES = 100_000;
export const REPORT_FILE_PATTERN = (
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.(?:md|txt)$/
);

export class ReportAlreadyExistsError extends Error {
  constructor(fileName) {
    super(`Report already exists: ${fileName}`);
    this.name = "ReportAlreadyExistsError";
  }
}

export class PipelineStageError extends Error {
  constructor(stage, cause) {
    super(`Pipeline failed at ${stage}`, { cause });
    this.name = "PipelineStageError";
    this.stage = stage;
  }
}

function markdownText(value) {
  return String(value).replace(/[\\`*_{}[\]<>]/g, "\\$&");
}

export function summarizeSearchResults(searchResult) {
  const lines = [
    `# GitHub search: ${markdownText(searchResult.query)}`,
    "",
    `Found ${searchResult.totalCount} repositories; showing ${searchResult.items.length}.`,
    `Search completed at ${searchResult.searchedAt}.`,
    "",
  ];

  if (searchResult.items.length === 0) {
    lines.push("No repositories matched the query.");
  } else {
    searchResult.items.forEach((item, index) => {
      const description = item.description
        ? ` — ${markdownText(item.description)}`
        : "";
      const language = item.language ? `, ${markdownText(item.language)}` : "";
      lines.push(
        `${index + 1}. [${markdownText(item.fullName)}](${item.url}) — `
        + `${item.stars} stars, ${item.forks} forks${language}${description}`,
      );
    });
  }

  return {
    query: searchResult.query,
    itemCount: searchResult.items.length,
    summary: `${lines.join("\n")}\n`,
  };
}

export async function saveToFile({
  outputDirectory,
  fileName,
  content,
  overwrite = false,
}) {
  if (!outputDirectory) throw new TypeError("outputDirectory is required");
  if (!REPORT_FILE_PATTERN.test(fileName)) {
    throw new TypeError("fileName must be a simple .md or .txt file name");
  }

  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_SUMMARY_BYTES) {
    throw new RangeError(`content must not exceed ${MAX_SUMMARY_BYTES} bytes`);
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
        if (error?.code === "EEXIST") {
          throw new ReportAlreadyExistsError(fileName);
        }
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
    bytes,
    savedAt: new Date().toISOString(),
  };
}

export async function runSearchSummaryPipeline({
  query,
  limit,
  fileName,
  overwrite,
}, {
  search,
  summarize,
  save,
  signal,
  onTrace = () => {},
}) {
  signal?.throwIfAborted();
  onTrace("search", { query, limit });
  let searchResult;
  try {
    searchResult = await search({ query, limit, signal });
  } catch (error) {
    throw new PipelineStageError("search", error);
  }
  signal?.throwIfAborted();

  onTrace("summarize", { searchResult });
  let summaryResult;
  try {
    summaryResult = await summarize({ searchResult });
  } catch (error) {
    throw new PipelineStageError("summarize", error);
  }
  signal?.throwIfAborted();

  onTrace("save_to_file", {
    fileName,
    content: summaryResult.summary,
    overwrite,
  });
  let savedResult;
  try {
    savedResult = await save({
      fileName,
      content: summaryResult.summary,
      overwrite,
    });
  } catch (error) {
    throw new PipelineStageError("save_to_file", error);
  }

  return {
    stages: [
      {
        tool: "search",
        received: { query, limit },
        produced: { itemCount: searchResult.items.length },
      },
      {
        tool: "summarize",
        received: { itemCount: searchResult.items.length },
        produced: { bytes: Buffer.byteLength(summaryResult.summary, "utf8") },
      },
      {
        tool: "save_to_file",
        received: { fileName, overwrite },
        produced: { bytes: savedResult.bytes },
      },
    ],
    search: searchResult,
    summary: summaryResult,
    saved: savedResult,
  };
}
