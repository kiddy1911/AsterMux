import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";

import type { GatewayConfig } from "./config.js";
import { handleHealth } from "../protocols/handlers/health.js";
import {
  getCachedCursorModels,
  handleModels,
  type ModelCacheRef,
} from "../protocols/handlers/model-list.js";
import { handleChatCompletions } from "../protocols/handlers/openai-chat.js";
import { handleResponses } from "../protocols/handlers/openai-responses.js";
import { handleAnthropicMessages } from "../protocols/handlers/anthropic-messages.js";
import {
  adminDashboardMatches,
  handleAdminDashboard,
} from "./control-surface.js";
import { extractBearerToken, json, readBody } from "./http.js";
import { appendSessionLine, logIncoming } from "./request-log.js";
import type { ToolSessionRegistry } from "../acp/stateful-turn-registry.js";
import type { BatchManager, BatchCreateRequest } from "../scheduling/batch-store.js";
import { buildRuntimeStatus, renderPrometheusStatus } from "./status.js";

export type GatewayServerOptions = {
  version: string;
  config: GatewayConfig;
};

export type GatewayRequestRuntime = {
  toolSessions: ToolSessionRegistry;
  batchManager?: BatchManager;
};

export function createRequestListener(
  opts: GatewayServerOptions,
  runtime: GatewayRequestRuntime,
) {
  const { config } = opts;
  const modelCacheRef: ModelCacheRef = { current: undefined };
  const lastRequestedModelRef: { current?: string } = {};

  // Warm the model catalog once at startup so the first chat request does not
  // pay cursor-agent --list-models latency. Failures remain non-fatal: the
  // normal request path will retry.
  void getCachedCursorModels(config, modelCacheRef).catch((error) =>
    console.warn(
      `[models] startup cache warm-up failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ),
  );

  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const protocol = config.tlsCertPath && config.tlsKeyPath ? "https" : "http";
    const url = new URL(
      req.url || "/",
      `${protocol}://${req.headers.host || "localhost"}`,
    );
    const remoteAddress = req.socket?.remoteAddress ?? "unknown";
    const method = req.method ?? "?";
    const pathname = url.pathname;

    // Skip request logging for the admin dashboard's own traffic
    // (status/log/stats polls, asset loads, control actions). These are
    // self-referential noise that pollutes the live log tail the dashboard
    // reads from the sessions log file.
    const isAdminDashboardReq = adminDashboardMatches(req);

    if (!isAdminDashboardReq) {
      logIncoming(method, pathname, remoteAddress);
      res.on("finish", () => {
        appendSessionLine(
          config.sessionsLogPath,
          method,
          pathname,
          remoteAddress,
          res.statusCode,
        );
      });
    }

    try {
      if (req.method === "GET" && pathname === "/healthz") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok\n");
        return;
      }

      if (isAdminDashboardReq) {
        handleAdminDashboard(req, res, opts);
        return;
      }

      if (config.requiredKey) {
        const token = extractBearerToken(req) ?? "";
        const expected = config.requiredKey;
        const a = Buffer.from(token, "utf8");
        const b = Buffer.from(expected, "utf8");
        const match =
          a.length === b.length && crypto.timingSafeEqual(a, b);
        if (!match) {
          json(res, 401, {
            error: { message: "Invalid API key", code: "unauthorized" },
          });
          return;
        }
      }

      if (req.method === "GET" && pathname === "/health") {
        handleHealth(res, { version: opts.version, config });
        return;
      }

      if (req.method === "GET" && pathname === "/v1/runtime/status") {
        json(
          res,
          200,
          buildRuntimeStatus({
            version: opts.version,
            config,
            toolSessions: runtime.toolSessions,
            batchManager: runtime.batchManager,
          }),
        );
        return;
      }

      if (req.method === "GET" && pathname === "/metrics") {
        const text = renderPrometheusStatus({
          version: opts.version,
          config,
          toolSessions: runtime.toolSessions,
          batchManager: runtime.batchManager,
        });
        res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
        res.end(text);
        return;
      }

      if (pathname === "/v1/batches" && req.method === "POST") {
        if (!runtime.batchManager) {
          json(res, 404, { error: { message: "Batch API is disabled", code: "not_found" } });
          return;
        }
        try {
          const input = JSON.parse(await readBody(req)) as BatchCreateRequest;
          json(res, 202, runtime.batchManager.create(input));
        } catch (error) {
          json(res, 400, {
            error: {
              message: error instanceof Error ? error.message : String(error),
              code: "invalid_batch_request",
              type: "invalid_request_error",
            },
          });
        }
        return;
      }

      if (pathname === "/v1/batches" && req.method === "GET") {
        if (!runtime.batchManager) {
          json(res, 404, { error: { message: "Batch API is disabled", code: "not_found" } });
          return;
        }
        const limit = Number(url.searchParams.get("limit") ?? "20");
        json(res, 200, { object: "list", data: runtime.batchManager.list(limit) });
        return;
      }

      const batchMatch = pathname.match(/^\/v1\/batches\/(batch_[a-z0-9]+)(?:\/(results|cancel))?$/i);
      if (batchMatch) {
        if (!runtime.batchManager) {
          json(res, 404, { error: { message: "Batch API is disabled", code: "not_found" } });
          return;
        }
        const batchId = batchMatch[1]!;
        const action = batchMatch[2];
        if (req.method === "GET" && !action) {
          const job = runtime.batchManager.get(batchId);
          json(
            res,
            job ? 200 : 404,
            job ?? { error: { message: "Batch not found", code: "not_found" } },
          );
          return;
        }
        if (req.method === "GET" && action === "results") {
          const result = runtime.batchManager.results(batchId);
          json(
            res,
            result ? 200 : 404,
            result ?? { error: { message: "Batch not found", code: "not_found" } },
          );
          return;
        }
        if (req.method === "POST" && action === "cancel") {
          const job = runtime.batchManager.cancel(batchId);
          json(
            res,
            job ? 200 : 404,
            job ?? { error: { message: "Batch not found", code: "not_found" } },
          );
          return;
        }
      }

      if (req.method === "GET" && pathname === "/v1/models") {
        await handleModels(res, { config, modelCacheRef });
        return;
      }

      if (req.method === "POST" && pathname === "/v1/chat/completions") {
        const raw = await readBody(req);
        await handleChatCompletions(
          req,
          res,
          {
            config,
            lastRequestedModelRef,
            modelCacheRef,
            toolSessions: runtime.toolSessions,
          },
          raw,
          method,
          pathname,
          remoteAddress,
        );
        return;
      }

      if (req.method === "POST" && pathname === "/v1/responses") {
        const raw = await readBody(req);
        await handleResponses(
          req,
          res,
          {
            config,
            lastRequestedModelRef,
            modelCacheRef,
            toolSessions: runtime.toolSessions,
          },
          raw,
          method,
          pathname,
          remoteAddress,
        );
        return;
      }

      if (req.method === "POST" && pathname === "/v1/messages") {
        const raw = await readBody(req);
        await handleAnthropicMessages(
          req,
          res,
          {
            config,
            lastRequestedModelRef,
            modelCacheRef,
            toolSessions: runtime.toolSessions,
          },
          raw,
          method,
          pathname,
          remoteAddress,
        );
        return;
      }

      if (
        (req.method === "POST" || req.method === "GET") &&
        pathname === "/v1/completions"
      ) {
        json(res, 404, {
          error: {
            message:
              "Legacy completions endpoint is not supported. Use POST /v1/chat/completions instead.",
            code: "not_found",
          },
        });
      } else if (pathname === "/v1/embeddings") {
        json(res, 404, {
          error: {
            message: "Embeddings are not supported by this proxy.",
            code: "not_found",
          },
        });
      } else {
        json(res, 404, { error: { message: "Not found", code: "not_found" } });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${new Date().toISOString()}] Gateway error: ${msg}`);
      if (err instanceof Error && err.stack) {
        console.error(err.stack);
      }
      try {
        fs.appendFileSync(
          config.sessionsLogPath,
          `${new Date().toISOString()} ERROR ${method} ${pathname} ${remoteAddress} ${msg.slice(0, 200).replace(/\n/g, " ")}\n`,
        );
      } catch {
        /* ignore */
      }
      if (!res.headersSent) {
        json(res, 500, {
          error: { message: msg, code: "internal_error" },
        });
      } else {
        res.end();
      }
    }
  };
}
