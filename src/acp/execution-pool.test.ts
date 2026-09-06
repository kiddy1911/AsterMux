import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  AcpPoolQueueError,
  closeAllAcpPools,
  getAcpPoolMetrics,
  primePooledAcp,
  runPooledAcpStream,
  runPooledAcpSync,
  type AcpPoolOptions,
} from "./execution-pool.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeAcp = path.join(here, "__tests__", "fake-agent.mjs");
const roots: string[] = [];

function options(): AcpPoolOptions {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-pool-test-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".cursor", "rules"), { recursive: true });
  fs.mkdirSync(path.join(root, ".config"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cursor", "cli-config.json"), "{}", "utf8");
  return {
    command: process.execPath,
    args: [fakeAcp, "--workspace", root, "acp", "--mode", "ask", "--model", "gpt-4"],
    env: {
      FAKE_ACP_SCENARIO: "",
      HOME: root,
      USERPROFILE: root,
      XDG_CONFIG_HOME: path.join(root, ".config"),
      CURSOR_CONFIG_DIR: path.join(root, ".cursor"),
    },
    requestWorkspace: root,
    requestTimeoutMs: 5_000,
    skipAuthenticate: true,
    poolSize: 1,
    maxRequests: 10,
    maxAgeMs: 60_000,
  };
}

afterEach(async () => {
  await closeAllAcpPools();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("ACP worker pool", () => {
  it("prewarms and serves repeated isolated sessions", async () => {
    const opts = options();
    await primePooledAcp(opts);
    const first = await runPooledAcpSync({ ...opts, prompt: "one" });
    const second = await runPooledAcpSync({ ...opts, prompt: "two" });
    expect(first).toMatchObject({ code: 0, stdout: "Hello from fake ACP" });
    expect(second).toMatchObject({ code: 0, stdout: "Hello from fake ACP" });
  });


  it("keeps only the warm floor hot, scales to the ceiling, then shrinks", async () => {
    const opts = options();
    opts.poolSize = 3;
    opts.warmSize = 1;
    opts.idleTtlMs = 200;
    opts.env.FAKE_ACP_SCENARIO = "slow_count";

    await primePooledAcp(opts);
    expect(getAcpPoolMetrics()[0]).toMatchObject({
      poolSize: 3,
      warmSize: 1,
      workers: 1,
      prepared: 1,
    });

    const pending = Promise.all(
      ["one", "two", "three"].map((prompt) =>
        runPooledAcpSync({ ...opts, prompt }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(getAcpPoolMetrics()[0]).toMatchObject({
      poolSize: 3,
      warmSize: 1,
      workers: 3,
      active: 3,
    });

    const results = await pending;
    expect(results.every((result) => result.code === 0)).toBe(true);

    // The exact number of idle workers immediately after completion is
    // intentionally unspecified: the shrink timer may already have fired on
    // a busy CI host. The active-phase assertion above proves scale-up; the
    // settled assertion below proves convergence back to the warm floor.
    await new Promise((resolve) => setTimeout(resolve, 320));
    expect(getAcpPoolMetrics()[0]).toMatchObject({
      poolSize: 3,
      warmSize: 1,
      workers: 1,
      active: 0,
      prepared: 1,
    });
  });

  it("preserves legacy eager priming when warmSize is omitted", async () => {
    const opts = options();
    opts.poolSize = 3;
    await primePooledAcp(opts);
    expect(getAcpPoolMetrics()[0]).toMatchObject({
      poolSize: 3,
      warmSize: 3,
      workers: 3,
      prepared: 3,
    });
  });

  it("shares one physical pool across models and selects each model per session", async () => {
    const firstOpts = options();
    firstOpts.env.FAKE_ACP_SCENARIO = "universal_models";
    await primePooledAcp(firstOpts);

    const first = await runPooledAcpSync({
      ...firstOpts,
      model: "model-a",
      strictModel: true,
      prompt: "first",
    });
    expect(first.stdout).toBe("model:model-a[fast=false]");

    const secondOpts = {
      ...firstOpts,
      args: firstOpts.args.map((value) =>
        value === "gpt-4" ? "model-b" : value,
      ),
    };
    const second = await runPooledAcpSync({
      ...secondOpts,
      model: "model-b",
      strictModel: true,
      prompt: "second",
    });
    expect(second.stdout).toBe("model:model-b[reasoning=medium,fast=false]");

    const metrics = getAcpPoolMetrics();
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({ workers: 1, completed: 2 });
  });

  it("serves the first request from a prepared session", async () => {
    const opts = options();
    opts.env.FAKE_ACP_SCENARIO = "slow_session_new";
    await primePooledAcp(opts);

    const started = Date.now();
    const result = await runPooledAcpSync({ ...opts, prompt: "prepared" });
    const elapsed = Date.now() - started;

    expect(result.stdout).toBe("Hello from fake ACP");
    expect(elapsed).toBeLessThan(250);
  });

  it("refills the next isolated session while the current prompt runs", async () => {
    const opts = options();
    opts.env.FAKE_ACP_SCENARIO = "overlap_session_refill";
    await primePooledAcp(opts);

    const first = await runPooledAcpSync({ ...opts, prompt: "first" });
    expect(first.stdout).toBe("Hello from fake ACP");

    const started = Date.now();
    const second = await runPooledAcpSync({ ...opts, prompt: "second" });
    const elapsed = Date.now() - started;

    expect(second.stdout).toBe("Hello from fake ACP");
    // session/new is 300ms and prompt is 500ms in this scenario. If refill
    // starts only after the first prompt, the second call is roughly 800ms.
    expect(elapsed).toBeLessThan(650);
  });

  it("reuses a healthy worker after a client abort", async () => {
    const opts = options();
    opts.env.FAKE_ACP_SCENARIO = "slow_count";
    await primePooledAcp(opts);
    const controller = new AbortController();
    const first = runPooledAcpSync({
      ...opts,
      prompt: "first",
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    await expect(first).rejects.toThrow(/aborted/i);

    const second = await runPooledAcpSync({ ...opts, prompt: "second" });
    expect(second.stdout).toBe("prompt-2");
  });

  it("bounds the queue and rejects overload before spawning fallback work", async () => {
    const opts = options();
    opts.env.FAKE_ACP_SCENARIO = "slow_count";
    opts.queueMax = 1;
    opts.queueTimeoutMs = 1_000;
    await primePooledAcp(opts);

    const first = runPooledAcpSync({ ...opts, prompt: "first" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = runPooledAcpSync({ ...opts, prompt: "second" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const started = Date.now();
    await expect(runPooledAcpSync({ ...opts, prompt: "third" })).rejects.toMatchObject({
      code: "queue_overloaded",
      status: 429,
    });
    expect(Date.now() - started).toBeLessThan(80);
    await expect(first).resolves.toMatchObject({ code: 0 });
    await expect(second).resolves.toMatchObject({ code: 0 });
    expect(getAcpPoolMetrics()[0]?.queueRejected).toBe(1);
  });

  it("removes aborted waiters instead of consuming a future worker slot", async () => {
    const opts = options();
    opts.env.FAKE_ACP_SCENARIO = "slow_count";
    opts.queueMax = 2;
    opts.queueTimeoutMs = 1_000;
    await primePooledAcp(opts);

    const first = runPooledAcpSync({ ...opts, prompt: "first" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const controller = new AbortController();
    const queued = runPooledAcpSync({
      ...opts,
      prompt: "queued",
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    await expect(queued).rejects.toBeInstanceOf(AcpPoolQueueError);
    await first;

    const next = await runPooledAcpSync({ ...opts, prompt: "next" });
    expect(next.stdout).toBe("prompt-2");
    const metrics = getAcpPoolMetrics()[0]!;
    expect(metrics.queueAborted).toBe(1);
    expect(metrics.queued).toBe(0);
  });

  it("expires queued work before the request deadline is exhausted", async () => {
    const opts = options();
    opts.env.FAKE_ACP_SCENARIO = "slow_count";
    opts.queueMax = 2;
    opts.queueTimeoutMs = 25;
    await primePooledAcp(opts);

    const first = runPooledAcpSync({ ...opts, prompt: "first" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(runPooledAcpSync({ ...opts, prompt: "queued" })).rejects.toMatchObject({
      code: "queue_timeout",
      status: 429,
    });
    await first;
    expect(getAcpPoolMetrics()[0]?.queueTimedOut).toBe(1);
  });

  it("lets interactive traffic borrow an idle batch worker without queueing", async () => {
    const batch = options();
    batch.env.FAKE_ACP_SCENARIO = "slow_count";
    batch.lane = "batch";
    const interactive = { ...batch, lane: "interactive" as const };
    await Promise.all([primePooledAcp(batch), primePooledAcp(interactive)]);

    const first = runPooledAcpSync({ ...interactive, prompt: "first" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await runPooledAcpSync({
      ...interactive,
      borrowFrom: batch,
      prompt: "second",
    });
    await first;

    expect(second.pool.lane).toBe("interactive");
    expect(second.pool.workerLane).toBe("batch");
    expect(second.pool.queueWaitMs).toBe(0);
    const metrics = getAcpPoolMetrics();
    expect(metrics.find((item) => item.lane === "batch")?.borrowedIn).toBe(1);
  });

  it("keeps interactive and batch lanes on independent workers", async () => {
    const batch = options();
    batch.env.FAKE_ACP_SCENARIO = "slow_count";
    batch.lane = "batch";
    const interactive = { ...batch, lane: "interactive" as const };
    await Promise.all([primePooledAcp(batch), primePooledAcp(interactive)]);

    const batchRun = runPooledAcpSync({ ...batch, prompt: "batch" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const started = Date.now();
    const interactiveRun = await runPooledAcpSync({ ...interactive, prompt: "interactive" });
    const elapsed = Date.now() - started;

    expect(interactiveRun.code).toBe(0);
    expect(elapsed).toBeLessThan(180);
    await batchRun;
    expect(getAcpPoolMetrics().map((item) => item.lane)).toEqual(["batch", "interactive"]);
  });

  it("streams chunks through the pooled connection", async () => {
    const opts = options();
    const chunks: string[] = [];
    const result = await runPooledAcpStream({
      ...opts,
      prompt: "stream",
      onChunk: (text) => chunks.push(text),
    });
    expect(result.code).toBe(0);
    expect(chunks.join("")).toBe("Hello from fake ACP");
  });
});
