import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const MIN_INTERVAL_MINUTES = 5;
export const MAX_INTERVAL_MINUTES = 7 * 24 * 60;
export const MAX_HISTORY_ENTRIES = 50;
export const MAX_TASKS = 20;
export const RETRY_DELAY_MS = 30_000;
export const MAX_RETRY_DELAY_MS = 5 * 60_000;

const STORE_VERSION = 1;
const TASK_ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

function copy(value) {
  return structuredClone(value);
}

function isoNow(now) {
  return now().toISOString();
}

function numericDelta(current = {}, previous = {}) {
  const keys = new Set([...Object.keys(previous), ...Object.keys(current)]);
  return Object.fromEntries(
    [...keys]
      .sort()
      .map((key) => [key, Number(current[key] || 0) - Number(previous[key] || 0)]),
  );
}

function statsDelta(current, previous) {
  if (!current || !previous) return null;
  return {
    repositories: numericDelta(current.repositories, previous.repositories),
    totals: numericDelta(current.totals, previous.totals),
    languages: numericDelta(current.languages, previous.languages),
  };
}

function validTimestamp(value, nullable = false) {
  return (nullable && value === null)
    || (typeof value === "string" && Number.isFinite(Date.parse(value)));
}

function validateState(state, minimumIntervalMinutes, maxHistoryEntries) {
  if (!state || state.version !== STORE_VERSION || !Array.isArray(state.tasks)) {
    throw new Error("Scheduler storage has an unsupported format");
  }
  if (state.tasks.length > MAX_TASKS) {
    throw new Error("Scheduler storage contains too many tasks");
  }

  const ids = new Set();
  for (const task of state.tasks) {
    if (
      !task
      || !TASK_ID_PATTERN.test(task.id)
      || ids.has(task.id)
      || typeof task.enabled !== "boolean"
      || !Number.isInteger(task.intervalMinutes)
      || task.intervalMinutes < minimumIntervalMinutes
      || task.intervalMinutes > MAX_INTERVAL_MINUTES
      || !task.parameters
      || typeof task.parameters !== "object"
      || Array.isArray(task.parameters)
      || !validTimestamp(task.createdAt)
      || !validTimestamp(task.updatedAt)
      || !validTimestamp(task.nextRunAt, true)
      || !validTimestamp(task.lastRunAt, true)
      || !Array.isArray(task.history)
      || task.history.length > maxHistoryEntries
    ) {
      throw new Error("Scheduler storage contains an invalid task");
    }
    ids.add(task.id);
    for (const run of task.history) {
      if (
        !run
        || typeof run.ok !== "boolean"
        || !validTimestamp(run.startedAt)
        || !validTimestamp(run.completedAt)
        || (run.ok && (!run.stats || typeof run.stats !== "object"))
        || (!run.ok && typeof run.error !== "string")
      ) {
        throw new Error("Scheduler storage contains an invalid history entry");
      }
    }
  }

  return state;
}

export class ScheduleNotFoundError extends Error {
  constructor(taskId) {
    super(`GitHub statistics schedule does not exist: ${taskId}`);
    this.name = "ScheduleNotFoundError";
  }
}

export class ScheduleLimitError extends Error {
  constructor() {
    super(
      `GitHub scheduler supports at most ${MAX_TASKS} tasks; update an existing taskId`,
    );
    this.name = "ScheduleLimitError";
  }
}

