import {
  AcpConnection,
  permissionOption,
  type AcpConnectionOptions,
  type AcpPermissionParams,
  type AcpSessionResult,
} from "./transport.js";
import { configureAcpSessionModel } from "./session-client.js";
import type {
  ToolAcpConnectionHandlers,
  ToolAcpConnectionLease,
} from "./tool-pool.js";
import { ExternalToolAdapter } from "./external-tools.js";
import type {
  ClientToolDefinition,
  ClientToolOutput,
  PendingClientToolCall,
} from "../protocols/tools.js";

const TOOL_BATCH_IDLE_MS = 50;

export type ToolTurnEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string };

export type ToolTurnResult =
  | {
      status: "tool_calls";
      text: string;
      reasoning: string;
      toolCalls: PendingClientToolCall[];
    }
  | {
      status: "completed";
      text: string;
      reasoning: string;
      toolCalls: [];
      stderr: string;
    };

export type AcpToolSessionOptions = {
  command: string;
  args: readonly string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  timeoutMs: number;
  /** Idle lifetime only while waiting for the HTTP caller to return tool outputs. */
  ttlMs?: number;
  spawnOptions?: { windowsVerbatimArguments?: boolean };
  skipAuthenticate?: boolean;
  rawDebug?: boolean;
  signal?: AbortSignal;
  modelCandidates?: string[];
  strictModel?: boolean;
  tools: readonly ClientToolDefinition[];
  requireToolCall?: boolean;
  maxParallelToolCalls?: number;
  onClose?: () => void | Promise<void>;
  /** Optional pre-initialized ACP connection. The Tool session remains fresh. */
  connectionLease?: ToolAcpConnectionLease;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function toolCallId(value: unknown): string | undefined {
  const rec = record(value);
  return typeof rec?.toolCallId === "string" ? rec.toolCallId : undefined;
}

export class AcpToolSession {
  readonly bridge: ExternalToolAdapter;

  readonly #opts: AcpToolSessionOptions;
  readonly #toolUpdates = new Map<string, Record<string, unknown>>();
  #connection?: AcpConnection;
  #sessionId?: string;
  #promptDone?: Promise<{ ok: true } | { ok: false; error: Error }>;
  #text = "";
  #reasoning = "";
  #listener?: (event: ToolTurnEvent) => void;
  #parkedTtl?: ReturnType<typeof setTimeout>;
  #activeTimeout?: ReturnType<typeof setTimeout>;
  #activeTimeoutError?: Error;
  #closed = false;
  #terminal = false;
  #connectionLease?: ToolAcpConnectionLease;
  #abortHandler?: () => void;

  constructor(opts: AcpToolSessionOptions) {
    this.#opts = opts;
    this.bridge = new ExternalToolAdapter(opts.tools);
  }

  async start(prompt: string): Promise<void> {
    await this.bridge.start();
    try {
      const handlers: ToolAcpConnectionHandlers = {
        onAgentTextChunk: (text) => {
          this.#text += text;
          this.#listener?.({ type: "text", text });
        },
        onAgentThoughtChunk: (text) => {
          this.#reasoning += text;
          this.#listener?.({ type: "reasoning", text });
        },
        onSessionUpdate: (update) => {
          const id = toolCallId(update);
          if (!id) return;
          const prior = this.#toolUpdates.get(id) ?? {};
          this.#toolUpdates.set(id, { ...prior, ...update });
        },
        onPermission: (params) => this.#permissionFor(params),
      };

      if (this.#opts.connectionLease) {
        if (this.#opts.signal?.aborted) {
          throw new Error("ACP tool session aborted before start");
        }
        this.#connectionLease = this.#opts.connectionLease;
        this.#connectionLease.setHandlers(handlers);
        this.#connection = this.#connectionLease.connection;
        if (this.#opts.signal) {
          this.#abortHandler = () => void this.close();
          this.#opts.signal.addEventListener("abort", this.#abortHandler, { once: true });
        }
      } else {
        const connectionOptions: AcpConnectionOptions = {
          cwd: this.#opts.cwd,
          env: this.#opts.env,
          requestTimeoutMs: this.#opts.timeoutMs,
          spawnOptions: this.#opts.spawnOptions,
          rawDebug: this.#opts.rawDebug,
          signal: this.#opts.signal,
          ...handlers,
        };
        this.#connection = new AcpConnection(
          this.#opts.command,
          this.#opts.args,
          connectionOptions,
        );
        const initialized = await this.#connection.initialize();
        if (initialized.agentCapabilities?.mcpCapabilities?.http !== true) {
          throw new Error(
            "Installed Cursor ACP agent does not support HTTP MCP servers",
          );
        }
        if (!this.#opts.skipAuthenticate) {
          await this.#connection.authenticate();
        }
      }
      const session = await this.#connection.newSession(this.#opts.cwd, [
        this.bridge.mcpServer,
      ]);
      this.#sessionId = session.sessionId;
      if (!this.#sessionId) throw new Error("ACP session/new returned no sessionId");
      await this.#setModel(session);
      this.#promptDone = this.#connection
        .prompt(this.#sessionId, prompt, 0)
        .then(() => ({ ok: true }) as const)
        .catch((error: unknown) => ({
          ok: false as const,
          error: error instanceof Error ? error : new Error(String(error)),
        }));
      this.#enterActive();
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  get terminal(): boolean {
    return this.#terminal;
  }

  get closed(): boolean {
    return this.#closed;
  }

  hasCall(callId: string): boolean {
    return this.bridge.has(callId);
  }

  pendingCalls(): PendingClientToolCall[] {
    return this.bridge.pendingCalls();
  }

  async collect(
    listener?: (event: ToolTurnEvent) => void,
  ): Promise<ToolTurnResult> {
    if (!this.#promptDone) throw new Error("ACP tool session has not started");
    if (this.#closed) {
      throw this.#activeTimeoutError ?? new Error("ACP tool session is closed");
    }
    this.#listener = listener;

    const abort = new AbortController();
    const pendingBatch = this.#waitForToolBatch(abort.signal);
    const winner = await Promise.race([
      this.#promptDone.then((result) => ({ type: "prompt" as const, result })),
      pendingBatch.then((result) => ({ type: "tools" as const, result })),
    ]);
    abort.abort();
    this.#listener = undefined;

    if (winner.type === "tools" && winner.result === "ready") {
      const calls = this.bridge.pendingCalls();
      if (calls.length > 0) {
        if (
          this.#opts.maxParallelToolCalls != null &&
          calls.length > this.#opts.maxParallelToolCalls
        ) {
          await this.close();
          throw new Error(
            `Agent emitted ${calls.length} parallel tool calls; maximum is ${this.#opts.maxParallelToolCalls}`,
          );
        }
        this.bridge.markExposed(calls.map((call) => call.callId));
        const { text, reasoning } = this.#drainOutput();
        // Only now is the session actually parked: Cursor has emitted a Tool
        // call and is waiting for the HTTP caller to return a Tool result.
        this.#enterParked();
        return { status: "tool_calls", text, reasoning, toolCalls: calls };
      }
    }

    const promptResult =
      winner.type === "prompt" ? winner.result : await this.#promptDone;
    if (!promptResult.ok) {
      const error = this.#activeTimeoutError ?? promptResult.error;
      await this.close();
      throw error;
    }
    if (this.#opts.requireToolCall && this.bridge.totalCalls === 0) {
      await this.close();
      throw new Error("Agent completed without the required tool call");
    }
    this.#terminal = true;
    const { text, reasoning } = this.#drainOutput();
    const stderr = this.#connection?.stderr ?? "";
    await this.close();
    return {
      status: "completed",
      text,
      reasoning,
      toolCalls: [],
      stderr,
    };
  }

  async resume(
    outputs: readonly ClientToolOutput[],
    listener?: (event: ToolTurnEvent) => void,
  ): Promise<ToolTurnResult> {
    if (outputs.length === 0) {
      throw new Error("No tool outputs supplied");
    }
    if (this.#closed) {
      throw this.#activeTimeoutError ?? new Error("ACP tool session is closed");
    }
    // A resumed turn is active model execution again. The short parked TTL must
    // no longer be allowed to kill it while Cursor is processing the result.
    this.#enterActive();
    this.bridge.resolveOutputs(outputs);
    return this.collect(listener);
  }

  async close(opts: { reusableConnection?: boolean } = {}): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearLifecycleTimers();
    if (this.#abortHandler) {
      this.#opts.signal?.removeEventListener("abort", this.#abortHandler);
      this.#abortHandler = undefined;
    }
    this.#listener = undefined;
    this.bridge.rejectAll(new Error("ACP tool session closed"));
    if (this.#connection && this.#sessionId) {
      await this.#connection.cancelSession(this.#sessionId).catch(() => undefined);
    }
    await this.bridge.close().catch(() => undefined);
    if (this.#connectionLease) {
      // Stateless external-tool turns intentionally stop as soon as a client
      // tool call is surfaced. The ACP session is cancelled above, but the
      // authenticated connection itself remains safe to reuse for a fresh
      // session. Legacy parked mode still requires a terminal turn unless the
      // caller opts in explicitly.
      const reusable =
        (this.#terminal || opts.reusableConnection === true) &&
        !this.#connectionLease.connection.closed;
      await this.#connectionLease.release(reusable).catch(() => undefined);
      this.#connectionLease = undefined;
    } else {
      await this.#connection?.close("SIGKILL").catch(() => undefined);
    }
    await this.#opts.onClose?.();
  }

  async #setModel(session: AcpSessionResult): Promise<void> {
    if (!this.#connection || !this.#sessionId) return;
    const candidates = (this.#opts.modelCandidates ?? []).filter(Boolean);
    if (candidates.length === 0) return;
    await configureAcpSessionModel({
      requested: candidates[0]!,
      aliases: candidates.slice(1),
      strictModel: this.#opts.strictModel,
      session,
      setOption: (configId, value) =>
        this.#connection!.setSessionConfigOption(
          this.#sessionId!,
          configId,
          value,
        ),
    });
  }

  #permissionFor(params: AcpPermissionParams): string {
    const call = record(params.toolCall) ?? {};
    const id = toolCallId(call);
    const merged = id ? { ...(this.#toolUpdates.get(id) ?? {}), ...call } : call;
    const payload = JSON.stringify(merged).toLowerCase();
    const title =
      typeof merged.title === "string" ? merged.title.trim().toLowerCase() : "";
    const kind =
      typeof merged.kind === "string" ? merged.kind.trim().toLowerCase() : "";
    const gatewayOwned =
      this.bridge.listed &&
      kind === "other" &&
      (title === "mcp: tool" ||
        payload.includes(this.bridge.serverName.toLowerCase()));
    return permissionOption(
      params,
      gatewayOwned ? "allow_once" : "reject_once",
    );
  }

  #drainOutput(): { text: string; reasoning: string } {
    const text = this.#text.trim();
    const reasoning = this.#reasoning.trim();
    this.#text = "";
    this.#reasoning = "";
    return { text, reasoning };
  }

  #waitForToolBatch(signal: AbortSignal): Promise<"ready" | "aborted"> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        unsubscribe();
        signal.removeEventListener("abort", onAbort);
      };
      const finish = (value: "ready" | "aborted") => {
        cleanup();
        resolve(value);
      };
      const arm = () => {
        if (this.bridge.pendingCalls().length === 0) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => finish("ready"), TOOL_BATCH_IDLE_MS);
      };
      const onAbort = () => finish("aborted");
      const unsubscribe = this.bridge.onCall(arm);
      signal.addEventListener("abort", onAbort, { once: true });
      arm();
    });
  }

  #enterActive(): void {
    if (this.#parkedTtl) {
      clearTimeout(this.#parkedTtl);
      this.#parkedTtl = undefined;
    }
    if (this.#activeTimeout) clearTimeout(this.#activeTimeout);
    this.#activeTimeoutError = undefined;
    const timeoutMs = this.#opts.timeoutMs;
    if (timeoutMs <= 0) return;
    this.#activeTimeout = setTimeout(() => {
      this.#activeTimeoutError = new Error(
        `ACP tool execution timed out after ${timeoutMs}ms`,
      );
      void this.close();
    }, timeoutMs);
    this.#activeTimeout.unref?.();
  }

  #enterParked(): void {
    if (this.#activeTimeout) {
      clearTimeout(this.#activeTimeout);
      this.#activeTimeout = undefined;
    }
    if (this.#parkedTtl) clearTimeout(this.#parkedTtl);
    const ttlMs = this.#opts.ttlMs ?? this.#opts.timeoutMs;
    if (ttlMs <= 0) return;
    this.#parkedTtl = setTimeout(() => {
      void this.close();
    }, ttlMs);
    this.#parkedTtl.unref?.();
  }

  #clearLifecycleTimers(): void {
    if (this.#activeTimeout) {
      clearTimeout(this.#activeTimeout);
      this.#activeTimeout = undefined;
    }
    if (this.#parkedTtl) {
      clearTimeout(this.#parkedTtl);
      this.#parkedTtl = undefined;
    }
  }
}
