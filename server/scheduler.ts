// The single project scheduler. It holds a renewable lease in the store; only the holder dispatches
// work, drives the runtime adapters, and applies their reports. Gaining the lease (at startup or after
// another holder's lease expired) triggers reconciliation before any dispatch: runs with no live
// process are marked lost or stopped, never completed and never duplicated.
//
// Adapters run asynchronously and emit events into a queue; each cycle drains the queue and applies
// everything in one lease-checked transaction, so state changes stay serialized.

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as C from "../src/domain/checks";
import * as D from "../src/domain/delivery";
import * as F from "../src/domain/findings";
import * as M from "../src/domain/model";
import { LEAD_REPLY_SCHEMA } from "../src/domain/model/leadReplySchema";
import * as P from "../src/domain/peReview";
import * as R from "../src/domain/studio/runs";
import { evidenceSummary } from "../src/domain/studio/evidence";
import * as S from "../src/domain/studio/studio";
import { DESIGNER_KINDS } from "../src/domain/studio/types";
import { REVIEW_ROLES, isProvider, type Artifact, type ChecksHealth, type Integration, type ProseCheck, type ProviderId, type Runner, type State, type Step, type Task } from "../src/domain/types";
import { SimulatedChecks, checkEnv, type CheckAssignment, type CheckRunner } from "./checks";
import { buildEnvelope, buildLeadEnvelope, capConventions, parseLeadOutput, parseOutputs, type ConventionsFile } from "./envelope";
import { prototypeFolders, readsPrototypes } from "./factoryLink";
import { SimulatedGitHub, type GitHubHost } from "./github";
import { PrDriver } from "./prdelivery";
import { checkLeadText, withLeadProse } from "./prose/record";
import type { ProseChecker } from "./prose/vale";
import { projectValeConfig } from "./prose/words";
import { FakeAdapter } from "./runtimes/fake";
import type { AdapterEvent, Connection, ProviderHealth, RuntimeAdapter } from "./runtimes/types";
import { LeaseLostError, type Store } from "./store";
import { ManifestError, readStaged, studioRoot, versionDir } from "./studio/artifacts";
import { SimulatedEvidence, evidenceDir, evidenceInputLines, evidenceReadRoots, type EvidenceRunner } from "./studio/evidence";
import { makeDemo, makeShots, type StudioMedia } from "./studio/media";
import { PeAnswerError, checkPeAnswer, newWorkPeEnvelope, peEnvelope, readPeAnswer, recordNewWorkPeRun, recordPeRun } from "./studio/pe";
import { repoGlance } from "./studio/existing";
import { askForRevisions } from "./studio/revise";
import { checkHandedIn, designerEnvelope, handedIn, importDesignerRun, prepareStaging, type HandedIn } from "./studio/runs";
import { withStudioPrinciples, withStudioProse } from "./studio/writing";
import type { VisionDocStore } from "./visiondocs";
import type { PreparedWorkspace, WorkspaceManager, WorkspaceSeed } from "./workspaces";

const SCHEDULER_LEASE = "scheduler";

interface SchedulerOptions {
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
  /** Where the user's vision documents are kept; their text goes into the lead's and designers' envelopes. */
  visionDocs?: VisionDocStore;
  /**
   * The runner for the project's checks. Real mode passes the sandboxed runners; without one
   * and without workspaces (the fake runtime) a simulated runner is used, which spawns nothing.
   */
  checks?: CheckRunner;
  /**
   * The runner for the Capture evidence step (ORC-029 pass 5): the recorder's container in real mode. Without one and
   * without workspaces (the fake runtime) a simulated runner is used, which runs nothing.
   */
  evidence?: EvidenceRunner;
  /** The service's data directory (next to the database): check caches and logs live under it. */
  dataDir?: string;
  /**
   * What makes a studio version's screenshots and terminal recordings after import (server/studio/media.ts). Without
   * it none are made, and the versions record none.
   */
  studioMedia?: StudioMedia;
  /**
   * What checks the lead's replies and questions, the PE's verdicts and the designer's documents against the
   * controlled-English style (server/prose/): Vale in the service. Without it nothing is checked and the runs record nothing.
   */
  prose?: ProseChecker;
}

/** Roles whose work is a code change in the workspace. Everyone else runs read-only. */
const WRITER_ROLES = new Set(["coder"]);
/** The repository instruction files read from the trusted base as project conventions. */
const CONVENTION_FILES = ["AGENTS.md", "CLAUDE.md"];

interface Launched {
  /** When the adapter was first seen without a live process for this run (no terminal event yet). */
  goneSince?: number;
  provider: Runner;
  access: "write" | "read";
  workspace?: PreparedWorkspace;
  stepId: string;
  taskId: string;
  /** A check run: the protected inputs its change touched, computed at launch, recorded with the result. */
  touchedInputs?: string[];
  /** A studio run: its staging folder, removed once what it handed in was imported. */
  staging?: string;
  /** A read-only studio run (the PE): its temp folder, outside the version it reads, removed when the run ends. */
  tmp?: string;
}

/** What the scheduler saw of a studio run outside the store: a lost process, an unconfirmed stop, a launch that failed. */
type StudioIssue = { id: string; kind: "lost" } | { id: string; kind: "timeout" } | { id: string; kind: "failed"; reason: string };
/** A designer run's studio.json, read and checked before the transaction that imports it. */
type StudioOutput = HandedIn | { refused: string };

/**
 * What the service recorded about a run before it started (the changed-path set a reviewer was shown,
 * the conventions it was given, the decisions its envelope carried). Queued before the run starts, so
 * it is applied in the same drain as, or an earlier one than, any event from the run. A lost lease
 * drops it with the run.
 */
interface ContextEvent {
  type: "context";
  attemptId: string;
  scope?: NonNullable<M.RunContext["scope"]>;
  conventions?: NonNullable<M.RunContext["conventions"]>;
  decisions?: string[];
}
/** A sandbox probe's result, applied under the lease like every other observation. */
interface HealthEvent {
  type: "checks-health";
  attemptId: "";
  health: ChecksHealth;
  /** When the probe began (the scheduler's clock): a "Check again" asked for later is not cleared by this result. */
  startedAt: string;
}
/** A studio version's screenshots or recording, made after import; recorded under the lease, for the project it was made in. */
interface MediaEvent {
  type: "studio-media";
  attemptId: "";
  projectId: string;
  artifactId: string;
  version: number;
  result: S.MediaResult;
}
type QueueEvent = AdapterEvent | ContextEvent | HealthEvent | MediaEvent;

