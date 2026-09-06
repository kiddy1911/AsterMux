import type { ChildProcess } from "node:child_process";

/**
 * The Cursor CLI spawns its own helpers (a TypeScript language server among
 * them) that outlive the agent process. Signalling only the agent leaves those
 * grandchildren running inside the service cgroup, where they accumulate until
 * the memory limit is hit. Agents are therefore spawned as process-group
 * leaders and signalled by negative pid so the whole group goes down together.
 */
export const DETACH_CHILDREN = process.platform !== "win32";

export function killProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
  opts: { detached?: boolean } = {},
): void {
  const detached = opts.detached ?? DETACH_CHILDREN;
  if (detached && typeof child.pid === "number") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      /* group already gone — fall through to the direct child */
    }
  }
  try {
    child.kill(signal);
  } catch {
    /* already exited */
  }
}
