import type { GatewayConfig } from "./config.js";
import { getAcpPoolMetrics } from "../acp/execution-pool.js";
import { getToolAcpPoolMetrics } from "../acp/tool-pool.js";
import type { BatchManager } from "../scheduling/batch-store.js";
import type { ToolSessionRegistry } from "../acp/stateful-turn-registry.js";
import { getStatelessOutputMetrics } from "../protocols/structured-output.js";

export function buildRuntimeStatus(opts: {
  version: string;
  config: GatewayConfig;
  toolSessions: ToolSessionRegistry;
  batchManager?: BatchManager;
}) {
  return {
    ok: true,
    version: opts.version,
    model: opts.config.defaultModel,
    pools: getAcpPoolMetrics(),
    tool_sessions: {
      mode: opts.config.toolSessionMode ?? "stateless",
      parked: opts.toolSessions.size,
      reserved: opts.toolSessions.reservedSize,
      max_per_owner: opts.config.toolSessionMaxPerOwner ?? 4,
      max_global: opts.config.toolSessionMaxGlobal ?? 16,
      ttl_ms: opts.config.toolSessionTtlMs ?? 60_000,
    },
    tool_pool: {
      ...getToolAcpPoolMetrics(),
      configured_size: opts.config.acpToolPoolSize ?? 0,
      configured_warm_size:
        opts.config.acpToolWarmSize == null || opts.config.acpToolWarmSize < 0
          ? (opts.config.acpToolPoolSize ?? 0)
          : Math.min(
              opts.config.acpToolPoolSize ?? 0,
              Math.max(0, Math.floor(opts.config.acpToolWarmSize)),
            ),
      queue_max: opts.config.acpToolQueueMax ?? 8,
      queue_timeout_ms: opts.config.acpToolQueueTimeoutMs ?? 120_000,
    },
    stateless_output: getStatelessOutputMetrics(),
    batch: opts.batchManager?.snapshot() ?? {
      enabled: false,
      concurrency: 0,
      active: 0,
      jobs: 0,
      queued: 0,
      in_progress: 0,
      completed: 0,
      failed: 0,
    },
  };
}

export function renderPrometheusStatus(opts: {
  version: string;
  config: GatewayConfig;
  toolSessions: ToolSessionRegistry;
  batchManager?: BatchManager;
}): string {
  const status = buildRuntimeStatus(opts);
  const lines: string[] = [
    "# TYPE astermux_acp_pool_workers gauge",
    "# TYPE astermux_acp_pool_size gauge",
    "# TYPE astermux_acp_pool_warm_size gauge",
    "# TYPE astermux_acp_pool_active gauge",
    "# TYPE astermux_acp_pool_queued gauge",
    "# TYPE astermux_acp_pool_queue_rejected_total counter",
    "# TYPE astermux_acp_pool_queue_timeout_total counter",
    "# TYPE astermux_acp_pool_queue_aborted_total counter",
    "# TYPE astermux_acp_pool_borrowed_in_total counter",
    "# TYPE astermux_acp_pool_completed_total counter",
    "# TYPE astermux_acp_pool_failed_total counter",
    "# TYPE astermux_acp_pool_cancelled_total counter",
    "# TYPE astermux_acp_pool_avg_queue_wait_ms gauge",
    "# TYPE astermux_acp_pool_avg_execution_ms gauge",
  ];
  for (const pool of status.pools) {
    const label = `{lane="${pool.lane}"}`;
    lines.push(`astermux_acp_pool_workers${label} ${pool.workers}`);
    lines.push(`astermux_acp_pool_size${label} ${pool.poolSize}`);
    lines.push(`astermux_acp_pool_warm_size${label} ${pool.warmSize}`);
    lines.push(`astermux_acp_pool_active${label} ${pool.active}`);
    lines.push(`astermux_acp_pool_queued${label} ${pool.queued}`);
    lines.push(`astermux_acp_pool_queue_rejected_total${label} ${pool.queueRejected}`);
    lines.push(`astermux_acp_pool_queue_timeout_total${label} ${pool.queueTimedOut}`);
    lines.push(`astermux_acp_pool_queue_aborted_total${label} ${pool.queueAborted}`);
    lines.push(`astermux_acp_pool_borrowed_in_total${label} ${pool.borrowedIn}`);
    lines.push(`astermux_acp_pool_completed_total${label} ${pool.completed}`);
    lines.push(`astermux_acp_pool_failed_total${label} ${pool.failed}`);
    lines.push(`astermux_acp_pool_cancelled_total${label} ${pool.cancelled}`);
    lines.push(`astermux_acp_pool_avg_queue_wait_ms${label} ${pool.avgQueueWaitMs}`);
    lines.push(`astermux_acp_pool_avg_execution_ms${label} ${pool.avgExecutionMs}`);
  }
  lines.push("# TYPE astermux_tool_sessions_parked gauge");
  lines.push(`astermux_tool_sessions_parked ${status.tool_sessions.parked}`);
  lines.push("# TYPE astermux_tool_sessions_reserved gauge");
  lines.push(`astermux_tool_sessions_reserved ${status.tool_sessions.reserved}`);
  lines.push("# TYPE astermux_tool_pool_workers gauge");
  lines.push(`astermux_tool_pool_workers ${status.tool_pool.workers}`);
  lines.push("# TYPE astermux_tool_pool_size gauge");
  lines.push(`astermux_tool_pool_size ${status.tool_pool.poolSize}`);
  lines.push("# TYPE astermux_tool_pool_warm_size gauge");
  lines.push(`astermux_tool_pool_warm_size ${status.tool_pool.warmSize}`);
  lines.push("# TYPE astermux_tool_pool_busy gauge");
  lines.push(`astermux_tool_pool_busy ${status.tool_pool.busy}`);
  lines.push("# TYPE astermux_tool_pool_queued gauge");
  lines.push(`astermux_tool_pool_queued ${status.tool_pool.queued}`);
  lines.push("# TYPE astermux_stateless_first_pass_total counter");
  lines.push(
    `astermux_stateless_first_pass_total ${status.stateless_output.firstPassCompleted}`,
  );
  lines.push("# TYPE astermux_stateless_repair_attempts_total counter");
  lines.push(
    `astermux_stateless_repair_attempts_total ${status.stateless_output.repairAttempts}`,
  );
  lines.push("# TYPE astermux_stateless_repair_completed_total counter");
  lines.push(
    `astermux_stateless_repair_completed_total ${status.stateless_output.repairCompleted}`,
  );
  lines.push("# TYPE astermux_stateless_failed_total counter");
  lines.push(`astermux_stateless_failed_total ${status.stateless_output.failed}`);
  lines.push("# TYPE astermux_batch_active gauge");
  lines.push(`astermux_batch_active ${status.batch.active}`);
  lines.push("# TYPE astermux_batch_queued gauge");
  lines.push(`astermux_batch_queued ${status.batch.queued}`);
  lines.push("# TYPE astermux_batch_completed_total counter");
  lines.push(`astermux_batch_completed_total ${status.batch.completed}`);
  lines.push("# TYPE astermux_batch_failed_total counter");
  lines.push(`astermux_batch_failed_total ${status.batch.failed}`);
  return `${lines.join("\n")}\n`;
}
