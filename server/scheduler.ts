// The single project scheduler. It holds a renewable lease in the store; only the holder dispatches
// work, drives the runtime adapters, and applies their reports. Gaining the lease (at startup or after
// another holder's lease expired) triggers reconciliation before any dispatch: runs with no live
// process are marked lost or stopped, never completed and never duplicated.
//
// Adapters run asynchronously and emit events into a queue; each cycle drains the queue and applies
// everything in one lease-checked transaction, so state changes stay serialized.

import { randomUUID } from "node:crypto";
import * as D from "../src/domain/delivery";
import * as M from "../src/domain/model";
import type { Integration, ProviderId, State, Step, Task } from "../src/domain/types";
import { buildEnvelope, buildLeadEnvelope, parseLeadOutput, parseOutputs } from "./envelope";
import { SimulatedGitHub, type GitHubHost } from "./github";
import { PrDriver } from "./prdelivery";
import { FakeAdapter } from "./runtimes/fake";
import type { AdapterEvent, Connection, ProviderHealth, RuntimeAdapter } from "./runtimes/types";
import { LeaseLostError, type Store } from "./store";
import type { PreparedWorkspace, WorkspaceManager, WorkspaceSeed } from "./workspaces";

export const SCHEDULER_LEASE = "scheduler";

export interface SchedulerOptions {
  /** Required for real runtimes: creates isolated worktrees and commits writer changes. */
  workspaces?: WorkspaceManager;
  leaseMs?: number;
  /** How long a stop may stay unacknowledged before a visible control failure. */
  ackTimeoutMs?: number;
  log?: (msg: string) => void;
  /**
   * The GitHub side of pull-request delivery. With the fake runtime (no workspaces) a simulated host is
   * used and nothing is contacted. A real service without one reports that pull requests cannot be opened.
   */
  github?: GitHubHost;
  /** True when Claude workers run with shell access; shown as a GitHub posture warning. */
  workerShell?: boolean;
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
  /** Pull-request delivery: the only code that talks to GitHub or pushes. */
  private readonly pr: PrDriver;
  /** Why the lead cannot run right now (shown in the conversation), if anything. */
  leadBlocked: string | undefined;

  constructor(store: Store, adapters: Record<ProviderId, RuntimeAdapter>, opts: SchedulerOptions = {}) {
    this.store = store;
    this.adapters = adapters;
    this.workspaces = opts.workspaces;
    this.leaseMs = opts.leaseMs ?? 15000;
    this.ackTimeoutMs = opts.ackTimeoutMs ?? (this.isFake ? 8000 : 45000);
    this.log = opts.log ?? (() => {});
    this.pr = new PrDriver(store, opts.github ?? (this.workspaces ? undefined : new SimulatedGitHub()), this.workspaces, { log: this.log, workerShell: opts.workerShell });
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
    // A GitHub operation in flight is stopped and its result dropped: its intent stays recorded and is
    // reconciled with GitHub by whoever holds the lease next.
    this.pr.abortAll();
  }

