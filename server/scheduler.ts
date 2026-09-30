// The single project scheduler. It holds a renewable lease in the store; only the holder dispatches
// work, drives the runtime adapters, and applies their reports. Gaining the lease (at startup or after
// another holder's lease expired) triggers reconciliation before any dispatch: runs with no live
// process are marked lost or stopped, never completed and never duplicated.
//
// Adapters run asynchronously and emit events into a queue; each cycle drains the queue and applies
// everything in one lease-checked transaction, so state changes stay serialized.

import { randomUUID } from "node:crypto";
import * as M from "../src/domain/model";
import type { ProviderId, State, Step, Task } from "../src/domain/types";
import { buildEnvelope, parseOutputs } from "./envelope";
import { FakeAdapter } from "./runtimes/fake";
import type { AdapterEvent, Connection, ProviderHealth, RuntimeAdapter } from "./runtimes/types";
import { LeaseLostError, type Store } from "./store";
import type { PreparedWorkspace, WorkspaceManager } from "./workspaces";

export const SCHEDULER_LEASE = "scheduler";

export interface SchedulerOptions {
  /** Required for real runtimes: creates isolated worktrees and commits writer changes. */
  workspaces?: WorkspaceManager;
  leaseMs?: number;
  /** How long a stop may stay unacknowledged before a visible control failure. */
  ackTimeoutMs?: number;
  log?: (msg: string) => void;
}

/** Roles whose work is a code change in the workspace. Everyone else runs read-only. */
const WRITER_ROLES = new Set(["coder"]);

interface Launched {
  /** When the adapter was first seen without a live process for this run (no terminal event yet). */
  goneSince?: number;
  provider: ProviderId;
  access: "write" | "read";
  workspace?: PreparedWorkspace;
  stepId: string;
  taskId: string;
}

export class Scheduler {
  readonly holder = randomUUID();
  /** Fake runtime only: whether the simulation clock advances on each timer tick. */
  auto = true;
  private isActive = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private healthTimer: ReturnType<typeof setInterval> | undefined;
  private readonly leaseMs: number;
  private readonly ackTimeoutMs: number;
  private readonly log: (msg: string) => void;
  private readonly store: Store;
  readonly adapters: Record<ProviderId, RuntimeAdapter>;
  private readonly workspaces?: WorkspaceManager;
  private queue: AdapterEvent[] = [];
  private launched = new Map<string, Launched>();
  private healthState: Partial<Record<ProviderId, ProviderHealth>> = {};
  private connectionsState: Partial<Record<ProviderId, Connection[] | null>> = {};
  private repoCheck: { path: string; ok: boolean; at: number } | undefined;

  constructor(store: Store, adapters: Record<ProviderId, RuntimeAdapter>, opts: SchedulerOptions = {}) {
    this.store = store;
    this.adapters = adapters;
    this.workspaces = opts.workspaces;
    this.leaseMs = opts.leaseMs ?? 15000;
    this.ackTimeoutMs = opts.ackTimeoutMs ?? (this.isFake ? 8000 : 45000);
    this.log = opts.log ?? (() => {});
    for (const [p, a] of Object.entries(adapters) as [ProviderId, RuntimeAdapter][]) {
      a.onEvent((e) => this.queue.push(e));
      // The fake runtime is always available; real providers are checked asynchronously.
      if (a instanceof FakeAdapter) this.healthState[p] = { status: "ready", detail: "Fake runtime (simulated).", checkedAt: new Date().toISOString() };
    }
  }

  get active() {
    return this.isActive;
  }

  get isFake() {
    return Object.values(this.adapters).every((a) => a instanceof FakeAdapter);
  }

  get health(): Partial<Record<ProviderId, ProviderHealth>> {
    return this.healthState;
  }

  /** MCP servers found in each provider's own configuration (null: could not be listed). */
  get connections(): Partial<Record<ProviderId, Connection[] | null>> {
    return this.connectionsState;
  }

