// One lock per computer for the heavy tests (vite.config.ts, the "heavy" project): they start Docker containers,
// Chrome and VHS, and one Docker VM (Colima: 2 CPUs) cannot run two test runs' recordings at once in their time
// limits. The heavy project already runs its files one at a time inside one run; this lock makes a second run on the
// same computer (another agent, or the lead) wait until the first run's heavy tests are done (ORC-030 B-34).
//
// The lock is a folder (mkdir is atomic) holding the holder's process id. A lock whose holder is gone is stale and is
// taken over. The wait has a limit, so a stuck holder fails the run with its reason instead of hanging it.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const LOCK = join(tmpdir(), "orchestrator-heavy-tests.lock");
const WAIT_MS = 60 * 60_000;
const POLL_MS = 2_000;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

const holder = (dir: string) => {
  try {
    return Number(readFileSync(join(dir, "pid"), "utf8"));
  } catch {
    return NaN;
  }
};

/** Take the lock, waiting while another live process holds it. Returns the release. */
export async function takeHeavyLock(dir = LOCK, o: { waitMs?: number; pollMs?: number; log?: (m: string) => void } = {}): Promise<() => void> {
  const until = Date.now() + (o.waitMs ?? WAIT_MS);
  let told = false;
  for (;;) {
    try {
      mkdirSync(dir);
      writeFileSync(join(dir, "pid"), String(process.pid));
      return () => {
        if (holder(dir) === process.pid) rmSync(dir, { recursive: true, force: true });
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const pid = holder(dir);
    // No pid yet: the holder is between its mkdir and its write, or it died there; after 30 s that lock is stale.
    const noPidTooLong = !(pid > 0) && Date.now() - (statSync(dir, { throwIfNoEntry: false })?.mtimeMs ?? Date.now()) > 30_000;
    if ((Number.isInteger(pid) && pid > 0 && !alive(pid)) || noPidTooLong) {
      rmSync(dir, { recursive: true, force: true });
      continue;
    }
    if (Date.now() > until) throw new Error(`The heavy tests waited ${Math.round((o.waitMs ?? WAIT_MS) / 60_000)} min for another test run (pid ${pid}) that holds ${dir}.`);
    if (!told) (o.log ?? console.log)(`Heavy tests: waiting for another test run's Docker tests to finish (pid ${pid}).`);
    told = true;
    await new Promise((r) => setTimeout(r, o.pollMs ?? POLL_MS));
  }
}

/** Vitest's global setup for the heavy project: the lock for the whole run, released at teardown. */
export default async function setup() {
  return await takeHeavyLock();
}
