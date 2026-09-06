/**
 * ACP (Agent Client Protocol) client for Cursor CLI.
 * Spawns `agent acp` and communicates via JSON-RPC over stdio.
 * See https://cursor.com/docs/cli/acp and https://agentclientprotocol.com/
 */

import * as readline from "node:readline";
import { spawn } from "node:child_process";
import { debuglog } from "node:util";

import { trackChildProcess } from "../runtime/subprocess.js";
import { DETACH_CHILDREN, killProcessTree } from "../runtime/process-tree.js";

const debugAcp = debuglog("astermux:acp");

export type AcpRunOptions = {
  cwd: string;
  timeoutMs: number;
  env?: Record<string, string | undefined>;
  /** When set, call session/set_config_option for "model" after session/new (ACP session config). */
  model?: string;
  /** Additional catalog names for model matching (typically `agent --list-models` display name). */
  modelAliases?: string[];
  /** Reject a requested model when the ACP catalog cannot match it. */
  strictModel?: boolean;
  /** Per-request timeout in ms (default 60000). Rejects and clears pending on timeout. */
  requestTimeoutMs?: number;
  /** Spawn options (e.g. windowsVerbatimArguments for cmd.exe fallback on Windows). */
  spawnOptions?: { windowsVerbatimArguments?: boolean };
  /** When true, skip authenticate step (use when pre-authenticated via --api-key or agent login). */
  skipAuthenticate?: boolean;
  /** When true, log every raw JSON-RPC line from ACP stdout (very verbose). */
  rawDebug?: boolean;
  /** When aborted, the ACP child is killed (same as CLI path). */
  signal?: AbortSignal;
};

export type AcpSyncResult = {
  code: number;
  /** Assistant message text only (never includes agent_thought_chunk). */
  stdout: string;
  stderr: string;
  /**
   * Concatenated agent_thought_chunk text for this turn.
   * Present when any thought arrived; callers decide drop vs reasoning_content.
   */
  reasoning?: string;
};

export type AcpStreamResult = {
  code: number;
  stderr: string;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/** Avoid passing the entire parent environment into ACP children (may contain unrelated secrets). */
function buildAcpSpawnEnv(
  extra?: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  const inheritKeys = [
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "USERNAME",
    "HOME",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PROGRAMDATA",
    "PUBLIC",
    "NODE_OPTIONS",
  ];
  const out: NodeJS.ProcessEnv = {};
  for (const k of inheritKeys) {
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
  }
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v !== undefined) out[k] = v;
    }
  }
  return out;
}

type AcpParsedMsg = {
  id?: number;
  method?: string;
  params?: { update?: { sessionUpdate?: string; content?: { text?: string } } };
  result?: unknown;
  error?: { message?: string };
};

/** Normalise CRLF / stray CR so JSON-RPC lines parse on Windows (avoids silent hangs). */
function parseAcpStdoutLine(line: string): AcpParsedMsg | null {
  const t = line.replace(/\r$/, "").trim();
  if (!t) return null;
  try {
    return JSON.parse(t) as AcpParsedMsg;
  } catch {
    return null;
  }
}

/** Extract text payload from an ACP session/update content field. */
export function extractAcpUpdateText(
  content:
    | { text?: string }
    | Array<{ content?: { text?: string }; text?: string }>
    | undefined
    | null,
): string {
  if (
    typeof content === "object" &&
    content !== null &&
    !Array.isArray(content) &&
    typeof (content as { text?: string }).text === "string"
  ) {
    return (content as { text: string }).text;
  }
  if (Array.isArray(content)) {
    return content
      .map((c: { content?: { text?: string }; text?: string }) =>
        typeof c?.content?.text === "string"
          ? c.content.text
          : typeof c?.text === "string"
            ? c.text
            : "",
      )
      .join("");
  }
  return "";
}

/**
 * Handle ACP server→client notifications (session/update chunks, permissions, cursor/*).
 * Returns true if the message was consumed as a notification.
 *
 * Thought and message are separate channels: callers must not mix them into content.
 */