export class GitHubStatsScheduler {
  constructor({
    storePath,
    collectStats,
    now = () => new Date(),
    minimumIntervalMinutes = MIN_INTERVAL_MINUTES,
    millisecondsPerMinute = 60_000,
    maxHistoryEntries = MAX_HISTORY_ENTRIES,
    formatError = () => "GitHub statistics collection failed",
    retryDelayMs = RETRY_DELAY_MS,
    maxRetryDelayMs = MAX_RETRY_DELAY_MS,
    logger = console,
  }) {
    if (!storePath) throw new TypeError("storePath is required");
    if (typeof collectStats !== "function") {
      throw new TypeError("collectStats is required");
    }
    if (
      !Number.isFinite(retryDelayMs)
      || retryDelayMs <= 0
      || !Number.isFinite(maxRetryDelayMs)
      || maxRetryDelayMs < retryDelayMs
    ) {
      throw new RangeError("retry delays must be positive and bounded");
    }

    this.storePath = storePath;
    this.collectStats = collectStats;
    this.now = now;
    this.minimumIntervalMinutes = minimumIntervalMinutes;
    this.millisecondsPerMinute = millisecondsPerMinute;
    this.maxHistoryEntries = maxHistoryEntries;
    this.formatError = formatError;
    this.retryDelayMs = retryDelayMs;
    this.maxRetryDelayMs = maxRetryDelayMs;
    this.logger = logger;
    this.state = { version: STORE_VERSION, tasks: [] };
    this.loaded = false;
    this.started = false;
    this.stopping = false;
    this.timer = null;
    this.activeController = null;
    this.retryAttempts = 0;
    this.operation = Promise.resolve();
  }

