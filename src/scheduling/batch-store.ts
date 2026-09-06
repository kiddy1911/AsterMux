import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as path from "node:path";

import type { GatewayConfig } from "../gateway/config.js";

export type BatchItemStatus =
  | "queued"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled";

export type BatchItem = {
  custom_id: string;
  status: BatchItemStatus;
  body: Record<string, unknown>;
  attempts: number;
  created_at: number;
  started_at?: number;
  completed_at?: number;
  response?: {
    status_code: number;
    body: unknown;
  };
  error?: {
    message: string;
    code?: string;
  };
};

export type BatchJobStatus =
  | "queued"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled";

export type BatchJob = {
  id: string;
  object: "proxy.batch";
  status: BatchJobStatus;
  created_at: number;
  updated_at: number;
  completed_at?: number;
  cancelled_at?: number;
  items: BatchItem[];
};

export type BatchCreateRequest = {
  requests: Array<{
    custom_id?: string;
    body: Record<string, unknown>;
  }>;
};

export type BatchSnapshot = {
  enabled: boolean;
  concurrency: number;
  active: number;
  jobs: number;
  queued: number;
  in_progress: number;
  completed: number;
  failed: number;
};

export type BatchExecutorResult = {
  statusCode: number;
  body: unknown;
  headers?: http.IncomingHttpHeaders;
};

export type BatchExecutor = (
  body: Record<string, unknown>,
  context: { batchId: string; customId: string; signal: AbortSignal },
) => Promise<BatchExecutorResult>;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function errorCode(body: unknown): string | undefined {
  const root = asRecord(body);
  const error = asRecord(root?.error);
  return typeof error?.code === "string" ? error.code : undefined;
}

function errorMessage(body: unknown): string | undefined {
  const root = asRecord(body);
  const error = asRecord(root?.error);
  return typeof error?.message === "string" ? error.message : undefined;
}

function shouldRetry(result: BatchExecutorResult): boolean {
  if (result.statusCode === 429 || result.statusCode === 503) return true;
  const code = errorCode(result.body);
  return (
    code === "queue_overloaded" ||
    code === "queue_timeout" ||
    code === "stateless_tool_output_invalid" ||
    code === "cursor_cli_error" ||
    code === "tool_session_error"
  );
}

function withJitter(ms: number): number {
  const factor = 0.8 + Math.random() * 0.4;
  return Math.max(50, Math.round(ms * factor));
}

function retryDelayMs(result: BatchExecutorResult, attempt: number): number {
  const retryAfterRaw = result.headers?.["retry-after"];
  const retryAfter = Array.isArray(retryAfterRaw) ? retryAfterRaw[0] : retryAfterRaw;
  const parsed = retryAfter ? Number(retryAfter) : NaN;
  if (Number.isFinite(parsed) && parsed >= 0) {
    return withJitter(Math.min(10_000, Math.max(250, parsed * 1000)));
  }
  return withJitter(Math.min(8_000, 500 * 2 ** Math.max(0, attempt - 1)));
}

function summarize(job: BatchJob) {
  const counts = {
    total: job.items.length,
    queued: 0,
    in_progress: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const item of job.items) {
    counts[item.status] += 1;
  }
  return counts;
}

function isBatchCancelled(job: BatchJob, signal: AbortSignal): boolean {
  // job.status may change while awaiting the executor; keep the read behind a
  // function boundary so TypeScript does not incorrectly treat it as narrowed.
  return job.status === "cancelled" || signal.aborted;
}

function publicJob(job: BatchJob, includeItems = false) {
  return {
    id: job.id,
    object: job.object,
    status: job.status,
    created_at: job.created_at,
    updated_at: job.updated_at,
    completed_at: job.completed_at,
    cancelled_at: job.cancelled_at,
    request_counts: summarize(job),
    ...(includeItems ? { items: job.items } : {}),
  };
}

export class BatchManager {
  readonly #config: GatewayConfig;
  readonly #dir: string;
  readonly #concurrency: number;
  readonly #maxRequests: number;
  readonly #maxJobs: number;
  readonly #retentionMs: number;
  readonly #jobs = new Map<string, BatchJob>();
  readonly #executor: BatchExecutor;
  readonly #persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #dirtyJobs = new Set<string>();
  readonly #activeControllers = new Map<string, AbortController>();
  #active = 0;
  #loopbackPort: number;
  #started = false;
  #closed = false;
  #pumpScheduled = false;

