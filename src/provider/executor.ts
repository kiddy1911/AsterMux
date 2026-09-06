import * as fs from "node:fs";

import { runAcpStream, runAcpSync } from "../acp/session-client.js";
import {
  AcpPoolQueueError,
  PooledAcpRunError,
  primePooledAcp,
  runPooledAcpStream,
  runPooledAcpSync,
  type AcpPoolLane,
  type AcpPoolOptions,
  type AcpPoolTiming,
} from "../acp/execution-pool.js";
import { AcpToolSession } from "../acp/tool-turn.js";
import {
  acquireToolAcpConnection,
  primeToolAcpPool,
  tryAcquireToolAcpConnection,
  type ToolAcpPoolOptions,
} from "../acp/tool-pool.js";
import { buildAgentFixedArgs } from "./invocation.js";
import type { GatewayConfig } from "../gateway/config.js";
import type { CursorExecutionMode } from "./execution-mode.js";
import { run, runStreaming } from "../runtime/subprocess.js";
import { createStreamParser } from "../runtime/stream-parser.js";
import type { ClientToolDefinition } from "../protocols/tools.js";
import { getChatOnlyEnvOverrides, resolveWorkspace } from "../gateway/workspace.js";
import { readKeychainToken, writeCachedToken } from "./token-cache.js";

function cacheTokenForAccount(configDir?: string): void {
  if (!configDir) return;
  const token = readKeychainToken();
  if (token) writeCachedToken(configDir, token);
}

export type AgentRunResult = {
  code: number;
  stdout: string;
  stderr: string;
  pool?: AcpPoolTiming;
};

function acpArgsWithModel(acpArgs: string[], model: string): string[] {
  const i = acpArgs.indexOf("acp");
  if (i === -1) return acpArgs;
  return [...acpArgs.slice(0, i + 1), "--model", model, ...acpArgs.slice(i + 1)];
}

function acpArgsWithMode(acpArgs: string[], mode: CursorExecutionMode): string[] {
  const i = acpArgs.indexOf("acp");
  if (i === -1) return acpArgs;
  // cursor-agent only accepts --mode plan|ask; agent mode is the default.
  if (mode === "agent") return acpArgs;
  return [...acpArgs.slice(0, i + 1), "--mode", mode, ...acpArgs.slice(i + 1)];
}

function acpArgsWithWorkspace(acpArgs: string[], workspaceDir: string): string[] {
  const i = acpArgs.indexOf("acp");
  if (i === -1) return acpArgs;
  return [...acpArgs.slice(0, i), "--workspace", workspaceDir, ...acpArgs.slice(i)];
}

const CHAT_ONLY_ACP_LOW_MEMORY_FLAGS = [
  "--disable-indexing",
  "--disable-codebase-ref",
  "--exclude-workspace-context",
] as const;

function acpArgsForChatOnly(acpArgs: string[]): string[] {
  const i = acpArgs.indexOf("acp");
  if (i === -1) return acpArgs;
  const missing = CHAT_ONLY_ACP_LOW_MEMORY_FLAGS.filter(
    (flag) => !acpArgs.includes(flag),
  );
  if (missing.length === 0) return acpArgs;
  return [...acpArgs.slice(0, i), ...missing, ...acpArgs.slice(i)];
}

function extractModelFromCmdArgs(cmdArgs: string[]): string | undefined {
  const i = cmdArgs.indexOf("--model");
  return i >= 0 && i + 1 < cmdArgs.length ? cmdArgs[i + 1] : undefined;
}

function extractModeFromCmdArgs(cmdArgs: string[]): CursorExecutionMode {
  const i = cmdArgs.indexOf("--mode");
  const m =
    i >= 0 && i + 1 < cmdArgs.length ? cmdArgs[i + 1] : undefined;
  if (m === "agent" || m === "ask" || m === "plan") return m;
  return "ask";
}

