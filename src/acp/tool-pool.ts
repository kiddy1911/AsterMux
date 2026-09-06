import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  AcpConnection,
  type AcpPermissionParams,
} from "./transport.js";
import { ExternalToolAdapter } from "./external-tools.js";

export type ToolAcpConnectionHandlers = {
  onAgentTextChunk?: (text: string) => void;
  onAgentThoughtChunk?: (text: string) => void;
  onSessionUpdate?: (update: Record<string, unknown>) => void;
  onPermission?: (
    params: AcpPermissionParams,
  ) => string | undefined | Promise<string | undefined>;
};

export type ToolAcpPoolOptions = {
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
  requestWorkspace: string;
  requestTimeoutMs: number;
  spawnOptions?: { windowsVerbatimArguments?: boolean };
  skipAuthenticate: boolean;
  rawDebug?: boolean;
  /** Maximum physical Tool ACP workers. */
  poolSize: number;
  /** Tool workers kept hot while idle. Defaults to poolSize. */
  warmSize?: number;
  /** Shrink elastic Tool workers back to warmSize after this idle period. */
  idleTtlMs?: number;
  queueMax?: number;
  queueTimeoutMs?: number;
  maxRequests: number;
  maxAgeMs: number;
};

export class ToolAcpQueueError extends Error {
  constructor(
    message: string,
    readonly code: "tool_queue_overloaded" | "tool_queue_timeout" | "tool_queue_aborted",
    readonly status: number,
    readonly retryAfterSeconds: number,
  ) {
    super(message);
  }
}

type ToolAcpWaiter = {
  resolve: (lease: ToolAcpConnectionLease) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  timer?: ReturnType<typeof setTimeout>;
};

export type ToolAcpPoolMetrics = {
  pools: number;
  workers: number;
  warmSize: number;
  poolSize: number;
  idleTtlMs: number;
  busy: number;
  idle: number;
  queued: number;
};

export type ToolAcpConnectionLease = {
  readonly connection: AcpConnection;
  setHandlers(handlers: ToolAcpConnectionHandlers): void;
  release(reusable: boolean): Promise<void>;
};

