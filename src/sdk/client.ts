/**
 * SDK for calling astermux from another project.
 *
 * When autoStart is true (default), the SDK will start the proxy in the
 * background if it is not already reachable. Prerequisites: Cursor agent CLI
 * must be installed and set up separately (see README).
 */

const DEFAULT_BASE_URL = "http://127.0.0.1:8765";
const HEALTH_PATH = "/health";
const GATEWAY_START_TIMEOUT_MS = 15_000;
const GATEWAY_POLL_MS = 200;
const GATEWAY_STOP_TIMEOUT_MS = 5_000;
const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const;

export type AsterMuxClientOptions = {
  /** Gateway base URL (e.g. http://127.0.0.1:8765). Default: env ASTERMUX_URL or http://127.0.0.1:8765 */
  baseUrl?: string;
  /** Optional API key; if the proxy is started with ASTERMUX_API_KEY, pass it here. */
  apiKey?: string;
  /**
   * When true (default), start the proxy in the background if it is not reachable.
   * Only applies when using the default base URL. Set to false if you run the proxy yourself.
   */
  autoStart?: boolean;
};

export type AsterMuxFunctionTool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

export type AsterMuxToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type AsterMuxChatMessage = {
  role: string;
  content?: unknown;
  tool_calls?: AsterMuxToolCall[];
  tool_call_id?: string;
  name?: string;
};

export type AsterMuxChatCompletionsParams = {
  model?: string;
  messages: AsterMuxChatMessage[];
  stream?: false;
  tools?: AsterMuxFunctionTool[];
  tool_choice?: unknown;
  functions?: Array<{
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  }>;
  function_call?: unknown;
  parallel_tool_calls?: boolean;
};

export type AsterMuxResponsesParams = {
  model?: string;
  input: unknown;
  stream?: false;
  tools?: Array<{
    type: "function";
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  }>;
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  previous_response_id?: string;
  store?: boolean;
  [key: string]: unknown;
};

export type AsterMuxAnthropicMessagesParams = {
  model?: string;
  max_tokens: number;
  messages: Array<{ role: "user" | "assistant"; content: unknown }>;
  stream?: false;
  tools?: Array<{
    name: string;
    description?: string;
    input_schema: Record<string, unknown>;
  }>;
  tool_choice?: unknown;
  [key: string]: unknown;
};

let _gatewayProcess: import("node:child_process").ChildProcess | null = null;
let _managedGatewayStartupPromise: Promise<string> | null = null;
let _managedGatewayStartedBySdk = false;
let _shutdownHandlersInstalled = false;
let _signalCleanupInProgress = false;

function killManagedGatewaySync(): void {
  const child = _gatewayProcess;
  if (!child || !_managedGatewayStartedBySdk) return;
  if (child.exitCode == null) {
    try {
      child.kill("SIGTERM");
    } catch {}
  }
  _gatewayProcess = null;
  _managedGatewayStartedBySdk = false;
  _managedGatewayStartupPromise = null;
}

function installShutdownHandlers(): void {
  if (
    _shutdownHandlersInstalled ||
    typeof process === "undefined" ||
    !process?.on
  ) {
    return;
  }

  _shutdownHandlersInstalled = true;

  process.on("exit", () => {
    killManagedGatewaySync();
  });

  const handleSignal = async (signal: (typeof SHUTDOWN_SIGNALS)[number]) => {
    if (_signalCleanupInProgress) {
      return;
    }
    _signalCleanupInProgress = true;

    try {
      await stopManagedAsterMux();
    } finally {
      for (const value of SHUTDOWN_SIGNALS) {
        process.removeListener(value, signalHandlers[value]);
      }
      _signalCleanupInProgress = false;
      try {
        process.kill(process.pid, signal);
      } catch {
        process.exit(1);
      }
    }
  };

  const signalHandlers = {
    SIGINT: () => {
      void handleSignal("SIGINT");
    },
    SIGTERM: () => {
      void handleSignal("SIGTERM");
    },
    SIGHUP: () => {
      void handleSignal("SIGHUP");
    },
    SIGBREAK: () => {
      void handleSignal("SIGBREAK");
    },
  } satisfies Record<(typeof SHUTDOWN_SIGNALS)[number], () => void>;

  for (const signal of SHUTDOWN_SIGNALS) {
    process.on(signal, signalHandlers[signal]);
  }
}

function isDefaultBaseUrl(baseUrl: string): boolean {
  const u = baseUrl.replace(/\/$/, "");
  return u === DEFAULT_BASE_URL || u === "http://127.0.0.1:8765" || u === "http://localhost:8765";
}