  async start() {
    return this.#enqueue(async () => {
      await this.#load();
      if (this.stopping) return;
      this.started = true;
      this.#scheduleNext();
    });
  }

  async stop() {
    this.stopping = true;
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.activeController?.abort();
    await this.operation;
  }

  async upsertTask({
    taskId = "default",
    intervalMinutes,
    enabled = true,
    runImmediately = true,
    parameters,
  }) {
    if (this.stopping) throw new Error("Scheduler is stopping");
    return this.#enqueue(async () => {
      if (this.stopping) throw new Error("Scheduler is stopping");
      await this.#load();
      this.#validateTaskInput(taskId, intervalMinutes);

      const candidate = copy(this.state);
      const timestamp = isoNow(this.now);
      let task = candidate.tasks.find((item) => item.id === taskId);
      if (!task) {
        if (candidate.tasks.length >= MAX_TASKS) {
          throw new ScheduleLimitError();
        }
        task = {
          id: taskId,
          enabled,
          intervalMinutes,
          parameters: copy(parameters),
          createdAt: timestamp,
          updatedAt: timestamp,
          nextRunAt: null,
          lastRunAt: null,
          history: [],
        };
        candidate.tasks.push(task);
      } else {
        task.enabled = enabled;
        task.intervalMinutes = intervalMinutes;
        task.parameters = copy(parameters);
        task.updatedAt = timestamp;
      }

      task.nextRunAt = enabled
        ? new Date(
          this.now().valueOf() + intervalMinutes * this.millisecondsPerMinute,
        ).toISOString()
        : null;
      if (enabled && runImmediately && !this.stopping) {
        const run = await this.#collectRun(task);
        this.#applyRun(task, run);
      }
      await this.#persist(candidate);
      this.state = candidate;

      this.#scheduleNext();
      return this.#publicTask(this.#findTask(taskId));
    });
  }

  async runNow(taskId = "default") {
    if (this.stopping) throw new Error("Scheduler is stopping");
    return this.#enqueue(async () => {
      if (this.stopping) throw new Error("Scheduler is stopping");
      await this.#load();
      const task = this.#findTask(taskId);
      const run = await this.#execute(task);
      this.#scheduleNext();
      return copy(run);
    });
  }

  async summary(taskId = "default", historyLimit = 10) {
    return this.#enqueue(async () => {
      await this.#load();
      const task = this.#findTask(taskId);
      const successful = task.history.filter((run) => run.ok);
      const latest = successful.at(-1) ?? null;
      const previous = successful.at(-2) ?? null;
      return {
        task: this.#publicTask(task),
        latest: latest ? copy(latest) : null,
        history: copy(task.history.slice(-historyLimit).reverse()),
        delta: statsDelta(latest?.stats, previous?.stats),
      };
    });
  }

  #enqueue(action) {
    const result = this.operation.then(action, action);
    this.operation = result.catch(() => {});
    return result;
  }

  async #load() {
    if (this.loaded) return;
    try {
      const content = await readFile(this.storePath, "utf8");
      this.state = validateState(
        JSON.parse(content),
        this.minimumIntervalMinutes,
        this.maxHistoryEntries,
      );
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    this.loaded = true;
  }

  async #persist(state = this.state) {
    const folder = dirname(this.storePath);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const temporary = `${this.storePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, this.storePath);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  #validateTaskInput(taskId, intervalMinutes) {
    if (!TASK_ID_PATTERN.test(taskId)) {
      throw new TypeError("taskId must contain only letters, digits, '.', '_' or '-'");
    }
    if (
      !Number.isInteger(intervalMinutes)
      || intervalMinutes < this.minimumIntervalMinutes
      || intervalMinutes > MAX_INTERVAL_MINUTES
    ) {
      throw new RangeError(
        `intervalMinutes must be between ${this.minimumIntervalMinutes} and ${MAX_INTERVAL_MINUTES}`,
      );
    }
  }

  #findTask(taskId) {
    const task = this.state.tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new ScheduleNotFoundError(taskId);
    return task;
  }

  #publicTask(task) {
    const { history: _history, ...publicTask } = task;
    return copy(publicTask);
  }

  async #collectRun(task) {
    const startedAt = isoNow(this.now);
    const controller = new AbortController();
    this.activeController = controller;
    let run;
    try {
      const stats = await this.collectStats(
        copy(task.parameters),
        { signal: controller.signal },
      );
      run = {
        startedAt,
        completedAt: isoNow(this.now),
        ok: true,
        stats,
      };
    } catch (error) {
      run = {
        startedAt,
        completedAt: isoNow(this.now),
        ok: false,
        error: String(this.formatError(error)).slice(0, 500),
      };
    } finally {
      if (this.activeController === controller) this.activeController = null;
    }

    return run;
  }

  #applyRun(task, run) {
    task.lastRunAt = run.completedAt;
    task.nextRunAt = task.enabled
      ? new Date(
        this.now().valueOf()
          + task.intervalMinutes * this.millisecondsPerMinute,
      ).toISOString()
      : null;
    task.history.push(run);
    task.history = task.history.slice(-this.maxHistoryEntries);
  }

  async #execute(task) {
    const currentTask = this.#findTask(task.id);
    const run = await this.#collectRun(currentTask);
    const candidate = copy(this.state);
    const candidateTask = candidate.tasks.find((item) => item.id === currentTask.id);
    this.#applyRun(candidateTask, run);
    await this.#persist(candidate);
    this.state = candidate;
    return run;
  }

  #scheduleNext() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.started || this.stopping) return;
    this.retryAttempts = 0;

    const nextTimestamp = this.state.tasks
      .filter((task) => task.enabled && task.nextRunAt)
      .map((task) => Date.parse(task.nextRunAt))
      .filter(Number.isFinite)
      .sort((left, right) => left - right)[0];
    if (nextTimestamp === undefined) return;

    const delay = Math.max(0, nextTimestamp - this.now().valueOf());
    this.#armTimer(Math.min(delay, 2_147_483_647));
  }

  #scheduleRetry() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.started || this.stopping) return;

    this.retryAttempts += 1;
    const delay = Math.min(
      this.retryDelayMs * (2 ** Math.min(this.retryAttempts - 1, 30)),
      this.maxRetryDelayMs,
    );
    this.#armTimer(delay);
  }

  #armTimer(delay) {
    this.timer = setTimeout(() => {
      void this.#runDueTasks().catch((error) => {
        this.logger.error("GitHub scheduler failed:", error);
      });
    }, delay);
    this.timer.unref?.();
  }

  async #runDueTasks() {
    if (this.stopping) return;
    await this.#enqueue(async () => {
      if (this.stopping) return;
      let failed = false;
      try {
        const dueAt = this.now().valueOf();
        const due = this.state.tasks.filter((task) => (
          task.enabled
          && task.nextRunAt
          && Date.parse(task.nextRunAt) <= dueAt
        ));
        for (const task of due) {
          if (!this.started) break;
          await this.#execute(task);
        }
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        if (failed) this.#scheduleRetry();
        else this.#scheduleNext();
      }
    });
  }
}
