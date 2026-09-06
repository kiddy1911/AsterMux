import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AcpToolSession } from "./tool-turn.js";
import {
  acquireToolAcpConnection,
  closeAllToolAcpPools,
  getToolAcpPoolMetrics,
  primeToolAcpPool,
  ToolAcpQueueError,
  tryAcquireToolAcpConnection,
  type ToolAcpPoolOptions,
} from "./tool-pool.js";

const node = process.execPath;
const cwd = process.cwd();
const fakeServerPath = join(
  cwd,
  "src",
  "acp",
  "__tests__",
  "fake-agent.mjs",
);

function poolOptions(): ToolAcpPoolOptions {
  return {
    command: node,
    args: [fakeServerPath],
    env: { FAKE_ACP_SCENARIO: "tool_pool_slow_first_new" },
    requestWorkspace: cwd,
    requestTimeoutMs: 5_000,
    skipAuthenticate: true,
    poolSize: 1,
    queueMax: 1,
    queueTimeoutMs: 1_000,
    maxRequests: 20,
    maxAgeMs: 60_000,
  };
}

const tools = [
  {
    name: "weather",
    description: "Get weather",
    inputSchema: {
      type: "object",
      properties: { city: { type: "string" } },
    },
  },
];

afterEach(async () => {
  await closeAllToolAcpPools();
});

