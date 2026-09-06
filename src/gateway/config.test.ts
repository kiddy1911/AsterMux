import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { loadGatewayConfig } from "./config.js";

describe("loadGatewayConfig", () => {
  it("returns defaults when env is empty", () => {
    const config = loadGatewayConfig({ env: {}, cwd: "/workspace" });

    expect(config.agentBin).toBe("agent");
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(8787);
    expect(config.requiredKey).toBeUndefined();
    expect(config.defaultModel).toBe("default");
    expect(config.force).toBe(false);
    expect(config.approveMcps).toBe(false);
    expect(config.strictModel).toBe(true);
    expect(config.mode).toBe("ask");
    expect(config.workspace).toBe("/workspace");
    expect(config.chatOnlyWorkspace).toBe(true);
    expect(config.chatOnlyWorkspaceExplicit).toBe(false);
    expect(config.sessionsLogPath).toBe(path.join("/workspace", "sessions.log"));
    expect(config.winCmdlineMax).toBe(30_000);
    expect(config.contextPreamble).toBe(true);
    expect(config.gatewayPackageVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(config.contextExtra).toBeUndefined();
  });

  it("assembles config from the centralized env layer", () => {
    const config = loadGatewayConfig({
      env: {
        CURSOR_AGENT_BIN: "/usr/bin/agent",
        ASTERMUX_HOST: "0.0.0.0",
        ASTERMUX_PORT: "9999",
        ASTERMUX_API_KEY: "sk-secret",
        ASTERMUX_DEFAULT_MODEL: "org/claude-3-opus",
        ASTERMUX_FORCE: "true",
        ASTERMUX_APPROVE_MCPS: "yes",
        ASTERMUX_STRICT_MODEL: "false",
        ASTERMUX_WORKSPACE: "./my-workspace",
        ASTERMUX_TIMEOUT_MS: "60000",
        ASTERMUX_CHAT_ONLY_WORKSPACE: "false",
        ASTERMUX_VERBOSE: "1",
        ASTERMUX_TLS_CERT: "./certs/test.crt",
        ASTERMUX_TLS_KEY: "./certs/test.key",
      },
      cwd: "/tmp/project",
    });

    expect(config.agentBin).toBe("/usr/bin/agent");
    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(9999);
    expect(config.requiredKey).toBe("sk-secret");
    expect(config.defaultModel).toBe("claude-3-opus");
    expect(config.force).toBe(true);
    expect(config.approveMcps).toBe(true);
    expect(config.strictModel).toBe(false);
    expect(path.isAbsolute(config.workspace)).toBe(true);
    expect(config.workspace).toContain("my-workspace");
    expect(config.timeoutMs).toBe(60000);
    expect(config.chatOnlyWorkspace).toBe(false);
    expect(config.chatOnlyWorkspaceExplicit).toBe(true);
    expect(config.verbose).toBe(true);
    expect(config.tlsCertPath).toBe(
      path.resolve("/tmp/project", "./certs/test.crt"),
    );
    expect(config.tlsKeyPath).toBe(
      path.resolve("/tmp/project", "./certs/test.key"),
    );
  });

  it("sets acpSkipAuthenticate and acpEnv when CURSOR_API_KEY is set", () => {
    const config = loadGatewayConfig({
      env: { CURSOR_API_KEY: "sk-abc", CURSOR_AGENT_BIN: "agent" },
      cwd: "/workspace",
    });
    expect(config.acpSkipAuthenticate).toBe(true);
    expect(config.acpEnv.CURSOR_API_KEY).toBe("sk-abc");
    expect(config.acpEnv.CURSOR_AUTH_TOKEN).toBe("sk-abc");
  });

  it("allows ASTERMUX_ACP_SKIP_AUTHENTICATE to force skip", () => {
    const config = loadGatewayConfig({
      env: {
        ASTERMUX_ACP_SKIP_AUTHENTICATE: "true",
        CURSOR_AGENT_BIN: "agent",
      },
      cwd: "/workspace",
    });
    expect(config.acpSkipAuthenticate).toBe(true);
  });

  it("sets acpRawDebug when ASTERMUX_ACP_RAW_DEBUG=1", () => {
    const config = loadGatewayConfig({
      env: { ASTERMUX_ACP_RAW_DEBUG: "1", CURSOR_AGENT_BIN: "agent" },
      cwd: "/workspace",
    });
    expect(config.acpRawDebug).toBe(true);
  });

  it("loads ASTERMUX_CONTEXT_EXTRA", () => {
    const config = loadGatewayConfig({
      env: {
        CURSOR_AGENT_BIN: "agent",
        ASTERMUX_CONTEXT_EXTRA: "  line1\nline2  ",
      },
      cwd: "/workspace",
    });
    expect(config.contextExtra).toBe("line1\nline2");
  });

  it("uses tailscale host fallback without mutating process.env", () => {
    const config = loadGatewayConfig({
      env: {},
      tailscale: true,
      cwd: "/workspace",
    });

    expect(config.host).toBe("0.0.0.0");
  });

  it("reads ASTERMUX_MODE from env", () => {
    const config = loadGatewayConfig({
      env: { ASTERMUX_MODE: "agent", CURSOR_AGENT_BIN: "agent" },
      cwd: "/workspace",
    });
    expect(config.mode).toBe("agent");
  });

  it("prefers env mode over CLI opts.mode", () => {
    const config = loadGatewayConfig({
      env: { ASTERMUX_MODE: "plan", CURSOR_AGENT_BIN: "agent" },
      mode: "agent",
      cwd: "/workspace",
    });
    expect(config.mode).toBe("plan");
  });

  it("uses opts.mode when env unset", () => {
    const config = loadGatewayConfig({
      env: { CURSOR_AGENT_BIN: "agent" },
      mode: "agent",
      cwd: "/workspace",
    });
    expect(config.mode).toBe("agent");
  });

  it("throws on invalid ASTERMUX_MODE", () => {
    expect(() =>
      loadGatewayConfig({
        env: { ASTERMUX_MODE: "bogus", CURSOR_AGENT_BIN: "agent" },
        cwd: "/workspace",
      }),
    ).toThrow(/ASTERMUX_MODE/);
  });
});