  private lease(nowMs: number) {
    return { name: SCHEDULER_LEASE, holder: this.holder, nowMs };
  }

  private killAll() {
    for (const a of Object.values(this.adapters)) for (const id of a.ids()) a.kill(id);
    this.queue = [];
    this.launched.clear();
  }

  /** Stop acting as scheduler: local processes can no longer be trusted or reported. */
  private deactivate(reason: string) {
    if (this.isActive) this.log(`${reason}; stopping local runs`);
    this.isActive = false;
    this.killAll();
    this.store.emit();
  }

  /** Check every provider's credentials/binary. Never starts a model run. */
  async refreshHealth() {
    for (const [p, a] of Object.entries(this.adapters) as [ProviderId, RuntimeAdapter][]) {
      try {
        this.healthState[p] = await a.health();
        if (a.listConnections) this.connectionsState[p] = await a.listConnections().catch(() => null);
        // Keep the model catalog current with what the connected runtime reports.
        if (!(a instanceof FakeAdapter) && this.healthState[p]?.status === "ready") {
          const models = await a.listModels().catch(() => null);
          if (models?.length) this.store.update((s) => M.setCatalog(s, p, models, new Date().toISOString()), new Date().toISOString());
        }
      } catch (e) {
        this.healthState[p] = { status: "unavailable", detail: e instanceof Error ? e.message : String(e), checkedAt: new Date().toISOString() };
      }
    }
    this.store.emit();
  }

