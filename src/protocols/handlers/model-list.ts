import * as http from "node:http";

import type { GatewayConfig } from "../../gateway/config.js";
import type { CursorCliModel } from "../../provider/cursor-agent.js";
import { listCursorCliModels } from "../../provider/cursor-agent.js";
import { json } from "../../gateway/http.js";
import { getAnthropicModelAliases } from "../../provider/model-catalog.js";

const MODEL_CACHE_TTL_MS = 30 * 60_000;

export type ModelCache = { at: number; models: CursorCliModel[] };
export type ModelCacheRef = {
  current?: ModelCache;
  inflight?: Promise<CursorCliModel[]>;
};

export type HandleModelsOpts = {
  config: GatewayConfig;
  modelCacheRef: ModelCacheRef;
};

export async function getCachedCursorModels(
  config: GatewayConfig,
  modelCacheRef: ModelCacheRef,
): Promise<CursorCliModel[]> {
  const now = Date.now();
  const stale =
    !modelCacheRef.current ||
    now - modelCacheRef.current.at > MODEL_CACHE_TTL_MS;

  if (stale && !modelCacheRef.inflight) {
    modelCacheRef.inflight = listCursorCliModels({
      agentBin: config.agentBin,
      timeoutMs: 60_000,
    }).then(
      (models) => {
        // Never cache an empty catalog — usually a parse/env glitch.
        if (models.length > 0) {
          modelCacheRef.current = { at: Date.now(), models };
        }
        modelCacheRef.inflight = undefined;
        return models;
      },
      (err) => {
        modelCacheRef.inflight = undefined;
        throw err;
      },
    );
  }

  // If we already have a catalog, serve it immediately while a stale refresh
  // runs in the background. Only the very first load blocks a request.
  if (modelCacheRef.current) {
    // The stale refresh is intentionally detached from this request. Attach a
    // rejection handler so an upstream catalog failure cannot become an
    // unhandled promise rejection while the known-good cache keeps serving.
    if (modelCacheRef.inflight) void modelCacheRef.inflight.catch(() => undefined);
    return modelCacheRef.current.models;
  }
  if (modelCacheRef.inflight) await modelCacheRef.inflight;
  return (modelCacheRef.current as ModelCache | undefined)?.models ?? [];
}

export async function handleModels(
  res: http.ServerResponse,
  opts: HandleModelsOpts,
): Promise<void> {
  const { config, modelCacheRef } = opts;
  const models = await getCachedCursorModels(config, modelCacheRef);
  const cursorModels = models.map((m) => ({
    id: m.id,
    object: "model" as const,
    owned_by: "cursor" as const,
    name: m.name,
  }));
  const anthropicAliases = getAnthropicModelAliases(
    models.map((m) => m.id),
  ).map((a) => ({
    id: a.id,
    object: "model" as const,
    owned_by: "cursor" as const,
    name: a.name,
  }));

  json(res, 200, {
    object: "list",
    data: [...cursorModels, ...anthropicAliases],
  });
}
