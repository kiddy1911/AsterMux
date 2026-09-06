import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { CursorExecutionMode } from "../provider/execution-mode.js";
import { loadEnvConfig, resolveAgentCommand, type EnvOptions } from "./environment.js";

function readGatewayPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, "../../package.json");
    const raw = fs.readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(raw) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

export type { CursorExecutionMode } from "../provider/execution-mode.js";

export type GatewayConfig = {
  agentBin: string;
  /** Resolved command for ACP (node + script on Windows when .cmd); avoids spawn EINVAL and DEP0190. */
  acpCommand: string;
  /** Args for ACP (e.g. [scriptPath, "acp"] or ["acp"]). */
  acpArgs: string[];
  /** Env to use when spawning ACP (e.g. CURSOR_INVOKED_AS). */
  acpEnv: Record<string, string | undefined>;
  host: string;
  port: number;
  requiredKey?: string;
  defaultModel: string;
  mode: CursorExecutionMode;
  /** Infer agent/plan from trusted DSH system prompt markers when no explicit mode is provided. */
  dshAutoMode?: boolean;
  /** Stable marker identifying a DSH-owned system prompt. */
  dshSystemMarker?: string;
  /** Stable marker present only while DSH plan mode is active. */
  dshPlanMarker?: string;
  force: boolean;
  approveMcps: boolean;
  strictModel: boolean;
  workspace: string;
  timeoutMs: number;
  /** Structured external-tool lifecycle. Stateless reconstructs from request history. */
  toolSessionMode?: "stateless" | "stateful";
  /** Maximum idle lifetime for a parked structured-tool turn (stateful legacy mode only). */
  toolSessionTtlMs?: number;
  /** Maximum parked structured-tool turns per API owner. */
  toolSessionMaxPerOwner?: number;
  /** Maximum parked structured-tool turns across this server. */
  toolSessionMaxGlobal?: number;
  /** One-shot output-function allowlist. Empty keeps all tools stateful. */
  statelessToolNames?: string[];
  /** Bounded formatting retries for stateless structured output. */
  statelessRepairRetries?: number;
  batchEnabled?: boolean;
  batchDir?: string;
  batchConcurrency?: number;
  batchMaxRequests?: number;
  batchMaxJobs?: number;
  batchRetentionMs?: number;
  /** Path to TLS certificate file (e.g. Tailscale cert). When set with tlsKeyPath, server uses HTTPS. */
  tlsCertPath?: string;
  /** Path to TLS private key file. When set with tlsCertPath, server uses HTTPS. */
  tlsKeyPath?: string;
  /** Path to sessions log file; each request is appended as a line. Default: sessions.log in cwd. */
  sessionsLogPath: string;
  /** When true (default), run CLI in an empty temp dir so it cannot read or write the real project. Pure chat only. */
  chatOnlyWorkspace: boolean;
  /** True when ASTERMUX_CHAT_ONLY_WORKSPACE was set in the environment (any value). */
  chatOnlyWorkspaceExplicit: boolean;
  /** When true, print full request/response content to stdout for each completion. */
  verbose: boolean;
  /** When true, enable Cursor Max Mode (larger context, more tool calls) via cli-config.json preflight. */
  maxMode: boolean;
  /** When true, pass the user prompt via stdin instead of argv (avoids Windows argv issues). */
  promptViaStdin: boolean;
  /** When true, use ACP (Agent Client Protocol) over stdio; fixes prompt delivery on Windows. */
  useAcp: boolean;
  /** Spawn options for ACP (e.g. windowsVerbatimArguments when using cmd.exe fallback). */
  acpSpawnOptions?: { windowsVerbatimArguments?: boolean };
  /** When true, skip ACP authenticate step (use when pre-authenticated via --api-key or agent login). */
  acpSkipAuthenticate: boolean;
  /** When true, log every raw JSON-RPC line from ACP stdout (very verbose). Set ASTERMUX_ACP_RAW_DEBUG=1 to enable. */
  acpRawDebug: boolean;
  /** Number of persistent ACP workers reserved for interactive traffic. */
  acpPoolSize?: number;
  /** Maximum persistent ACP workers reserved for batch/stateless traffic. */
  acpBatchPoolSize?: number;
  /** Hot interactive worker floor; -1/undefined inherits acpPoolSize. */
  acpInteractiveWarmSize?: number;
  /** Hot batch worker floor; -1/undefined inherits acpBatchPoolSize. */
  acpBatchWarmSize?: number;
  /** Idle time before elastic workers above the warm floor are retired. */
  acpElasticIdleMs?: number;
  acpInteractiveQueueMax?: number;
  acpBatchQueueMax?: number;
  acpInteractiveQueueTimeoutMs?: number;
  acpBatchQueueTimeoutMs?: number;
  /** Maximum ACP connections reserved for structured Tool sessions. */
  acpToolPoolSize?: number;
  /** Hot Tool connection floor; -1/undefined inherits acpToolPoolSize. */
  acpToolWarmSize?: number;
  acpToolQueueMax?: number;
  acpToolQueueTimeoutMs?: number;
  /** Recycle a persistent ACP worker after this many completed requests. */
  acpPoolMaxRequests?: number;
  /** Recycle a persistent ACP worker after this age in milliseconds. */
  acpPoolMaxAgeMs?: number;
  /** Pool of cursor configuration directories for round-robin account rotation. */
  configDirs: string[];
  /** When true, runs each config dir on its own incrementing port starting from `port` */
  multiPort: boolean;
  /** Windows CreateProcess command-line budget for prompt truncation (ignored on non-Windows). */
  winCmdlineMax: number;
  /** Prepend bridge/workspace context to the agent prompt (see ASTERMUX_CONTEXT_PREAMBLE). */
  contextPreamble: boolean;
  /** `version` field from this package’s package.json (shown in the bridge preamble). */
  gatewayPackageVersion: string;
  /** Optional operator notes appended to the preamble (see ASTERMUX_CONTEXT_EXTRA). */
  contextExtra?: string;
};

