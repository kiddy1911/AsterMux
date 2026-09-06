import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  computeSessionStats,
  parseSessionLine,
  readLastLines,
  recentSessionRequests,
} from "./session-log.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function readLines(filePath: string, maxLines: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    readLastLines(filePath, maxLines, (err, lines) => {
      if (err) reject(err);
      else resolve(lines);
    });
  });
}

describe("session log", () => {
  it("parses normal request lines including IPv6 addresses", () => {
    expect(
      parseSessionLine(
        "2026-07-13T12:00:00.000Z POST /v1/chat/completions ::1 200",
      ),
    ).toEqual({
      ts: "2026-07-13T12:00:00.000Z",
      method: "POST",
      pathname: "/v1/chat/completions",
      remoteAddress: "::1",
      status: 200,
    });
  });

  it("ignores error and malformed lines", () => {
    expect(
      parseSessionLine(
        "2026-07-13T12:00:00.000Z ERROR POST /v1/messages ::1 agent_exit_1 failed",
      ),
    ).toBeNull();
    expect(parseSessionLine("not a request")).toBeNull();
  });

  it("returns newest requests first and applies the limit", () => {
    const lines = [
      "2026-07-13T12:00:00.000Z GET /first 127.0.0.1 200",
      "2026-07-13T12:00:01.000Z ERROR GET /first 127.0.0.1 failed",
      "2026-07-13T12:00:02.000Z POST /second ::1 500",
    ];

    expect(recentSessionRequests(lines, 1)).toEqual([
      {
        ts: "2026-07-13T12:00:02.000Z",
        method: "POST",
        pathname: "/second",
        remoteAddress: "::1",
        status: 500,
      },
    ]);
  });

  it("computes dashboard-compatible stats", () => {
    const recent = new Date(Date.now() - 60_000).toISOString();
    const old = new Date(Date.now() - 48 * 3600_000).toISOString();
    const stats = computeSessionStats(
      [
        `${old} GET /old ::1 200`,
        `${recent} GET /health ::1 200`,
        `${recent} POST /v1/messages ::1 429`,
      ],
      24,
    );

    expect(stats).toEqual({
      windowHours: 24,
      total: 2,
      errors: 1,
      byPath: { "/health": 1, "/v1/messages": 1 },
      recent: [
        { ts: recent, method: "POST", pathname: "/v1/messages", status: 429 },
        { ts: recent, method: "GET", pathname: "/health", status: 200 },
      ],
    });
  });

  it("tails files and treats a missing file as empty", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-log-"));
    tempDirs.push(dir);
    const logPath = path.join(dir, "sessions.log");
    fs.writeFileSync(logPath, "one\ntwo\nthree\n", "utf8");

    await expect(readLines(logPath, 2)).resolves.toEqual(["two", "three"]);
    await expect(readLines(path.join(dir, "missing.log"), 2)).resolves.toEqual(
      [],
    );
  });
});
