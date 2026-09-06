import { describe, expect, it } from "vitest";

import {
  buildGatewayContext,
  readHttpHeader,
} from "./prompt-context.js";

describe("readHttpHeader", () => {
  it("reads the first header value case-insensitively", () => {
    expect(
      readHttpHeader({ "x-foo": "  bar  " } as any, "X-Foo"),
    ).toBe("bar");
  });

  it("returns undefined for missing or empty", () => {
    expect(readHttpHeader({}, "x-missing")).toBeUndefined();
    expect(readHttpHeader({ "x-missing": "   " }, "x-missing")).toBeUndefined();
  });
});

describe("buildGatewayContext", () => {
  it("uses one line with workspace and cwd when paths differ", () => {
    const text = buildGatewayContext({
      headers: {},
      bridgeWorkspaceBase: "/Users/me/Developer",
      agentWorkspaceDir: "/tmp/astermux-sandbox-abc",
      isolatedChatOnly: true,
      cursorMode: "ask",
    });
    expect(text).toMatch(/^Via astermux → Cursor CLI\./);
    expect(text).toContain("mode=ask");
    expect(text).toContain("/Users/me/Developer");
    expect(text).toContain("/tmp/astermux-sandbox-abc");
    expect(text).toContain("temp sandbox");
    expect(text.split("\n").length).toBe(1);
  });

  it("dedupes to cwd= only when workspace matches cwd and not sandboxed", () => {
    const text = buildGatewayContext({
      headers: {},
      bridgeWorkspaceBase: "/w",
      agentWorkspaceDir: "/w",
      isolatedChatOnly: false,
      cursorMode: "ask",
    });
    expect(text).toContain("cwd=/w");
    expect(text).not.toContain("workspace=");
    expect(text).not.toContain("temp sandbox");
  });

  it("includes X-AsterMux-Workspace hint line when header set", () => {
    const text = buildGatewayContext({
      headers: { "x-astermux-workspace": "/Users/me/Developer/my-app" },
      bridgeWorkspaceBase: "/Users/me/Developer",
      agentWorkspaceDir: "/tmp/sandbox",
      isolatedChatOnly: true,
      cursorMode: "ask",
    });
    expect(text).toContain("X-AsterMux-Workspace=");
    expect(text).toContain("/Users/me/Developer/my-app");
    expect(text).toContain("(hint only)");
  });

  it("prefers X-AsterMux-Invoke-From over X-AsterMux-Client", () => {
    const text = buildGatewayContext({
      headers: {
        "x-astermux-client": "claude-cli-homebrew",
        "x-astermux-invoke-from": "cursor-claude-extension",
      },
      bridgeWorkspaceBase: "/w",
      agentWorkspaceDir: "/w",
      isolatedChatOnly: false,
      cursorMode: "agent",
    });
    expect(text).toContain("client=cursor-claude-extension");
    expect(text).not.toContain("claude-cli-homebrew");
  });

  it("uses X-AsterMux-Client when invoke-from absent", () => {
    const text = buildGatewayContext({
      headers: {
        "x-astermux-client": "sdk-helper",
      },
      bridgeWorkspaceBase: "/w",
      agentWorkspaceDir: "/w",
      isolatedChatOnly: false,
      cursorMode: "ask",
    });
    expect(text).toContain("client=sdk-helper");
  });

  it("does not add a client line from User-Agent alone", () => {
    const text = buildGatewayContext({
      headers: { "user-agent": "curl/8" },
      bridgeWorkspaceBase: "/w",
      agentWorkspaceDir: "/w",
      isolatedChatOnly: false,
      cursorMode: "ask",
    });
    expect(text).not.toContain("client=");
    expect(text).not.toContain("curl");
  });

  it("appends operator context extra on its own line", () => {
    const text = buildGatewayContext({
      headers: {},
      bridgeWorkspaceBase: "/w",
      agentWorkspaceDir: "/w",
      isolatedChatOnly: false,
      cursorMode: "ask",
      contextExtra: "Default ValNet apps under ~/Sites.",
    });
    expect(text).toContain("Default ValNet apps under ~/Sites.");
  });
});
