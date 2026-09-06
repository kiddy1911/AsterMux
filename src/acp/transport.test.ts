import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { AcpConnection } from "./transport.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeAcp = path.join(here, "__tests__", "fake-agent.mjs");

describe("AcpConnection", () => {
  it("caps stderr retained by a long-lived connection", async () => {
    const connection = new AcpConnection(process.execPath, [fakeAcp], {
      cwd: process.cwd(),
      env: { FAKE_ACP_SCENARIO: "stderr_flood" },
      requestTimeoutMs: 5_000,
    });
    try {
      await connection.initialize();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(connection.stderr.length).toBeLessThanOrEqual(256 * 1024);
      expect(connection.stderr.endsWith("TAIL")).toBe(true);
    } finally {
      await connection.close();
    }
  });
});