function handleAcpNotification(
  msg: AcpParsedMsg,
  opts: {
    rawDebug?: boolean;
    stdin: NodeJS.WritableStream | null | undefined;
    onAgentTextChunk?: (text: string) => void;
    onAgentThoughtChunk?: (text: string) => void;
  },
): boolean {
  if (msg.method === "session/update") {
    const update = (msg.params?.update ?? msg.params) as {
      sessionUpdate?: string;
      content?: { text?: string } | Array<{ content?: { text?: string }; text?: string }>;
    } | undefined;
    const content = update?.content;
    const text = extractAcpUpdateText(content);
    const sessionUpdate = update?.sessionUpdate;
    if (sessionUpdate === "agent_message_chunk" && text) {
      opts.onAgentTextChunk?.(text);
    } else if (sessionUpdate === "agent_thought_chunk" && text) {
      opts.onAgentThoughtChunk?.(text);
    } else if (
      sessionUpdate &&
      sessionUpdate !== "agent_thought_chunk" &&
      sessionUpdate !== "available_commands_update" &&
      sessionUpdate !== "tool_call" &&
      sessionUpdate !== "tool_call_update"
    ) {
      debugAcp(
        "session/update (unhandled): %s",
        JSON.stringify({
          sessionUpdate,
          hasContent: !!content,
          contentKeys: content && typeof content === "object" && !Array.isArray(content) ? Object.keys(content) : [],
        }),
      );
    }
    return true;
  }

  if (msg.method === "session/request_permission") {
    if (msg.id != null && opts.stdin) {
      respond(opts.stdin, msg.id, {
        outcome: { outcome: "selected", optionId: "reject-once" },
      });
    }
    return true;
  }

  if (msg.id != null && msg.method && opts.stdin) {
    const method = String(msg.method);
    if (method.startsWith("cursor/")) {
      const params = msg.params as Record<string, unknown> | undefined;
      if (method === "cursor/ask_question" && params?.options && Array.isArray(params.options)) {
        const options = params.options as Array<{ id?: string; label?: string }>;
        const first = options[0];
        console.warn(
          "[astermux:acp] cursor/ask_question auto-selecting first option: id=%s (total=%d)",
          first?.id ?? "(none)",
          options.length,
        );
        respond(opts.stdin, msg.id, { selectedId: first?.id ?? "" });
      } else if (method === "cursor/create_plan") {
        respond(opts.stdin, msg.id, { approved: true });
      } else {
        console.warn(
          "[astermux:acp] auto-responding to unknown %s with empty result",
          method,
        );
        respond(opts.stdin, msg.id, {});
      }
      return true;
    }
  }

  return false;
}

export type AcpAvailableModel = { modelId: string; name: string };

/**
 * Map OpenAI-style display name to Cursor ACP `modelId` (e.g. `composer-2` → `composer-2[fast=true]`).
 * If `availableModels` is missing or empty, returns `displayName` unchanged.
 * If the list is non-empty but no row matches `name`, logs via debug and falls back to session default.
 * Duplicate `name` entries: first match wins.
 */