function safePositiveInt(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
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
  if (acpIndex >= 0) out.splice(acpIndex, 0, "--workspace", workspace);
  return out;
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

function poolKey(opts: ToolAcpPoolOptions): string {
  return JSON.stringify({
    command: opts.command,
    // Tool workers are shared across models; model is selected per session.
    args: argsWithoutModel(argsWithoutWorkspace(opts.args)),
    auth: authFingerprint(opts.env, opts.requestWorkspace),
    skipAuthenticate: opts.skipAuthenticate,
    spawnOptions: opts.spawnOptions,
    poolSize: Math.max(0, Math.floor(opts.poolSize)),
    warmSize: Math.max(0, Math.floor(opts.warmSize ?? opts.poolSize)),
    idleTtlMs: Math.max(0, Math.floor(opts.idleTtlMs ?? 0)),
    queueMax: Math.max(0, Math.floor(opts.queueMax ?? 8)),
    queueTimeoutMs: Math.max(1, Math.floor(opts.queueTimeoutMs ?? 120_000)),
  });
}

function prepareStableEnvironment(
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

class ToolAcpWorker {
  readonly createdAt = Date.now();
  requestCount = 0;
  busy = false;
  broken = false;

  readonly #opts: ToolAcpPoolOptions;
  readonly #root: string;
  readonly #workspace: string;
  readonly #connection: AcpConnection;
  #handlers: ToolAcpConnectionHandlers = {};
  #ready?: Promise<void>;
  #readyDone = false;

  constructor(opts: ToolAcpPoolOptions) {
    this.#opts = opts;
    this.#root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-acp-tool-worker-"));
    this.#workspace = path.join(this.#root, "workspace");
    fs.mkdirSync(this.#workspace, { recursive: true });
    const env = prepareStableEnvironment(this.#root, opts.requestWorkspace, opts.env);
    const args = argsWithWorkspace(argsWithoutModel(opts.args), this.#workspace);
    this.#connection = new AcpConnection(opts.command, args, {
      cwd: this.#workspace,
      env,
      requestTimeoutMs: opts.requestTimeoutMs,
      spawnOptions: opts.spawnOptions,
      rawDebug: opts.rawDebug,
      onAgentTextChunk: (text) => this.#handlers.onAgentTextChunk?.(text),
      onAgentThoughtChunk: (text) => this.#handlers.onAgentThoughtChunk?.(text),
      onSessionUpdate: (update) => this.#handlers.onSessionUpdate?.(update),
      onPermission: (params) => this.#handlers.onPermission?.(params),
    });
  }

  get readyDone(): boolean {
    return this.#readyDone;
  }

  get connectionClosed(): boolean {
    return this.#connection.closed;
  }

  shouldRecycle(): boolean {
    return (
      this.broken ||
      this.#connection.closed ||
      this.requestCount >= safePositiveInt(this.#opts.maxRequests, 100) ||
      Date.now() - this.createdAt >= Math.max(60_000, this.#opts.maxAgeMs)
    );
  }

  async ready(): Promise<void> {
    if (!this.#ready) this.#ready = this.#initialize();
    return this.#ready;
  }

  async #initialize(): Promise<void> {
    let bridge: ExternalToolAdapter | undefined;
    let warmWorkspace: string | undefined;
    try {
      const initialized = await this.#connection.initialize();
      if (initialized.agentCapabilities?.mcpCapabilities?.http !== true) {
        throw new Error("Installed Cursor ACP agent does not support HTTP MCP servers");
      }
      if (!this.#opts.skipAuthenticate) await this.#connection.authenticate();

      // Cursor pays a ~5s one-time MCP attach cost on the first MCP-backed
      // session of an ACP connection. Pay it here, before serving traffic.
      bridge = new ExternalToolAdapter([]);
      await bridge.start();
      warmWorkspace = fs.mkdtempSync(path.join(this.#root, "warm-"));
      const warm = await this.#connection.newSession(warmWorkspace, [bridge.mcpServer]);
      if (!warm.sessionId) throw new Error("ACP tool warm-up returned no sessionId");
      await this.#connection.cancelSession(warm.sessionId).catch(() => undefined);
      this.#readyDone = true;
    } catch (error) {
      this.broken = true;
      throw error;
    } finally {
      await bridge?.close().catch(() => undefined);
      if (warmWorkspace) {
        try {
          fs.rmSync(warmWorkspace, { recursive: true, force: true });
        } catch {
          // best effort
        }
      }
    }
  }

  acquire(
    releaseWorker: (worker: ToolAcpWorker, reusable: boolean) => Promise<void>,
  ): ToolAcpConnectionLease {
    if (this.busy || !this.#readyDone || this.shouldRecycle()) {
      throw new Error("ACP tool worker is not available");
    }
    this.busy = true;
    this.requestCount += 1;
    let released = false;
    return {
      connection: this.#connection,
      setHandlers: (handlers) => {
        this.#handlers = { ...handlers };
      },
      release: async (reusable) => {
        if (released) return;
        released = true;
        this.#handlers = {};
        await releaseWorker(this, reusable);
      },
    };
  }

  markIdle(): void {
    this.busy = false;
  }

  async close(): Promise<void> {
    this.broken = true;
    this.#handlers = {};
    await this.#connection.close("SIGKILL").catch(() => undefined);
    try {
      fs.rmSync(this.#root, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

class ToolAcpPool {
  readonly #opts: ToolAcpPoolOptions;
  readonly #workers = new Set<ToolAcpWorker>();
  readonly #waiters: ToolAcpWaiter[] = [];
  #primePromise?: Promise<void>;
  #trimTimer?: ReturnType<typeof setTimeout>;
  #closed = false;

  constructor(opts: ToolAcpPoolOptions) {
    this.#opts = opts;
  }

  get targetSize(): number {
    return Math.max(0, Math.floor(this.#opts.poolSize));
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

  async prime(): Promise<void> {
    if (this.#closed) return;
    if (!this.#primePromise) this.#primePromise = this.#ensureSize(this.warmSize);
    try {
      await this.#primePromise;
    } finally {
      this.#primePromise = undefined;
    }
    this.#dispatchWaiters();
  }

  async #ensureSize(desired: number): Promise<void> {
    const target = Math.min(this.targetSize, Math.max(0, Math.floor(desired)));
    const tasks: Promise<void>[] = [];
    while (!this.#closed && this.#workers.size < target) {
      const worker = new ToolAcpWorker(this.#opts);
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

  async #scaleForDemand(): Promise<void> {
    if (this.#closed || this.#workers.size >= this.targetSize) return;
    const desired = Math.min(
      this.targetSize,
      Math.max(this.warmSize, this.#workers.size + Math.max(1, this.#waiters.length)),
    );
    await this.#ensureSize(desired);
    this.#dispatchWaiters();
  }

  tryAcquire(): ToolAcpConnectionLease | undefined {
    if (this.#closed || this.#waiters.length > 0) return undefined;
    const lease = this.#takeIdleLease();
    if (!lease && this.#workers.size < this.targetSize) {
      void this.#scaleForDemand().catch(() => undefined);
    }
    return lease;
  }

  async acquire(signal?: AbortSignal): Promise<ToolAcpConnectionLease> {
    if (this.#closed) throw new Error("ACP Tool connection pool is closed");
    if (signal?.aborted) {
      throw new ToolAcpQueueError(
        "ACP Tool queue request aborted",
        "tool_queue_aborted",
        499,
        0,
      );
    }

    await this.prime();
    if (this.#waiters.length === 0) {
      const lease = this.#takeIdleLease();
      if (lease) return lease;
    }

    const queueMax = Math.max(0, Math.floor(this.#opts.queueMax ?? 8));
    if (this.#waiters.length >= queueMax) {
      throw new ToolAcpQueueError(
        `ACP Tool queue is full (${this.#waiters.length}/${queueMax})`,
        "tool_queue_overloaded",
        429,
        2,
      );
    }

    return new Promise<ToolAcpConnectionLease>((resolve, reject) => {
      const waiter: ToolAcpWaiter = { resolve, reject, signal };
      const cleanup = () => {
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.timer = undefined;
        if (waiter.onAbort && waiter.signal) {
          waiter.signal.removeEventListener("abort", waiter.onAbort);
        }
        waiter.onAbort = undefined;
      };
      const remove = () => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
      };
      waiter.onAbort = () => {
        remove();
        cleanup();
        reject(
          new ToolAcpQueueError(
            "ACP Tool queue request aborted",
            "tool_queue_aborted",
            499,
            0,
          ),
        );
      };
      if (signal) signal.addEventListener("abort", waiter.onAbort, { once: true });
      const timeoutMs = Math.max(1, Math.floor(this.#opts.queueTimeoutMs ?? 120_000));
      waiter.timer = setTimeout(() => {
        remove();
        cleanup();
        reject(
          new ToolAcpQueueError(
            `ACP Tool queue wait timed out after ${timeoutMs}ms`,
            "tool_queue_timeout",
            429,
            2,
          ),
        );
      }, timeoutMs);
      waiter.timer.unref?.();
      const originalResolve = waiter.resolve;
      waiter.resolve = (lease) => {
        cleanup();
        originalResolve(lease);
      };
      const originalReject = waiter.reject;
      waiter.reject = (error) => {
        cleanup();
        originalReject(error);
      };
      this.#waiters.push(waiter);
      this.#dispatchWaiters();
      if (this.#waiters.includes(waiter) && this.#workers.size < this.targetSize) {
        void this.#scaleForDemand().catch((error) => {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          waiter.reject(error instanceof Error ? error : new Error(String(error)));
        });
      }
    });
  }

  #takeIdleLease(): ToolAcpConnectionLease | undefined {
    for (const worker of [...this.#workers]) {
      if (!worker.busy && worker.shouldRecycle()) {
        void this.#discard(worker);
      }
    }
    const worker = [...this.#workers].find(
      (candidate) => !candidate.busy && candidate.readyDone && !candidate.shouldRecycle(),
    );
    return worker?.acquire((candidate, reusable) => this.#release(candidate, reusable));
  }

  #dispatchWaiters(): void {
    if (this.#closed) return;
    while (this.#waiters.length > 0) {
      const waiter = this.#waiters[0]!;
      if (waiter.signal?.aborted) {
        this.#waiters.shift();
        waiter.reject(
          new ToolAcpQueueError(
            "ACP Tool queue request aborted",
            "tool_queue_aborted",
            499,
            0,
          ),
        );
        continue;
      }
      const lease = this.#takeIdleLease();
      if (!lease) break;
      this.#waiters.shift();
      waiter.resolve(lease);
    }
  }

  async #release(worker: ToolAcpWorker, reusable: boolean): Promise<void> {
    if (!this.#workers.has(worker)) return;
    if (!reusable || worker.connectionClosed || worker.shouldRecycle()) {
      await this.#discard(worker);
      return;
    }
    worker.markIdle();
    this.#dispatchWaiters();
    this.#scheduleTrim();
  }

  async #discard(worker: ToolAcpWorker): Promise<void> {
    if (!this.#workers.delete(worker)) return;
    await worker.close();
    if (!this.#closed) {
      const refill = this.#waiters.length > 0 ? this.#scaleForDemand() : this.prime();
      void refill
        .then(() => this.#dispatchWaiters())
        .catch((error) => {
          const waiters = this.#waiters.splice(0);
          for (const waiter of waiters) waiter.reject(
            error instanceof Error ? error : new Error(String(error)),
          );
        });
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
    const closing: Promise<void>[] = [];
    for (const worker of workers.filter((worker) => !worker.busy).reverse()) {
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

  snapshot(): Omit<ToolAcpPoolMetrics, "pools"> {
    const workers = this.#workers.size;
    const busy = [...this.#workers].filter((worker) => worker.busy).length;
    return {
      workers,
      warmSize: this.warmSize,
      poolSize: this.targetSize,
      idleTtlMs: this.idleTtlMs,
      busy,
      idle: Math.max(0, workers - busy),
      queued: this.#waiters.length,
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#trimTimer) clearTimeout(this.#trimTimer);
    this.#trimTimer = undefined;
    const waiters = this.#waiters.splice(0);
    for (const waiter of waiters) {
      waiter.reject(new Error("ACP Tool connection pool is closed"));
    }
    const workers = [...this.#workers];
    this.#workers.clear();
    await Promise.all(workers.map((worker) => worker.close()));
  }
}

const pools = new Map<string, ToolAcpPool>();

function getPool(opts: ToolAcpPoolOptions): ToolAcpPool {
  const key = poolKey(opts);
  let pool = pools.get(key);
  if (!pool) {
    pool = new ToolAcpPool(opts);
    pools.set(key, pool);
  }
  return pool;
}

export async function primeToolAcpPool(opts: ToolAcpPoolOptions): Promise<void> {
  if (opts.poolSize <= 0) return;
  await getPool(opts).prime();
}

export function tryAcquireToolAcpConnection(
  opts: ToolAcpPoolOptions,
): ToolAcpConnectionLease | undefined {
  if (opts.poolSize <= 0) return undefined;
  const pool = getPool(opts);
  const lease = pool.tryAcquire();
  if (!lease) void pool.prime().catch(() => undefined);
  return lease;
}

export async function acquireToolAcpConnection(
  opts: ToolAcpPoolOptions,
  signal?: AbortSignal,
): Promise<ToolAcpConnectionLease | undefined> {
  if (opts.poolSize <= 0) return undefined;
  return getPool(opts).acquire(signal);
}

export function getToolAcpPoolMetrics(): ToolAcpPoolMetrics {
  let workers = 0;
  let warmSize = 0;
  let poolSize = 0;
  let idleTtlMs = 0;
  let busy = 0;
  let idle = 0;
  let queued = 0;
  for (const pool of pools.values()) {
    const item = pool.snapshot();
    workers += item.workers;
    warmSize += item.warmSize;
    poolSize += item.poolSize;
    idleTtlMs = Math.max(idleTtlMs, item.idleTtlMs);
    busy += item.busy;
    idle += item.idle;
    queued += item.queued;
  }
  return { pools: pools.size, workers, warmSize, poolSize, idleTtlMs, busy, idle, queued };
}

export async function closeAllToolAcpPools(): Promise<void> {
  const active = [...pools.values()];
  pools.clear();
  await Promise.all(active.map((pool) => pool.close()));
}