function acpInvocation(
  config: GatewayConfig,
  workspaceDir: string,
  effectiveChatOnly: boolean,
  cmdArgs: string[],
  configDir?: string,
): {
  args: string[];
  env: Record<string, string | undefined>;
  model?: string;
} {
  const model = extractModelFromCmdArgs(cmdArgs);
  const mode = extractModeFromCmdArgs(cmdArgs);
  let args = acpArgsWithWorkspace(config.acpArgs, workspaceDir);
  args = model ? acpArgsWithModel(args, model) : args;
  args = acpArgsWithMode(args, mode);
  if (effectiveChatOnly) args = acpArgsForChatOnly(args);
  const env = { ...config.acpEnv };
  if (effectiveChatOnly) {
    Object.assign(env, getChatOnlyEnvOverrides(workspaceDir, configDir));
  } else if (configDir) {
    env.CURSOR_CONFIG_DIR = configDir;
  }
  return { args, env, model };
}

function cleanupRun(tempDir?: string, configDir?: string): void {
  cacheTokenForAccount(configDir);
  if (!tempDir) return;
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

function poolSizeForLane(config: GatewayConfig, lane: AcpPoolLane): number {
  return lane === "batch"
    ? (config.acpBatchPoolSize ?? 0)
    : (config.acpPoolSize ?? 0);
}

function warmSizeForLane(config: GatewayConfig, lane: AcpPoolLane): number {
  const ceiling = poolSizeForLane(config, lane);
  const configured =
    lane === "batch"
      ? config.acpBatchWarmSize
      : config.acpInteractiveWarmSize;
  if (configured == null || configured < 0) return ceiling;
  return Math.min(ceiling, Math.max(0, Math.floor(configured)));
}

function shouldUsePooledAcp(
  config: GatewayConfig,
  effectiveChatOnly: boolean,
  cmdArgs: string[],
  configDir: string | undefined,
  lane: AcpPoolLane,
): boolean {
  if (poolSizeForLane(config, lane) <= 0) return false;
  // Pool all isolated ask-mode traffic regardless of model. The physical ACP
  // process is model-agnostic; each fresh session selects its requested model
  // through session/set_config_option before prompting. Account rotation still
  // uses the compatibility path because auth identity is process-scoped.
  if (!effectiveChatOnly || configDir || config.configDirs.length > 0) return false;
  return extractModeFromCmdArgs(cmdArgs) === "ask";
}

function shouldUsePooledToolAcp(
  config: GatewayConfig,
  effectiveChatOnly: boolean,
  cmdArgs: string[],
  configDir?: string,
): boolean {
  if ((config.acpToolPoolSize ?? 0) <= 0) return false;
  if (!effectiveChatOnly || configDir || config.configDirs.length > 0) return false;
  return extractModeFromCmdArgs(cmdArgs) === "ask";
}

function toolPoolOptions(
  config: GatewayConfig,
  invocation: ReturnType<typeof acpInvocation>,
  requestWorkspace: string,
): ToolAcpPoolOptions {
  return {
    command: config.acpCommand,
    args: invocation.args,
    env: invocation.env,
    requestWorkspace,
    requestTimeoutMs: config.timeoutMs,
    spawnOptions: config.acpSpawnOptions,
    skipAuthenticate: config.acpSkipAuthenticate,
    rawDebug: config.acpRawDebug,
    poolSize: config.acpToolPoolSize ?? 0,
    warmSize:
      config.acpToolWarmSize == null || config.acpToolWarmSize < 0
        ? (config.acpToolPoolSize ?? 0)
        : Math.min(
            config.acpToolPoolSize ?? 0,
            Math.max(0, Math.floor(config.acpToolWarmSize)),
          ),
    idleTtlMs: config.acpElasticIdleMs ?? 120_000,
    queueMax: config.acpToolQueueMax ?? 8,
    queueTimeoutMs: config.acpToolQueueTimeoutMs ?? 120_000,
    maxRequests: config.acpPoolMaxRequests ?? 100,
    maxAgeMs: config.acpPoolMaxAgeMs ?? 3_600_000,
  };
}

function pooledOptions(
  config: GatewayConfig,
  invocation: ReturnType<typeof acpInvocation>,
  requestWorkspace: string,
  lane: AcpPoolLane,
): AcpPoolOptions {
  return {
    command: config.acpCommand,
    args: invocation.args,
    env: invocation.env,
    requestWorkspace,
    requestTimeoutMs: config.timeoutMs,
    skipAuthenticate: config.acpSkipAuthenticate,
    rawDebug: config.acpRawDebug,
    poolSize: poolSizeForLane(config, lane),
    warmSize: warmSizeForLane(config, lane),
    idleTtlMs: config.acpElasticIdleMs ?? 120_000,
    maxRequests: config.acpPoolMaxRequests ?? 100,
    maxAgeMs: config.acpPoolMaxAgeMs ?? 3_600_000,
    lane,
    queueMax:
      lane === "batch"
        ? (config.acpBatchQueueMax ?? 12)
        : (config.acpInteractiveQueueMax ?? 4),
    queueTimeoutMs:
      lane === "batch"
        ? (config.acpBatchQueueTimeoutMs ?? 30_000)
        : (config.acpInteractiveQueueTimeoutMs ?? 15_000),
  };
}

function cliArgsForPrompt(
  config: GatewayConfig,
  cmdArgs: string[],
  prompt: string | undefined,
): { args: string[]; stdinContent?: string } {
  // A freshly rebuilt container has no persisted Cursor workspace-trust state.
  // The bridge API is already authenticated and restricts workspaces to the
  // configured base, so make the compatibility CLI path non-interactive.
  const trustedArgs = cmdArgs.includes("--trust")
    ? [...cmdArgs]
    : [cmdArgs[0] ?? "--print", "--trust", ...cmdArgs.slice(1)];
  if (typeof prompt !== "string") return { args: trustedArgs };
  if (config.promptViaStdin) {
    return { args: trustedArgs, stdinContent: prompt };
  }
  // With ACP enabled the HTTP handlers intentionally keep the prompt out of
  // argv. For a compatibility fallback, reconstruct the pre-ACP CLI argv path.
  return { args: [...trustedArgs, prompt] };
}

async function runCliCompatibilitySync(
  config: GatewayConfig,
  workspaceDir: string,
  effectiveChatOnly: boolean,
  cmdArgs: string[],
  prompt: string | undefined,
  configDir?: string,
  signal?: AbortSignal,
): Promise<AgentRunResult> {
  const cli = cliArgsForPrompt(config, cmdArgs, prompt);
  const envOverrides = effectiveChatOnly
    ? getChatOnlyEnvOverrides(workspaceDir, configDir)
    : undefined;
  return run(config.agentBin, cli.args, {
    cwd: workspaceDir,
    timeoutMs: config.timeoutMs,
    maxMode: config.maxMode,
    stdinContent: cli.stdinContent,
    envOverrides,
    configDir,
    signal,
  });
}

async function runCliCompatibilityStream(
  config: GatewayConfig,
  workspaceDir: string,
  effectiveChatOnly: boolean,
  cmdArgs: string[],
  prompt: string | undefined,
  onText: StreamLineHandler,
  configDir?: string,
  signal?: AbortSignal,
): Promise<{ code: number; stderr: string }> {
  const cli = cliArgsForPrompt(config, cmdArgs, prompt);
  const envOverrides = effectiveChatOnly
    ? getChatOnlyEnvOverrides(workspaceDir, configDir)
    : undefined;
  const parseLine = createStreamParser(onText, () => undefined);
  return runStreaming(config.agentBin, cli.args, {
    cwd: workspaceDir,
    timeoutMs: config.timeoutMs,
    maxMode: config.maxMode,
    onLine: parseLine,
    stdinContent: cli.stdinContent,
    envOverrides,
    configDir,
    signal,
  });
}

export async function primeDefaultAcpPool(config: GatewayConfig): Promise<void> {
  if (
    !config.useAcp ||
    ((config.acpPoolSize ?? 0) <= 0 && (config.acpBatchPoolSize ?? 0) <= 0)
  ) return;
  if (!config.chatOnlyWorkspace || config.configDirs.length > 0) return;

  const ws = resolveWorkspace(config, undefined, true);
  try {
    const cmdArgs = buildAgentFixedArgs(
      config,
      ws.workspaceDir,
      config.defaultModel,
      false,
      "ask",
      true,
    );
    const invocation = acpInvocation(
      config,
      ws.workspaceDir,
      true,
      cmdArgs,
      undefined,
    );
    const lanes: AcpPoolLane[] = [];
    if ((config.acpPoolSize ?? 0) > 0) lanes.push("interactive");
    if ((config.acpBatchPoolSize ?? 0) > 0) lanes.push("batch");
    await Promise.all(
      lanes.map((lane) =>
        primePooledAcp(pooledOptions(config, invocation, ws.workspaceDir, lane)),
      ),
    );
  } finally {
    if (ws.tempDir) {
      try {
        fs.rmSync(ws.tempDir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  }
}

export async function primeDefaultToolAcpPool(config: GatewayConfig): Promise<void> {
  if (!config.useAcp || (config.acpToolPoolSize ?? 0) <= 0) return;
  if (!config.chatOnlyWorkspace || config.configDirs.length > 0) return;

  const ws = resolveWorkspace(config, undefined, true);
  try {
    const cmdArgs = buildAgentFixedArgs(
      config,
      ws.workspaceDir,
      config.defaultModel,
      false,
      "ask",
      true,
    );
    const invocation = acpInvocation(
      config,
      ws.workspaceDir,
      true,
      cmdArgs,
      undefined,
    );
    await primeToolAcpPool(toolPoolOptions(config, invocation, ws.workspaceDir));
  } finally {
    if (ws.tempDir) {
      try {
        fs.rmSync(ws.tempDir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  }
}

export async function runAgentSync(
  config: GatewayConfig,
  workspaceDir: string,
  effectiveChatOnly: boolean,
  cmdArgs: string[],
  tempDir?: string,
  stdinPrompt?: string,
  configDir?: string,
  signal?: AbortSignal,
  modelDisplayName?: string,
  poolLane: AcpPoolLane = "interactive",
): Promise<AgentRunResult> {
  try {
    if (config.useAcp && typeof stdinPrompt === "string") {
      const invocation = acpInvocation(
        config,
        workspaceDir,
        effectiveChatOnly,
        cmdArgs,
        configDir,
      );

      if (poolSizeForLane(config, poolLane) > 0) {
        if (shouldUsePooledAcp(config, effectiveChatOnly, cmdArgs, configDir, poolLane)) {
          try {
            return await runPooledAcpSync({
              ...pooledOptions(config, invocation, workspaceDir, poolLane),
              borrowFrom:
                poolLane === "interactive" && (config.acpBatchPoolSize ?? 0) > 0
                  ? pooledOptions(config, invocation, workspaceDir, "batch")
                  : undefined,
              prompt: stdinPrompt,
              model: invocation.model,
              modelAliases: modelDisplayName ? [modelDisplayName] : undefined,
              strictModel: config.strictModel,
              signal,
            });
          } catch (error) {
            if (signal?.aborted || error instanceof AcpPoolQueueError) throw error;
            console.warn(
              `[acp-pool] pooled sync request failed; falling back to legacy CLI: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
        return await runCliCompatibilitySync(
          config,
          workspaceDir,
          effectiveChatOnly,
          cmdArgs,
          stdinPrompt,
          configDir,
          signal,
        );
      }

      // Pooling disabled: preserve the project's original one-shot ACP mode.
      return await runAcpSync(config.acpCommand, invocation.args, stdinPrompt, {
        cwd: workspaceDir,
        timeoutMs: config.timeoutMs,
        env: invocation.env,
        model: invocation.model,
        modelAliases: modelDisplayName ? [modelDisplayName] : undefined,
        strictModel: config.strictModel,
        requestTimeoutMs: config.timeoutMs,
        spawnOptions: config.acpSpawnOptions,
        skipAuthenticate: config.acpSkipAuthenticate,
        rawDebug: config.acpRawDebug,
        signal,
      });
    }

    const runEnvOverrides = effectiveChatOnly
      ? getChatOnlyEnvOverrides(workspaceDir, configDir)
      : undefined;
    return await run(config.agentBin, cmdArgs, {
      cwd: workspaceDir,
      timeoutMs: config.timeoutMs,
      maxMode: config.maxMode,
      stdinContent: stdinPrompt,
      envOverrides: runEnvOverrides,
      configDir,
      signal,
    });
  } finally {
    cleanupRun(tempDir, configDir);
  }
}

export type StreamLineHandler = (line: string) => void;

export async function runAgentStream(
  config: GatewayConfig,
  workspaceDir: string,
  effectiveChatOnly: boolean,
  cmdArgs: string[],
  onLine: StreamLineHandler,
  tempDir?: string,
  stdinPrompt?: string,
  configDir?: string,
  signal?: AbortSignal,
  modelDisplayName?: string,
  poolLane: AcpPoolLane = "interactive",
  onStarted?: (timing?: {
    lane: AcpPoolLane;
    workerLane?: AcpPoolLane;
    queueWaitMs: number;
  }) => void,
): Promise<{ code: number; stderr: string; pool?: AcpPoolTiming }> {
  try {
    if (config.useAcp && typeof stdinPrompt === "string") {
      const invocation = acpInvocation(
        config,
        workspaceDir,
        effectiveChatOnly,
        cmdArgs,
        configDir,
      );

      if (poolSizeForLane(config, poolLane) > 0) {
        if (shouldUsePooledAcp(config, effectiveChatOnly, cmdArgs, configDir, poolLane)) {
          let emitted = false;
          try {
            return await runPooledAcpStream({
              ...pooledOptions(config, invocation, workspaceDir, poolLane),
              borrowFrom:
                poolLane === "interactive" && (config.acpBatchPoolSize ?? 0) > 0
                  ? pooledOptions(config, invocation, workspaceDir, "batch")
                  : undefined,
              prompt: stdinPrompt,
              model: invocation.model,
              modelAliases: modelDisplayName ? [modelDisplayName] : undefined,
              strictModel: config.strictModel,
              signal,
              onAcquired: onStarted,
              onChunk: (text) => {
                emitted = true;
                onLine(text);
              },
            });
          } catch (error) {
            if (signal?.aborted || error instanceof AcpPoolQueueError) throw error;
            const hadOutput =
              emitted || (error instanceof PooledAcpRunError && error.hadOutput);
            if (hadOutput) throw error;
            console.warn(
              `[acp-pool] pooled stream request failed before output; falling back to legacy CLI: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
        onStarted?.();
        return await runCliCompatibilityStream(
          config,
          workspaceDir,
          effectiveChatOnly,
          cmdArgs,
          stdinPrompt,
          onLine,
          configDir,
          signal,
        );
      }

      onStarted?.();
      return await runAcpStream(
        config.acpCommand,
        invocation.args,
        stdinPrompt,
        {
          cwd: workspaceDir,
          timeoutMs: config.timeoutMs,
          env: invocation.env,
          model: invocation.model,
          modelAliases: modelDisplayName ? [modelDisplayName] : undefined,
          strictModel: config.strictModel,
          requestTimeoutMs: config.timeoutMs,
          spawnOptions: config.acpSpawnOptions,
          skipAuthenticate: config.acpSkipAuthenticate,
          rawDebug: config.acpRawDebug,
          signal,
        },
        onLine,
      );
    }

    const streamEnvOverrides = effectiveChatOnly
      ? getChatOnlyEnvOverrides(workspaceDir, configDir)
      : undefined;
    onStarted?.();
    return await runStreaming(config.agentBin, cmdArgs, {
      cwd: workspaceDir,
      timeoutMs: config.timeoutMs,
      maxMode: config.maxMode,
      onLine,
      stdinContent: stdinPrompt,
      envOverrides: streamEnvOverrides,
      configDir,
      signal,
    });
  } finally {
    cleanupRun(tempDir, configDir);
  }
}

export async function startAgentToolSession(opts: {
  config: GatewayConfig;
  workspaceDir: string;
  effectiveChatOnly: boolean;
  cmdArgs: string[];
  prompt: string;
  tools: readonly ClientToolDefinition[];
  tempDir?: string;
  configDir?: string;
  signal?: AbortSignal;
  modelDisplayName?: string;
  requireToolCall?: boolean;
  maxParallelToolCalls?: number;
  /** Runs after cleanup is armed but before any ACP/MCP work starts. */
  beforeStart?: () => void;
  /** Queue for a bounded warm Tool connection instead of cold-spawning. */
  waitForToolConnection?: boolean;
}): Promise<AcpToolSession> {
  if (!opts.config.useAcp) {
    throw new Error("Structured tool passthrough requires ACP mode");
  }
  const invocation = acpInvocation(
    opts.config,
    opts.workspaceDir,
    opts.effectiveChatOnly,
    opts.cmdArgs,
    opts.configDir,
  );
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    cacheTokenForAccount(opts.configDir);
    if (opts.tempDir) {
      try {
        fs.rmSync(opts.tempDir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  };
  try {
    // Capacity reservation must happen before acquiring/spawning Cursor ACP.
    // If it throws, cleanup is already armed so an isolated temp workspace
    // does not leak.
    opts.beforeStart?.();
    const canUseToolPool = shouldUsePooledToolAcp(
      opts.config,
      opts.effectiveChatOnly,
      opts.cmdArgs,
      opts.configDir,
    );
    const poolOpts = canUseToolPool
      ? toolPoolOptions(opts.config, invocation, opts.workspaceDir)
      : undefined;
    const elasticToolPool =
      poolOpts != null && (poolOpts.warmSize ?? poolOpts.poolSize) < poolOpts.poolSize;
    const connectionLease = poolOpts
      ? opts.waitForToolConnection || elasticToolPool
        ? await acquireToolAcpConnection(poolOpts, opts.signal)
        : tryAcquireToolAcpConnection(poolOpts)
      : undefined;
    const session = new AcpToolSession({
      command: opts.config.acpCommand,
      args: invocation.args,
      cwd: opts.workspaceDir,
      env: invocation.env,
      timeoutMs: opts.config.timeoutMs,
      ttlMs: opts.config.toolSessionTtlMs ?? 60_000,
      spawnOptions: opts.config.acpSpawnOptions,
      skipAuthenticate: opts.config.acpSkipAuthenticate,
      rawDebug: opts.config.acpRawDebug,
      signal: opts.signal,
      // Warm Tool connections are model-agnostic. Select the requested model
      // on the fresh MCP-backed session. Cold compatibility sessions still
      // launch with --model and do not need a second session-level selection.
      modelCandidates: connectionLease
        ? [invocation.model, opts.modelDisplayName].filter(
            (value): value is string => typeof value === "string" && value.length > 0,
          )
        : [],
      strictModel: opts.config.strictModel,
      tools: opts.tools,
      requireToolCall: opts.requireToolCall,
      maxParallelToolCalls: opts.maxParallelToolCalls,
      connectionLease,
      onClose: cleanup,
    });
    await session.start(opts.prompt);
    return session;
  } catch (error) {
    cleanup();
    throw error;
  }
}