export function resolveAcpModelConfigValue(
  displayName: string,
  availableModels: AcpAvailableModel[] | undefined,
  aliases: readonly string[] = [],
): string {
  if (!availableModels?.length) return displayName;
  const candidates = new Set(
    [displayName, ...aliases]
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  const hit = availableModels.find((model) => {
    const modelId = model.modelId.trim().toLowerCase();
    const baseModelId = modelId.replace(/\[.*$/, "");
    return (
      candidates.has(model.name.trim().toLowerCase()) ||
      candidates.has(modelId) ||
      candidates.has(baseModelId)
    );
  });
  if (!hit) {
    debugAcp(
      "ACP model: no catalog match for display name %j; falling back to default[]",
      displayName,
    );
    return "default[]";
  }
  return hit.modelId;
}


type AcpConfigChoiceLike = {
  value?: string;
  name?: string;
  description?: string;
};

type AcpConfigOptionLike = {
  id?: string;
  name?: string;
  description?: string;
  category?: string;
  type?: string;
  currentValue?: string | boolean;
  options?: Array<
    | AcpConfigChoiceLike
    | { group?: string; options?: AcpConfigChoiceLike[] }
  >;
};

export type AcpSessionModelMetadata = {
  models?: { availableModels?: AcpAvailableModel[] };
  configOptions?: AcpConfigOptionLike[];
};

export type AcpSessionModelSelection = {
  configId: string;
  value: string;
  viaConfigOptions: boolean;
};

export type AcpSessionConfigUpdate = {
  configId: string;
  value: string | boolean;
  semantic: "effort" | "fast" | "thinking" | "context";
};

type PublicModelHints = {
  base: string;
  effort?: string;
  fast?: boolean;
  thinking?: boolean;
  context?: string;
};

function flattenConfigChoices(
  option: AcpConfigOptionLike | undefined,
): AcpConfigChoiceLike[] {
  const out: AcpConfigChoiceLike[] = [];
  for (const item of option?.options ?? []) {
    if (!item || typeof item !== "object") continue;
    if (Array.isArray((item as { options?: unknown }).options)) {
      out.push(...((item as { options: AcpConfigChoiceLike[] }).options ?? []));
      continue;
    }
    out.push(item as AcpConfigChoiceLike);
  }
  return out;
}

function splitCompoundModel(value: string): {
  base: string;
  params: Map<string, string>;
} {
  const trimmed = value.trim();
  const match = trimmed.match(/^([^\[]+)(?:\[(.*)\])?$/);
  const base = (match?.[1] ?? trimmed).trim();
  const params = new Map<string, string>();
  for (const part of (match?.[2] ?? "").split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const val = part.slice(eq + 1).trim().toLowerCase();
    if (key) params.set(key, val);
  }
  return { base, params };
}

function normalizeEffort(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const key = value.trim().toLowerCase().replace(/[ _]+/g, "-");
  if (key === "extra-high" || key === "extra-high-reasoning") return "xhigh";
  if (["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(key)) {
    return key;
  }
  return undefined;
}

function normalizeContext(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const raw = value.trim().toLowerCase();
  const match = raw.match(
    /(?:^|[^a-z0-9])(\d+(?:\.\d+)?)(k|m)(?=$|[^a-z0-9])/i,
  );
  return match ? `${match[1]}${match[2].toLowerCase()}` : undefined;
}

function publicModelHints(value: string): PublicModelHints {
  const compound = splitCompoundModel(value.trim().toLowerCase());
  let base = compound.base;
  let fast = compound.params.has("fast")
    ? compound.params.get("fast") === "true"
    : undefined;
  let effort = normalizeEffort(
    compound.params.get("reasoning") ?? compound.params.get("effort"),
  );
  let thinking = compound.params.has("thinking")
    ? compound.params.get("thinking") === "true"
    : undefined;
  let context = normalizeContext(compound.params.get("context"));

  if (base.endsWith("-fast")) {
    fast = true;
    base = base.slice(0, -5);
  } else if (fast === undefined) {
    // Public `--list-models` exposes standard and `-fast` as separate rows.
    fast = false;
  }

  const efforts = ["extra-high", "minimal", "medium", "xhigh", "high", "none", "low", "max"];
  const effortSuffix = efforts.find((item) => base.endsWith(`-${item}`));
  if (effortSuffix) {
    effort = normalizeEffort(effortSuffix);
    base = base.slice(0, -(effortSuffix.length + 1));
  }

  if (base.endsWith("-thinking")) {
    thinking = true;
    base = base.slice(0, -9);
  }

  // `cursor-` is a public API namespace prefix; ACP commonly exposes the
  // underlying model without it (for example cursor-grok-* -> grok-*).
  if (base.startsWith("cursor-")) base = base.slice("cursor-".length);

  if (!context) context = normalizeContext(value);
  return { base, effort, fast, thinking, context };
}

function mergePublicModelHints(
  displayName: string,
  aliases: readonly string[],
): PublicModelHints {
  const primary = publicModelHints(displayName);
  const merged = { ...primary };
  for (const alias of aliases) {
    const hint = publicModelHints(alias);
    if (!merged.effort && hint.effort) merged.effort = hint.effort;
    if (merged.fast === undefined && hint.fast !== undefined) merged.fast = hint.fast;
    if (merged.thinking === undefined && hint.thinking !== undefined) {
      merged.thinking = hint.thinking;
    }
    if (!merged.context && hint.context) merged.context = hint.context;
  }
  return merged;
}

function friendlyModelKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/^cursor[-\s]+/, "")
    .replace(/\b(?:1m|300k|272k|256k|200k|fast|thinking|extra[- ]high|xhigh|high|medium|low|minimal|none|max)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function modelChoiceScore(
  choice: AcpConfigChoiceLike,
  hints: PublicModelHints,
): number {
  if (typeof choice.value !== "string") return Number.NEGATIVE_INFINITY;
  const parsed = splitCompoundModel(choice.value);
  if (publicModelHints(parsed.base).base !== hints.base) {
    return Number.NEGATIVE_INFINITY;
  }
  let score = 10;
  const effort = normalizeEffort(
    parsed.params.get("reasoning") ?? parsed.params.get("effort"),
  );
  const fast = parsed.params.has("fast")
    ? parsed.params.get("fast") === "true"
    : undefined;
  const thinking = parsed.params.has("thinking")
    ? parsed.params.get("thinking") === "true"
    : undefined;
  const context = normalizeContext(parsed.params.get("context"));
  if (hints.effort && effort) score += hints.effort === effort ? 4 : -4;
  if (hints.fast !== undefined && fast !== undefined) score += hints.fast === fast ? 2 : -2;
  if (hints.thinking !== undefined && thinking !== undefined) {
    score += hints.thinking === thinking ? 2 : -2;
  }
  if (hints.context && context) score += hints.context === context ? 2 : -2;
  return score;
}

/** Resolve the exact model selector id/value advertised by this ACP session. */
export function resolveAcpSessionModelSelection(
  displayName: string,
  session: AcpSessionModelMetadata | undefined,
  aliases: readonly string[] = [],
): AcpSessionModelSelection {
  const modelOption = session?.configOptions?.find(
    (option) => option?.category === "model" || option?.id === "model",
  );
  const choices = flattenConfigChoices(modelOption);
  if (choices.length > 0) {
    const candidates = [displayName, ...aliases].filter(Boolean);
    const lower = new Set(candidates.map((value) => value.trim().toLowerCase()));
    const friendly = new Set(candidates.map(friendlyModelKey).filter(Boolean));
    const hints = mergePublicModelHints(displayName, aliases);

    let hit = choices.find((choice) => {
      const value = choice.value?.trim().toLowerCase();
      const name = choice.name?.trim().toLowerCase();
      return Boolean((value && lower.has(value)) || (name && lower.has(name)));
    });

    if (!hit) {
      const ranked = choices
        .map((choice) => ({ choice, score: modelChoiceScore(choice, hints) }))
        .filter((item) => Number.isFinite(item.score))
        .sort((a, b) => b.score - a.score);
      hit = ranked[0]?.choice;
    }

    if (!hit) {
      hit = choices.find((choice) => {
        const keys = [choice.value, choice.name]
          .filter((value): value is string => typeof value === "string")
          .map(friendlyModelKey)
          .filter(Boolean);
        return keys.some((key) => friendly.has(key));
      });
    }

    if (!hit && candidates.some((value) => /^(?:default|auto)$/i.test(value))) {
      hit = choices.find((choice) =>
        /^(?:default(?:\[\])?|auto(?:-smart)?)$/i.test(
          choice.value ?? choice.name ?? "",
        ),
      );
    }

    if (typeof hit?.value === "string" && hit.value.trim()) {
      return {
        configId: modelOption?.id?.trim() || "model",
        value: hit.value.trim(),
        viaConfigOptions: true,
      };
    }
    // A model selector was advertised, so an unmatched request is a real
    // catalog miss rather than permission to invent an arbitrary value.
    return {
      configId: modelOption?.id?.trim() || "model",
      value: "default[]",
      viaConfigOptions: true,
    };
  }

  return {
    configId: "model",
    value: resolveAcpModelConfigValue(
      displayName,
      session?.models?.availableModels,
      aliases,
    ),
    viaConfigOptions: false,
  };
}

/** Backward-compatible value-only wrapper used by older callers/tests. */
export function resolveAcpSessionModelConfigValue(
  displayName: string,
  session: AcpSessionModelMetadata | undefined,
  aliases: readonly string[] = [],
): string {
  return resolveAcpSessionModelSelection(displayName, session, aliases).value;
}

function optionSemantic(option: AcpConfigOptionLike): AcpSessionConfigUpdate["semantic"] | undefined {
  const key = `${option.id ?? ""} ${option.name ?? ""} ${option.description ?? ""}`
    .toLowerCase();
  if (option.category === "thought_level") return "effort";
  if (option.category !== "model_config") return undefined;
  if (/\b(?:fast|speed|latency)\b/.test(key)) return "fast";
  if (/\b(?:context|window)\b/.test(key)) return "context";
  if (/\b(?:thinking|think)\b/.test(key)) return "thinking";
  if (/\b(?:reasoning|effort|thought)\b/.test(key)) return "effort";
  return undefined;
}

function desiredSemanticValue(
  semantic: AcpSessionConfigUpdate["semantic"],
  hints: PublicModelHints,
): string | boolean | undefined {
  if (semantic === "effort") return hints.effort;
  if (semantic === "fast") return hints.fast;
  if (semantic === "thinking") return hints.thinking;
  return hints.context;
}

function normalizeChoiceToken(value: string): string {
  const effort = normalizeEffort(value);
  if (effort) return effort;
  const context = normalizeContext(value);
  if (context) return context;
  return value.trim().toLowerCase().replace(/[ _]+/g, "-");
}

/**
 * Resolve only exact values explicitly advertised by the Agent for secondary
 * model controls. No synthetic config values are generated.
 */
export function resolveAcpSessionVariantConfigUpdates(
  displayName: string,
  aliases: readonly string[],
  configOptions: readonly AcpConfigOptionLike[] | undefined,
): AcpSessionConfigUpdate[] {
  const hints = mergePublicModelHints(displayName, aliases);
  const updates: AcpSessionConfigUpdate[] = [];
  for (const option of configOptions ?? []) {
    const semantic = optionSemantic(option);
    if (!semantic || !option.id) continue;
    const desired = desiredSemanticValue(semantic, hints);
    if (desired === undefined) continue;

    if (option.type === "boolean" || typeof option.currentValue === "boolean") {
      if (typeof desired !== "boolean" || option.currentValue === desired) continue;
      updates.push({ configId: option.id, value: desired, semantic });
      continue;
    }

    if (typeof desired !== "string") continue;
    const target = normalizeChoiceToken(desired);
    const hit = flattenConfigChoices(option).find((choice) => {
      const values = [choice.value, choice.name]
        .filter((value): value is string => typeof value === "string")
        .map(normalizeChoiceToken);
      return values.includes(target);
    });
    if (typeof hit?.value !== "string") continue;
    if (String(option.currentValue ?? "") === hit.value) continue;
    updates.push({ configId: option.id, value: hit.value, semantic });
  }
  return updates;
}


export async function configureAcpSessionModel(args: {
  requested: string;
  aliases?: readonly string[];
  strictModel?: boolean;
  session: AcpSessionModelMetadata;
  setOption: (
    configId: string,
    value: string | boolean,
  ) => Promise<{ configOptions?: AcpConfigOptionLike[] } | undefined>;
}): Promise<void> {
  const aliases = args.aliases ?? [];
  const selection = resolveAcpSessionModelSelection(
    args.requested,
    args.session,
    aliases,
  );
  if (
    selection.value === "default[]" &&
    args.strictModel &&
    args.requested !== "default"
  ) {
    throw new Error(
      `ACP model catalog has no match for ${JSON.stringify(args.requested)}`,
    );
  }

  let activeConfigOptions = args.session.configOptions;
  const shouldSetModel =
    selection.viaConfigOptions ||
    (selection.value !== "default" && selection.value !== "default[]");
  if (shouldSetModel) {
    const changed = await args.setOption(selection.configId, selection.value);
    activeConfigOptions = changed?.configOptions ?? activeConfigOptions;
  }

  // Config options may depend on the selected model. ACP returns the complete
  // updated config set after every change, so re-resolve against the latest
  // state instead of assuming all selectors are static.
  const applied = new Set<string>();
  for (let i = 0; i < 8; i += 1) {
    const update = resolveAcpSessionVariantConfigUpdates(
      args.requested,
      aliases,
      activeConfigOptions,
    ).find((item) => !applied.has(item.configId));
    if (!update) break;
    const changed = await args.setOption(update.configId, update.value);
    applied.add(update.configId);
    activeConfigOptions = changed?.configOptions ?? activeConfigOptions;
  }
}

function sendRequest(
  stdin: NodeJS.WritableStream,
  nextId: { current: number },
  method: string,
  params: object,
  pending: Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void; timerId?: ReturnType<typeof setTimeout> }
  >,
  requestTimeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<unknown> {
  const id = nextId.current++;
  const line =
    JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
  stdin.write(line, "utf8");
  return new Promise((resolve, reject) => {
    let timerId: ReturnType<typeof setTimeout> | undefined;
    if (requestTimeoutMs > 0) {
      timerId = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`ACP ${method} timed out after ${requestTimeoutMs}ms`));
        }
      }, requestTimeoutMs);
    }
    pending.set(id, {
      resolve: (v) => {
        if (timerId) clearTimeout(timerId);
        resolve(v);
      },
      reject: (e) => {
        if (timerId) clearTimeout(timerId);
        reject(e);
      },
      timerId,
    });
  });
}

