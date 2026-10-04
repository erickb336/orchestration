// Keep the Mac awake while agents run (ORC-030 C4, the owner's choice). While any run is active, the service holds
// macOS's idle-sleep assertion through one child process, `caffeinate -i -w <the service's pid>`, and ends it when no
// run is active and when the service stops. `-w` ends it with the service too, however the service ends. The display
// may still sleep, and closing the lid still sleeps the Mac. Other systems: nothing is held. The owner's own system
// settings are never changed.

import { spawn } from "node:child_process";
import * as M from "../src/domain/model";
import { activeStudioRuns } from "../src/domain/studio/runs";
import type { State } from "../src/domain/types";

/** Whether any run is active: an agent's or a check's (a task run, a capture included), the lead's, or a studio run. */
export function anyRunActive(s: State): boolean {
  return M.activeAttempts(s).length > 0 || !!M.activeLeadRun(s) || activeStudioRuns(s).length > 0;
}

/** The part of a child process the holder uses. */
export interface HeldProcess {
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: "error", listener: (e: Error) => void): unknown;
}

/** Starts the holding process. Injected in tests, so no test starts a real `caffeinate`. */
export type Spawner = (command: string, args: string[]) => HeldProcess;

/** What the app says about sleep: present only where this service keeps the computer awake. */
export interface KeepAwakeStatus {
  /** True while the assertion is held (a run is active). */
  holding: boolean;
  /** Why the assertion could not be held the last time a run started, if it could not. */
  failed?: string;
}

const CAFFEINATE = "/usr/bin/caffeinate";

const systemSpawner: Spawner = (command, args) => {
  const child = spawn(command, args, { stdio: "ignore" });
  // The service never waits for it: it ends when the runs end, or with the service (-w).
  child.unref();
  return child;
};

export class KeepAwake {
  /** False on systems other than macOS: `set` then does nothing. */
  readonly supported: boolean;
  private readonly pid: number;
  private readonly spawner: Spawner;
  private readonly log: (msg: string) => void;
  private child: HeldProcess | undefined;
  private failed: string | undefined;

  constructor(opts: { platform?: NodeJS.Platform; pid?: number; spawn?: Spawner; log?: (msg: string) => void } = {}) {
    this.supported = (opts.platform ?? process.platform) === "darwin";
    this.pid = opts.pid ?? process.pid;
    this.spawner = opts.spawn ?? systemSpawner;
    this.log = opts.log ?? (() => {});
  }

  get holding(): boolean {
    return !!this.child;
  }

  /**
   * Say whether any run is active. The first active run starts the one holding process; no active run ends it. A
   * process that could not start is not tried again until no run is active, so a missing `caffeinate` costs one try
   * per stretch of work, not one per cycle. A holding process that someone else ended (a signal) is started again; one
   * that failed (an exit code) is not.
   */
  set(active: boolean) {
    if (!this.supported) return;
    if (!active) {
      this.failed = undefined;
      this.end();
      return;
    }
    if (this.child || this.failed) return;
    let child: HeldProcess;
    try {
      child = this.spawner(CAFFEINATE, ["-i", "-w", String(this.pid)]);
    } catch (e) {
      this.fail(e);
      return;
    }
    this.child = child;
    child.once("exit", (code) => {
      if (this.child !== child) return; // ended by us
      this.child = undefined;
      if (code) this.fail(new Error(`it exited with code ${code}`));
    });
    child.once("error", (e) => {
      if (this.child === child) this.child = undefined;
      this.fail(e);
    });
  }

  /** The service stops: let go of the assertion. */
  stop() {
    this.end();
  }

  /** For the app; undefined where nothing is held (other systems). */
  status(): KeepAwakeStatus | undefined {
    if (!this.supported) return undefined;
    return { holding: this.holding, ...(this.failed ? { failed: this.failed } : {}) };
  }

  private end() {
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }

  private fail(e: unknown) {
    this.failed = `caffeinate could not start (${e instanceof Error ? e.message : String(e)})`;
    this.log(`Keeping the Mac awake: ${this.failed}`);
  }
}
