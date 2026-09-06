import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BatchManager, type BatchExecutor } from "./batch-store.js";
import type { GatewayConfig } from "../gateway/config.js";

const roots: string[] = [];

function config(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "astermux-batch-store-test-"));
  roots.push(root);
  return {
    agentBin: "agent",
    acpCommand: "agent",
    acpArgs: ["acp"],
    acpEnv: {},
    host: "127.0.0.1",
    port: 9999,
    defaultModel: "gpt-4",
    mode: "ask",
    force: false,
    approveMcps: false,
    strictModel: true,
    workspace: root,
    timeoutMs: 5_000,
    sessionsLogPath: path.join(root, "sessions.log"),
    chatOnlyWorkspace: true,
    chatOnlyWorkspaceExplicit: false,
    verbose: false,
    maxMode: false,
    promptViaStdin: false,
    useAcp: true,
    acpSkipAuthenticate: true,
    acpRawDebug: false,
    acpPoolSize: 1,
    acpBatchPoolSize: 1,
    acpPoolMaxRequests: 100,
    acpPoolMaxAgeMs: 3_600_000,
    configDirs: [],
    multiPort: false,
    winCmdlineMax: 30_000,
    contextPreamble: false,
    gatewayPackageVersion: "test",
    batchEnabled: true,
    batchDir: path.join(root, "batches"),
    batchConcurrency: 2,
    batchMaxRequests: 10,
    ...overrides,
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for batch");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("BatchManager", () => {
  it("persists and completes queued requests with bounded concurrency", async () => {
    let active = 0;
    let maxActive = 0;
    const executor: BatchExecutor = async (body) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 30));
      active -= 1;
      return { statusCode: 200, body: { ok: true, echo: body.value } };
    };
    const cfg = config();
    const manager = new BatchManager(cfg, executor);
    manager.start();
    const created = manager.create({
      requests: [1, 2, 3, 4].map((value) => ({
        custom_id: `id-${value}`,
        body: { value },
      })),
    });

    await waitFor(() => manager.get(created.id)?.status === "completed");
    const results = manager.results(created.id)!;
    expect(results.request_counts.completed).toBe(4);
    expect(results.data.every((item) => item.status === "completed")).toBe(true);
    expect(maxActive).toBe(2);
    expect(fs.existsSync(path.join(cfg.batchDir!, `${created.id}.json`))).toBe(true);
    manager.close();
  });

  it("reloads in-progress items as queued after restart", async () => {
    const cfg = config();
    fs.mkdirSync(cfg.batchDir!, { recursive: true });
    const id = "batch_restartfixture";
    fs.writeFileSync(
      path.join(cfg.batchDir!, `${id}.json`),
      JSON.stringify({
        id,
        object: "proxy.batch",
        status: "in_progress",
        created_at: 1,
        updated_at: 1,
        items: [
          {
            custom_id: "one",
            status: "in_progress",
            body: { value: 1 },
            attempts: 1,
            created_at: 1,
          },
        ],
      }),
    );
    const manager = new BatchManager(cfg, async () => ({ statusCode: 200, body: { ok: true } }));
    expect(manager.get(id, true)?.status).toBe("queued");
    expect((manager.get(id, true) as any).items[0].status).toBe("queued");
    manager.start();
    await waitFor(() => manager.get(id)?.status === "completed");
    manager.close();
  });

  it("rejects streaming and oversized batches", () => {
    const cfg = config({ batchMaxRequests: 1 });
    const manager = new BatchManager(cfg, async () => ({ statusCode: 200, body: {} }));
    expect(() =>
      manager.create({ requests: [{ body: { stream: true } }] }),
    ).toThrow(/stream=true/);
    expect(() =>
      manager.create({ requests: [{ body: {} }, { body: {} }] }),
    ).toThrow(/maximum is 1/);
    manager.close();
  });

  it("prunes expired terminal jobs but keeps active jobs", () => {
    const cfg = config({ batchRetentionMs: 60_000, batchMaxJobs: 10 });
    fs.mkdirSync(cfg.batchDir!, { recursive: true });
    const old = Math.floor((Date.now() - 120_000) / 1000);
    fs.writeFileSync(
      path.join(cfg.batchDir!, "batch_expired.json"),
      JSON.stringify({
        id: "batch_expired",
        object: "proxy.batch",
        status: "completed",
        created_at: old,
        updated_at: old,
        completed_at: old,
        items: [],
      }),
    );
    fs.writeFileSync(
      path.join(cfg.batchDir!, "batch_active.json"),
      JSON.stringify({
        id: "batch_active",
        object: "proxy.batch",
        status: "queued",
        created_at: old,
        updated_at: old,
        items: [
          {
            custom_id: "one",
            status: "queued",
            body: { value: 1 },
            attempts: 0,
            created_at: old,
          },
        ],
      }),
    );

    const manager = new BatchManager(cfg, async () => ({ statusCode: 200, body: {} }));
    expect(manager.get("batch_expired")).toBeUndefined();
    expect(fs.existsSync(path.join(cfg.batchDir!, "batch_expired.json"))).toBe(false);
    expect(manager.get("batch_active")).toBeDefined();
    manager.close();
  });

  it("evicts oldest terminal jobs to make room without dropping active work", () => {
    const cfg = config({ batchMaxJobs: 2, batchRetentionMs: 86_400_000 });
    fs.mkdirSync(cfg.batchDir!, { recursive: true });
    const now = Math.floor(Date.now() / 1000);
    for (const [id, updated] of [["batch_old", now - 10], ["batch_new", now - 5]] as const) {
      fs.writeFileSync(
        path.join(cfg.batchDir!, `${id}.json`),
        JSON.stringify({
          id,
          object: "proxy.batch",
          status: "completed",
          created_at: updated,
          updated_at: updated,
          completed_at: updated,
          items: [],
        }),
      );
    }

    const manager = new BatchManager(cfg, async () => ({ statusCode: 200, body: {} }));
    const created = manager.create({ requests: [{ custom_id: "fresh", body: { value: 1 } }] });
    expect(created.id).toMatch(/^batch_/);
    expect(manager.get("batch_old")).toBeUndefined();
    expect(manager.get("batch_new")).toBeDefined();
    expect(manager.snapshot().jobs).toBe(2);
    manager.close();
  });

  it("rejects new jobs when the job cap is occupied entirely by active work", () => {
    const cfg = config({ batchMaxJobs: 1 });
    const manager = new BatchManager(cfg, async () => ({ statusCode: 200, body: {} }));
    manager.create({ requests: [{ body: { value: 1 } }] });
    expect(() => manager.create({ requests: [{ body: { value: 2 } }] })).toThrow(
      /Batch job limit reached/,
    );
    manager.close();
  });

  it("aborts in-progress work when a batch is cancelled", async () => {
    let observedAbort = false;
    const manager = new BatchManager(config({ batchConcurrency: 1 }), async (_body, context) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ statusCode: 200, body: { late: true } }), 5_000);
        context.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            observedAbort = true;
            reject(new Error("cancelled"));
          },
          { once: true },
        );
      }),
    );
    manager.start();
    const job = manager.create({ requests: [{ custom_id: "one", body: { value: 1 } }] });
    await waitFor(() => manager.get(job.id)?.request_counts.in_progress === 1);
    const cancelled = manager.cancel(job.id)!;
    expect(cancelled.status).toBe("cancelled");
    await waitFor(() => manager.results(job.id)?.data[0]?.status === "cancelled");
    expect(observedAbort).toBe(true);
    expect(manager.snapshot().active).toBe(0);
    manager.close();
  });

  it("retries a bounded stateless-format failure for batch reliability", async () => {
    let calls = 0;
    const manager = new BatchManager(config({ batchConcurrency: 1 }), async () => {
      calls += 1;
      if (calls === 1) {
        return {
          statusCode: 502,
          body: {
            error: {
              code: "stateless_tool_output_invalid",
              message: "invalid JSON",
            },
          },
        };
      }
      return { statusCode: 200, body: { ok: true } };
    });
    manager.start();
    const job = manager.create({ requests: [{ body: { value: 1 } }] });
    await waitFor(() => manager.get(job.id)?.status === "completed", 3_000);
    expect(calls).toBe(2);
    expect(manager.results(job.id)?.data[0]?.attempts).toBe(2);
    manager.close();
  });

  it("retries transient 429 responses", async () => {
    let calls = 0;
    const manager = new BatchManager(config({ batchConcurrency: 1 }), async () => {
      calls += 1;
      if (calls === 1) {
        return {
          statusCode: 429,
          body: { error: { code: "queue_overloaded", message: "busy" } },
          headers: { "retry-after": "0" },
        };
      }
      return { statusCode: 200, body: { ok: true } };
    });
    manager.start();
    const job = manager.create({ requests: [{ body: { value: 1 } }] });
    await waitFor(() => manager.get(job.id)?.status === "completed");
    expect(calls).toBe(2);
    manager.close();
  });
});