function respond(stdin: NodeJS.WritableStream, id: number, result: object): void {
  const line = JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n";
  stdin.write(line, "utf8");
}

/**
 * Run a single prompt via ACP and return the full response (sync).
 * Uses pre-resolved command + args (e.g. node + script on Windows) to avoid spawn EINVAL and DEP0190.
 */
export function runAcpSync(
  command: string,
  args: string[],
  prompt: string,
  opts: AcpRunOptions,
): Promise<AcpSyncResult> {
  const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: buildAcpSpawnEnv(opts.env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsVerbatimArguments: opts.spawnOptions?.windowsVerbatimArguments,
      detached: DETACH_CHILDREN,
    });

    trackChildProcess(child);

    let stderr = "";
    let accumulated = "";
    let accumulatedThought = "";
    let resolved = false;

    const onAbort = () => {
      killProcessTree(child, "SIGTERM");
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    const finish = (code: number) => {
      if (resolved) return;
      resolved = true;
      opts.signal?.removeEventListener("abort", onAbort);
      const exitErr = new Error(`ACP child exited with code ${code}`);
      for (const [id, waiter] of Array.from(pending.entries())) {
        pending.delete(id);
        if (waiter.timerId) clearTimeout(waiter.timerId);
        waiter.reject(exitErr);
      }
      try {
        child.stdin?.end();
      } catch {
        /* ignore */
      }
      killProcessTree(child, "SIGKILL");
      const reasoning = accumulatedThought.trim();
      resolve({
        code,
        stdout: accumulated.trim(),
        stderr: stderr.trim(),
        ...(reasoning ? { reasoning } : {}),
      });
    };

    const timeout =
      opts.timeoutMs > 0
        ? setTimeout(() => {
            finish(124); // timeout exit code
          }, opts.timeoutMs)
        : undefined;

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => (stderr += chunk));

    const nextId = { current: 1 };
    const pending = new Map<
      number,
      { resolve: (value: unknown) => void; reject: (err: Error) => void; timerId?: ReturnType<typeof setTimeout> }
    >();

    const rl = readline.createInterface({ input: child.stdout! });
    rl.on("line", (line: string) => {
      try {
        if (opts.rawDebug) {
          debugAcp("ACP raw: %s", line);
        }
        const msg = parseAcpStdoutLine(line);
        if (!msg) return;

        if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
          const reqId = typeof msg.id === "number" ? msg.id : Number(msg.id);
          const waiter = Number.isFinite(reqId) ? pending.get(reqId) : undefined;
          if (waiter) {
            pending.delete(reqId);
            if (msg.error) {
              waiter.reject(new Error(msg.error.message ?? "ACP error"));
            } else {
              waiter.resolve(msg.result);
            }
          }
          return;
        }

        handleAcpNotification(msg, {
          rawDebug: opts.rawDebug,
          stdin: child.stdin,
          onAgentTextChunk: (text) => {
            accumulated += text;
          },
          onAgentThoughtChunk: (text) => {
            accumulatedThought += text;
          },
        });
      } catch {
        /* ignore notification handler errors */
      }
    });

    child.on("error", (err) => {
      if (timeout) clearTimeout(timeout);
      opts.signal?.removeEventListener("abort", onAbort);
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });

    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      finish(code ?? 1);
    });

    const run = async () => {
      if (!child.stdin) {
        finish(1);
        return;
      }
      try {
        debugAcp("ACP step: initialize");
        await sendRequest(child.stdin, nextId, "initialize", {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: "astermux", version: "0.1.0" },
        }, pending, requestTimeoutMs);

        if (!opts.skipAuthenticate) {
          debugAcp("ACP step: authenticate");
          await sendRequest(child.stdin, nextId, "authenticate", {
            methodId: "cursor_login",
          }, pending, requestTimeoutMs);
        } else {
          debugAcp("ACP step: authenticate (skipped, pre-authenticated)");
        }

        debugAcp("ACP step: session/new");
        const sessionResult = (await sendRequest(
          child.stdin,
          nextId,
          "session/new",
          { cwd: opts.cwd, mcpServers: [] },
          pending,
          requestTimeoutMs,
        )) as {
          sessionId?: string;
          models?: { availableModels?: AcpAvailableModel[] };
          configOptions?: AcpConfigOptionLike[];
        };
        const sessionId = sessionResult?.sessionId;
        if (!sessionId) {
          finish(1);
          return;
        }

        if (opts.model) {
          await configureAcpSessionModel({
            requested: opts.model,
            aliases: opts.modelAliases,
            strictModel: opts.strictModel,
            session: sessionResult,
            setOption: async (configId, value) =>
              (await sendRequest(
                child.stdin,
                nextId,
                "session/set_config_option",
                {
                  sessionId,
                  configId,
                  ...(typeof value === "boolean" ? { type: "boolean" } : {}),
                  value,
                },
                pending,
                requestTimeoutMs,
              )) as { configOptions?: AcpConfigOptionLike[] },
          });
        }

        debugAcp("ACP step: session/prompt");
        await sendRequest(child.stdin, nextId, "session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: prompt }],
        }, pending, requestTimeoutMs);
        if (accumulated.length === 0) {
          debugAcp("ACP sync: no content accumulated; stderr tail: %s", stderr.slice(-500));
        }
        finish(0);
      } catch {
        if (timeout) clearTimeout(timeout);
        if (!resolved) {
          finish(1);
        }
      }
    };

    run();
  });
}