describe("ACP Tool connection warm pool", () => {
  it("uses a prewarmed connection without changing the Tool lifecycle", async () => {
    const opts = poolOptions();
    await primeToolAcpPool(opts);

    // Measure the same fake scenario without a warm lease. Its first
    // MCP-backed session/new has a deterministic 300ms cold-start penalty.
    const coldSession = new AcpToolSession({
      command: node,
      args: [fakeServerPath],
      cwd,
      env: opts.env,
      timeoutMs: 5_000,
      skipAuthenticate: true,
      tools,
    });
    const coldStarted = Date.now();
    await coldSession.start("Use weather");
    const coldFirst = await coldSession.collect();
    const coldElapsed = Date.now() - coldStarted;
    expect(coldFirst.status).toBe("tool_calls");
    await coldSession.close();

    const lease = tryAcquireToolAcpConnection(opts);
    expect(lease).toBeDefined();

    const session = new AcpToolSession({
      command: node,
      args: [fakeServerPath],
      cwd,
      env: opts.env,
      timeoutMs: 5_000,
      skipAuthenticate: true,
      tools,
      connectionLease: lease,
    });

    const started = Date.now();
    await session.start("Use weather");
    const first = await session.collect();
    const elapsed = Date.now() - started;

    expect(first.status).toBe("tool_calls");
    expect(elapsed).toBeLessThan(coldElapsed);
    expect(coldElapsed - elapsed).toBeGreaterThan(100);
    if (first.status !== "tool_calls") return;
    expect(first.toolCalls[0]).toMatchObject({ name: "weather" });

    // The fixed-size pool must never hand one live connection to two parked
    // Tool sessions. Callers can fall back to the existing cold path instead.
    expect(tryAcquireToolAcpConnection(opts)).toBeUndefined();

    const final = await session.resume([
      { callId: first.toolCalls[0].callId, output: "sunny" },
    ]);
    expect(final.status).toBe("completed");
    expect(final.status === "completed" && final.text).toContain("sunny");

    // A normally completed Tool turn returns the healthy connection to the pool.
    const reused = tryAcquireToolAcpConnection(opts);
    expect(reused).toBeDefined();
    await reused?.release(false);
  });


  it("keeps a Tool warm floor, scales to the ceiling, then shrinks", async () => {
    const opts = {
      ...poolOptions(),
      poolSize: 2,
      warmSize: 1,
      idleTtlMs: 200,
      queueMax: 2,
    };
    await primeToolAcpPool(opts);
    expect(getToolAcpPoolMetrics()).toMatchObject({
      poolSize: 2,
      warmSize: 1,
      workers: 1,
      idle: 1,
    });

    const first = await acquireToolAcpConnection(opts);
    expect(first).toBeDefined();
    const secondPending = acquireToolAcpConnection(opts);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(getToolAcpPoolMetrics()).toMatchObject({
      poolSize: 2,
      warmSize: 1,
      workers: 2,
    });
    const second = await secondPending;
    expect(second).toBeDefined();
    expect(getToolAcpPoolMetrics()).toMatchObject({ workers: 2, busy: 2 });

    await Promise.all([first?.release(true), second?.release(true)]);
    expect(getToolAcpPoolMetrics()).toMatchObject({ workers: 2, busy: 0 });
    await new Promise((resolve) => setTimeout(resolve, 320));
    expect(getToolAcpPoolMetrics()).toMatchObject({
      poolSize: 2,
      warmSize: 1,
      workers: 1,
      busy: 0,
      idle: 1,
    });
  });

  it("preserves eager Tool priming when warmSize is omitted", async () => {
    const opts = { ...poolOptions(), poolSize: 2 };
    await primeToolAcpPool(opts);
    expect(getToolAcpPoolMetrics()).toMatchObject({
      poolSize: 2,
      warmSize: 2,
      workers: 2,
      idle: 2,
    });
  });

  it("shares the same physical Tool pool across model-specific invocations", async () => {
    const firstOpts = {
      ...poolOptions(),
      args: [fakeServerPath, "acp", "--model", "model-a"],
    };
    await primeToolAcpPool(firstOpts);

    const secondOpts = {
      ...firstOpts,
      args: [fakeServerPath, "acp", "--model", "model-b"],
    };
    const lease = await acquireToolAcpConnection(secondOpts);
    expect(lease).toBeDefined();
    expect(getToolAcpPoolMetrics()).toMatchObject({ pools: 1, workers: 1 });
    await lease?.release(false);
  });

  it("queues for a busy warm Tool connection and reuses it after release", async () => {
    const opts = poolOptions();
    await primeToolAcpPool(opts);
    const first = await acquireToolAcpConnection(opts);
    expect(first).toBeDefined();

    let resolved = false;
    const secondPromise = acquireToolAcpConnection(opts).then((lease) => {
      resolved = true;
      return lease;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(resolved).toBe(false);

    await first?.release(true);
    const second = await secondPromise;
    expect(second).toBeDefined();
    await second?.release(false);
  });

  it("rejects bounded Tool queue overload instead of spawning more workers", async () => {
    const opts = poolOptions();
    await primeToolAcpPool(opts);
    const first = await acquireToolAcpConnection(opts);
    const queued = acquireToolAcpConnection(opts);
    await new Promise((resolve) => setTimeout(resolve, 10));

    await expect(acquireToolAcpConnection(opts)).rejects.toMatchObject({
      code: "tool_queue_overloaded",
      status: 429,
    } satisfies Partial<ToolAcpQueueError>);

    await first?.release(true);
    const second = await queued;
    await second?.release(false);
  });

  it("removes an aborted Tool queue waiter and leaves the pool reusable", async () => {
    const opts = { ...poolOptions(), queueTimeoutMs: 1_000 };
    await primeToolAcpPool(opts);
    const first = await acquireToolAcpConnection(opts);
    const controller = new AbortController();
    const queued = acquireToolAcpConnection(opts, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await expect(queued).rejects.toMatchObject({
      code: "tool_queue_aborted",
      status: 499,
    } satisfies Partial<ToolAcpQueueError>);

    await first?.release(true);
    const reused = await acquireToolAcpConnection(opts);
    expect(reused).toBeDefined();
    await reused?.release(false);
  });

  it("times out a Tool queue waiter without leaking the busy worker", async () => {
    const opts = { ...poolOptions(), queueTimeoutMs: 30 };
    await primeToolAcpPool(opts);
    const first = await acquireToolAcpConnection(opts);
    await expect(acquireToolAcpConnection(opts)).rejects.toMatchObject({
      code: "tool_queue_timeout",
      status: 429,
    } satisfies Partial<ToolAcpQueueError>);
    await first?.release(true);
    const reused = await acquireToolAcpConnection(opts);
    expect(reused).toBeDefined();
    await reused?.release(false);
  });
});
