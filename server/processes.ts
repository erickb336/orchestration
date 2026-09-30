// The service's live child processes: every process group an adapter or the check runner started and
// has not seen exit. If this process exits, they are killed, so no agent or check outlives the service
// that is responsible for it. Shared by the Codex adapter (server/runtimes/codex.ts) and the check
// runners (server/checks.ts).

import type { ChildProcess } from "node:child_process";

const LIVE = new Set<ChildProcess>();
let exitHookInstalled = false;

/** Register a child (spawned detached, so it leads its own process group) for the exit hook. */
export function trackLive(child: ChildProcess) {
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on("exit", () => {
      for (const c of LIVE) killGroup(c, "SIGKILL");
    });
  }
  LIVE.add(child);
  child.once("exit", () => LIVE.delete(child));
  child.once("error", () => LIVE.delete(child));
}

/** Signal the child's whole process group (it was spawned detached), falling back to the child alone. */
export function killGroup(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      /* fall through to the direct kill */
    }
  }
  try {
    child.kill(signal);
  } catch {
    /* already gone */
  }
}

/** Live children still tracked (tests). */
export function liveCount(): number {
  return LIVE.size;
}
