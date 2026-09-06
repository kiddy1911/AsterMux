export type CursorExecutionMode = "agent" | "ask" | "plan";

const MODES = new Set<string>(["agent", "ask", "plan"]);

/**
 * Parse ASTERMUX_MODE; undefined if unset/blank; throws if invalid.
 */
export function tryParseExecutionModeEnv(
  raw: string | undefined,
): CursorExecutionMode | undefined {
  if (raw == null) return undefined;
  const t = raw.trim().toLowerCase();
  if (!t) return undefined;
  if (!MODES.has(t)) {
    throw new Error("ASTERMUX_MODE must be agent, ask, or plan");
  }
  return t as CursorExecutionMode;
}

export function parseExecutionModeFromRequest(
  raw: string,
  source: string,
): CursorExecutionMode {
  const t = raw.trim().toLowerCase();
  if (!t) {
    throw new Error(`${source}: empty mode`);
  }
  if (!MODES.has(t)) {
    throw new Error(`${source}: invalid mode (use agent, ask, or plan)`);
  }
  return t as CursorExecutionMode;
}