async function pingHealth(baseUrl: string): Promise<boolean> {
  const url = `${baseUrl.replace(/\/$/, "")}${HEALTH_PATH}`;
  try {
    const res = await fetch(url, { method: "GET" });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Ensures the proxy is running at the given base URL. If the URL is the default
 * and the proxy is not reachable, starts it in the background (Node.js only).
 * Resolves when /health returns 200 or rejects on timeout.
 */
export async function ensureAsterMuxRunning(
  options: { baseUrl?: string; timeoutMs?: number } = {},
): Promise<string> {
  const baseUrl =
    options.baseUrl ??
    ((typeof process !== "undefined" && process.env?.ASTERMUX_URL) ||
      DEFAULT_BASE_URL);
  const root = baseUrl.replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? GATEWAY_START_TIMEOUT_MS;

  if (await pingHealth(root)) {
    return root;
  }

  if (!isDefaultBaseUrl(root)) {
    throw new Error(
      `astermux is not reachable at ${root}. Start it manually (e.g. npx astermux) or use the default URL for auto-start.`,
    );
  }

  const isNode =
    typeof process !== "undefined" &&
    process.versions?.node &&
    typeof globalThis.fetch !== "undefined";

  if (!isNode) {
    throw new Error(
      "astermux is not reachable. Start it manually (e.g. npx astermux). Auto-start is only available in Node.js.",
    );
  }

  if (_managedGatewayStartupPromise) {
    return _managedGatewayStartupPromise;
  }

  const startupPromise = (async () => {
    const { spawn } = await import("node:child_process");
    const pathMod = await import("node:path");
    const path = pathMod.default;
    const { fileURLToPath } = await import("node:url");

    const clientDir = path.dirname(fileURLToPath(import.meta.url));
    const cliPath = path.join(clientDir, "..", "entry", "cli.js");

    const child = spawn(process.execPath, [cliPath], {
      stdio: "ignore",
      detached: false,
      cwd: process.cwd(),
      env: process.env,
    });
    child.unref();
    installShutdownHandlers();
    _gatewayProcess = child;
    _managedGatewayStartedBySdk = true;

    let exitCode: number | null = null;
    child.on("error", () => {
      _gatewayProcess = null;
      _managedGatewayStartedBySdk = false;
    });
    child.on("exit", (code) => {
      exitCode = code ?? null;
      _gatewayProcess = null;
      _managedGatewayStartedBySdk = false;
    });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, GATEWAY_POLL_MS));
      if (await pingHealth(root)) {
        return root;
      }
      if (exitCode != null) {
        _gatewayProcess = null;
        _managedGatewayStartedBySdk = false;
        throw new Error(
          `astermux process exited with code ${exitCode} before becoming ready. Ensure Cursor CLI is installed (agent login).`,
        );
      }
    }

    if (_gatewayProcess) {
      _gatewayProcess.kill();
      _gatewayProcess = null;
    }
    _managedGatewayStartedBySdk = false;
    throw new Error(
      `astermux did not become ready within ${timeoutMs}ms. Ensure Cursor CLI is installed (agent login).`,
    );
  })();

  _managedGatewayStartupPromise = startupPromise;
  try {
    return await startupPromise;
  } finally {
    if (_managedGatewayStartupPromise === startupPromise) {
      _managedGatewayStartupPromise = null;
    }
  }
}

export async function stopManagedAsterMux(
  options: { timeoutMs?: number } = {},
): Promise<boolean> {
  const child = _gatewayProcess;
  if (!child || !_managedGatewayStartedBySdk) {
    return false;
  }

  const timeoutMs = options.timeoutMs ?? GATEWAY_STOP_TIMEOUT_MS;
  _managedGatewayStartupPromise = null;

  if (child.exitCode != null) {
    _gatewayProcess = null;
    _managedGatewayStartedBySdk = false;
    return true;
  }

  const exitPromise = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });

  child.kill("SIGTERM");

  const exited = await Promise.race([
    exitPromise.then(() => true),
    new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);

  if (!exited && child.exitCode == null) {
    child.kill("SIGKILL");
    await exitPromise;
  }

  _gatewayProcess = null;
  _managedGatewayStartedBySdk = false;
  return true;
}

/**
 * Options suitable for the OpenAI SDK constructor.
 * Use: new OpenAI(getOpenAIOptions())
 * For auto-starting the proxy first, use getOpenAIOptionsAsync() and await it.
 */