export function loadGatewayConfig(opts: EnvOptions = {}): GatewayConfig {
  const env = loadEnvConfig(opts);
  const acpResolved = resolveAgentCommand(env.agentBin, ["acp"], opts);
  const envSource = opts.env ?? process.env;
  const apiKey = envSource.CURSOR_API_KEY ?? envSource.CURSOR_AUTH_TOKEN;
  const acpArgs = acpResolved.args;

  const acpEnv = { ...acpResolved.env } as Record<string, string | undefined>;
  if (apiKey) {
    acpEnv.CURSOR_API_KEY = apiKey;
    acpEnv.CURSOR_AUTH_TOKEN = apiKey;
  }

  return {
    agentBin: env.agentBin,
    acpCommand: acpResolved.command,
    acpArgs,
    acpEnv,
    host: env.host,
    port: env.port,
    requiredKey: env.requiredKey,
    defaultModel: env.defaultModel,
    mode: env.mode ?? opts.mode ?? "ask",
    dshAutoMode: env.dshAutoMode,
    dshSystemMarker: env.dshSystemMarker,
    dshPlanMarker: env.dshPlanMarker,
    force: env.force,
    approveMcps: env.approveMcps,
    strictModel: env.strictModel,
    workspace: env.workspace,
    timeoutMs: env.timeoutMs,
    toolSessionMode: env.toolSessionMode,
    toolSessionTtlMs: env.toolSessionTtlMs,
    toolSessionMaxPerOwner: env.toolSessionMaxPerOwner,
    toolSessionMaxGlobal: env.toolSessionMaxGlobal,
    statelessToolNames: env.statelessToolNames,
    statelessRepairRetries: env.statelessRepairRetries,
    batchEnabled: env.batchEnabled,
    batchDir: env.batchDir,
    batchConcurrency: env.batchConcurrency,
    batchMaxRequests: env.batchMaxRequests,
    batchMaxJobs: env.batchMaxJobs,
    batchRetentionMs: env.batchRetentionMs,
    tlsCertPath: env.tlsCertPath,
    tlsKeyPath: env.tlsKeyPath,
    sessionsLogPath: env.sessionsLogPath,
    chatOnlyWorkspace: env.chatOnlyWorkspace,
    chatOnlyWorkspaceExplicit: env.chatOnlyWorkspaceExplicit,
    verbose: env.verbose,
    maxMode: env.maxMode,
    promptViaStdin: env.promptViaStdin,
    useAcp: env.useAcp,
    acpSpawnOptions:
      acpResolved.windowsVerbatimArguments != null
        ? { windowsVerbatimArguments: acpResolved.windowsVerbatimArguments }
        : undefined,
    acpSkipAuthenticate:
      !!apiKey ||
      /^(1|true|yes|on)$/i.test(
        String(envSource.ASTERMUX_ACP_SKIP_AUTHENTICATE ?? "").trim(),
      ),
    acpRawDebug: /^(1|true|yes|on)$/i.test(
      String(envSource.ASTERMUX_ACP_RAW_DEBUG ?? "").trim(),
    ),
    acpPoolSize: env.acpPoolSize,
    acpBatchPoolSize: env.acpBatchPoolSize,
    acpInteractiveWarmSize: env.acpInteractiveWarmSize,
    acpBatchWarmSize: env.acpBatchWarmSize,
    acpElasticIdleMs: env.acpElasticIdleMs,
    acpInteractiveQueueMax: env.acpInteractiveQueueMax,
    acpBatchQueueMax: env.acpBatchQueueMax,
    acpInteractiveQueueTimeoutMs: env.acpInteractiveQueueTimeoutMs,
    acpBatchQueueTimeoutMs: env.acpBatchQueueTimeoutMs,
    acpToolPoolSize: env.acpToolPoolSize,
    acpToolWarmSize: env.acpToolWarmSize,
    acpToolQueueMax: env.acpToolQueueMax,
    acpToolQueueTimeoutMs: env.acpToolQueueTimeoutMs,
    acpPoolMaxRequests: env.acpPoolMaxRequests,
    acpPoolMaxAgeMs: env.acpPoolMaxAgeMs,
    configDirs: env.configDirs ?? [],
    multiPort: env.multiPort,
    winCmdlineMax: env.winCmdlineMax,
    contextPreamble: env.contextPreamble,
    gatewayPackageVersion: readGatewayPackageVersion(),
    contextExtra: env.contextExtra,
  };
}