  /** Resolves when the GitHub operation in flight (if any) has settled. */
  prIdle(): Promise<void> {
    return this.pr.idle();
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
        const lead = M.activeLeadRun(next);
        if (lead && !this.adapterFor(lead.provider).has(lead.id)) next = M.reportLeadStopped(next, lead.id, now, true);
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
        // With pull-request delivery, writers wait for the first fetch of the base they start from.
        const next = M.dispatchEligible(M.leadPromoteProposals(s, now), now, { unavailable, deferred, workspaceFor, holdWriters: D.writersHeld(s) });
        for (const a of M.activeAttempts(next)) if (!before.has(a.id)) dispatched.add(a.id);
        return next;
      },
      now,
      lease,
    );

    // 2. Start the runs dispatched in step 1; stop orphans; forward stop requests.
    const { state } = this.store.read();
    const active = new Map(M.activeAttempts(state).map((a) => [a.id, a]));
    const leadRun = M.activeLeadRun(state);
    for (const adapter of Object.values(this.adapters)) {
      for (const id of adapter.ids()) {
        if (!active.has(id) && id !== leadRun?.id) {
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

    // 2b. The lead: supervise the active lead run, or start one when a message or planning is due.
    const leadIssues: { id: string; kind: "lost" | "timeout" | "failed"; reason?: string }[] = [];
    if (leadRun) {
      const adapter = this.adapterFor(leadRun.provider);
      const launchedL = this.launched.get(leadRun.id);
      if (!adapter.has(leadRun.id) && !this.queue.some((e) => e.attemptId === leadRun.id)) {
        if (!launchedL) leadIssues.push({ id: leadRun.id, kind: "lost" });
        else {
          launchedL.goneSince ??= nowMs;
          if (nowMs - launchedL.goneSince > 10_000) {
            this.launched.delete(leadRun.id);
            leadIssues.push({ id: leadRun.id, kind: "lost" });
          }
        }
      } else if (leadRun.outcome === "stopping") {
        if (adapter instanceof FakeAdapter) adapter.interruptAt(leadRun.id, nowMs);
        else adapter.interrupt(leadRun.id);
        if (leadRun.stopRequestedAt && nowMs - Date.parse(leadRun.stopRequestedAt) >= this.ackTimeoutMs) leadIssues.push({ id: leadRun.id, kind: "timeout" });
      }
    } else if (!canDispatch) {
      this.leadBlocked = M.pendingMessages(state).length
        ? state.project.sample
          ? "This is the sample project; start a new project in Settings for a live lead."
          : "No usable repository is configured (Settings → Project)."
        : undefined;
    } else {
      const local = new Date(nowMs);
      const trigger = M.leadDue(state, nowMs, local.getHours() * 60 + local.getMinutes());
      const lead = trigger ? this.resolveLead(state) : undefined;
      this.leadBlocked = !trigger
        ? undefined
        : !lead
          ? `The lead (${M.providerLabel(state.project.leadSelection.provider)} · ${state.project.leadSelection.model}) is not enabled or not in the model catalog. Choose another lead in Settings.`
          : unavailable[lead.provider]
            ? `${M.providerLabel(lead.provider)} is not available: ${unavailable[lead.provider]}`
            : deferred.includes(lead.provider)
              ? "Checking the lead's provider…"
              : undefined;
      if (trigger && lead && !unavailable[lead.provider] && !deferred.includes(lead.provider)) {
        let runId = "";
        this.store.update(
          (s) => {
            const r = M.startLeadRun(s, { provider: lead.provider, model: lead.model, trigger }, now);
            runId = r.runId;
            return r.state;
          },
          now,
          lease,
        );
        const err = this.launchLead(this.store.read().state, runId);
        if (err) leadIssues.push({ id: runId, kind: "failed", reason: err });
      }
    }

    // 3. The fake runtime advances on the scheduler's clock; real adapters report on their own.
    for (const adapter of Object.values(this.adapters)) if (adapter instanceof FakeAdapter && this.auto) adapter.tick(nowMs);

    // 4. Drain adapter events. Work that touches git happens here, outside the transaction.
    const events = this.queue.splice(0);
    const completions = new Map<string, { outputs: M.OutputReport[]; problems: string[]; chosen?: string }>();
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
          for (const l of leadIssues) {
            if (l.kind === "lost") next = M.reportLeadStopped(next, l.id, now, true);
            else if (l.kind === "timeout") next = M.reportLeadStopTimeout(next, l.id, now);
            else next = M.reportLeadFailed(next, l.id, l.reason ?? "could not start", now);
          }
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
    for (const e of events) {
      if (e.type !== "completed" && e.type !== "failed" && e.type !== "stopped") continue;
      const info = this.launched.get(e.attemptId);
      // Lead checkouts are only for reading the repository during the run: remove them afterwards.
      if (info?.taskId === "LEAD" && info.workspace && this.workspaces) this.workspaces.remove(state.project.repoPath, info.workspace.path);
      this.launched.delete(e.attemptId);
    }

    // 5. Integration: one finished task per cycle, frozen while the project is paused; then delivery.
    this.integrateNext(nowMs, lease);
    this.deliverIfDue(nowMs, lease);
    this.pr.tick(nowMs, lease);

    // 6. Automatic retries of failed steps (opt-in, bounded per step, never for credential/config failures).
    const retries = M.autoRetryCandidates(this.store.read().state, nowMs);
    if (retries.length) this.store.update((s) => retries.reduce((acc, r) => M.autoRetryStep(acc, r.taskId, r.stepId, now), s), now, lease);
  }

  /** Merge the oldest done task's final change into the integration branch (serial, one per cycle). */
  private integrateNext(nowMs: number, lease: { name: string; holder: string; nowMs: number }) {
    const now = new Date(nowMs).toISOString();
    const { state } = this.store.read();
    if (state.project.hold) return;
    const t = M.nextIntegration(state, nowMs);
    if (!t) return;
    // Fake runs produce code-change artifacts without commits; simulate their integration.
    const change = this.workspaces ? M.finalChange(state, t) : state.artifacts.filter((x) => x.taskId === t.id && x.kind === "code-change").pop();
    const pr = state.project.prDelivery;
    let result: Integration;
    if (!change) result = { status: "not-needed" };
    else if (pr.enabled) {
      // Pull-request mode: the task's final commit becomes a pull-request head. Nothing is merged
      // locally and nothing is pushed here; the driver publishes it.
      const n = (t.integration?.pr?.n ?? 0) + 1;
      if (!this.workspaces) {
        this.store.update((s) => D.reportPrHead(s, t.id, { n, sha: `sim-${t.id}-${n}`, baseSha: "sim-base", simulated: true, changed: { files: 0, additions: 0, deletions: 0, paths: [], protectedHits: [], workflowHits: [] } }, now), now, lease);
        return;
      }
      if (state.project.sample || !this.repoUsable(state.project.repoPath, nowMs)) return;
      if (!state.project.github?.base) {
        this.store.update((s) => M.reportIntegrationError(s, t.id, `waiting for the first fetch of ${pr.remote}/${pr.base}`, now), now, lease);
        return;
      }
      try {
        const head = this.workspaces.preparePrHead({
          repoPath: state.project.repoPath,
          projectId: state.project.id,
          taskId: t.id,
          n,
          baseRef: this.workspaces.baseRef(state.project.id),
          sha: change.ref!.split(" ")[0],
          protectedPaths: pr.protectedPaths,
        });
        if (head.status === "ready") {
          this.store.update((s) => D.reportPrHead(s, t.id, { n, sha: head.sha, baseSha: head.baseSha, changed: head.changed }, now), now, lease);
          return;
        }
        result = { status: "conflict", message: head.message };
      } catch (err) {
        const msg = (err instanceof Error ? err.message : String(err)).split("\n")[0].slice(0, 200);
        this.store.update((s) => M.reportIntegrationError(s, t.id, msg, now), now, lease);
        return;
      }
    } else if (!this.workspaces) result = { status: "integrated", ref: "simulated integration (no commit)" };
    else if (state.project.sample || !this.repoUsable(state.project.repoPath, nowMs)) return;
    else {
      try {
        const sha = change.ref!.split(" ")[0];
        const d = state.project.autonomy.autoDeliver;
        // A change a person supplied by editing the artifact is theirs to integrate; anything else must
        // contain a commit of the task's own.
        result = this.workspaces.integrate({
          repoPath: state.project.repoPath,
          projectId: state.project.id,
          sha,
          message: `Integrate ${t.id}: ${M.currentSpec(t).content.title}`,
          baseBranch: d.enabled ? d.branch : undefined,
          requireOwn: change.author !== "user",
        });
      } catch (err) {
        // Environmental (not a merge conflict): keep it pending and retry later with a short reason.
        const msg = (err instanceof Error ? err.message : String(err)).split("\n")[0].slice(0, 200);
        this.store.update((s) => M.reportIntegrationError(s, t.id, msg, now), now, lease);
        return;
      }
    }
    this.store.update((s) => M.reportIntegration(s, t.id, result, now), now, lease);
  }

  /** Automatic delivery (opt-in): retried until the branch contains all integrated work. */
  private deliverIfDue(nowMs: number, lease: { name: string; holder: string; nowMs: number }) {
    const { state } = this.store.read();
    if (!this.workspaces || state.project.sample || !M.deliveryDue(state, nowMs)) return;
    const now = new Date(nowMs).toISOString();
    let result: { status: "delivered" | "skipped" | "conflict" | "blocked"; message: string; sha?: string };
    try {
      result = this.workspaces.deliver({ repoPath: state.project.repoPath, projectId: state.project.id, branch: state.project.autonomy.autoDeliver.branch, lastDelivered: state.project.delivery?.lastSha });
    } catch (err) {
      result = { status: "skipped", message: `Delivery failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    this.store.update((s) => M.reportDeliveryResult(s, result, now), now, lease);
  }

  /** Remove workspaces of runs that are no longer active (real mode). */
  prune(): number {
    if (!this.workspaces) return 0;
    const { state } = this.store.read();
    const keep = new Set([...M.activeAttempts(state).map((a) => a.id), ...(M.activeLeadRun(state) ? [M.activeLeadRun(state)!.id] : [])]);
    return this.workspaces.prune({ repoPath: state.project.repoPath, projectId: state.project.id, keep });
  }

  /** The lead's concrete provider/model ("auto" resolves to the first catalog model). */
  private resolveLead(state: State): { provider: ProviderId; model: string } | undefined {
    const sel = state.project.leadSelection;
    const catalog = state.project.catalog[sel.provider];
    if (!state.project.enabledProviders.includes(sel.provider)) return undefined;
    if (sel.model === "auto") return catalog[0] ? { provider: sel.provider, model: catalog[0].id } : undefined;
    return catalog.some((m) => m.id === sel.model) ? { provider: sel.provider, model: sel.model } : undefined;
  }

  /** Start a lead run: a read-only checkout (real mode) and the lead envelope. */
  private launchLead(state: State, runId: string): string | undefined {
    const run = state.leadRuns.find((r) => r.id === runId)!;
    const adapter = this.adapterFor(run.provider);
    const limits = state.project.runLimits;
    try {
      let workspace: PreparedWorkspace | undefined;
      if (this.workspaces) {
        workspace = this.workspaces.prepare({ repoPath: state.project.repoPath, projectId: state.project.id, attemptId: runId, taskId: "LEAD", stepId: "plan", access: "read" });
      }
      this.launched.set(runId, { provider: run.provider, access: "read", workspace, stepId: "LEAD", taskId: "LEAD" });
      adapter.start({
        attemptId: runId,
        taskId: "LEAD",
        stepId: "LEAD",
        role: "lead",
        provider: run.provider,
        model: run.model,
        workspace: { path: workspace?.path ?? "", access: "read" },
        environment: state.project.workerEnvironment[run.provider],
        connections: state.project.workerConnections[run.provider],
        prompt: buildLeadEnvelope(state, run, "read"),
        outputs: [],
        limits: { maxTurns: limits.maxTurns, timeoutMs: limits.timeoutMinutes * 60_000, maxBudgetUsd: limits.maxBudgetUsd },
      });
      return undefined;
    } catch (e) {
      this.launched.delete(runId);
      return `Could not start the lead: ${e instanceof Error ? e.message : String(e)}`;
    }
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
        const d = state.project.autonomy.autoDeliver;
        // With delivery on, new work starts from the delivery base, not from whatever is checked out:
        // the delivery branch (local mode), or the fetched tip of the remote base (pull requests). In
        // pull-request mode a writer never falls back to a local branch or HEAD.
        const input = baseRefFor(state, task, step);
        const prBase = state.project.prDelivery.enabled && (access === "write" || state.project.github?.base) ? this.workspaces.baseRef(state.project.id) : undefined;
        // A revert starts from where the work it undoes landed, whatever the delivery mode is now.
        const origin = task.revertOf ? state.tasks.find((x) => x.id === task.revertOf!.taskId)?.integration?.landed : undefined;
        const revertBase = origin?.via === "local" ? `refs/heads/${origin.target}` : origin?.via === "pr" && state.project.github?.base ? this.workspaces.baseRef(state.project.id) : undefined;
        const baseRef = input ?? revertBase ?? prBase ?? (d.enabled ? `refs/heads/${d.branch}` : undefined);
        // A revert task's first writer (the one that continues no earlier change) starts from the
        // delivery base with the revert of the landed commit already prepared in its worktree.
        const seed: WorkspaceSeed | undefined = task.revertOf && access === "write" && !input ? { kind: "revert", commit: task.revertOf.commit } : undefined;
        workspace = this.workspaces.prepare({ repoPath: state.project.repoPath, projectId: state.project.id, attemptId, taskId: task.id, stepId: step.id, access, baseRef, seed });
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
        prompt: buildEnvelope({ state, task, step, attemptId, access, seed: workspace?.seed }),
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
    return { outputs, problems: parsed.problems, chosen: parsed.chosen };
  }

  private applyEvent(s: State, e: AdapterEvent, completions: Map<string, { outputs: M.OutputReport[]; problems: string[]; chosen?: string }>, now: string): State {
    if (s.leadRuns.some((r) => r.id === e.attemptId)) return this.applyLeadEvent(s, e, now);
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
        let next = M.reportCompletion(s, e.attemptId, [], now, c.outputs, { usage: e.usage, actualModel: e.model, chosen: c.chosen });
        if (c.problems.length) next = noteProblems(next, e.attemptId, c.problems);
        return next;
      }
    }
  }

  private applyLeadEvent(s: State, e: AdapterEvent, now: string): State {
    switch (e.type) {
      case "started":
        return M.reportLeadStarted(s, e.attemptId, { sessionId: e.sessionId, actualModel: e.model });
      case "activity":
        return M.reportLeadActivity(s, e.attemptId, e.note);
      case "progress":
        return s;
      case "stopped":
        return M.reportLeadStopped(s, e.attemptId, now);
      case "failed":
        return M.reportLeadFailed(s, e.attemptId, e.message, now, e.usage);
      case "completed": {
        const out = parseLeadOutput(e.finalText);
        return M.completeLeadRun(s, e.attemptId, { reply: out.reply, proposals: out.proposals }, now, { usage: e.usage, actualModel: e.model });
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
