import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";

import type { GatewayConfig } from "./config.js";
import { createRequestListener } from "./router.js";
import {
  primeDefaultAcpPool,
  primeDefaultToolAcpPool,
} from "../provider/executor.js";
import { closeAllAcpPools } from "../acp/execution-pool.js";
import { closeAllToolAcpPools } from "../acp/tool-pool.js";
import { initAccountPool } from "../provider/accounts.js";
import { killAllChildProcesses } from "../runtime/subprocess.js";
import { ToolSessionRegistry } from "../acp/stateful-turn-registry.js";
import { BatchManager } from "../scheduling/batch-store.js";

function acpLauncherLabel(acpArgs: string[]): string {
  const first = acpArgs[0];
  if (first && /\.[cm]?js$/i.test(first)) return "node + script";
  return "cmd";
}

function warmFloor(max: number | undefined, configured: number | undefined): number {
  const ceiling = Math.max(0, Math.floor(max ?? 0));
  if (configured == null || configured < 0) return ceiling;
  return Math.min(ceiling, Math.max(0, Math.floor(configured)));
}

export type GatewayServerOptions = {
  version: string;
  config: GatewayConfig;
};

export function startGatewayServer(
  opts: GatewayServerOptions,
): (http.Server | https.Server)[] {
  const { config } = opts;
  const servers: (http.Server | https.Server)[] = [];

  if (config.configDirs && config.configDirs.length > 0) {
    if (config.multiPort) {
      // In multi-port mode, we don't need a central pool. We spawn a server for each configDir
      config.configDirs.forEach((dir, index) => {
        const port = config.port + index;
        const serverOpts = {
          ...opts,
          config: {
            ...config,
            port,
            configDirs: [dir], // each server gets only one configDir
            multiPort: false, // Disable multi-port for child servers to prevent recursion
          },
        };
        const server = startSingleServer(serverOpts);
        servers.push(server);
      });
      return servers;
    } else {
      initAccountPool(config.configDirs);
    }
  }

  servers.push(startSingleServer(opts));
  return servers;
}

/**
 * Register SIGTERM / SIGINT handlers for graceful shutdown.
 * Closes all HTTP(S) servers, kills in-flight agent processes, then exits.
 */
export function setupGracefulShutdown(
  servers: (http.Server | https.Server)[],
  timeoutMs = 10_000,
): void {
  let shuttingDown = false;

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(
      `\n[${new Date().toISOString()}] ${signal} received — shutting down gracefully…`,
    );

    // Stop accepting new connections and kill all in-flight agent processes.
    // Persistent ACP workers are closed explicitly so their temp roots are cleaned.
    const poolClose = closeAllAcpPools().catch(() => undefined);
    const toolPoolClose = closeAllToolAcpPools().catch(() => undefined);
    killAllChildProcesses();

    const closePromises = [poolClose, toolPoolClose, ...servers.map(
      (s) =>
        new Promise<void>((resolve) => {
          // closeAllConnections available since Node 18.2
          if (typeof (s as any).closeAllConnections === "function") {
            (s as any).closeAllConnections();
          }
          s.close(() => resolve());
        }),
    )];

    const forceExit = setTimeout(() => {
      console.error(
        "[shutdown] Timed out waiting for connections to drain — forcing exit.",
      );
      process.exit(1);
    }, timeoutMs).unref();

    Promise.all(closePromises).then(() => {
      clearTimeout(forceExit);
      process.exit(0);
    });
  };

  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

