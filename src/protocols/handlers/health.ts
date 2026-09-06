import * as http from "node:http";

import type { GatewayConfig } from "../../gateway/config.js";
import { json } from "../../gateway/http.js";

export type HealthHandlerOpts = {
  version: string;
  config: GatewayConfig;
};

export function handleHealth(
  res: http.ServerResponse,
  opts: HealthHandlerOpts,
): void {
  const { version, config } = opts;
  // mode: default for Cursor CLI; clients may override per request (body.mode, X-AsterMux-Mode).
  json(res, 200, {
    ok: true,
    version,
    workspace: config.workspace,
    mode: config.mode,
    perRequestMode: true,
    defaultModel: config.defaultModel,
    force: config.force,
    approveMcps: config.approveMcps,
    strictModel: config.strictModel,
  });
}
