import type { GatewayConfig } from "../gateway/config.js";

/**
 * Resolve the requested model (already normalized) to the final model string,
 * applying strictModel and lastRequestedModelRef semantics.
 */
export function resolveModel(
  requested: string | undefined,
  lastRequestedModelRef: { current?: string },
  config: GatewayConfig,
): string {
  const isDefault = requested === "default";
  const explicitModel = requested && !isDefault ? requested : undefined;

  // "default" matches ACP catalog name for session default model — pass through directly
  if (isDefault) return "default";

  return (
    explicitModel ??
    (config.strictModel ? lastRequestedModelRef.current : undefined) ??
    lastRequestedModelRef.current ??
    config.defaultModel
  );
}

/**
 * Persist only the final model used for execution.
 */
export function rememberResolvedModel(
  model: string,
  lastRequestedModelRef: { current?: string },
): void {
  if (!model || model === "default") return;
  lastRequestedModelRef.current = model;
}
