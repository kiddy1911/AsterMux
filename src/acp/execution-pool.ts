import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  AcpConnection,
  type AcpAvailableModel,
  type AcpConfigOption,
} from "./transport.js";
import { configureAcpSessionModel } from "./session-client.js";

export type AcpPoolLane = "interactive" | "batch";

export type AcpPoolOptions = {
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
  requestWorkspace: string;
  requestTimeoutMs: number;
  skipAuthenticate: boolean;
  rawDebug?: boolean;
  /** Maximum physical workers for this lane. */
  poolSize: number;
  /** Workers kept hot while idle. Defaults to poolSize (legacy behavior). */
  warmSize?: number;
  /** Shrink elastic workers back to warmSize after this idle period. 0 disables shrink. */
  idleTtlMs?: number;
  maxRequests: number;
  maxAgeMs: number;
  lane?: AcpPoolLane;
  queueMax?: number;
  queueTimeoutMs?: number;
};

export type AcpPoolRunOptions = AcpPoolOptions & {
  prompt: string;
  /** Requested Cursor model for this session. The ACP process itself is model-agnostic. */
  model?: string;
  /** Additional display/catalog aliases for per-session model resolution. */
  modelAliases?: string[];
  strictModel?: boolean;
  signal?: AbortSignal;
  onChunk?: (text: string) => void;
  /** Optional one-way borrowing source. Used only when the primary lane is busy. */
  borrowFrom?: AcpPoolOptions;
  onAcquired?: (timing: {
    lane: AcpPoolLane;
    workerLane?: AcpPoolLane;
    queueWaitMs: number;
  }) => void;
};

export type AcpPoolTiming = {
  lane: AcpPoolLane;
  workerLane?: AcpPoolLane;
  queueWaitMs: number;
  executionMs: number;
};

export type AcpPoolMetrics = {
  lane: AcpPoolLane;
  poolSize: number;
  warmSize: number;
  idleTtlMs: number;
  workers: number;
  active: number;
  idle: number;
  prepared: number;
  queued: number;
  queueMax: number;
  queueTimeoutMs: number;
  completed: number;
  failed: number;
  cancelled: number;
  queueRejected: number;
  queueTimedOut: number;
  queueAborted: number;
  borrowedIn: number;
  avgQueueWaitMs: number;
  avgExecutionMs: number;
  maxQueueWaitMs: number;
  maxExecutionMs: number;
};

export class PooledAcpRunError extends Error {
  readonly hadOutput: boolean;

  constructor(message: string, hadOutput: boolean, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PooledAcpRunError";
    this.hadOutput = hadOutput;
  }
}

export class AcpPoolQueueError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterSeconds: number;
  readonly lane: AcpPoolLane;

  constructor(
    message: string,
    opts: {
      lane: AcpPoolLane;
      code: "queue_overloaded" | "queue_timeout" | "queue_aborted";
      status?: number;
      retryAfterSeconds?: number;
    },
  ) {
    super(message);
    this.name = "AcpPoolQueueError";
    this.status = opts.status ?? 429;
    this.code = opts.code;
    this.retryAfterSeconds = opts.retryAfterSeconds ?? 2;
    this.lane = opts.lane;
  }
}

function safePositiveInt(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function safeNonNegativeInt(value: number | undefined, fallback: number): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function argsWithoutWorkspace(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--workspace" && i + 1 < args.length) {
      i += 1;
      continue;
    }
    out.push(args[i]!);
  }
  return out;
}

function argsWithoutModel(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--model" && i + 1 < args.length) {
      i += 1;
      continue;
    }
    out.push(args[i]!);
  }
  return out;
}

function argsWithWorkspace(args: readonly string[], workspace: string): string[] {
  const out = [...args];
  const index = out.indexOf("--workspace");
  if (index >= 0 && index + 1 < out.length) {
    out[index + 1] = workspace;
    return out;
  }
  const acpIndex = out.indexOf("acp");
  if (acpIndex >= 0) {
    out.splice(acpIndex, 0, "--workspace", workspace);
  } else {
    out.unshift("--workspace", workspace);
  }
  return out;
}

const CHAT_ONLY_LOW_MEMORY_FLAGS = [
  "--disable-indexing",
  "--disable-codebase-ref",
  "--exclude-workspace-context",
] as const;