export function getOpenAIOptions(
  options: AsterMuxClientOptions = {},
): { baseURL: string; apiKey: string } {
  const baseUrl =
    options.baseUrl ??
    ((typeof process !== "undefined" && process.env?.ASTERMUX_URL) ||
      DEFAULT_BASE_URL);
  const baseURL = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl.replace(/\/$/, "")}/v1`;
  const apiKey =
    options.apiKey ??
    ((typeof process !== "undefined" && process.env?.ASTERMUX_API_KEY) ||
      "unused");
  return { baseURL, apiKey };
}

/**
 * Like getOpenAIOptions but ensures the proxy is running first (starts it in the background if needed).
 * Use: new OpenAI(await getOpenAIOptionsAsync())
 */
export async function getOpenAIOptionsAsync(
  options: AsterMuxClientOptions & { timeoutMs?: number } = {},
): Promise<{ baseURL: string; apiKey: string }> {
  const autoStart = options.autoStart !== false;
  const baseUrl =
    options.baseUrl ??
    ((typeof process !== "undefined" && process.env?.ASTERMUX_URL) ||
      DEFAULT_BASE_URL);
  const root = baseUrl.replace(/\/$/, "");

  if (autoStart && isDefaultBaseUrl(root)) {
    await ensureAsterMuxRunning({ baseUrl: root, timeoutMs: options.timeoutMs });
  }
  return getOpenAIOptions(options);
}

/**
 * Minimal client to call the proxy HTTP API.
 * When autoStart is true (default), the proxy is started in the background on first request if not reachable.
 */
export function createAsterMuxClient(options: AsterMuxClientOptions = {}) {
  const autoStart = options.autoStart !== false;
  const baseUrl =
    options.baseUrl ??
    ((typeof process !== "undefined" && process.env?.ASTERMUX_URL) ||
      DEFAULT_BASE_URL);
  const root = baseUrl.replace(/\/$/, "");
  const apiKeyRaw =
    options.apiKey ??
    (typeof process !== "undefined" ? process.env?.ASTERMUX_API_KEY : undefined);
  const apiKey = typeof apiKeyRaw === "string" ? apiKeyRaw : undefined;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };

  async function ensureThenRequest<T>(
    path: string,
    init: RequestInit,
  ): Promise<Response> {
    const url = path.startsWith("http")
      ? path
      : `${root}${path.startsWith("/") ? "" : "/"}${path}`;
    if (autoStart && isDefaultBaseUrl(root)) {
      await ensureAsterMuxRunning({ baseUrl: root });
    }
    return fetch(url, init);
  }

  return {
    /** Base URL of the proxy (no /v1 suffix) */
    baseUrl: root,
    /** Headers to send (Content-Type and optional Authorization) */
    headers,
    /** Get options for the OpenAI SDK constructor */
    getOpenAIOptions: () =>
      getOpenAIOptions({ baseUrl: root, apiKey: apiKey ?? "unused" }),

    /**
     * POST to a path (e.g. /v1/chat/completions). Body is JSON-serialized.
     */
    async request<T = unknown>(
      path: string,
      body: unknown,
    ): Promise<{ data: T; ok: boolean; status: number }> {
      const url = path.startsWith("http")
        ? path
        : `${root}${path.startsWith("/") ? "" : "/"}${path}`;
      const res = await ensureThenRequest(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as T;
      return { data, ok: res.ok, status: res.status };
    },

    /** OpenAI-style chat completions (non-streaming). */
    async chatCompletionsCreate(params: AsterMuxChatCompletionsParams) {
      const { data, ok, status } = await this.request<{
        choices?: Array<{
          message?: {
            content?: string | null;
            tool_calls?: AsterMuxToolCall[];
          };
          finish_reason?: "stop" | "tool_calls" | string;
        }>;
        error?: { message?: string };
      }>("/v1/chat/completions", {
        ...params,
        model: params.model ?? "default",
        stream: false,
      });
      if (!ok) {
        const err = data?.error?.message ?? JSON.stringify(data);
        throw new Error(`astermux error (${status}): ${err}`);
      }
      return data;
    },

    /** OpenAI Responses API (non-streaming), including function_call output. */
    async responsesCreate(params: AsterMuxResponsesParams) {
      const { data, ok, status } = await this.request<{
        id?: string;
        output_text?: string;
        output?: Array<{
          type?: string;
          call_id?: string;
          name?: string;
          arguments?: string;
        }>;
        error?: { message?: string };
      }>("/v1/responses", { ...params, stream: false });
      if (!ok) {
        const err = data?.error?.message ?? JSON.stringify(data);
        throw new Error(`astermux error (${status}): ${err}`);
      }
      return data;
    },

    /** Anthropic Messages API (non-streaming), including tool_use blocks. */
    async anthropicMessagesCreate(params: AsterMuxAnthropicMessagesParams) {
      const { data, ok, status } = await this.request<{
        id?: string;
        content?: Array<{
          type?: string;
          text?: string;
          id?: string;
          name?: string;
          input?: unknown;
        }>;
        stop_reason?: string;
        error?: { message?: string };
      }>("/v1/messages", { ...params, stream: false });
      if (!ok) {
        const err = data?.error?.message ?? JSON.stringify(data);
        throw new Error(`astermux error (${status}): ${err}`);
      }
      return data;
    },

    /**
     * Use for streaming: returns a fetch Response so you can read the body stream.
     * Ensures the proxy is running first when autoStart is true.
     */
    async fetch(path: string, init: RequestInit = {}): Promise<Response> {
      const url = path.startsWith("http")
        ? path
        : `${root}${path.startsWith("/") ? "" : "/"}${path}`;
      const merged = new Headers(init.headers);
      merged.set("Content-Type", "application/json");
      if (apiKey) merged.set("Authorization", `Bearer ${apiKey}`);
      return ensureThenRequest(url, { ...init, headers: merged });
    },
  };
}