  constructor(config: GatewayConfig, executor?: BatchExecutor) {
    this.#config = config;
    this.#dir = config.batchDir ?? path.resolve("data/batches");
    this.#concurrency = Math.max(1, config.batchConcurrency ?? 6);
    this.#maxRequests = Math.max(1, config.batchMaxRequests ?? 1000);
    this.#maxJobs = Math.max(1, config.batchMaxJobs ?? 100);
    this.#retentionMs = Math.max(60_000, config.batchRetentionMs ?? 259_200_000);
    this.#executor = executor ?? ((body, context) => this.#executeLoopback(body, context));
    this.#loopbackPort = config.port;
    fs.mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(this.#dir, 0o700);
    } catch {
      // best effort
    }
    this.#load();
  }

  setLoopbackPort(port: number): void {
    if (Number.isFinite(port) && port > 0) this.#loopbackPort = Math.floor(port);
  }

  start(): void {
    if (this.#closed || this.#started) return;
    this.#started = true;
    this.#schedulePump();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const controller of this.#activeControllers.values()) controller.abort();
    this.#activeControllers.clear();
    for (const timer of this.#persistTimers.values()) clearTimeout(timer);
    this.#persistTimers.clear();
    for (const id of [...this.#dirtyJobs]) {
      const job = this.#jobs.get(id);
      if (job) this.#writeJob(job);
    }
    this.#dirtyJobs.clear();
  }

  create(input: BatchCreateRequest): ReturnType<typeof publicJob> {
    this.#prune(true);
    if (this.#jobs.size >= this.#maxJobs) {
      throw new Error(
        `Batch job limit reached (${this.#jobs.size}/${this.#maxJobs}); wait for retained terminal jobs to expire`,
      );
    }
    if (!Array.isArray(input.requests) || input.requests.length === 0) {
      throw new Error("Batch requests must be a non-empty array");
    }
    if (input.requests.length > this.#maxRequests) {
      throw new Error(
        `Batch has ${input.requests.length} requests; maximum is ${this.#maxRequests}`,
      );
    }

    const seen = new Set<string>();
    const createdAt = nowSeconds();
    const items: BatchItem[] = input.requests.map((request, index) => {
      const body = asRecord(request.body);
      if (!body) throw new Error(`Batch request ${index} body must be an object`);
      if (body.stream === true) {
        throw new Error(`Batch request ${index} cannot use stream=true`);
      }
      const customId = request.custom_id?.trim() || `request-${index + 1}`;
      if (seen.has(customId)) throw new Error(`Duplicate custom_id: ${customId}`);
      seen.add(customId);
      return {
        custom_id: customId,
        status: "queued",
        body: { ...body, stream: false },
        attempts: 0,
        created_at: createdAt,
      };
    });

    const id = `batch_${randomUUID().replace(/-/g, "")}`;
    const job: BatchJob = {
      id,
      object: "proxy.batch",
      status: "queued",
      created_at: createdAt,
      updated_at: createdAt,
      items,
    };
    this.#jobs.set(id, job);
    this.#persist(job, true);
    this.#schedulePump();
    return publicJob(job);
  }

  get(id: string, includeItems = false) {
    const job = this.#jobs.get(id);
    return job ? publicJob(job, includeItems) : undefined;
  }

  list(limit = 20) {
    this.#prune(false);
    return [...this.#jobs.values()]
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, Math.max(1, Math.min(100, limit)))
      .map((job) => publicJob(job));
  }

  results(id: string) {
    const job = this.#jobs.get(id);
    if (!job) return undefined;
    return {
      id: job.id,
      status: job.status,
      request_counts: summarize(job),
      data: job.items.map((item) => ({
        custom_id: item.custom_id,
        status: item.status,
        attempts: item.attempts,
        response: item.response,
        error: item.error,
      })),
    };
  }

  cancel(id: string) {
    const job = this.#jobs.get(id);
    if (!job) return undefined;
    if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
      return publicJob(job);
    }
    const now = nowSeconds();
    job.status = "cancelled";
    job.cancelled_at = now;
    job.updated_at = now;
    for (const item of job.items) {
      if (item.status === "queued") {
        item.status = "cancelled";
        item.completed_at = now;
      }
    }
    const prefix = `${job.id}\0`;
    for (const [key, controller] of this.#activeControllers) {
      if (key.startsWith(prefix)) controller.abort();
    }
    this.#persist(job, true);
    return publicJob(job);
  }

  snapshot(): BatchSnapshot {
    let queued = 0;
    let inProgress = 0;
    let completed = 0;
    let failed = 0;
    for (const job of this.#jobs.values()) {
      for (const item of job.items) {
        if (item.status === "queued") queued += 1;
        else if (item.status === "in_progress") inProgress += 1;
        else if (item.status === "completed") completed += 1;
        else if (item.status === "failed") failed += 1;
      }
    }
    return {
      enabled: true,
      concurrency: this.#concurrency,
      active: this.#active,
      jobs: this.#jobs.size,
      queued,
      in_progress: inProgress,
      completed,
      failed,
    };
  }

  #load(): void {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.#dir).filter((name) => /^batch_[a-z0-9]+\.json$/i.test(name));
    } catch {
      return;
    }
    for (const name of names) {
      try {
        const raw = fs.readFileSync(path.join(this.#dir, name), "utf8");
        const job = JSON.parse(raw) as BatchJob;
        if (!job?.id || !Array.isArray(job.items)) continue;
        if (job.status === "in_progress" || job.status === "queued") {
          job.status = "queued";
          for (const item of job.items) {
            if (item.status === "in_progress") item.status = "queued";
          }
        }
        this.#jobs.set(job.id, job);
      } catch (error) {
        console.warn(
          `[batch] failed to load ${name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    this.#prune(false);
  }

  #jobPath(job: BatchJob): string {
    return path.join(this.#dir, `${job.id}.json`);
  }

  #persist(job: BatchJob, immediate = false): void {
    job.updated_at = nowSeconds();
    this.#dirtyJobs.add(job.id);
    const existing = this.#persistTimers.get(job.id);
    if (immediate) {
      if (existing) clearTimeout(existing);
      this.#persistTimers.delete(job.id);
      this.#writeJob(job);
      this.#dirtyJobs.delete(job.id);
      return;
    }
    if (existing) return;
    const timer = setTimeout(() => {
      this.#persistTimers.delete(job.id);
      if (!this.#dirtyJobs.has(job.id)) return;
      const current = this.#jobs.get(job.id);
      if (current) this.#writeJob(current);
      this.#dirtyJobs.delete(job.id);
    }, 500);
    timer.unref?.();
    this.#persistTimers.set(job.id, timer);
  }

  #writeJob(job: BatchJob): void {
    const target = this.#jobPath(job);
    const temp = `${target}.tmp-${process.pid}-${randomUUID()}`;
    fs.writeFileSync(temp, JSON.stringify(job), { mode: 0o600 });
    fs.renameSync(temp, target);
    try {
      fs.chmodSync(target, 0o600);
    } catch {
      // best effort
    }
  }

  #removeJob(job: BatchJob): void {
    const timer = this.#persistTimers.get(job.id);
    if (timer) clearTimeout(timer);
    this.#persistTimers.delete(job.id);
    this.#dirtyJobs.delete(job.id);
    this.#jobs.delete(job.id);
    try {
      fs.rmSync(this.#jobPath(job), { force: true });
    } catch {
      // best effort
    }
  }

  #prune(makeRoom: boolean): void {
    const nowMs = Date.now();
    const terminal = [...this.#jobs.values()]
      .filter((job) =>
        job.status === "completed" || job.status === "failed" || job.status === "cancelled",
      )
      .sort((a, b) => a.updated_at - b.updated_at);

    for (const job of terminal) {
      if ((job.updated_at || job.created_at) * 1000 + this.#retentionMs < nowMs) {
        this.#removeJob(job);
      }
    }

    if (!makeRoom) return;
    const remainingTerminal = [...this.#jobs.values()]
      .filter((job) =>
        job.status === "completed" || job.status === "failed" || job.status === "cancelled",
      )
      .sort((a, b) => a.updated_at - b.updated_at);
    while (this.#jobs.size >= this.#maxJobs && remainingTerminal.length > 0) {
      this.#removeJob(remainingTerminal.shift()!);
    }
  }

  #schedulePump(): void {
    if (!this.#started || this.#closed || this.#pumpScheduled) return;
    this.#pumpScheduled = true;
    queueMicrotask(() => {
      this.#pumpScheduled = false;
      this.#pump();
    });
  }

  #nextItem(): { job: BatchJob; item: BatchItem } | undefined {
    const jobs = [...this.#jobs.values()].sort((a, b) => a.created_at - b.created_at);
    for (const job of jobs) {
      if (job.status === "cancelled" || job.status === "completed" || job.status === "failed") {
        continue;
      }
      const item = job.items.find((candidate) => candidate.status === "queued");
      if (item) return { job, item };
    }
    return undefined;
  }

  #pump(): void {
    if (this.#closed || !this.#started) return;
    while (this.#active < this.#concurrency) {
      const next = this.#nextItem();
      if (!next) break;
      const { job, item } = next;
      item.status = "in_progress";
      item.started_at = nowSeconds();
      if (job.status === "queued") job.status = "in_progress";
      this.#active += 1;
      this.#persist(job);
      void this.#runItem(job, item).finally(() => {
        this.#active -= 1;
        this.#finishJobIfDone(job);
        this.#schedulePump();
      });
    }
  }

  async #runItem(job: BatchJob, item: BatchItem): Promise<void> {
    const maxAttempts = 3;
    let lastError: unknown;
    const controller = new AbortController();
    const activeKey = `${job.id}\0${item.custom_id}`;
    this.#activeControllers.set(activeKey, controller);
    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (isBatchCancelled(job, controller.signal)) {
          item.status = "cancelled";
          item.completed_at = nowSeconds();
          this.#persist(job);
          return;
        }
        item.attempts = attempt;
        try {
          const result = await this.#executor(item.body, {
            batchId: job.id,
            customId: item.custom_id,
            signal: controller.signal,
          });
          if (isBatchCancelled(job, controller.signal)) {
            item.status = "cancelled";
            item.completed_at = nowSeconds();
            this.#persist(job);
            return;
          }
          if (result.statusCode >= 200 && result.statusCode < 300) {
            item.status = "completed";
            item.response = { status_code: result.statusCode, body: result.body };
            item.error = undefined;
            item.completed_at = nowSeconds();
            this.#persist(job);
            return;
          }
          if (attempt < maxAttempts && shouldRetry(result)) {
            await sleep(retryDelayMs(result, attempt));
            continue;
          }
          item.status = "failed";
          item.response = { status_code: result.statusCode, body: result.body };
          item.error = {
            message: errorMessage(result.body) ?? `HTTP ${result.statusCode}`,
            code: errorCode(result.body),
          };
          item.completed_at = nowSeconds();
          this.#persist(job);
          return;
        } catch (error) {
          lastError = error;
          if (isBatchCancelled(job, controller.signal)) {
            item.status = "cancelled";
            item.completed_at = nowSeconds();
            this.#persist(job);
            return;
          }
          if (attempt < maxAttempts) {
            await sleep(withJitter(Math.min(8_000, 500 * 2 ** (attempt - 1))));
            continue;
          }
        }
      }
      item.status = "failed";
      item.error = {
        message:
          lastError instanceof Error
            ? lastError.message
            : String(lastError ?? "batch request failed"),
        code: "batch_execution_error",
      };
      item.completed_at = nowSeconds();
      this.#persist(job);
    } finally {
      this.#activeControllers.delete(activeKey);
    }
  }

  #finishJobIfDone(job: BatchJob): void {
    if (job.status === "cancelled") {
      this.#persist(job, true);
      return;
    }
    if (job.items.some((item) => item.status === "queued" || item.status === "in_progress")) {
      this.#persist(job);
      return;
    }
    job.completed_at = nowSeconds();
    job.status = job.items.some((item) => item.status === "failed") ? "failed" : "completed";
    this.#persist(job, true);
  }

  async #executeLoopback(
    body: Record<string, unknown>,
    context: { batchId: string; customId: string; signal: AbortSignal },
  ): Promise<BatchExecutorResult> {
    const tls = Boolean(this.#config.tlsCertPath && this.#config.tlsKeyPath);
    const transport = tls ? https : http;
    const raw = JSON.stringify({ ...body, stream: false });
    const timeoutMs =
      this.#config.timeoutMs + (this.#config.acpBatchQueueTimeoutMs ?? 30_000) + 10_000;

    return new Promise<BatchExecutorResult>((resolve, reject) => {
      const req = transport.request(
        {
          host: "127.0.0.1",
          port: this.#loopbackPort,
          path: "/v1/chat/completions",
          method: "POST",
          rejectUnauthorized: false,
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(raw),
            "x-astermux-pool-lane": "batch",
            "x-cursor-batch-id": context.batchId,
            "x-cursor-batch-item": context.customId,
            ...(this.#config.requiredKey
              ? { authorization: `Bearer ${this.#config.requiredKey}` }
              : {}),
          },
        },
        (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("end", () => {
            let parsed: unknown = data;
            try {
              parsed = data ? JSON.parse(data) : {};
            } catch {
              // preserve raw body
            }
            resolve({
              statusCode: res.statusCode ?? 500,
              body: parsed,
              headers: res.headers,
            });
          });
        },
      );
      const onAbort = () => {
        req.destroy(new Error("Batch item cancelled"));
      };
      if (context.signal.aborted) {
        onAbort();
        return;
      }
      context.signal.addEventListener("abort", onAbort, { once: true });
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`Batch loopback request timed out after ${timeoutMs}ms`));
      });
      req.on("close", () => {
        context.signal.removeEventListener("abort", onAbort);
      });
      req.on("error", reject);
      req.end(raw);
    });
  }
}