function argsForPooledWorker(
  args: readonly string[],
  workspace: string,
): string[] {
  const out = argsWithWorkspace(argsWithoutModel(args), workspace);
  const acpIndex = out.indexOf("acp");
  if (acpIndex < 0) return out;
  const missing = CHAT_ONLY_LOW_MEMORY_FLAGS.filter((flag) => !out.includes(flag));
  out.splice(acpIndex, 0, ...missing);
  return out;
}

function poolKey(opts: AcpPoolOptions): string {
  return JSON.stringify({
    command: opts.command,
    // Model selection is a session property, not a physical worker identity.
    args: argsWithoutModel(argsWithoutWorkspace(opts.args)),
    auth: authFingerprint(opts.env, opts.requestWorkspace),
    skipAuthenticate: opts.skipAuthenticate,
    lane: opts.lane ?? "interactive",
    poolSize: opts.poolSize,
    warmSize: opts.warmSize ?? opts.poolSize,
    queueMax: opts.queueMax,
    queueTimeoutMs: opts.queueTimeoutMs,
    idleTtlMs: opts.idleTtlMs ?? 0,
  });
}

function isPathInside(candidate: string | undefined, root: string): boolean {
  if (!candidate) return false;
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function authFingerprint(
  env: Record<string, string | undefined>,
  requestWorkspace: string,
): string {
  const configDir = env.CURSOR_CONFIG_DIR;
  const auth =
    configDir && !isPathInside(configDir, requestWorkspace)
      ? configDir
      : env.CURSOR_API_KEY ?? env.CURSOR_AUTH_TOKEN ?? "default";
  return createHash("sha256").update(auth).digest("hex").slice(0, 16);
}

function prepareStableWorkerEnvironment(
  root: string,
  requestWorkspace: string,
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const home = path.join(root, "home");
  const cursorDir = path.join(home, ".cursor");
  const xdg = path.join(home, ".config");
  fs.mkdirSync(path.join(cursorDir, "rules"), { recursive: true });
  fs.mkdirSync(xdg, { recursive: true });

  const sourceConfig = path.join(requestWorkspace, ".cursor", "cli-config.json");
  const targetConfig = path.join(cursorDir, "cli-config.json");
  try {
    if (fs.existsSync(sourceConfig)) {
      fs.copyFileSync(sourceConfig, targetConfig);
    } else {
      fs.writeFileSync(
        targetConfig,
        JSON.stringify({
          version: 1,
          editor: { vimMode: false },
          permissions: { allow: [], deny: [] },
        }),
        "utf8",
      );
    }
  } catch {
    // Cursor can still start with its defaults.
  }

  const out = { ...env };
  if (isPathInside(out.HOME, requestWorkspace)) out.HOME = home;
  if (isPathInside(out.USERPROFILE, requestWorkspace)) out.USERPROFILE = home;
  if (isPathInside(out.XDG_CONFIG_HOME, requestWorkspace)) out.XDG_CONFIG_HOME = xdg;
  if (isPathInside(out.CURSOR_CONFIG_DIR, requestWorkspace)) {
    out.CURSOR_CONFIG_DIR = cursorDir;
  }
  return out;
}

type PreparedSession = {
  sessionId: string;
  workspace: string;
  availableModels?: AcpAvailableModel[];
  configOptions?: AcpConfigOption[];
};

class AcpWorker {
  readonly createdAt = Date.now();
  requestCount = 0;
  busy = false;
  broken = false;

  readonly #opts: AcpPoolOptions;
  readonly #root: string;
  readonly #workspace: string;
  readonly #connection: AcpConnection;
  #ready?: Promise<void>;
  #activeChunk?: (text: string) => void;
  #accumulated = "";
  #captureOutput = false;
  #hadOutput = false;
  #prepared?: Promise<PreparedSession>;
  #preparedReady = false;

  constructor(opts: AcpPoolOptions) {
    this.#opts = opts;
    this.#root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-acp-worker-"));
    this.#workspace = path.join(this.#root, "workspace");
    fs.mkdirSync(this.#workspace, { recursive: true });
    const workerEnv = prepareStableWorkerEnvironment(
      this.#root,
      opts.requestWorkspace,
      opts.env,
    );
    const workerArgs = argsForPooledWorker(opts.args, this.#workspace);
    this.#connection = new AcpConnection(opts.command, workerArgs, {
      cwd: this.#workspace,
      env: workerEnv,
      requestTimeoutMs: opts.requestTimeoutMs,
      rawDebug: opts.rawDebug,
      onAgentTextChunk: (text) => {
        this.#hadOutput = true;
        if (this.#captureOutput) this.#accumulated += text;
        this.#activeChunk?.(text);
      },
    });
  }

  get hasPreparedSession(): boolean {
    return this.#preparedReady;
  }

  async ready(): Promise<void> {
    if (!this.#ready) this.#ready = this.#initialize();
    return this.#ready;
  }

  async #initialize(): Promise<void> {
    try {
      await this.#connection.initialize();
      if (!this.#opts.skipAuthenticate) await this.#connection.authenticate();
      this.#startPreparing();
      await this.#prepared;
    } catch (error) {
      this.broken = true;
      throw error;
    }
  }

  #sessionWorkspace(): string {
    return fs.mkdtempSync(path.join(this.#root, "session-"));
  }

  async #prepareSession(): Promise<PreparedSession> {
    const workspace = this.#sessionWorkspace();
    try {
      const session = await this.#connection.newSession(workspace, []);
      if (!session.sessionId) {
        throw new Error("ACP session/new returned no sessionId");
      }
      return {
        sessionId: session.sessionId,
        workspace,
        availableModels: session.models?.availableModels,
        configOptions: session.configOptions,
      };
    } catch (error) {
      try {
        fs.rmSync(workspace, { recursive: true, force: true });
      } catch {
        // best effort
      }
      throw error;
    }
  }

  #startPreparing(): void {
    if (this.broken || this.#connection.closed || this.#prepared) return;
    const pending = this.#prepareSession();
    this.#prepared = pending;
    this.#preparedReady = false;
    void pending.then(
      () => {
        if (this.#prepared === pending) this.#preparedReady = true;
      },
      () => {
        this.broken = true;
      },
    );
  }

  async #takePrepared(): Promise<PreparedSession> {
    if (!this.#prepared) this.#startPreparing();
    const pending = this.#prepared;
    if (!pending) throw new Error("ACP prepared session unavailable");
    try {
      return await pending;
    } finally {
      if (this.#prepared === pending) {
        this.#prepared = undefined;
        this.#preparedReady = false;
      }
    }
  }

  shouldRecycle(): boolean {
    return (
      this.broken ||
      this.requestCount >= safePositiveInt(this.#opts.maxRequests, 100) ||
      Date.now() - this.createdAt >= Math.max(60_000, this.#opts.maxAgeMs)
    );
  }

  async run(
    workspace: string,
    prompt: string,
    signal?: AbortSignal,
    onChunk?: (text: string) => void,
    model?: string,
    modelAliases: string[] = [],
    strictModel = false,
  ): Promise<string> {
    await this.ready();
    if (signal?.aborted) {
      throw new PooledAcpRunError("Pooled ACP request aborted before start", false);
    }

    this.requestCount += 1;
    this.#accumulated = "";
    this.#hadOutput = false;
    this.#captureOutput = onChunk === undefined;
    this.#activeChunk = onChunk;
    let sessionId: string | undefined;
    let sessionWorkspace: string | undefined;
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      this.#captureOutput = false;
      this.#activeChunk = undefined;
      if (sessionId) void this.#connection.cancelSession(sessionId);
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      void workspace;
      const session = await this.#takePrepared();
      sessionId = session.sessionId;
      sessionWorkspace = session.workspace;
      if (!this.broken && !this.#connection.closed) this.#startPreparing();
      if (signal?.aborted) {
        onAbort();
        throw new Error("Pooled ACP request aborted before prompt");
      }
      if (model) {
        await configureAcpSessionModel({
          requested: model,
          aliases: modelAliases,
          strictModel,
          session: {
            models: { availableModels: session.availableModels },
            configOptions: session.configOptions,
          },
          setOption: (configId, value) =>
            this.#connection.setSessionConfigOption(sessionId!, configId, value),
        });
      }
      await this.#connection.prompt(sessionId, prompt, this.#opts.requestTimeoutMs);
      if (aborted) throw new Error("Pooled ACP request aborted");
      return this.#accumulated;
    } catch (error) {
      if (!aborted || this.#connection.closed) this.broken = true;
      throw new PooledAcpRunError(
        error instanceof Error ? error.message : String(error),
        this.#hadOutput,
        error,
      );
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.#activeChunk = undefined;
      this.#captureOutput = false;
      this.#accumulated = "";
      this.#hadOutput = false;
      if (sessionId) {
        await this.#connection.cancelSession(sessionId).catch(() => undefined);
      }
      if (sessionWorkspace) {
        try {
          fs.rmSync(sessionWorkspace, { recursive: true, force: true });
        } catch {
          // best effort
        }
      }
      if (!this.broken && !this.#connection.closed) this.#startPreparing();
    }
  }

  async close(): Promise<void> {
    this.broken = true;
    await this.#connection.close("SIGKILL").catch(() => undefined);
    try {
      fs.rmSync(this.#root, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

type WorkerLease = {
  worker: AcpWorker;
  queueWaitMs: number;
};

type Waiter = {
  resolve: (lease: WorkerLease) => void;
  reject: (error: Error) => void;
  enqueuedAt: number;
  signal?: AbortSignal;
  onAbort?: () => void;
  timer?: ReturnType<typeof setTimeout>;
};

class AcpPoolBucket {
  readonly #opts: AcpPoolOptions;
  readonly #workers = new Set<AcpWorker>();
  readonly #waiters: Waiter[] = [];
  #closed = false;
  #completed = 0;
  #failed = 0;
  #cancelled = 0;
  #queueRejected = 0;
  #queueTimedOut = 0;
  #queueAborted = 0;
  #borrowedIn = 0;
  #queueWaitTotalMs = 0;
  #executionTotalMs = 0;
  #maxQueueWaitMs = 0;
  #maxExecutionMs = 0;
  #trimTimer?: ReturnType<typeof setTimeout>;

  constructor(opts: AcpPoolOptions) {
    this.#opts = opts;
  }

  get lane(): AcpPoolLane {
    return this.#opts.lane ?? "interactive";
  }

  get targetSize(): number {
    return Math.min(8, safePositiveInt(this.#opts.poolSize, 1));
  }

  get warmSize(): number {
    const configured = this.#opts.warmSize ?? this.targetSize;
    if (!Number.isFinite(configured)) return this.targetSize;
    return Math.min(this.targetSize, Math.max(0, Math.floor(configured)));
  }

  get idleTtlMs(): number {
    const configured = this.#opts.idleTtlMs ?? 0;
    if (!Number.isFinite(configured)) return 0;
    return Math.max(0, Math.floor(configured));
  }

  get queueMax(): number {
    return safeNonNegativeInt(this.#opts.queueMax, this.targetSize * 2);
  }

  get queueTimeoutMs(): number {
    return safePositiveInt(this.#opts.queueTimeoutMs ?? 30_000, 30_000);
  }

  async prime(): Promise<void> {
    await this.#ensureSize(this.warmSize);
  }

  async #ensureSize(desired: number): Promise<void> {
    const target = Math.min(this.targetSize, Math.max(0, Math.floor(desired)));
    const tasks: Promise<void>[] = [];
    while (!this.#closed && this.#workers.size < target) {
      const worker = new AcpWorker(this.#opts);
      // Keep a worker under construction out of the idle candidate set.
      worker.busy = true;
      this.#workers.add(worker);
      tasks.push(
        worker.ready().then(
          () => {
            worker.busy = false;
          },
          async (error) => {
            this.#workers.delete(worker);
            await worker.close();
            throw error;
          },
        ),
      );
    }
    await Promise.all(tasks);
  }

  async tryAcquireNow(
    signal?: AbortSignal,
    allowCreate = true,
  ): Promise<WorkerLease | undefined> {
    if (this.#closed) throw new Error("ACP worker pool is closed");
    if (signal?.aborted) {
      this.#queueAborted += 1;
      throw new AcpPoolQueueError("ACP queue request aborted", {
        lane: this.lane,
        code: "queue_aborted",
        status: 499,
        retryAfterSeconds: 0,
      });
    }

    // Never let a newer request bypass an already queued request. This is
    // especially important when an interactive request considers borrowing a
    // batch worker: queued batch work keeps priority over borrowed traffic.
    if (this.#waiters.length > 0) return undefined;

    for (const worker of [...this.#workers]) {
      if (!worker.busy && worker.shouldRecycle()) await this.#discard(worker);
    }

    const idle = [...this.#workers].filter(
      (worker) => !worker.busy && !worker.shouldRecycle(),
    );
    const worker = idle.find((candidate) => candidate.hasPreparedSession) ?? idle[0];
    if (worker) {
      worker.busy = true;
      try {
        await worker.ready();
        return { worker, queueWaitMs: 0 };
      } catch (error) {
        await this.#discard(worker);
        throw error;
      }
    }

    if (allowCreate && this.#workers.size < this.targetSize) {
      const created = new AcpWorker(this.#opts);
      created.busy = true;
      this.#workers.add(created);
      try {
        await created.ready();
        return { worker: created, queueWaitMs: 0 };
      } catch (error) {
        await this.#discard(created);
        throw error;
      }
    }
    return undefined;
  }

  async acquire(signal?: AbortSignal): Promise<WorkerLease> {
    const immediate = await this.tryAcquireNow(signal, true);
    if (immediate) return immediate;

    if (this.#waiters.length >= this.queueMax) {
      this.#queueRejected += 1;
      throw new AcpPoolQueueError(
        `ACP ${this.lane} queue is full (${this.#waiters.length}/${this.queueMax})`,
        { lane: this.lane, code: "queue_overloaded", retryAfterSeconds: 2 },
      );
    }

    return new Promise<WorkerLease>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        enqueuedAt: Date.now(),
        signal,
      };
      const remove = () => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        if (waiter.timer) clearTimeout(waiter.timer);
        if (waiter.signal && waiter.onAbort) {
          waiter.signal.removeEventListener("abort", waiter.onAbort);
        }
      };
      waiter.onAbort = () => {
        remove();
        this.#queueAborted += 1;
        reject(
          new AcpPoolQueueError("ACP queued request aborted by client", {
            lane: this.lane,
            code: "queue_aborted",
            status: 499,
            retryAfterSeconds: 0,
          }),
        );
      };
      waiter.timer = setTimeout(() => {
        remove();
        this.#queueTimedOut += 1;
        reject(
          new AcpPoolQueueError(
            `ACP ${this.lane} queue wait exceeded ${this.queueTimeoutMs}ms`,
            { lane: this.lane, code: "queue_timeout", retryAfterSeconds: 2 },
          ),
        );
      }, this.queueTimeoutMs);
      waiter.timer.unref?.();
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      this.#waiters.push(waiter);
    });
  }

  async release(worker: AcpWorker): Promise<void> {
    if (!this.#workers.has(worker)) return;
    worker.busy = false;
    if (this.#closed || worker.shouldRecycle()) {
      await this.#discard(worker);
      if (!this.#closed) void this.#replenish();
      return;
    }
    this.#serveWaiter();
    this.#scheduleTrim();
  }

  recordRun(
    queueWaitMs: number,
    executionMs: number,
    ok: boolean,
    borrowed = false,
    cancelled = false,
  ): void {
    if (ok) this.#completed += 1;
    else if (cancelled) this.#cancelled += 1;
    else this.#failed += 1;
    if (borrowed) this.#borrowedIn += 1;
    this.#queueWaitTotalMs += Math.max(0, queueWaitMs);
    this.#executionTotalMs += Math.max(0, executionMs);
    this.#maxQueueWaitMs = Math.max(this.#maxQueueWaitMs, queueWaitMs);
    this.#maxExecutionMs = Math.max(this.#maxExecutionMs, executionMs);
  }

  metrics(): AcpPoolMetrics {
    const workers = [...this.#workers];
    const active = workers.filter((worker) => worker.busy).length;
    const completedRuns = this.#completed + this.#failed;
    return {
      lane: this.lane,
      poolSize: this.targetSize,
      warmSize: this.warmSize,
      idleTtlMs: this.idleTtlMs,
      workers: workers.length,
      active,
      idle: workers.length - active,
      prepared: workers.filter((worker) => worker.hasPreparedSession).length,
      queued: this.#waiters.length,
      queueMax: this.queueMax,
      queueTimeoutMs: this.queueTimeoutMs,
      completed: this.#completed,
      failed: this.#failed,
      cancelled: this.#cancelled,
      queueRejected: this.#queueRejected,
      queueTimedOut: this.#queueTimedOut,
      queueAborted: this.#queueAborted,
      borrowedIn: this.#borrowedIn,
      avgQueueWaitMs:
        completedRuns > 0 ? Math.round(this.#queueWaitTotalMs / completedRuns) : 0,
      avgExecutionMs:
        completedRuns > 0 ? Math.round(this.#executionTotalMs / completedRuns) : 0,
      maxQueueWaitMs: Math.round(this.#maxQueueWaitMs),
      maxExecutionMs: Math.round(this.#maxExecutionMs),
    };
  }

  async #discard(worker: AcpWorker): Promise<void> {
    this.#workers.delete(worker);
    worker.busy = false;
    await worker.close();
    this.#serveWaiter();
  }

  #cleanupWaiter(waiter: Waiter): void {
    if (waiter.timer) clearTimeout(waiter.timer);
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
  }

  #serveWaiter(): void {
    if (this.#closed || this.#waiters.length === 0) return;
    const idle = [...this.#workers].filter(
      (candidate) => !candidate.busy && !candidate.shouldRecycle(),
    );
    const worker = idle.find((candidate) => candidate.hasPreparedSession) ?? idle[0];
    if (!worker) {
      if (this.#workers.size < this.targetSize) void this.#replenish();
      return;
    }

    while (this.#waiters.length > 0) {
      const waiter = this.#waiters.shift()!;
      this.#cleanupWaiter(waiter);
      if (waiter.signal?.aborted) {
        this.#queueAborted += 1;
        waiter.reject(
          new AcpPoolQueueError("ACP queued request aborted by client", {
            lane: this.lane,
            code: "queue_aborted",
            status: 499,
            retryAfterSeconds: 0,
          }),
        );
        continue;
      }
      worker.busy = true;
      const queueWaitMs = Date.now() - waiter.enqueuedAt;
      waiter.resolve({ worker, queueWaitMs });
      return;
    }
  }

  async #replenish(): Promise<void> {
    if (this.#closed) return;
    try {
      const demandTarget = Math.min(
        this.targetSize,
        Math.max(this.warmSize, this.#workers.size + this.#waiters.length),
      );
      await this.#ensureSize(demandTarget);
      this.#serveWaiter();
    } catch (error) {
      const waiter = this.#waiters.shift();
      if (waiter) {
        this.#cleanupWaiter(waiter);
        waiter.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  #scheduleTrim(): void {
    if (
      this.#closed ||
      this.idleTtlMs <= 0 ||
      this.warmSize >= this.targetSize ||
      this.#workers.size <= this.warmSize
    ) {
      return;
    }
    if (this.#trimTimer) clearTimeout(this.#trimTimer);
    this.#trimTimer = setTimeout(() => {
      this.#trimTimer = undefined;
      void this.#trimExcessIdle();
    }, this.idleTtlMs);
    this.#trimTimer.unref?.();
  }

  async #trimExcessIdle(): Promise<void> {
    if (this.#closed || this.#waiters.length > 0) return;
    const workers = [...this.#workers];
    const active = workers.filter((worker) => worker.busy).length;
    let excess = Math.max(0, workers.length - Math.max(this.warmSize, active));
    if (excess <= 0) return;
    const idle = workers.filter((worker) => !worker.busy).reverse();
    const closing: Promise<void>[] = [];
    for (const worker of idle) {
      if (excess <= 0) break;
      if (!this.#workers.delete(worker)) continue;
      excess -= 1;
      closing.push(worker.close());
    }
    await Promise.all(closing);
    if (!this.#closed && this.#workers.size < this.warmSize) {
      await this.#ensureSize(this.warmSize);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#trimTimer) clearTimeout(this.#trimTimer);
    this.#trimTimer = undefined;
    const error = new Error("ACP worker pool closed");
    while (this.#waiters.length > 0) {
      const waiter = this.#waiters.shift()!;
      this.#cleanupWaiter(waiter);
      waiter.reject(error);
    }
    const workers = [...this.#workers];
    this.#workers.clear();
    await Promise.all(workers.map((worker) => worker.close()));
  }
}

const buckets = new Map<string, AcpPoolBucket>();

function bucketFor(opts: AcpPoolOptions): AcpPoolBucket {
  const key = poolKey(opts);
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = new AcpPoolBucket(opts);
    buckets.set(key, bucket);
  }
  return bucket;
}

export async function primePooledAcp(opts: AcpPoolOptions): Promise<void> {
  await bucketFor(opts).prime();
}

async function acquireRunLease(opts: AcpPoolRunOptions): Promise<{
  logicalBucket: AcpPoolBucket;
  workerBucket: AcpPoolBucket;
  lease: WorkerLease;
  borrowed: boolean;
}> {
  const logicalBucket = bucketFor(opts);
  const immediate = await logicalBucket.tryAcquireNow(opts.signal, true);
  if (immediate) {
    return { logicalBucket, workerBucket: logicalBucket, lease: immediate, borrowed: false };
  }

  if (opts.borrowFrom && logicalBucket.lane === "interactive") {
    const borrowBucket = bucketFor(opts.borrowFrom);
    const borrowedLease = await borrowBucket.tryAcquireNow(opts.signal, false);
    if (borrowedLease) {
      return {
        logicalBucket,
        workerBucket: borrowBucket,
        lease: borrowedLease,
        borrowed: true,
      };
    }
  }

  const lease = await logicalBucket.acquire(opts.signal);
  return { logicalBucket, workerBucket: logicalBucket, lease, borrowed: false };
}

export async function runPooledAcpSync(
  opts: AcpPoolRunOptions,
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
  pool: AcpPoolTiming;
}> {
  const { logicalBucket, workerBucket, lease, borrowed } = await acquireRunLease(opts);
  const executionStarted = Date.now();
  try {
    const stdout = await lease.worker.run(
      opts.requestWorkspace,
      opts.prompt,
      opts.signal,
      undefined,
      opts.model,
      opts.modelAliases,
      opts.strictModel,
    );
    const executionMs = Date.now() - executionStarted;
    workerBucket.recordRun(lease.queueWaitMs, executionMs, true, borrowed);
    return {
      code: 0,
      stdout,
      stderr: "",
      pool: {
        lane: logicalBucket.lane,
        ...(borrowed ? { workerLane: workerBucket.lane } : {}),
        queueWaitMs: lease.queueWaitMs,
        executionMs,
      },
    };
  } catch (error) {
    workerBucket.recordRun(
      lease.queueWaitMs,
      Date.now() - executionStarted,
      false,
      borrowed,
      opts.signal?.aborted === true,
    );
    throw error;
  } finally {
    await workerBucket.release(lease.worker);
  }
}

export async function runPooledAcpStream(
  opts: AcpPoolRunOptions,
): Promise<{
  code: number;
  stderr: string;
  pool: AcpPoolTiming;
}> {
  const { logicalBucket, workerBucket, lease, borrowed } = await acquireRunLease(opts);
  opts.onAcquired?.({
    lane: logicalBucket.lane,
    ...(borrowed ? { workerLane: workerBucket.lane } : {}),
    queueWaitMs: lease.queueWaitMs,
  });
  const executionStarted = Date.now();
  try {
    await lease.worker.run(
      opts.requestWorkspace,
      opts.prompt,
      opts.signal,
      opts.onChunk,
      opts.model,
      opts.modelAliases,
      opts.strictModel,
    );
    const executionMs = Date.now() - executionStarted;
    workerBucket.recordRun(lease.queueWaitMs, executionMs, true, borrowed);
    return {
      code: 0,
      stderr: "",
      pool: {
        lane: logicalBucket.lane,
        ...(borrowed ? { workerLane: workerBucket.lane } : {}),
        queueWaitMs: lease.queueWaitMs,
        executionMs,
      },
    };
  } catch (error) {
    workerBucket.recordRun(
      lease.queueWaitMs,
      Date.now() - executionStarted,
      false,
      borrowed,
      opts.signal?.aborted === true,
    );
    throw error;
  } finally {
    await workerBucket.release(lease.worker);
  }
}

export function getAcpPoolMetrics(): AcpPoolMetrics[] {
  return [...buckets.values()]
    .map((bucket) => bucket.metrics())
    .sort((a, b) => a.lane.localeCompare(b.lane));
}

export async function closeAllAcpPools(): Promise<void> {
  const all = [...buckets.values()];
  buckets.clear();
  await Promise.all(all.map((bucket) => bucket.close()));
}