function startSingleServer(
  opts: GatewayServerOptions,
): http.Server | https.Server {
  const { config } = opts;

  const toolSessions = new ToolSessionRegistry({
    maxGlobal: config.toolSessionMaxGlobal,
    maxPerOwner: config.toolSessionMaxPerOwner,
  });
  const batchManager = config.batchEnabled ? new BatchManager(config) : undefined;
  const requestListener = createRequestListener(opts, { toolSessions, batchManager });

  const useTls = Boolean(config.tlsCertPath && config.tlsKeyPath);
  let server: http.Server | https.Server;

  if (useTls) {
    const cert = fs.readFileSync(config.tlsCertPath!, "utf8");
    const key = fs.readFileSync(config.tlsKeyPath!, "utf8");
    server = https.createServer({ cert, key }, requestListener);
  } else {
    server = http.createServer(requestListener);
  }

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `\u274c Port ${config.port} is already in use. Set ASTERMUX_PORT to use a different port.`,
      );
    } else {
      console.error(`\u274c Server error:`, err.message);
    }
    process.exit(1);
  });
  server.once("close", () => {
    batchManager?.close();
    void toolSessions.closeAll();
  });

  server.listen(config.port, config.host, () => {
    const address = server.address();
    if (address && typeof address !== "string") {
      batchManager?.setLoopbackPort(address.port);
    }
    const scheme = useTls ? "https" : "http";
    console.log(
      `astermux listening on ${scheme}://${config.host}:${config.port}`,
    );
    console.log(`- agent bin: ${config.agentBin}`);
    console.log(
      `- ACP: ${config.useAcp ? "yes" : "no"}${config.useAcp ? ` (launcher: ${acpLauncherLabel(config.acpArgs)})` : ""}`,
    );
    console.log(
      `- ACP lanes: ${
        config.useAcp && ((config.acpPoolSize ?? 0) > 0 || (config.acpBatchPoolSize ?? 0) > 0)
          ? `interactive=${warmFloor(config.acpPoolSize, config.acpInteractiveWarmSize)}/${config.acpPoolSize ?? 0} warm/max, batch=${warmFloor(config.acpBatchPoolSize, config.acpBatchWarmSize)}/${config.acpBatchPoolSize ?? 0} warm/max; elastic_idle=${config.acpElasticIdleMs ?? 120_000}ms; queues interactive=${config.acpInteractiveQueueMax ?? 4}/${config.acpInteractiveQueueTimeoutMs ?? 15_000}ms, batch=${config.acpBatchQueueMax ?? 12}/${config.acpBatchQueueTimeoutMs ?? 30_000}ms`
          : "disabled"
      }`,
    );
    console.log(
      `- ACP tool warm pool: ${
        config.useAcp && (config.acpToolPoolSize ?? 0) > 0
          ? `${warmFloor(config.acpToolPoolSize, config.acpToolWarmSize)}/${config.acpToolPoolSize} warm/max connection${config.acpToolPoolSize === 1 ? "" : "s"} (elastic_idle=${config.acpElasticIdleMs ?? 120_000}ms, queue=${config.acpToolQueueMax ?? 8}/${config.acpToolQueueTimeoutMs ?? 120_000}ms)`
          : "disabled"
      }`,
    );
    console.log(
      `- external tool mode: ${config.toolSessionMode ?? "stateless"}${
        (config.toolSessionMode ?? "stateless") === "stateless"
          ? " (Chat/Anthropic reconstruct from request history; no parked turn)"
          : " (legacy parked continuation)"
      }`,
    );
    console.log(
      `- legacy parked tool limits: ttl=${config.toolSessionTtlMs ?? 60_000}ms, per-owner=${config.toolSessionMaxPerOwner ?? 4}, global=${config.toolSessionMaxGlobal ?? 16}`,
    );
    console.log(
      `- stateless output tools: ${(config.statelessToolNames ?? []).length > 0 ? `${(config.statelessToolNames ?? []).join(", ")} (repair_retries=${config.statelessRepairRetries ?? 1})` : "disabled"}`,
    );
    console.log(
      `- async batch: ${config.batchEnabled ? `enabled (concurrency=${config.batchConcurrency ?? 6}, max_requests=${config.batchMaxRequests ?? 1000}, max_jobs=${config.batchMaxJobs ?? 100}, retention_ms=${config.batchRetentionMs ?? 259_200_000}, dir=${config.batchDir})` : "disabled"}`,
    );
    console.log(`- workspace: ${config.workspace}`);
    console.log(`- mode: ${config.mode}`);
    console.log(`- default model: ${config.defaultModel}`);
    console.log(`- force: ${config.force}`);
    console.log(`- approve mcps: ${config.approveMcps}`);
    console.log(`- required api key: ${config.requiredKey ? "yes" : "no"}`);
    console.log(`- sessions log: ${config.sessionsLogPath}`);
    console.log(
      `- chat-only workspace: ${config.chatOnlyWorkspace ? "yes (isolated temp dir)" : "no"}`,
    );
    console.log(
      `- verbose traffic: ${config.verbose ? "yes (ASTERMUX_VERBOSE=true)" : "no"}`,
    );
    console.log(
      `- max mode: ${config.maxMode ? "yes (ASTERMUX_MAX_MODE=true)" : "no"}`,
    );
    console.log(
      `- Windows cmdline budget: ${config.winCmdlineMax} (prompt tail truncation when over limit; Windows only)`,
    );
    if (config.configDirs && config.configDirs.length > 0) {
      console.log(
        `- account pool: enabled with ${config.configDirs.length} configuration directories`,
      );
    }
    if (
      config.useAcp &&
      ((config.acpPoolSize ?? 0) > 0 || (config.acpBatchPoolSize ?? 0) > 0)
    ) {
      void primeDefaultAcpPool(config)
        .then(() =>
          console.log(
            `[acp-pool] interactive=${warmFloor(config.acpPoolSize, config.acpInteractiveWarmSize)}/${config.acpPoolSize ?? 0} batch=${warmFloor(config.acpBatchPoolSize, config.acpBatchWarmSize)}/${config.acpBatchPoolSize ?? 0} warm/max workers ready`,
          ),
        )
        .catch((error) =>
          console.warn(
            `[acp-pool] warm-up failed; requests will use the existing one-shot ACP fallback: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
    }
    batchManager?.start();
    if (config.useAcp && (config.acpToolPoolSize ?? 0) > 0) {
      void primeDefaultToolAcpPool(config)
        .then(() =>
          console.log(
            `[acp-tool-pool] ${warmFloor(config.acpToolPoolSize, config.acpToolWarmSize)}/${config.acpToolPoolSize} warm/max connection ready`,
          ),
        )
        .catch((error) =>
          console.warn(
            `[acp-tool-pool] warm-up failed; ${
              (config.toolSessionMode ?? "stateless") === "stateless"
                ? "stateless Tool requests will retry bounded warm-pool initialization"
                : "legacy stateful Tool requests may use the cold ACP path"
            }: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
    }
  });

  return server;
}
