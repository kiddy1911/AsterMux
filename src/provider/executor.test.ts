import { describe, it, expect, vi, beforeEach } from "vitest";

import type { GatewayConfig } from "../gateway/config.js";
import { runAgentSync, runAgentStream } from "./executor.js";
import { runAcpStream, runAcpSync } from "../acp/session-client.js";
import { runPooledAcpStream, runPooledAcpSync } from "../acp/execution-pool.js";
import { run, runStreaming } from "../runtime/subprocess.js";

vi.mock("../acp/session-client.js", () => ({
  runAcpSync: vi.fn().mockResolvedValue({ code: 0, stdout: "ok", stderr: "" }),
  runAcpStream: vi.fn().mockResolvedValue({ code: 0, stderr: "" }),
}));


vi.mock("../acp/execution-pool.js", () => {
  class PooledAcpRunError extends Error {
    hadOutput: boolean;
    constructor(message: string, hadOutput: boolean) {
      super(message);
      this.hadOutput = hadOutput;
    }
  }
  class AcpPoolQueueError extends Error {}
  return {
    PooledAcpRunError,
    AcpPoolQueueError,
    primePooledAcp: vi.fn().mockResolvedValue(undefined),
    runPooledAcpSync: vi.fn().mockResolvedValue({ code: 0, stdout: "pooled", stderr: "" }),
    runPooledAcpStream: vi.fn().mockResolvedValue({ code: 0, stderr: "" }),
  };
});

vi.mock("../runtime/subprocess.js", () => ({
  run: vi.fn().mockResolvedValue({ code: 0, stdout: "cli", stderr: "" }),
  runStreaming: vi.fn().mockResolvedValue({ code: 0, stderr: "" }),
}));

vi.mock("./token-cache.js", () => ({
  readKeychainToken: vi.fn().mockReturnValue(undefined),
  writeCachedToken: vi.fn(),
}));

function config(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    agentBin: "agent",
    acpCommand: "agent",
    acpArgs: ["acp"],
    acpEnv: {},
    host: "127.0.0.1",
    port: 0,
    defaultModel: "default",
    mode: "ask",
    force: false,
    approveMcps: false,
    strictModel: true,
    workspace: process.cwd(),
    timeoutMs: 123_456,
    sessionsLogPath: "/tmp/astermux-executor-test.log",
    chatOnlyWorkspace: true,
    chatOnlyWorkspaceExplicit: false,
    verbose: false,
    maxMode: false,
    promptViaStdin: false,
    useAcp: true,
    acpSkipAuthenticate: true,
    acpRawDebug: false,
    acpPoolSize: 0,
    acpPoolMaxRequests: 100,
    acpPoolMaxAgeMs: 3_600_000,
    configDirs: [],
    multiPort: false,
    winCmdlineMax: 30_000,
    contextPreamble: true,
    gatewayPackageVersion: "0.0.0-test",
    ...overrides,
  };
}

describe("ACP requestTimeoutMs", () => {
  beforeEach(() => {
    vi.mocked(runAcpSync).mockClear();
    vi.mocked(runAcpStream).mockClear();
  });

  it("passes config.timeoutMs as ACP sync requestTimeoutMs", async () => {
    await runAgentSync(
      config(),
      "/tmp/ws",
      true,
      ["--print", "--mode", "ask", "--model", "auto"],
      undefined,
      "hello",
    );
    expect(runAcpSync).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runAcpSync).mock.calls[0][3]).toMatchObject({
      timeoutMs: 123_456,
      requestTimeoutMs: 123_456,
    });
  });

  it("passes config.timeoutMs as ACP stream requestTimeoutMs", async () => {
    await runAgentStream(
      config(),
      "/tmp/ws",
      true,
      ["--print", "--mode", "ask", "--model", "auto"],
      () => {},
      undefined,
      "hello",
    );
    expect(runAcpStream).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runAcpStream).mock.calls[0][3]).toMatchObject({
      timeoutMs: 123_456,
      requestTimeoutMs: 123_456,
    });
  });
});


describe("ACP hot pool routing", () => {
  beforeEach(() => {
    vi.mocked(runAcpSync).mockClear();
    vi.mocked(runAcpStream).mockClear();
    vi.mocked(runPooledAcpSync).mockClear();
    vi.mocked(runPooledAcpStream).mockClear();
    vi.mocked(run).mockClear();
    vi.mocked(runStreaming).mockClear();
  });

  it("uses the pool for the isolated default ask model", async () => {
    await runAgentSync(
      config({ defaultModel: "auto", acpPoolSize: 2 }),
      "/tmp/ws",
      true,
      ["--print", "--mode", "ask", "--model", "auto"],
      undefined,
      "hello",
    );
    expect(runPooledAcpSync).toHaveBeenCalledTimes(1);
    expect(runAcpSync).not.toHaveBeenCalled();
  });

  it("uses the same hot pool for non-default ask models", async () => {
    await runAgentSync(
      config({ defaultModel: "auto", acpPoolSize: 2 }),
      "/tmp/ws",
      true,
      ["--print", "--mode", "ask", "--model", "gpt-5.6-sol"],
      undefined,
      "hello",
    );
    expect(runPooledAcpSync).toHaveBeenCalledTimes(1);
    expect(runAcpSync).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(vi.mocked(runPooledAcpSync).mock.calls[0][0]).toMatchObject({
      model: "gpt-5.6-sol",
      strictModel: true,
    });
  });

  it("falls back to legacy CLI when pooled sync fails", async () => {
    vi.mocked(runPooledAcpSync).mockRejectedValueOnce(new Error("pool down"));
    await runAgentSync(
      config({ defaultModel: "auto", acpPoolSize: 2 }),
      "/tmp/ws",
      true,
      ["--print", "--mode", "ask", "--model", "auto"],
      undefined,
      "hello",
    );
    expect(runPooledAcpSync).toHaveBeenCalledTimes(1);
    expect(runAcpSync).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("adds trust for fresh-container plan compatibility", async () => {
    await runAgentSync(
      config({ defaultModel: "auto", acpPoolSize: 2 }),
      "/app",
      false,
      ["--print", "--mode", "plan", "--model", "auto"],
      undefined,
      "make a plan",
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(vi.mocked(run).mock.calls[0][1]).toEqual([
      "--print",
      "--trust",
      "--mode",
      "plan",
      "--model",
      "auto",
      "make a plan",
    ]);
  });

  it("uses the same hot pool for non-default streaming requests", async () => {
    vi.mocked(runPooledAcpStream).mockImplementationOnce(async (opts: any) => {
      opts.onChunk?.("ok");
      return {
        code: 0,
        stderr: "",
        pool: { lane: "interactive", queueWaitMs: 0, executionMs: 1 },
      };
    });
    const chunks: string[] = [];
    await runAgentStream(
      config({ defaultModel: "auto", acpPoolSize: 2 }),
      "/tmp/ws",
      true,
      [
        "--print",
        "--mode",
        "ask",
        "--model",
        "gpt-5.6-sol",
        "--stream-partial-output",
        "--output-format",
        "stream-json",
      ],
      (chunk) => chunks.push(chunk),
      undefined,
      "hello",
    );
    expect(runPooledAcpStream).toHaveBeenCalledTimes(1);
    expect(runAcpStream).not.toHaveBeenCalled();
    expect(runStreaming).not.toHaveBeenCalled();
    expect(vi.mocked(runPooledAcpStream).mock.calls[0][0]).toMatchObject({
      model: "gpt-5.6-sol",
      strictModel: true,
    });
    expect(chunks).toEqual(["ok"]);
  });
});