/** A simulated head commit: "sim" and 9 hex digits, short enough to show whole where commits are cut to 12 characters. */
export const simSha = (key: string) => `sim${createHash("sha256").update(key).digest("hex").slice(0, 9)}`;

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
  /** The check runner, if this service has one. */
  readonly checks?: CheckRunner;
  /** The capture runner, if this service has one. */
  readonly evidence?: EvidenceRunner;
  private readonly dataDir?: string;
  /** A sandbox probe in flight (at most one), and how many check runs in a row failed to start. */
  private probing = false;
  private failedStarts = 0;
  private readonly workspaces?: WorkspaceManager;
  private readonly visionDocs?: VisionDocStore;
  private readonly media?: StudioMedia;
  private readonly prose?: ProseChecker;
  /** The checks of lead replies drained this cycle, made before the transaction and recorded in it. */
  private leadProse = new Map<string, ProseCheck>();
  /** The same for studio runs: a PE's answer, a designer's documents. */
  private studioProse = new Map<string, ProseCheck>();
  /** Studio versions' screenshots and recordings, made one at a time, after the run that handed them in completed. */
  private mediaChain: Promise<void> = Promise.resolve();
  /** The pending ones this instance started (project, version and kind), so each is made once per process. */
  private mediaStarted = new Set<string>();
  private queue: QueueEvent[] = [];
  private launched = new Map<string, Launched>();
  /** Notes this instance handed to an adapter, so each is handed over once; cleared with the runs. */
  private notesSent = new Set<string>();
  /** Conventions read this cycle, by trusted ref, so the files are read once per cycle. */
  private conventionsCache: { ref: string; at: number; files: ConventionsFile[] } | undefined;
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
    this.visionDocs = opts.visionDocs;
    this.dataDir = opts.dataDir;
    this.media = opts.studioMedia;
    this.prose = opts.prose;
    this.checks = opts.checks ?? (this.workspaces ? undefined : new SimulatedChecks());
    this.checks?.onEvent((e) => this.queue.push(e));
    this.evidence = opts.evidence ?? (this.workspaces ? undefined : new SimulatedEvidence());
    this.evidence?.onEvent((e) => this.queue.push(e));
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

  /** Every runner: the provider adapters, the check runner and the capture runner. */
  private allRunners(): RuntimeAdapter[] {
    return [...Object.values(this.adapters), ...(this.checks ? [this.checks as unknown as RuntimeAdapter] : []), ...(this.evidence ? [this.evidence as unknown as RuntimeAdapter] : [])];
  }

  private killAll() {
    for (const a of this.allRunners()) for (const id of a.ids()) a.kill(id);
    this.queue = [];
    this.launched.clear();
    this.notesSent.clear();
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
        // A note handed over before the restart gets no answer now; it is never shown as delivered.
        // Before the runs, so its reason names the restart rather than the lost run.
        let next = M.reconcileNotes(s, now);
        for (const a of M.activeAttempts(next)) {
          if (!this.runnerFor(a)?.has(a.id)) {
            next = M.reportRunLost(next, a.id, "No runtime process found after the service restarted or the scheduler changed", now);
          }
        }
        const lead = M.activeLeadRun(next);
        if (lead && !this.adapterFor(lead.provider).has(lead.id)) next = M.reportLeadStopped(next, lead.id, now, true);
        // A studio run without a process is lost, or stopped if it was stopping (a paused one is then asked for again).
        for (const r of R.activeStudioRuns(next)) if (!this.adapterFor(r.provider).has(r.id)) next = R.reportStudioRunStopped(next, r.id, now, { lost: true });
        return next;
      },
      now,
      this.lease(nowMs),
    );
    // The worktrees of check runs are throwaway by design. Any left by a crash (dirty from a build
    // or an install, which is why the ordinary prune keeps them) go now, together with their temp dirs.
    this.pruneCheckWorkspaces();
  }

  /** Remove the worktree and temp directory of every service check run that is no longer active, even when dirty. */
  private pruneCheckWorkspaces(): number {
    if (!this.workspaces) return 0;
    const { state } = this.store.read();
    const active = new Set(M.activeAttempts(state).map((a) => a.id));
    const stale = state.attempts.filter((a) => a.snapshot.provider === "service" && !active.has(a.id)).map((a) => a.id);
    try {
      return this.workspaces.pruneThrowaway({ repoPath: state.project.repoPath, projectId: state.project.id, ids: stale });
    } catch (e) {
      this.log(`could not remove leftover check worktrees: ${e instanceof Error ? e.message : String(e)}`);
      return 0;
    }
  }

  private adapterFor(p: ProviderId): RuntimeAdapter {
    return this.adapters[p];
  }

  /**
   * Who runs an attempt: a provider's adapter, or the service's check runner, or its capture runner (a service run with
   * an `evidence` snapshot). Undefined for a service run while this service has no runner, so such a run is
   * reconciled as lost.
   */
  private runnerFor(a: { snapshot: { provider: Runner; evidence?: unknown } }): RuntimeAdapter | undefined {
    const p = a.snapshot.provider;
    if (isProvider(p)) return this.adapters[p];
    return (a.snapshot.evidence ? this.evidence : this.checks) as unknown as RuntimeAdapter | undefined;
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
        // A revert waits for a fetch of the base made after the work it undoes landed.
        const next = M.dispatchEligible(M.leadPromoteProposals(s, now), now, { unavailable, deferred, workspaceFor, holdWriters: D.writersHeld(s), staleBase: (t) => D.revertWaitsForBase(s, t) });
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
    const studioActive = new Set(R.activeStudioRuns(state).map((r) => r.id));
    for (const adapter of this.allRunners()) {
      for (const id of adapter.ids()) {
        if (!active.has(id) && id !== leadRun?.id && !studioActive.has(id)) {
          adapter.kill(id); // its run is no longer active: it must never report into state again
          this.launched.delete(id);
        }
      }
    }
    const lost: { id: string; reason: string }[] = [];
    const failedToStart: { id: string; reason: string }[] = [];
    const timeouts: string[] = [];
    for (const a of active.values()) {
      const adapter = this.runnerFor(a);
      if (!adapter) {
        lost.push({ id: a.id, reason: "No runner exists for this run in this version" });
        continue;
      }
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
        if (adapter instanceof FakeAdapter || adapter instanceof SimulatedChecks || adapter instanceof SimulatedEvidence) adapter.interruptAt(a.id, nowMs);
        else adapter.interrupt(a.id);
        if (a.stopRequestedAt && nowMs - Date.parse(a.stopRequestedAt) >= this.ackTimeoutMs) timeouts.push(a.id);
      }
    }
    // Two check runs in a row that could not start ask for a new sandbox probe. A capture of evidence is not a check run.
    const checkRun = (id: string) => active.get(id)?.snapshot.provider === "service" && !active.get(id)?.snapshot.evidence;
    if (failedToStart.some((f) => checkRun(f.id))) this.failedStarts++;
    else if (dispatched.size && [...dispatched].some(checkRun)) this.failedStarts = 0;
    this.planProbe(state, nowMs);
    // Notes the user sent since the last cycle go to their live runs.
    this.sendNotes(state);

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

    // 2c. Studio runs (Vision): supervise the active ones, then dispatch queued ones (in Vision only) and launch them.
    const studioIssues = this.studioCycle(state, nowMs, lease, canDispatch, { unavailable, deferred });

    // 3. The fake runtime advances on the scheduler's clock; real adapters report on their own.
    for (const adapter of Object.values(this.adapters)) if (adapter instanceof FakeAdapter && this.auto) adapter.tick(nowMs);
    if (this.checks instanceof SimulatedChecks && this.auto) this.checks.tick(nowMs);
    if (this.evidence instanceof SimulatedEvidence && this.auto) this.evidence.tick(nowMs);

    // 4. Drain adapter events. Work that touches git happens here, outside the transaction, and so does reading
    //    what a studio run handed in.
    const events = this.queue.splice(0);
    const completions = new Map<string, { outputs: M.OutputReport[]; problems: string[] }>();
    const studioOutputs = new Map<string, StudioOutput>();
    const current = this.store.read().state;
    this.leadProse.clear();
    this.studioProse.clear();
    for (const e of events) {
      if (e.type !== "completed") continue;
      // A lead reply's text is checked here, outside the transaction (Vale is a process); never blocking the reply.
      if (this.prose && current.leadRuns.some((r) => r.id === e.attemptId)) {
        const prose = this.prose;
        const words = this.projectWords(current);
        const check = checkLeadText(parseLeadOutput(e.finalText), (text) => prose(text, words), now);
        if (check) this.leadProse.set(e.attemptId, check);
      }
      const studioRun = R.getStudioRun(current, e.attemptId);
      if (studioRun) {
        // A designer hands in files; the PE answers in its final message, read in the transaction.
        if (studioRun.kind === "designer") studioOutputs.set(e.attemptId, this.readStudioOutput(current, e.attemptId));
        // What it wrote for the owner is checked here too (the PE's verdicts, the designer's documents), and recorded with its result.
        // With the project's words (the dictionary in force), as for the lead.
        const words = this.prose ? this.projectWords(current) : undefined;
        const prose = this.prose && ((text: string) => this.prose!(text, words));
        const check = !prose ? undefined : studioRun.kind === "pe" ? checkPeAnswer(e.finalText, prose, now) : studioRun.kind === "designer" ? checkHandedIn(studioOutputs.get(e.attemptId), prose, now) : undefined;
        if (check) this.studioProse.set(e.attemptId, check);
        continue;
      }
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
              next = R.getStudioRun(next, e.attemptId) ? this.applyStudioEvent(next, e, studioOutputs, now) : this.applyEvent(next, e, completions, now);
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
          for (const l of studioIssues) {
            if (l.kind === "lost") next = R.reportStudioRunStopped(next, l.id, now, { lost: true });
            else if (l.kind === "timeout") next = R.reportStudioStopTimeout(next, l.id, now);
            else next = R.reportStudioRunFailed(next, l.id, l.reason, now);
          }
          // The PE reviews each designer version before the owner sees it: asked for once the version is imported
          // and its screenshots or recording are made (applied above), and again after a review ended without a verdict.
          // When its pass asks for changes, the designer revises the version, and the PE reviews the new one (the loop).
          // While building, the PE reviews new work before it starts (pass 5): a run for each piece that waits for one.
          // A change order closes once nothing is left to handle, also when the owner handled it by hand (pass 5).
          return M.settleChangeOrders(P.askForNewWorkReviews(askForRevisions(R.askForPeReviews(next, now), now), now), now);
        },
        now,
        lease,
      );
    } catch (err) {
      // Nothing was written: put the events back so the next cycle applies them.
      if (!(err instanceof LeaseLostError)) this.queue.unshift(...events);
      throw err;
    }
    const after = this.store.read().state;
    for (const e of events) {
      if (e.type !== "completed" && e.type !== "failed" && e.type !== "stopped") continue;
      const info = this.launched.get(e.attemptId);
      // Lead and studio checkouts are only for reading the repository during the run: remove them afterwards.
      // A check run's throwaway copy of the change goes too, pass or fail.
      if ((info?.taskId === "LEAD" || info?.taskId === "STUDIO" || info?.provider === "service") && info.workspace && this.workspaces) this.workspaces.remove(state.project.repoPath, info.workspace.path);
      // A studio run's staging folder goes once what it handed in is imported; a failed or stopped run's stays, to look at.
      if (info?.staging && R.getStudioRun(after, e.attemptId)?.status === "completed") rmSync(info.staging, { recursive: true, force: true });
      if (info?.tmp) rmSync(info.tmp, { recursive: true, force: true });
      this.launched.delete(e.attemptId);
    }
    this.conventionsCache = undefined;
    // Notes the lead's reply just sent (applied in the drain above) go to their live runs now.
    this.sendNotes(this.store.read().state);
    // Screenshots and recordings of studio versions imported just now, or left pending by an earlier service.
    this.startMedia(this.store.read().state);

    // 5. Integration: one finished task per cycle, frozen while the project is paused; then delivery.
    this.integrateNext(nowMs, lease);
    this.deliverIfDue(nowMs, lease);
    this.pr.tick(nowMs, lease);

    // 6. Automatic retries of failed steps (opt-in, bounded per step, never for credential/config failures).
    const retries = M.autoRetryCandidates(this.store.read().state, nowMs);
    if (retries.length) this.store.update((s) => retries.reduce((acc, r) => M.autoRetryStep(acc, r.taskId, r.stepId, now), s), now, lease);
  }

  /**
   * Hand every note the domain marked "sending" for a live run to that run's adapter, once. The
   * adapter answers with exactly one "note" event (also when it has no such run); the domain records the
   * answer, and a restart marks the unanswered ones not delivered. Notes written into a starting run's
   * instructions (`via: "start"`) are confirmed by `launch`, not here.
   */
  private sendNotes(state: State) {
    for (const n of state.notes) {
      if (n.status !== "sending" || n.via !== "live" || !n.attemptId || this.notesSent.has(n.id)) continue;
      this.notesSent.add(n.id);
      const a = state.attempts.find((x) => x.id === n.attemptId);
      const adapter = a && isProvider(a.snapshot.provider) ? this.adapters[a.snapshot.provider] : undefined;
      if (!adapter) {
        this.queue.push({ type: "note", attemptId: n.attemptId, noteId: n.id, outcome: "not-delivered", reason: "this run has no agent runtime" });
        continue;
      }
      adapter.note(n.attemptId, { id: n.id, text: M.noteMessage(n) });
    }
    // Settled notes are forgotten, so the set does not grow with the record.
    for (const id of this.notesSent) if (!state.notes.some((n) => n.id === id && n.status === "sending")) this.notesSent.delete(id);
  }

  /** Merge the oldest done task's final change into the integration branch (serial, one per cycle). */
  private integrateNext(nowMs: number, lease: { name: string; holder: string; nowMs: number }) {
    const now = new Date(nowMs).toISOString();
    const { state } = this.store.read();
    // Integration is delivery work; none starts while shaping (nothing is paused).
    if (state.project.hold || state.project.stage === "shaping") return;
    const t = M.nextIntegration(state, nowMs);
    if (!t) return;
    // Fake runs produce code-change artifacts without commits; simulate their integration.
    const change = this.workspaces ? M.finalChange(state, t) : state.artifacts.filter((x) => x.taskId === t.id && x.kind === "code-change").pop();
    const pr = state.project.prDelivery;
    // A fix for an open pull request is pushed onto that pull request; it opens none of its own.
    const target = t.deliverInto ? D.repairTarget(state, t) : undefined;
    let result: Integration;
    if (!change) result = { status: "not-needed" };
    else if (target && !pr.enabled) {
      // Pull-request delivery is off: nothing is pushed, and the fix is never delivered another way
      // while its pull request is still open (that would deliver the same work twice).
      this.store.update((s) => M.reportIntegrationError(s, t.id, `pull-request delivery is off; this fix is pushed onto ${target.task.id}'s pull request when it is switched back on`, now), now, lease);
      return;
    } else if (pr.enabled) {
      // Pull-request mode: the task's final commit becomes a pull-request head. Nothing is merged
      // locally and nothing is pushed here; the driver publishes it.
      const n = (t.integration?.pr?.n ?? 0) + 1;
      if (!this.workspaces) {
        const none = { files: 0, additions: 0, deletions: 0, paths: [], protectedHits: [], workflowHits: [] };
        if (target) this.store.update((s) => D.reportRepairHead(s, t.id, { n: target.pr.n, sha: simSha(`${target.task.id}-${target.pr.n}-fix-${t.id}`), baseSha: "sim-base", simulated: true, changed: none, descends: true }, now), now, lease);
        else this.store.update((s) => D.reportPrHead(s, t.id, { n, sha: simSha(`${t.id}-${n}`), baseSha: "sim-base", simulated: true, changed: none }, now), now, lease);
        return;
      }
      if (state.project.sample || !this.repoUsable(state.project.repoPath, nowMs)) return;
      if (!state.project.github?.base) {
        this.store.update((s) => M.reportIntegrationError(s, t.id, `waiting for the first fetch of ${pr.remote}/${pr.base}`, now), now, lease);
        return;
      }
      try {
        const sha = change.ref!.split(" ")[0];
        if (target) {
          // A fix applies only if it still descends from the pull request's head: the push is a fast-forward or nothing.
          const descends = this.workspaces.isAncestor({ repoPath: state.project.repoPath, ancestor: target.pr.headSha, sha });
          if (!descends) {
            this.store.update((s) => D.reportRepairHead(s, t.id, { n: target.pr.n, sha, baseSha: target.pr.baseSha, changed: target.pr.changed, descends: false }, now), now, lease);
            return;
          }
        }
        const head = this.workspaces.preparePrHead({
          repoPath: state.project.repoPath,
          projectId: state.project.id,
          taskId: target ? target.task.id : t.id,
          n: target ? target.pr.n : n,
          baseRef: this.workspaces.baseRef(state.project.id),
          sha,
          protectedPaths: pr.protectedPaths,
          skipConflictCheck: !!target,
        });
        if (head.status === "ready") {
          if (target) this.store.update((s) => D.reportRepairHead(s, t.id, { n: target.pr.n, sha: head.sha, baseSha: head.baseSha, changed: head.changed, descends: true }, now), now, lease);
          else this.store.update((s) => D.reportPrHead(s, t.id, { n, sha: head.sha, baseSha: head.baseSha, changed: head.changed }, now), now, lease);
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

  /** Remove workspaces of runs that are no longer active (real mode). Check worktrees go even when dirty. */
  prune(): number {
    if (!this.workspaces) return 0;
    const { state } = this.store.read();
    const keep = new Set([...M.activeAttempts(state).map((a) => a.id), ...(M.activeLeadRun(state) ? [M.activeLeadRun(state)!.id] : []), ...R.activeStudioRuns(state).map((r) => r.id)]);
    const throwaway = new Set(state.attempts.filter((a) => a.snapshot.provider === "service" && !keep.has(a.id)).map((a) => a.id));
    return this.workspaces.prune({ repoPath: state.project.repoPath, projectId: state.project.id, keep, throwaway });
  }

  /** The lead's concrete provider/model ("auto" resolves to the first catalog model). */
  private resolveLead(state: State): { provider: ProviderId; model: string } | undefined {
    const sel = state.project.leadSelection;
    const catalog = state.project.catalog[sel.provider];
    if (!state.project.enabledProviders.includes(sel.provider)) return undefined;
    if (sel.model === "auto") return catalog[0] ? { provider: sel.provider, model: catalog[0].id } : undefined;
    return catalog.some((m) => m.id === sel.model) ? { provider: sel.provider, model: sel.model } : undefined;
  }

  /**
   * The repository's AGENTS.md and CLAUDE.md at the trusted base (never a worktree), capped and
   * labelled for an envelope. Read at most once per cycle; nothing when the setting is off, in the
   * fake runtime, or when the repository cannot be read.
   */
  private conventionsFor(state: State, nowMs: number): ConventionsFile[] {
    if (!this.workspaces || !state.project.conventions?.include || state.project.sample || !state.project.repoPath) return [];
    const ref = M.trustedBaseRef(state);
    const cached = this.conventionsCache;
    if (cached && cached.ref === ref && nowMs - cached.at < 10_000) return cached.files;
    const files: { file: string; blob: string; text: string }[] = [];
    for (const file of CONVENTION_FILES) {
      try {
        const r = this.workspaces.readFileAt({ repoPath: state.project.repoPath, ref, path: file });
        if (r) files.push({ file, blob: r.blob, text: r.text });
      } catch {
        /* not readable: left out, never invented */
      }
    }
    const capped = capConventions(files);
    this.conventionsCache = { ref, at: nowMs, files: capped };
    return capped;
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
      const conventions = this.conventionsFor(state, Date.now());
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
        // In Vision the lead's studio brief says whether the repository has code (an "as it is today" first round).
        prompt: buildLeadEnvelope(state, run, "read", this.visionDocs?.reader(state.project.id), conventions, state.project.stage === "shaping" && !state.project.sample ? repoGlance(state.project.repoPath) : undefined),
        outputs: [],
        // The runtime constrains the lead's answer to its reply schema, so one missing brace cannot lose the reply.
        outputSchema: LEAD_REPLY_SCHEMA,
        limits: { maxTurns: limits.maxTurns, timeoutMs: limits.timeoutMinutes * 60_000, maxBudgetUsd: limits.maxBudgetUsd },
      });
      return undefined;
    } catch (e) {
      this.launched.delete(runId);
      return `Could not start the lead: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  /**
   * Studio runs, like the lead's: an active run whose process is gone is lost (after a short grace for its last
   * events), a stop is forwarded until the runtime confirms it, and one unconfirmed past the limit is a control
   * failure. Then queued runs are dispatched, committed before any process starts (the domain decides: Vision only,
   * not paused, below the budget, within the limits), and launched. Returns what is applied with the drain.
   */
  private studioCycle(state: State, nowMs: number, lease: { name: string; holder: string; nowMs: number }, canDispatch: boolean, avail: { unavailable: Partial<Record<ProviderId, string>>; deferred: ProviderId[] }): StudioIssue[] {
    const issues: StudioIssue[] = [];
    for (const r of R.activeStudioRuns(state)) {
      const adapter = this.adapterFor(r.provider);
      const launched = this.launched.get(r.id);
      if (!adapter.has(r.id) && !this.queue.some((e) => e.attemptId === r.id)) {
        if (!launched) issues.push({ id: r.id, kind: "lost" });
        else {
          launched.goneSince ??= nowMs;
          if (nowMs - launched.goneSince > 10_000) {
            this.launched.delete(r.id);
            issues.push({ id: r.id, kind: "lost" });
          }
        }
      } else if (r.status === "stopping") {
        if (adapter instanceof FakeAdapter) adapter.interruptAt(r.id, nowMs);
        else adapter.interrupt(r.id);
        if (r.stopRequestedAt && nowMs - Date.parse(r.stopRequestedAt) >= this.ackTimeoutMs) issues.push({ id: r.id, kind: "timeout" });
      }
    }
    // A sample or unconfigured project never reaches a real agent. With nothing queued there is nothing to write.
    if (!canDispatch || !state.studio.runs.some((r) => r.status === "queued")) return issues;
    const now = new Date(nowMs).toISOString();
    const simulated = (Object.keys(this.adapters) as ProviderId[]).filter((p) => this.adapters[p] instanceof FakeAdapter);
    let started: string[] = [];
    this.store.update(
      (s) => {
        const d = R.dispatchStudioRuns(s, now, { ...avail, simulated });
        started = d.started;
        // Each records the principles its envelope gives it, with their hashes, as a task run's snapshot does.
        return withStudioPrinciples(d.state, d.started);
      },
      now,
      lease,
    );
    if (!started.length) return issues;
    const fresh = this.store.read().state;
    for (const id of started) {
      const err = this.launchStudio(fresh, id);
      if (err) issues.push({ id, kind: "failed", reason: err });
    }
    return issues;
  }

  /**
   * Start a studio run. A designer's: a fresh staging folder under the data directory (the one place it writes), a
   * read-only checkout of the product (real mode), and its envelope. The PE's: read-only, in the folder of the version
   * it reviews (the files, screenshots and recordings), with nothing to write. Isolated, with no connections and no
   * shell, whatever the project's environment setting: the adapters enforce it for `studio` runs too.
   */
  private launchStudio(state: State, runId: string): string | undefined {
    const run = R.getStudioRun(state, runId)!;
    if (run.kind === "probe") return "Probe runs cannot start yet; they come in ORC-029 pass 4";
    if (!this.dataDir) return "This service has no data directory for the studio";
    const adapter = this.adapterFor(run.provider);
    const limits = state.project.runLimits;
    if (run.kind === "pe" && run.review) return this.launchNewWorkPe(state, run);
    if (run.kind === "pe") {
      try {
        const root = studioRoot(this.dataDir, state.project.id);
        const folder = versionDir(root, run.artifactId!, run.baseVersion!);
        // Its temp files go in its own staging folder: the version it reads is immutable (review finding 6).
        const tmp = join(root, run.workspace);
        rmSync(tmp, { recursive: true, force: true });
        mkdirSync(tmp, { recursive: true });
        // A reproduction of the code as it is today is judged against the code: the PE reads a checkout of it (review finding 5).
        const asIs = !!S.getArtifact(state, run.artifactId!, run.baseVersion!).provenance;
        const checkout = asIs && this.workspaces ? this.workspaces.prepare({ repoPath: state.project.repoPath, projectId: state.project.id, attemptId: runId, taskId: "STUDIO", stepId: run.kind, access: "read" }) : undefined;
        this.launched.set(runId, { provider: run.provider, access: "read", workspace: checkout, stepId: run.kind, taskId: "STUDIO", tmp });
        adapter.start({
          attemptId: runId,
          taskId: "STUDIO",
          stepId: run.kind,
          role: "pe",
          provider: run.provider,
          model: run.model,
          workspace: { path: folder, access: "read", tmp, ...(checkout ? { readRoots: [checkout.path] } : {}) },
          studio: true,
          environment: "isolated",
          connections: [],
          prompt: peEnvelope(state, run, { folder, checkout: checkout?.path }),
          outputs: [],
          limits: { maxTurns: limits.maxTurns, timeoutMs: limits.timeoutMinutes * 60_000, maxBudgetUsd: limits.maxBudgetUsd },
        });
        return undefined;
      } catch (e) {
        const info = this.launched.get(runId);
        if (info?.tmp) rmSync(info.tmp, { recursive: true, force: true });
        if (info?.workspace && this.workspaces) this.workspaces.remove(state.project.repoPath, info.workspace.path);
        this.launched.delete(runId);
        return `Could not start the PE run: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    let checkout: PreparedWorkspace | undefined;
    try {
      const staging = prepareStaging(state, run, studioRoot(this.dataDir, state.project.id));
      if (this.workspaces) checkout = this.workspaces.prepare({ repoPath: state.project.repoPath, projectId: state.project.id, attemptId: runId, taskId: "STUDIO", stepId: run.kind, access: "read" });
      this.launched.set(runId, { provider: run.provider, access: "write", workspace: checkout, stepId: run.kind, taskId: "STUDIO", staging });
      adapter.start({
        attemptId: runId,
        taskId: "STUDIO",
        stepId: run.kind,
        role: "designer",
        provider: run.provider,
        model: run.model,
        workspace: { path: staging, access: "write", ...(checkout ? { readRoots: [checkout.path] } : {}) },
        studio: true,
        environment: "isolated",
        connections: [],
        prompt: designerEnvelope(state, run, { staging, checkout: checkout?.path }),
        outputs: [],
        limits: { maxTurns: limits.maxTurns, timeoutMs: limits.timeoutMinutes * 60_000, maxBudgetUsd: limits.maxBudgetUsd },
      });
      return undefined;
    } catch (e) {
      this.launched.delete(runId);
      if (checkout && this.workspaces) this.workspaces.remove(state.project.repoPath, checkout.path);
      return `Could not start the studio run: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  /**
   * Start a PE run on new work in the factory (pass 5): read-only, in a checkout of the product (its own empty folder
   * when there is no repository to read), with the approved prototypes the work cites as read roots. Isolated, with no
   * connections and no shell, like the studio's runs.
   */
  private launchNewWorkPe(state: State, run: ReturnType<typeof R.getStudioRun> & object): string | undefined {
    const adapter = this.adapterFor(run.provider);
    const limits = state.project.runLimits;
    let checkout: PreparedWorkspace | undefined;
    try {
      const root = studioRoot(this.dataDir!, state.project.id);
      const tmp = join(root, run.workspace);
      rmSync(tmp, { recursive: true, force: true });
      mkdirSync(tmp, { recursive: true });
      if (this.workspaces) checkout = this.workspaces.prepare({ repoPath: state.project.repoPath, projectId: state.project.id, attemptId: run.id, taskId: "STUDIO", stepId: "pe", access: "read" });
      const task = state.tasks.find((t) => t.id === run.review!.taskId)!;
      const protos = prototypeFolders(state, task, root);
      this.launched.set(run.id, { provider: run.provider, access: "read", workspace: checkout, stepId: "pe", taskId: "STUDIO", tmp });
      const folder = checkout?.path ?? tmp;
      adapter.start({
        attemptId: run.id,
        taskId: "STUDIO",
        stepId: "pe",
        role: "pe",
        provider: run.provider,
        model: run.model,
        workspace: { path: folder, access: "read", tmp, ...(protos.length ? { readRoots: protos } : {}) },
        studio: true,
        environment: "isolated",
        connections: [],
        prompt: newWorkPeEnvelope(state, run, { folder, checkout: checkout?.path, studioDir: root }),
        outputs: [],
        limits: { maxTurns: limits.maxTurns, timeoutMs: limits.timeoutMinutes * 60_000, maxBudgetUsd: limits.maxBudgetUsd },
      });
      return undefined;
    } catch (e) {
      const info = this.launched.get(run.id);
      if (info?.tmp) rmSync(info.tmp, { recursive: true, force: true });
      if (checkout && this.workspaces) this.workspaces.remove(state.project.repoPath, checkout.path);
      this.launched.delete(run.id);
      return `Could not start the PE run: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  /**
   * Make the screenshots or recording of every studio version still pending, one at a time and outside any
   * transaction; each result is queued and recorded in a later drain, under the lease. Each is started once per
   * process: one whose result could not be recorded is not retried in a loop, and one an earlier service left
   * pending (it stopped meanwhile) is made again here. Nothing starts while the project is paused: what waits is
   * made once it resumes, like the studio's runs (review finding 5).
   */
  private startMedia(state: State) {
    if (!this.media || !this.dataDir || state.project.hold) return;
    const media = this.media;
    const projectId = state.project.id;
    let studioDir: string;
    try {
      studioDir = studioRoot(this.dataDir, projectId);
    } catch (e) {
      return this.log(`Studio screenshots and recordings: ${e instanceof Error ? e.message : String(e)}`);
    }
    for (const p of S.pendingMedia(state)) {
      const key = `${projectId}/${p.artifactId}@${p.version}/${p.kind}`;
      if (this.mediaStarted.has(key)) continue;
      this.mediaStarted.add(key);
      const variants = S.getArtifact(state, p.artifactId, p.version).variants.map((v) => v.id);
      const now = () => new Date().toISOString();
      this.mediaChain = this.mediaChain
        .then(async () => {
          // Paused since it was queued behind another: it is asked for again once the project resumes.
          if (this.store.read().state.project.hold) return void this.mediaStarted.delete(key);
          const result = p.kind === "shots" ? await makeShots(media, studioDir, p.artifactId, p.version, now) : await makeDemo(media, studioDir, p.artifactId, p.version, variants, now);
          this.queue.push({ type: "studio-media", attemptId: "", projectId, artifactId: p.artifactId, version: p.version, result });
        })
        .catch((e) => this.log(`Studio ${p.kind === "shots" ? "screenshots" : "recording"} of ${p.artifactId} v${p.version} failed: ${e instanceof Error ? e.message : String(e)}`));
    }
  }

  /** Resolves when the studio screenshots and recordings started so far are made (their results are queued). */
  mediaIdle(): Promise<void> {
    return this.mediaChain;
  }

  /**
   * Record a version's screenshots or recording, for the project it was made in. A result the domain refuses is
   * recorded as none made, with the reason, so the version does not stay pending.
   */
  private applyMedia(s: State, e: MediaEvent, now: string): State {
    if (s.project.id !== e.projectId) return s;
    try {
      return S.recordArtifactMedia(s, e.artifactId, e.version, e.result, now);
    } catch (err) {
      const why = `the result could not be recorded (${err instanceof Error ? err.message : String(err)})`;
      this.log(`Studio media for ${e.artifactId} v${e.version}: ${why}`);
      const a = S.getArtifact(s, e.artifactId, e.version);
      const none: S.MediaResult = "shots" in e.result ? { shots: { status: "skipped", at: now, reason: why } } : { demo: { status: "done", at: now, variants: a.variants.map((v) => ({ variant: v.id, status: "not-recorded" as const, reason: why })) } };
      return S.recordArtifactMedia(s, e.artifactId, e.version, none, now);
    }
  }

  /**
   * The Vale configuration with the project's words (pass 4d), generated into the data folder from the dictionary in
   * force; undefined without one, or when it cannot be written (then the repository's style alone checks). Never throws.
   */
  private projectWords(state: State): string | undefined {
    if (!this.dataDir) return undefined;
    try {
      return projectValeConfig(this.dataDir, state);
    } catch (e) {
      this.log(`The project's words could not be written for the prose check: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
  }

  /**
   * Read and check the studio.json a finished designer run left in its staging folder, and look up the repository
   * files its provenance names: here, outside the store's transaction (review finding 11). Never throws.
   */
  private readStudioOutput(state: State, runId: string): StudioOutput {
    const staging = this.launched.get(runId)?.staging;
    if (!staging) return { refused: "its staging folder is not known to this service (it was started before a restart)" };
    try {
      return handedIn(state, runId, readStaged(staging, DESIGNER_KINDS));
    } catch (e) {
      return { refused: e instanceof ManifestError ? e.message : `it could not be read (${e instanceof Error ? e.message : String(e)})` };
    }
  }

  /**
   * A studio run's report. A result counts only from a run still running or stopping, and only when it is not stale
   * (its round still open, its artifact not revised meanwhile): then what it handed in is imported, its version
   * folders written before the transaction commits, and the run completes. A refused studio.json fails the run with
   * the reason, and nothing is recorded.
   */
  private applyStudioEvent(s: State, e: QueueEvent, outputs: Map<string, StudioOutput>, now: string): State {
    switch (e.type) {
      case "started":
        return R.reportStudioRunStarted(s, e.attemptId, { sessionId: e.sessionId, actualModel: e.model });
      case "activity":
        return R.reportStudioRunActivity(s, e.attemptId, e.note);
      case "stopped":
        return R.reportStudioRunStopped(s, e.attemptId, now, { usage: e.usage });
      case "failed":
        return R.reportStudioRunFailed(s, e.attemptId, e.message, now, e.usage);
      case "completed": {
        const run = R.getStudioRun(s, e.attemptId)!;
        if (!R.isActiveStudioRun(run)) return s;
        const started = e.model ? R.reportStudioRunStarted(s, run.id, { actualModel: e.model }) : s;
        const fail = (why: string) => R.reportStudioRunFailed(started, run.id, why, now, e.usage);
        const stale = R.staleReason(started, run);
        if (stale) return fail(`Its result is stale: ${stale}. Nothing was ${run.kind === "pe" ? "recorded" : "imported"}.`);
        if (run.kind === "pe") {
          // The PE's verdicts, from its final message: checked, then recorded on the version it reviewed.
          try {
            const mine = R.getStudioRun(started, run.id)!;
            const r = mine.review ? recordNewWorkPeRun(started, mine, readPeAnswer(e.finalText), now) : recordPeRun(started, mine, readPeAnswer(e.finalText), now);
            // The check of its text goes on the run (never on the verdicts: the owner sees no score); the PE's next run is told what it broke.
            return withStudioProse(R.completeStudioRun(r.state, run.id, now, { usage: e.usage, actualModel: e.model, summary: r.summary }), run.id, this.studioProse.get(run.id));
          } catch (err) {
            return fail(`Its verdicts were refused: ${err instanceof PeAnswerError || err instanceof Error ? err.message : String(err)}`);
          }
        }
        const out = outputs.get(run.id);
        if (!out || "refused" in out) return fail(`studio.json was refused: ${out && "refused" in out ? out.refused : "it was not read"}`);
        try {
          const r = importDesignerRun(started, run.id, out, studioRoot(this.dataDir!, s.project.id), now);
          // Screenshots and recordings are made after this transaction commits; the run completes without them.
          const marked = this.media ? r.imported.reduce((acc, v) => S.startArtifactMedia(acc, v.artifactId, v.version), r.state) : r.state;
          return withStudioProse(R.completeStudioRun(marked, run.id, now, { usage: e.usage, actualModel: e.model, summary: r.summary }), run.id, this.studioProse.get(run.id));
        } catch (err) {
          return fail(`studio.json was refused: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      default:
        return s;
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
    if (a.snapshot.provider === "service") return a.snapshot.evidence ? this.launchEvidence(state, a.id, task, step) : this.launchChecks(state, a.id, task, step);
    const adapter = this.runnerFor(a);
    if (!adapter) return "This version has no runner for this run";
    const access: "write" | "read" = WRITER_ROLES.has(step.role) ? "write" : "read";
    const limits = state.project.runLimits;
    try {
      let workspace: PreparedWorkspace | undefined;
      let changeUnderReview: { from: string; to: string; text: string } | undefined;
      let scope: NonNullable<M.RunContext["scope"]> | undefined;
      if (this.workspaces) {
        const d = state.project.autonomy.autoDeliver;
        // With delivery on, new work starts from the delivery base, not from whatever is checked out:
        // the delivery branch (local mode), or the fetched tip of the remote base (pull requests). In
        // pull-request mode a writer never falls back to a local branch or HEAD.
        const input = baseRefFor(state, task, step);
        const prMode = state.project.prDelivery.enabled;
        const fetched = state.project.github?.base ? this.workspaces.baseRef(state.project.id) : undefined;
        const prBase = prMode && (access === "write" || fetched) ? this.workspaces.baseRef(state.project.id) : undefined;
        // A revert starts from where the work it undoes landed. With pull-request delivery on that is
        // always the fetched remote base (never a local branch, which may carry commits that were not
        // pushed); dispatch waited for a fetch made after the work landed.
        const origin = task.revertOf ? state.tasks.find((x) => x.id === task.revertOf!.taskId)?.integration?.landed : undefined;
        const revertBase = !origin ? undefined : prMode ? prBase : origin.via === "local" ? `refs/heads/${origin.target}` : fetched;
        // A dedicated delivery review reads a worktree detached at exactly the commit under review.
        const review = task.reviewTarget;
        // A fix for an open pull request continues from that pull request's head, so its push is a fast-forward.
        const target = task.deliverInto && access === "write" && !input ? D.repairTarget(state, task) : undefined;
        const baseRef = input ?? review?.headSha ?? target?.pr.headSha ?? revertBase ?? prBase ?? (d.enabled ? `refs/heads/${d.branch}` : undefined);
        // A revert task's first writer (the one that continues no earlier change) starts from the
        // delivery base with the revert of the landed commit already prepared in its worktree. A fix
        // for a conflict starts from the pull request's head with the merge of the base prepared.
        const seed: WorkspaceSeed | undefined =
          task.revertOf && access === "write" && !input
            ? { kind: "revert", commit: task.revertOf.commit }
            : target && task.deliverInto!.mergeBase && fetched
              ? { kind: "merge", ref: fetched }
              : undefined;
        workspace = this.workspaces.prepare({ repoPath: state.project.repoPath, projectId: state.project.id, attemptId, taskId: task.id, stepId: step.id, access, baseRef, seed });
        try {
          if (review && workspace.base !== review.headSha) throw new Error(`the workspace is not at the commit under review (${review.headSha.slice(0, 12)})`);
          // A read-only step that receives a code change (a reviewer, the lead's verification) is
          // handed the changed lines: its tools cannot show a diff.
          if (access === "read" && (review || input)) {
            const diff = this.workspaces.reviewDiff({
              repoPath: state.project.repoPath,
              to: review ? review.headSha : input!,
              ...(review ? { from: review.baseSha } : { baseRef: prMode && fetched ? fetched : d.enabled ? `refs/heads/${d.branch}` : undefined }),
            });
            if (diff) {
              changeUnderReview = { from: diff.from, to: diff.to, text: diff.text };
              // The changed-path set a reviewer must account for, recorded before the run can report anything.
              if (REVIEW_ROLES.includes(step.role)) scope = { from: diff.from, to: diff.to, paths: diff.paths, total: diff.total };
            }
            // A dedicated review without the change in front of it would prove nothing.
            else if (review) throw new Error("the change under review could not be read from the repository");
          }
        } catch (e) {
          this.workspaces.remove(state.project.repoPath, workspace.path);
          throw e;
        }
      }
      const conventions = this.conventionsFor(state, Date.now());
      const decisions = F.decisionsForStep(state, task, step).map((d) => d.id);
      this.launched.set(attemptId, { provider: a.snapshot.provider, access, workspace, stepId: step.id, taskId: task.id });
      // The approved prototypes the task cites (pass 5): the designer starts from them, the UX reviewer compares with them.
      const studioDir = this.dataDir ? studioRoot(this.dataDir, state.project.id) : undefined;
      const protos = studioDir && readsPrototypes(step) ? prototypeFolders(state, task, studioDir) : [];
      // Queued before the run starts, so it is applied no later than any event from the run.
      this.queue.push({ type: "context", attemptId, ...(scope ? { scope } : {}), ...(conventions.length ? { conventions: conventions.map((c) => ({ file: c.file, blob: c.blob, bytes: c.bytes, truncated: c.truncated })) } : {}), ...(decisions.length ? { decisions } : {}) });
      // A step that reads evidence (the UX review, ORC-029 pass 5) may read the built screenshots and recordings, and the
      // approved design's own, read-only; its inputs name them.
      const dataDir = this.dataDir;
      const evidenceRoots = dataDir ? a.snapshot.inputs.flatMap((i) => state.artifacts.filter((x) => x.id === i.artifactId && x.kind === "evidence").flatMap((x) => evidenceReadRoots(state, x, dataDir))) : [];
      adapter.start({
        attemptId,
        taskId: task.id,
        stepId: step.id,
        role: step.role,
        provider: isProvider(a.snapshot.provider) ? a.snapshot.provider : "claude",
        model: a.snapshot.model,
        workspace: { path: workspace?.path ?? a.snapshot.workspace, access, ...(protos.length || evidenceRoots.length ? { readRoots: [...new Set([...protos, ...evidenceRoots])] } : {}) },
        environment: a.snapshot.environment ?? "isolated",
        connections: a.snapshot.connections ?? [],
        prompt: buildEnvelope({
          state,
          task,
          step,
          attemptId,
          access,
          seed: workspace?.seed,
          changeUnderReview,
          ...(scope && step.role === "code_reviewer" ? { changedPaths: { paths: scope.paths, total: scope.total } } : {}),
          ...(step.coverageGap ? { coverageGap: step.coverageGap } : {}),
          ...(conventions.length ? { conventions } : {}),
          docs: this.visionDocs?.reader(state.project.id),
          ...(studioDir ? { studioDir } : {}),
          ...(dataDir ? { evidenceFiles: (art: Artifact) => evidenceInputLines(state, art, dataDir) } : {}),
        }),
        outputs: step.outputs,
        limits: { maxTurns: limits.maxTurns, timeoutMs: limits.timeoutMinutes * 60_000, maxBudgetUsd: limits.maxBudgetUsd },
      });
      // Notes written into the instructions ("via start") are confirmed when the runtime reports the run started:
      // a run that fails before it starts settles them as not delivered.
      return undefined;
    } catch (e) {
      this.launched.delete(attemptId);
      return `Could not start the run: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  /**
   * Start a check run. A throwaway worktree detached at the target commit (removed after the run, pass
   * or fail), the protected inputs the change touched, and the command environment from the allowlist.
   * The runner is the service's own; no envelope, no provider.
   */
  private launchChecks(state: State, attemptId: string, task: Task, step: Step): string | undefined {
    const a = state.attempts.find((x) => x.id === attemptId)!;
    const runner = this.checks;
    if (!runner) return "This service has no runner for check runs";
    const plan = a.snapshot.checks;
    if (!plan) return "The run has no check plan in its snapshot";
    const cfg = state.project.checks;
    // The plan names the commit as the code-change artifact does (a 12-character prefix); the prepared worktree gives the full SHA.
    let target = plan.target.ref;
    let workspace: PreparedWorkspace | undefined;
    let touched: string[] = [];
    try {
      if (this.workspaces) {
        workspace = this.workspaces.prepare({ repoPath: state.project.repoPath, projectId: state.project.id, attemptId, taskId: task.id, stepId: step.id, access: "read", baseRef: target });
        try {
          if (!C.sameSha(workspace.base, target)) throw new Error(`the workspace is not at ${target.slice(0, 12)} (it is at ${workspace.base.slice(0, 12)})`);
          target = workspace.base;
          const changed = this.workspaces.changedPaths({ repoPath: state.project.repoPath, to: target, baseRef: M.trustedBaseRef(state) });
          touched = changed ? C.touchedInputs(cfg, changed.paths) : [];
        } catch (e) {
          this.workspaces.remove(state.project.repoPath, workspace.path);
          throw e;
        }
      }
      const path = workspace?.path ?? a.snapshot.workspace;
      const tmp = `${path}.tmp`;
      const dataDir = this.dataDir ?? join(this.workspaces?.root ?? path, "..");
      const cache = join(dataDir, "checks-cache", state.project.id.replace(/[^A-Za-z0-9._-]/g, "_"));
      const logDir = join(dataDir, "check-logs", state.project.id.replace(/[^A-Za-z0-9._-]/g, "_"), attemptId);
      const assignment: CheckAssignment = {
        attemptId,
        taskId: task.id,
        stepId: step.id,
        workspace: path,
        target,
        commands: plan.commands.map((c) => ({ ...c, argv: [...c.argv] })),
        runTimeoutMs: cfg.runTimeoutMinutes * 60_000,
        sandbox: plan.sandbox,
        prepareNetwork: cfg.prepareNetwork,
        env: runner.simulated ? {} : checkEnv(process.env, cfg, { tmp, cache }),
        tmpDir: tmp,
        cacheDir: cache,
        logDir,
        ...(cfg.testReport ? { testReport: cfg.testReport } : {}),
      };
      this.launched.set(attemptId, { provider: "service", access: "read", workspace, stepId: step.id, taskId: task.id, touchedInputs: touched });
      runner.start(assignment);
      return undefined;
    } catch (e) {
      this.launched.delete(attemptId);
      return `Could not start the check run: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  /**
   * Start a capture of evidence (ORC-029 pass 5): a throwaway worktree detached at the target commit, as for a check
   * run (removed after the run), handed to the capture runner with the items and the preview setting of the run's
   * snapshot. The files that come back go to <dataDir>/evidence/<project>/<run>.
   */
  private launchEvidence(state: State, attemptId: string, task: Task, step: Step): string | undefined {
    const a = state.attempts.find((x) => x.id === attemptId)!;
    const runner = this.evidence;
    if (!runner) return "This service has no runner for captures of evidence";
    const snap = a.snapshot.evidence!;
    // Without a setting the capture completed at dispatch, "not set up"; it is never started.
    if (!snap.preview) return "The capture has no preview setting in its snapshot";
    let target = snap.target.ref;
    let workspace: PreparedWorkspace | undefined;
    try {
      if (this.workspaces) {
        workspace = this.workspaces.prepare({ repoPath: state.project.repoPath, projectId: state.project.id, attemptId, taskId: task.id, stepId: step.id, access: "read", baseRef: target });
        if (!C.sameSha(workspace.base, target)) {
          this.workspaces.remove(state.project.repoPath, workspace.path);
          throw new Error(`the workspace is not at ${target.slice(0, 12)} (it is at ${workspace.base.slice(0, 12)})`);
        }
        target = workspace.base;
      }
      const path = workspace?.path ?? a.snapshot.workspace;
      const outDir = evidenceDir(this.dataDir ?? join(this.workspaces?.root ?? path, ".."), state.project.id, attemptId);
      if (!outDir) throw new Error(`the project id ${state.project.id} cannot name an evidence folder`);
      this.launched.set(attemptId, { provider: "service", access: "read", workspace, stepId: step.id, taskId: task.id });
      runner.start({ attemptId, taskId: task.id, stepId: step.id, workspace: path, sha: target, items: structuredClone(snap.items), preview: structuredClone(snap.preview), outDir });
      return undefined;
    } catch (e) {
      this.launched.delete(attemptId);
      if (workspace && this.workspaces) this.workspaces.remove(state.project.repoPath, workspace.path);
      return `Could not start the capture: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  /**
   * Probe the sandbox when checks were switched on, on request, every six hours, and after two check
   * runs in a row failed to start. At most one probe at a time; its result is queued and applied under
   * the lease. No probe with the simulated runner beyond its own answer.
   */
  private planProbe(state: State, nowMs: number) {
    const runner = this.checks;
    if (!runner || this.probing) return;
    if (!C.probeDue(state, nowMs) && this.failedStarts < 2) return;
    this.probing = true;
    this.failedStarts = 0;
    const sandbox = state.project.checks.sandbox;
    const startedAt = new Date(nowMs).toISOString();
    void runner
      .probe(sandbox)
      .catch((e): ChecksHealth => ({ sandbox, status: "unavailable", detail: e instanceof Error ? e.message : String(e), checkedAt: new Date().toISOString() }))
      .then((health) => {
        this.probing = false;
        this.queue.push({ type: "checks-health", attemptId: "", health, startedAt });
      });
  }

  /** Turn a completion into output reports: parse the output block; commit a writer's changes. */
  private collectOutputs(state: State, e: Extract<AdapterEvent, { type: "completed" }>) {
    const a = state.attempts.find((x) => x.id === e.attemptId);
    const task = a && state.tasks.find((t) => t.id === a.taskId);
    const step = task?.steps.find((x) => x.id === a!.stepId);
    if (!a || !step) return { outputs: [], problems: [] };
    const info = this.launched.get(e.attemptId);
    // A capture's report (ORC-029 pass 5) is the service's own, never parsed from text; it becomes the step's one output.
    if (a.snapshot.provider === "service" && a.snapshot.evidence) {
      if (!e.evidence || !step.outputs[0]) return { outputs: [], problems: ["The capture ended without a report."] };
      return { outputs: [{ name: step.outputs[0].name, summary: evidenceSummary(e.evidence), evidence: e.evidence }], problems: [] };
    }
    // A check run's report is never parsed from text; it becomes the step's one output.
    if (a.snapshot.provider === "service") {
      if (!e.checks || !step.outputs[0]) return { outputs: [], problems: ["The check run ended without a report."] };
      const record = { sha: e.checks.sha, configRev: a.snapshot.checks?.configRev ?? state.project.checks.rev, sandbox: e.checks.sandbox, ...(e.checks.simulated ? { simulated: true as const } : {}), touchedInputs: info?.touchedInputs ?? [], results: e.checks.results, durationMs: e.checks.durationMs, ...(e.checks.tests ? { tests: e.checks.tests } : {}), ...(e.checks.environment ? { environment: e.checks.environment } : {}) };
      const findings = C.findingsFromRun(record, a.snapshot.checks?.commands ?? []);
      return { outputs: [{ name: step.outputs[0].name, summary: C.runSummary(record), checkRun: record, findings }], problems: [] };
    }
    const parsed = parseOutputs(e.finalText, step.outputs);
    // What the parser corrected is recorded on the run, without refusing the result.
    parsed.problems.push(...parsed.notes);
    const outputs: M.OutputReport[] = parsed.outputs.map((o) => ({ ...o }));
    // The fake runtime commits nothing: a simulated change is named by its run, so a check step has something to check.
    if (!this.workspaces) for (const o of outputs) if (step.outputs.find((d) => d.name === o.name)?.kind === "code-change") o.ref = `sim-${e.attemptId} (simulated)`;
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

  private applyEvent(s: State, e: QueueEvent, completions: Map<string, { outputs: M.OutputReport[]; problems: string[] }>, now: string): State {
    // The service's own record of what a run was given; applied only while the run is active.
    if (e.type === "context") return M.reportRunContext(s, e.attemptId, { scope: e.scope, conventions: e.conventions, decisions: e.decisions });
    if (e.type === "checks-health") return C.reportChecksHealth(s, e.health, now, { startedAt: e.startedAt });
    if (e.type === "studio-media") return this.applyMedia(s, e, now);
    if (s.leadRuns.some((r) => r.id === e.attemptId)) return this.applyLeadEvent(s, e, now);
    switch (e.type) {
      case "started": {
        let next = M.reportRunStarted(s, e.attemptId, { sessionId: e.sessionId, actualModel: e.model });
        const simulated = this.simulatedRun(next, e.attemptId);
        for (const n of M.notesAtStart(next, e.attemptId)) if (n.status === "sending") next = M.reportNoteOutcome(next, { attemptId: e.attemptId, noteId: n.id, outcome: "delivered" }, now, simulated);
        return next;
      }
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
        return M.acknowledgeStop(s, e.attemptId, now, { usage: e.usage });
      }
      case "failed":
        return M.reportRunFailed(s, e.attemptId, e.message, now, { usage: e.usage });
      case "completed": {
        const c = completions.get(e.attemptId) ?? { outputs: [], problems: [] };
        let next = M.reportCompletion(s, e.attemptId, [], now, c.outputs, { usage: e.usage, actualModel: e.model, simulated: this.simulatedRun(s, e.attemptId) });
        if (c.problems.length) next = noteProblems(next, e.attemptId, c.problems);
        return next;
      }
      case "note": {
        // The runtime's answer (or the service's, for a note written into a run that started). An answer from
        // the fake runtime is recorded as simulated. A stale answer changes nothing (the domain checks the run).
        return M.reportNoteOutcome(s, e, now, this.simulatedRun(s, e.attemptId));
      }
    }
  }

  /** Whether a run is the fake runtime's: its note outcomes are recorded as simulated. */
  private simulatedRun(s: State, attemptId: string): true | undefined {
    const a = s.attempts.find((x) => x.id === attemptId);
    return a && isProvider(a.snapshot.provider) && this.adapters[a.snapshot.provider] instanceof FakeAdapter ? true : undefined;
  }

  private applyLeadEvent(s: State, e: AdapterEvent, now: string): State {
    switch (e.type) {
      case "started":
        return M.reportLeadStarted(s, e.attemptId, { sessionId: e.sessionId, actualModel: e.model });
      case "activity":
        return M.reportLeadActivity(s, e.attemptId, e.note);
      case "progress":
      case "note": // lead runs never receive notes
        return s;
      case "stopped":
        return M.reportLeadStopped(s, e.attemptId, now, false, e.usage);
      case "failed":
        return M.reportLeadFailed(s, e.attemptId, e.message, now, e.usage);
      case "completed": {
        const out = parseLeadOutput(e.finalText);
        // A reply from the fake runtime is recorded as simulated on what it changed (the focus, the change set, a draft).
        const run = s.leadRuns.find((r) => r.id === e.attemptId);
        const simulated = run && this.adapterFor(run.provider) instanceof FakeAdapter ? (true as const) : undefined;
        // The steering block, the vision draft, the decisions, the studio block and any parse problem go through as found; the domain validates them.
        // The final text goes too: the run keeps it when the answer could not be used as sent.
        const next = M.completeLeadRun(s, e.attemptId, { reply: out.reply, proposals: out.proposals, steer: out.steer, vision: out.vision, coverage: out.coverage, questions: out.questions, decisions: out.decisions, studio: out.studio, changeOrder: out.changeOrder, problem: out.problem, answerText: e.finalText }, now, { usage: e.usage, actualModel: e.model, ...(simulated ? { simulated } : {}) });
        // The check of its text goes on the run (not on the message: the owner sees no score); the lead's next run is told what it broke.
        const prose = this.leadProse.get(e.attemptId);
        return prose ? withLeadProse(next, e.attemptId, prose) : next;
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
    await Promise.all(this.allRunners().map((a) => a.shutdown().catch(() => undefined)));
    // A screenshot or recording in progress is waited for, so Chrome and VHS end with it; its result is dropped with
    // the queue, so the version stays pending and the next service makes it again.
    await this.mediaChain;
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