/**
 * Run a single prompt via ACP and stream response chunks via onChunk.
 */
export function runAcpStream(
  command: string,
  args: string[],
  prompt: string,
  opts: AcpRunOptions,
  onChunk: (text: string) => void,
): Promise<AcpStreamResult> {
  const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: buildAcpSpawnEnv(opts.env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsVerbatimArguments: opts.spawnOptions?.windowsVerbatimArguments,
      detached: DETACH_CHILDREN,
    });

    trackChildProcess(child);

    let stderr = "";
    let resolved = false;

    const onAbort = () => {
      killProcessTree(child, "SIGTERM");
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    const finish = (code: number) => {
      if (resolved) return;
      resolved = true;
      opts.signal?.removeEventListener("abort", onAbort);
      const exitErr = new Error(`ACP child exited with code ${code}`);
      for (const [id, waiter] of Array.from(pending.entries())) {
        pending.delete(id);
        if (waiter.timerId) clearTimeout(waiter.timerId);
        waiter.reject(exitErr);
      }
      try {
        child.stdin?.end();
      } catch {
        /* ignore */
      }
      killProcessTree(child, "SIGKILL");
      resolve({ code, stderr: stderr.trim() });
    };

    const timeout =
      opts.timeoutMs > 0
        ? setTimeout(() => finish(124), opts.timeoutMs)
        : undefined;

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => (stderr += chunk));

    const nextId = { current: 1 };
    const pending = new Map<
      number,
      { resolve: (value: unknown) => void; reject: (err: Error) => void; timerId?: ReturnType<typeof setTimeout> }
    >();

    const rl = readline.createInterface({ input: child.stdout! });
    rl.on("line", (line: string) => {
      try {
        if (opts.rawDebug) {
          debugAcp("ACP raw: %s", line);
        }
        const msg = parseAcpStdoutLine(line);
        if (!msg) return;

        if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
          const reqId = typeof msg.id === "number" ? msg.id : Number(msg.id);
          const waiter = Number.isFinite(reqId) ? pending.get(reqId) : undefined;
          if (waiter) {
            pending.delete(reqId);
            if (msg.error) {
              waiter.reject(new Error(msg.error.message ?? "ACP error"));
            } else {
              waiter.resolve(msg.result);
            }
          }
          return;
        }

        handleAcpNotification(msg, {
          rawDebug: opts.rawDebug,
          stdin: child.stdin,
          onAgentTextChunk: onChunk,
        });
      } catch {
        /* ignore notification handler errors */
      }
    });

    child.on("error", (err) => {
      if (timeout) clearTimeout(timeout);
      opts.signal?.removeEventListener("abort", onAbort);
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });

    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      finish(code ?? 1);
    });

    const run = async () => {
      if (!child.stdin) {
        finish(1);
        return;
      }
      try {
        debugAcp("ACP step: initialize");
        await sendRequest(child.stdin, nextId, "initialize", {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: "astermux", version: "0.1.0" },
        }, pending, requestTimeoutMs);

        if (!opts.skipAuthenticate) {
          debugAcp("ACP step: authenticate");
          await sendRequest(child.stdin, nextId, "authenticate", {
            methodId: "cursor_login",
          }, pending, requestTimeoutMs);
        } else {
          debugAcp("ACP step: authenticate (skipped, pre-authenticated)");
        }

        debugAcp("ACP step: session/new");
        const sessionResult = (await sendRequest(
          child.stdin,
          nextId,
          "session/new",
          { cwd: opts.cwd, mcpServers: [] },
          pending,
          requestTimeoutMs,
        )) as {
          sessionId?: string;
          models?: { availableModels?: AcpAvailableModel[] };
          configOptions?: AcpConfigOptionLike[];
        };
        const sessionId = sessionResult?.sessionId;
        if (!sessionId) {
          finish(1);
          return;
        }

        if (opts.model) {
          await configureAcpSessionModel({
            requested: opts.model,
            aliases: opts.modelAliases,
            strictModel: opts.strictModel,
            session: sessionResult,
            setOption: async (configId, value) =>
              (await sendRequest(
                child.stdin,
                nextId,
                "session/set_config_option",
                {
                  sessionId,
                  configId,
                  ...(typeof value === "boolean" ? { type: "boolean" } : {}),
                  value,
                },
                pending,
                requestTimeoutMs,
              )) as { configOptions?: AcpConfigOptionLike[] },
          });
        }

        debugAcp("ACP step: session/prompt");
        await sendRequest(child.stdin, nextId, "session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: prompt }],
        }, pending, requestTimeoutMs);
        finish(0);
      } catch {
        if (timeout) clearTimeout(timeout);
        if (!resolved) {
          finish(1);
        }
      }
    };

    run();
  });
}
