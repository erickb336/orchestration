// The single project scheduler. It holds a renewable lease in the store; only the holder
// dispatches work, drives the runtime, and applies runtime reports. Gaining the lease (at startup
// or after another holder's lease expired) triggers reconciliation before any dispatch: runs the
// runtime has no process for are marked lost or stopped, never completed and never duplicated.

import { randomUUID } from "node:crypto";
import * as M from "../src/domain/model";
import type { State } from "../src/domain/types";
import { simulatedOutputs } from "../src/runtime/simulated";
import type { FakeRuntime } from "./fakeRuntime";
import { LeaseLostError, type Store } from "./store";

export const SCHEDULER_LEASE = "scheduler";

export interface SchedulerOptions {
  leaseMs?: number;
  ackTimeoutMs?: number;
  log?: (msg: string) => void;
}

export class Scheduler {
  readonly holder = randomUUID();
  /** Whether the simulation clock advances on each timer tick. */
  auto = true;
  private isActive = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly leaseMs: number;
  private readonly ackTimeoutMs: number;
  private readonly log: (msg: string) => void;
  private readonly store: Store;
  private readonly runtime: FakeRuntime;

  constructor(store: Store, runtime: FakeRuntime, opts: SchedulerOptions = {}) {
    this.store = store;
    this.runtime = runtime;
    // Much longer than the tick interval and the database busy timeout, so a slow cycle does not
    // outlive its lease; every write re-checks the lease anyway.
    this.leaseMs = opts.leaseMs ?? 15000;
    this.ackTimeoutMs = opts.ackTimeoutMs ?? 8000;
    this.log = opts.log ?? (() => {});
  }

  get active() {
    return this.isActive;
  }

  private lease(nowMs: number) {
    return { name: SCHEDULER_LEASE, holder: this.holder, nowMs };
  }

  /** Stop acting as scheduler: local processes can no longer be trusted or reported. */
  private deactivate(reason: string) {
    if (this.isActive) this.log(`${reason}; dropping local runtime processes`);
    this.isActive = false;
    this.runtime.clear();
    this.store.emit();
  }

  /**
   * Renew the lease. On gaining it, reconcile first and become active only once reconciliation
   * has committed; if it fails, give the lease back so it is retried rather than skipped.
   */
  heartbeat(nowMs: number): boolean {
    const held = this.store.acquireLease(SCHEDULER_LEASE, this.holder, this.leaseMs, nowMs);
    if (!held) {
      if (this.isActive) this.deactivate("Scheduler lease lost");
      return false;
    }
    if (this.isActive) return true;
    try {
      this.log("Scheduler lease acquired; reconciling runs");
      this.runtime.clear();
      this.reconcile(nowMs);
      this.isActive = true;
      this.store.emit();
    } catch (e) {
      this.log(`Reconciliation failed (${e instanceof Error ? e.message : String(e)}); releasing the lease to retry`);
      this.store.releaseLease(SCHEDULER_LEASE, this.holder);
      this.isActive = false;
    }
    return this.isActive;
  }

  /** Mark every active run without a runtime process as lost (or stopped, if it was stopping). */
  reconcile(nowMs: number) {
    const now = new Date(nowMs).toISOString();
    this.store.update(
      (s) => {
        let next = s;
        for (const a of M.activeAttempts(s)) {
          if (!this.runtime.has(a.id)) next = M.reportRunLost(next, a.id, "No runtime process found after the service restarted or the scheduler changed", now);
        }
        return next;
      },
      now,
      this.lease(nowMs),
    );
  }

  /** One scheduling cycle: dispatch, start new runs, propagate stops, advance the runtime, apply reports. */
  cycle(nowMs: number) {
    if (!this.isActive) return;
    try {
      this.runCycle(nowMs);
    } catch (e) {
      if (e instanceof LeaseLostError) this.deactivate("Scheduler lease lost during a cycle");
      else throw e;
    }
  }

  private runCycle(nowMs: number) {
    const now = new Date(nowMs).toISOString();
    const lease = this.lease(nowMs);

    // 1. Lead promotion and dispatch, committed before any runtime process starts. If the service
    //    dies between the commit and the start, reconciliation marks the run lost.
    const dispatched = new Set<string>();
    this.store.update(
      (s) => {
        dispatched.clear();
        const before = new Set(M.activeAttempts(s).map((a) => a.id));
        const next = M.dispatchEligible(M.leadPromoteProposals(s, now), now);
        for (const a of M.activeAttempts(next)) if (!before.has(a.id)) dispatched.add(a.id);
        return next;
      },
      now,
      lease,
    );

    // 2. Start only the runs dispatched in step 1. Any other active run without a local process
    //    is an orphan (it cannot be ours); any local process whose run is no longer active is
    //    killed so it can never report into state again.
    const { state } = this.store.read();
    const active = new Map(M.activeAttempts(state).map((a) => [a.id, a]));
    for (const id of this.runtime.ids()) if (!active.has(id)) this.runtime.kill(id);
    const timeouts: string[] = [];
    const orphans: string[] = [];
    for (const a of active.values()) {
      if (!this.runtime.has(a.id)) {
        if (a.outcome === "running" && dispatched.has(a.id)) this.runtime.start(a.id, a.progress);
        else orphans.push(a.id);
      } else if (a.outcome === "stopping") {
        this.runtime.requestInterrupt(a.id, nowMs);
        if (a.stopRequestedAt && nowMs - Date.parse(a.stopRequestedAt) >= this.ackTimeoutMs) timeouts.push(a.id);
      }
    }

    // 3. Advance the runtime and apply everything it reported in one lease-checked transaction.
    const events = this.runtime.tick(nowMs);
    this.store.update(
      (s: State) => {
        let next = s;
        for (const id of orphans) next = M.reportRunLost(next, id, "No runtime process exists for this run", now);
        for (const e of events) {
          if (e.type === "progress") next = M.reportProgress(next, e.attemptId, e.progress);
          else if (e.type === "stopped") next = M.acknowledgeStop(next, e.attemptId, now);
          else if (e.type === "completed") {
            const a = next.attempts.find((x) => x.id === e.attemptId);
            if (a) next = M.reportCompletion(next, a.id, [], now, simulatedOutputs(next, a.taskId, a.stepId, a.id));
          }
        }
        for (const id of timeouts) next = M.reportStopTimeout(next, id, now);
        return next;
      },
      now,
      lease,
    );
  }

  /** Timer tick: always renew the lease; advance only while the simulation clock runs. */
  tick(nowMs: number) {
    if (this.heartbeat(nowMs) && this.auto) this.cycle(nowMs);
  }

  /** Manual single step (simulation clock paused). Renews the lease first. */
  step(nowMs: number): boolean {
    if (!this.heartbeat(nowMs)) return false;
    this.cycle(nowMs);
    return true;
  }

  start(intervalMs = 1000) {
    const safeTick = () => {
      try {
        this.tick(Date.now());
      } catch (e) {
        this.log(`Scheduler tick failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    safeTick();
    this.timer = setInterval(safeTick, intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.isActive) this.store.releaseLease(SCHEDULER_LEASE, this.holder);
    this.isActive = false;
    this.runtime.clear();
  }

  /** Forget runtime processes after the project state was replaced (sample reset). */
  resetRuntime() {
    this.runtime.clear();
  }
}