  private availability(): { unavailable: Partial<Record<ProviderId, string>>; deferred: ProviderId[] } {
    const unavailable: Partial<Record<ProviderId, string>> = {};
    const deferred: ProviderId[] = [];
    for (const p of Object.keys(this.adapters) as ProviderId[]) {
      const h = this.healthState[p];
      if (!h) deferred.push(p);
      else if (h.status !== "ready") unavailable[p] = h.detail;
    }
    return { unavailable, deferred };
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
      this.killAll();
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

  /** Mark every active run without a live process as lost (or stopped, if it was stopping). */
  reconcile(nowMs: number) {
    const now = new Date(nowMs).toISOString();
    this.store.update(
      (s) => {
        let next = s;
        for (const a of M.activeAttempts(s)) {
          if (!this.adapterFor(a.snapshot.provider).has(a.id)) {
            next = M.reportRunLost(next, a.id, "No runtime process found after the service restarted or the scheduler changed", now);
          }
        }
        return next;
      },
      now,
      this.lease(nowMs),
    );
  }

  private adapterFor(p: ProviderId): RuntimeAdapter {
    return this.adapters[p];
  }

  /** One scheduling cycle. */
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
    const { unavailable, deferred } = this.availability();
    const project = this.store.read().state.project;
    const repoPath = project.repoPath;
    // Real runs need a usable repository; until one is configured nothing is dispatched (a sample or
    // unconfigured project must never reach a real agent). Checked at most every 10 s.
    const canDispatch = !this.workspaces || (!project.sample && this.repoUsable(repoPath, nowMs));
    const workspaceFor = this.workspaces ? (_t: string, _s: string, attemptId: string) => this.workspaces!.pathFor(repoPath, attemptId, project.id) : undefined;

    // 1. Lead promotion and dispatch, committed before any process starts. If the service dies
    //    between the commit and the start, reconciliation marks the run lost.
    const dispatched = new Set<string>();
    this.store.update(
      (s) => {
        dispatched.clear();
        const before = new Set(M.activeAttempts(s).map((a) => a.id));
        if (!canDispatch) return s;
        const next = M.dispatchEligible(M.leadPromoteProposals(s, now), now, { unavailable, deferred, workspaceFor });
        for (const a of M.activeAttempts(next)) if (!before.has(a.id)) dispatched.add(a.id);
        return next;
      },
      now,
      lease,
    );

    // 2. Start the runs dispatched in step 1; stop orphans; forward stop requests.
    const { state } = this.store.read();
    const active = new Map(M.activeAttempts(state).map((a) => [a.id, a]));
    for (const adapter of Object.values(this.adapters)) {
      for (const id of adapter.ids()) {
        if (!active.has(id)) {
          adapter.kill(id); // its run is no longer active: it must never report into state again
          this.launched.delete(id);
        }
      }
    }
    const lost: { id: string; reason: string }[] = [];
    const failedToStart: { id: string; reason: string }[] = [];
    const timeouts: string[] = [];
    for (const a of active.values()) {
      const adapter = this.adapterFor(a.snapshot.provider);
      const launched = this.launched.get(a.id);
      if (launched && !adapter.has(a.id) && !this.queue.some((e) => e.attemptId === a.id)) {
        // The process is gone but no terminal event was applied: never leave it "running" forever.
        launched.goneSince ??= nowMs;
        if (nowMs - launched.goneSince > 10_000) {
          this.launched.delete(a.id);
          lost.push({ id: a.id, reason: "The runtime process ended without reporting a result" });
        }
        continue;
      }
      if (!adapter.has(a.id) && !launched) {
        if (a.outcome === "running" && dispatched.has(a.id)) {
          const err = this.launch(state, a.id);
          if (err) failedToStart.push({ id: a.id, reason: err });
        } else lost.push({ id: a.id, reason: "No runtime process exists for this run" });
      } else if (a.outcome === "stopping") {
        if (adapter instanceof FakeAdapter) adapter.interruptAt(a.id, nowMs);
        else adapter.interrupt(a.id);
        if (a.stopRequestedAt && nowMs - Date.parse(a.stopRequestedAt) >= this.ackTimeoutMs) timeouts.push(a.id);
      }
    }

    // 3. The fake runtime advances on the scheduler's clock; real adapters report on their own.
    for (const adapter of Object.values(this.adapters)) if (adapter instanceof FakeAdapter && this.auto) adapter.tick(nowMs);

    // 4. Drain adapter events. Work that touches git happens here, outside the transaction.
    const events = this.queue.splice(0);
    const completions = new Map<string, { outputs: M.OutputReport[]; problems: string[] }>();
    for (const e of events) {
      if (e.type !== "completed") continue;
      try {
        completions.set(e.attemptId, this.collectOutputs(state, e));
      } catch (err) {
        completions.set(e.attemptId, { outputs: [], problems: [`Recording the result failed: ${err instanceof Error ? err.message : String(err)}`] });
      }
    }

    try {
      this.store.update(
        (s: State) => {
          let next = s;
          for (const f of failedToStart) next = M.reportRunFailed(next, f.id, f.reason, now);
          for (const l of lost) next = M.reportRunLost(next, l.id, l.reason, now);
          for (const e of events) {
            try {
              next = this.applyEvent(next, e, completions, now);
            } catch (err) {
              // One bad event must not discard the batch (and with it other runs' terminal events).
              this.log(`Could not apply ${e.type} for ${e.attemptId}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          for (const id of timeouts) next = M.reportStopTimeout(next, id, now);
          return next;
        },
        now,
        lease,
      );
    } catch (err) {
      // Nothing was written: put the events back so the next cycle applies them.
      if (!(err instanceof LeaseLostError)) this.queue.unshift(...events);
      throw err;
    }
    for (const e of events) if (e.type === "completed" || e.type === "failed" || e.type === "stopped") this.launched.delete(e.attemptId);
  }

  private repoUsable(repoPath: string, nowMs: number): boolean {
    if (!repoPath) return false;
    if (this.repoCheck && this.repoCheck.path === repoPath && nowMs - this.repoCheck.at < 10_000) return this.repoCheck.ok;
    const ok = this.workspaces!.check(repoPath).ok;
    this.repoCheck = { path: repoPath, ok, at: nowMs };
    return ok;
  }

  /** Prepare the workspace and assignment, then start the run. Returns an error message on failure. */
  private launch(state: State, attemptId: string): string | undefined {
    const a = state.attempts.find((x) => x.id === attemptId)!;
    const task = state.tasks.find((t) => t.id === a.taskId)!;
    const step = task.steps.find((x) => x.id === a.stepId)!;
    const adapter = this.adapterFor(a.snapshot.provider);
    const access: "write" | "read" = WRITER_ROLES.has(step.role) ? "write" : "read";
    const limits = state.project.runLimits;
    try {
      let workspace: PreparedWorkspace | undefined;
      if (this.workspaces) {
        workspace = this.workspaces.prepare({ repoPath: state.project.repoPath, projectId: state.project.id, attemptId, taskId: task.id, stepId: step.id, access, baseRef: baseRefFor(state, task, step) });
      }
      this.launched.set(attemptId, { provider: a.snapshot.provider, access, workspace, stepId: step.id, taskId: task.id });
      adapter.start({
        attemptId,
        taskId: task.id,
        stepId: step.id,
        role: step.role,
        provider: a.snapshot.provider,
        model: a.snapshot.model,
        workspace: { path: workspace?.path ?? a.snapshot.workspace, access },
        environment: a.snapshot.environment ?? "isolated",
        connections: a.snapshot.connections ?? [],
        prompt: buildEnvelope({ state, task, step, attemptId, access }),
        outputs: step.outputs,
        limits: { maxTurns: limits.maxTurns, timeoutMs: limits.timeoutMinutes * 60_000, maxBudgetUsd: limits.maxBudgetUsd },
      });
      return undefined;
    } catch (e) {
      this.launched.delete(attemptId);
      return `Could not start the run: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  /** Turn a completion into output reports: parse the output block; commit a writer's changes. */
  private collectOutputs(state: State, e: Extract<AdapterEvent, { type: "completed" }>) {
    const a = state.attempts.find((x) => x.id === e.attemptId);
    const task = a && state.tasks.find((t) => t.id === a.taskId);
    const step = task?.steps.find((x) => x.id === a!.stepId);
    if (!a || !step) return { outputs: [], problems: [] };
    const parsed = parseOutputs(e.finalText, step.outputs);
    const info = this.launched.get(e.attemptId);
    const outputs: M.OutputReport[] = parsed.outputs.map((o) => ({ ...o }));
    if (this.workspaces && info?.workspace) {
      try {
        if (info.access === "write") {
          const c = this.workspaces.commit({ ...info.workspace, message: `${task!.id} ${step.id}: ${step.purpose} (${a.id})` });
          for (const o of outputs) {
            const def = step.outputs.find((d) => d.name === o.name);
            if (def?.kind === "code-change") {
              o.ref = `${c.sha.slice(0, 12)}${c.branch ? ` on ${c.branch}` : ""}`;
              o.summary = `${o.summary}\n\n${c.diffstat}${c.files.length ? `: ${c.files.join(", ")}` : ""}`;
            }
          }
        } else {
          const dirty = this.workspaces.dirtyFiles(info.workspace);
          if (dirty.length) parsed.problems.push(`A read-only run modified files (${dirty.join(", ")}); they were not recorded.`);
        }
      } catch (err) {
        parsed.problems.push(`Recording the workspace failed: ${err instanceof Error ? err.message : String(err)}`);
        // Without a recorded commit there is no code change: drop it so the run is not accepted.
        const codeOutputs = new Set(step.outputs.filter((d) => d.kind === "code-change").map((d) => d.name));
        return { outputs: outputs.filter((o) => !codeOutputs.has(o.name)), problems: parsed.problems };
      }
    }
    return { outputs, problems: parsed.problems };
  }

  private applyEvent(s: State, e: AdapterEvent, completions: Map<string, { outputs: M.OutputReport[]; problems: string[] }>, now: string): State {
    switch (e.type) {
      case "started":
        return M.reportRunStarted(s, e.attemptId, { sessionId: e.sessionId, actualModel: e.model });
      case "progress":
        return M.reportProgress(s, e.attemptId, e.percent);
      case "activity":
        return M.reportActivity(s, e.attemptId, e.note);
      case "stopped": {
        // A stop nobody requested (the run hit its time limit, or the runtime ended it) is a failure,
        // not a pause: acknowledging it would requeue the step and repeat the same limit forever.
        const a = s.attempts.find((x) => x.id === e.attemptId);
        if (a?.outcome === "running") {
          const reason = a.activity === "Time limit reached" ? `It reached the ${s.project.runLimits.timeoutMinutes}-minute time limit` : "The runtime stopped it without a stop request";
          return M.reportRunFailed(s, e.attemptId, `${reason}; partial work was left in its workspace.`, now, { usage: e.usage });
        }
        return M.acknowledgeStop(s, e.attemptId, now);
      }
      case "failed":
        return M.reportRunFailed(s, e.attemptId, e.message, now, { usage: e.usage });
      case "completed": {
        const c = completions.get(e.attemptId) ?? { outputs: [], problems: [] };
        let next = M.reportCompletion(s, e.attemptId, [], now, c.outputs, { usage: e.usage, actualModel: e.model });
        if (c.problems.length) next = noteProblems(next, e.attemptId, c.problems);
        return next;
      }
    }
  }

  /** Timer tick: renew the lease; run a cycle (the fake clock can be paused). */
  tick(nowMs: number) {
    if (this.heartbeat(nowMs) && (this.auto || !this.isFake)) this.cycle(nowMs);
  }

  /** Manual single step (simulation clock paused). Renews the lease first. */
  step(nowMs: number): boolean {
    if (!this.heartbeat(nowMs)) return false;
    const auto = this.auto;
    this.auto = true;
    try {
      this.cycle(nowMs);
    } finally {
      this.auto = auto;
    }
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
    void this.refreshHealth().then(safeTick);
    this.timer = setInterval(safeTick, intervalMs);
    this.healthTimer = setInterval(() => void this.refreshHealth(), 60_000);
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.timer = undefined;
    this.healthTimer = undefined;
    if (this.isActive) this.store.releaseLease(SCHEDULER_LEASE, this.holder);
    this.isActive = false;
    this.killAll();
    await Promise.all(Object.values(this.adapters).map((a) => a.shutdown().catch(() => undefined)));
  }

  /** Forget runtime processes after the project state was replaced. */
  resetRuntime() {
    this.killAll();
  }
}

/** A writer continues from the latest accepted code change among its inputs, else from HEAD. */
function baseRefFor(state: State, task: Task, step: Step): string | undefined {
  let best: { version: number; ref: string; at: string } | undefined;
  for (const i of M.consumedInputs(state, task, step)) {
    const art = state.artifacts.find((x) => x.id === i.artifactId);
    if (art?.kind === "code-change" && art.ref) {
      const sha = art.ref.split(" ")[0];
      if (!best || art.createdAt > best.at) best = { version: art.version, ref: sha, at: art.createdAt };
    }
  }
  return best?.ref;
}

/** Attach output problems to the attempt's note so the reason is visible where the step is blocked. */
function noteProblems(s: State, attemptId: string, problems: string[]): State {
  const next = structuredClone(s);
  const a = next.attempts.find((x) => x.id === attemptId);
  if (a) a.note = [a.note, ...problems].filter(Boolean).join(" ");
  const t = a && next.tasks.find((x) => x.id === a.taskId);
  const st = t?.steps.find((x) => x.id === a!.stepId);
  if (st?.state === "blocked" && st.blockedReason) st.blockedReason = `${st.blockedReason} ${problems.join(" ")}`;
  return next;
}
