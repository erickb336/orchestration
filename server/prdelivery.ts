// The driver of pull-request delivery. It runs inside the scheduler's cycle and follows
// intent → act → observe:
//
//   1. results of finished operations are applied, lease-checked and stale-guarded;
//   2. at most one network operation is in flight per project (single flight);
//   3. the pure planner (D.nextPrOp) chooses the next operation;
//   4. a write starts only after its intent is committed in a lease-checked transaction that re-checks
//      the pause, the hold and the gate;
//   5. the operation runs asynchronously; its result is queued for the next tick.
//
// After a restart or a lost lease nothing is in flight here, so the planner sees a recorded intent as
// interrupted and reconciles with GitHub before anything is tried again. Results from before a lost
// lease are dropped by a generation counter.
//
// Only this driver runs gh and git push. It never forces a push and never bypasses GitHub's rules.
// A re-run of a GitHub-cancelled job is a write like any other: intent (budget spent) → act
// → observe; an interrupted one is observed, never sent again.

import * as D from "../src/domain/delivery";
import type { State } from "../src/domain/types";
import { GhError, type GitHubHost, type RepoRef } from "./github";
import { redact } from "./redact";
import type { Store } from "./store";
import { ForeignCommitsError, type WorkspaceManager } from "./workspaces";

interface PrDriverOptions {
  log?: (msg: string) => void;
  /** Claude workers run with shell access (shown as a posture warning). */
  workerShell?: boolean;
}

type Lease = { name: string; holder: string; nowMs: number };

/** The push URL no longer names the repository that was checked. */
class RemoteChangedError extends Error {}

function opError(e: unknown): D.OpError {
  if (e instanceof RemoteChangedError) return { code: "remote", message: clean(e.message) };
  if (e instanceof GhError) return { code: e.code, message: clean(e.message), ...(e.retryAt ? { retryAt: e.retryAt } : {}) };
  if (e instanceof ForeignCommitsError) return { code: "foreign-commits", message: clean(e.message) };
  const message = clean(e instanceof Error ? e.message : String(e));
  // git's own network failures (fetch, ls-remote, push). git signs in by itself (an SSH key, a
  // credential helper): when that fails, `gh auth login` is not the fix, and the message says so.
  if (/couldn't find remote ref|does not appear to be a git repository|no such remote|repository not found/i.test(message)) return { code: "remote", message };
  if (/authentication failed|could not read username|permission denied|publickey|HTTP 40[13]|returned error: 40[13]/i.test(message))
    return { code: "git", message: `git could not sign in to the remote: ${message.slice(0, 160)}. This is git's own sign-in for this remote (an SSH key or a credential helper), not gh's.` };
  if (/timed out|was stopped/i.test(message)) return { code: "timeout", message };
  if (/could not resolve host|unable to access|connection|network/i.test(message)) return { code: "network", message };
  return { code: "unknown", message };
}

/** Redacted, last two lines, at most 300 characters. Nothing from a child process is kept raw. */
function clean(text: string): string {
  return redact(text).trim().split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 300);
}

export class PrDriver {
  private readonly store: Store;
  private readonly host: GitHubHost | undefined;
  private readonly workspaces: WorkspaceManager | undefined;
  private readonly log: (msg: string) => void;
  private readonly ctx: D.ReportContext;
  private gen = 0;
  /** The time of the latest tick: the driver's clock. A read is never stamped later than it happened. */
  private clockMs = 0;
  private inflight: Promise<void> | undefined;
  private results: { gen: number; result: D.PrOpResult }[] = [];

  /**
   * `workspaces` is absent with the fake runtime: no git runs, and `host` is then the simulated one.
   * `host` may be absent only in a real service started without a GitHub connection; the repository
   * check then reports that instead of doing anything.
   */
  constructor(store: Store, host: GitHubHost | undefined, workspaces: WorkspaceManager | undefined, opts: PrDriverOptions = {}) {
    this.store = store;
    this.host = host;
    this.workspaces = workspaces;
    this.log = opts.log ?? (() => {});
    this.ctx = { workerShell: opts.workerShell };
  }

  /** True while a network operation is running. */
  get busy(): boolean {
    return !!this.inflight;
  }

  /** Resolves when the operation in flight (if any) has settled. For tests and orderly shutdown. */
  idle(): Promise<void> {
    return this.inflight ?? Promise.resolve();
  }

  /** One step of the driver. Throws LeaseLostError when the scheduler no longer holds its lease. */
  tick(nowMs: number, lease: Lease) {
    const now = new Date(nowMs).toISOString();
    this.clockMs = nowMs;
    // 1. Apply finished operations. A result from before abortAll() belongs to an earlier generation.
    for (const r of this.results.splice(0)) {
      if (r.gen !== this.gen) continue;
      this.store.update((s) => D.reportPrOp(s, r.result, now, this.ctx), now, lease);
    }
    // 1b. Reviews and repairs of tracked pull requests: evidence recorded, the one dedicated review or
    //     bounded fix task created. Pure state; nothing is contacted. Changes nothing when nothing changed.
    this.store.update((s) => (this.workspaces && s.project.sample ? s : D.advanceDelivery(s, now)), now, lease);
    // 2. Single flight.
    if (this.inflight) return;
    // 3. Samples never contact GitHub (with the fake runtime nothing is contacted anyway).
    const { state } = this.store.read();
    if (this.workspaces && state.project.sample) return;
    // 4. Plan.
    const op = D.nextPrOp(state, nowMs);
    if (!op) return;
    // 5. A write starts only after its intent is committed.
    if (D.opMutates(op)) {
      let started = false;
      this.store.update(
        (s) => {
          const r = D.beginPrOp(s, op, now);
          started = r.started;
          return r.state;
        },
        now,
        lease,
      );
      if (!started) return;
    }
    // 6. Act, asynchronously.
    const gen = this.gen;
    const after = this.store.read().state;
    const p: Promise<void> = this.run(op, after)
      .catch((e): D.PrOpResult => ({ op, error: opError(e) }))
      .then((result) => {
        if (gen !== this.gen) return;
        if (result.error) this.log(`GitHub ${op.kind} failed: ${result.error.message}`);
        this.results.push({ gen, result });
        if (this.inflight === p) this.inflight = undefined;
      });
    this.inflight = p;
  }

  /** Stop everything in flight and forget its results: the lease was lost or the service is stopping. */
  abortAll() {
    this.gen += 1;
    this.results = [];
    this.inflight = undefined;
    try {
      this.host?.abortAll();
      this.workspaces?.abortNetwork();
    } catch {
      /* nothing in flight */
    }
  }

  /** The repository that was checked: the only one anything is read from or written to. */
  private repoOf(state: State): RepoRef {
    const slug = state.project.github?.repo ?? "";
    const [owner, name] = slug.split("/");
    if (!owner || !name) throw new GhError("unknown", "the repository has not been checked yet");
    return { owner, name };
  }

  /**
   * The repository a pull request lives in. The app acts on a pull request only there: when the
   * remote now names another repository, the same number is someone else's pull request.
   */
  private repoFor(state: State, slug: string | undefined): RepoRef {
    const checked = state.project.github?.repo ?? "";
    if (!slug || slug !== checked) throw new GhError("rejected", `this pull request is in ${slug || "an unknown repository"}, but the remote now points at ${checked || "an unchecked repository"}; nothing was sent`);
    return this.repoOf(state);
  }

  /** The push URL must still name the repository that was checked: nothing is pushed anywhere else. */
  private assertSameRemote(state: State, host: GitHubHost, repoSlug: string) {
    if (!this.workspaces) return;
    const url = this.workspaces.remoteUrl(state.project.repoPath, state.project.prDelivery.remote);
    const r = host.parseRemote(url);
    if (!r || `${r.owner}/${r.name}` !== repoSlug) throw new RemoteChangedError(`The remote ${state.project.prDelivery.remote} no longer points at ${repoSlug}; nothing was fetched or pushed.`);
  }

  /**
   * Read GitHub and stamp the observation with the time of the read, not the time its result is
   * applied (a later tick): "observed at most 15 s ago" then means what it says. The stamp is taken
   * before the request is sent, so it is never later than what GitHub answered.
   */
  private async observe(host: GitHubHost, a: Parameters<GitHubHost["observe"]>[0]): Promise<D.Observations> {
    const at = new Date(this.clockMs).toISOString();
    return { ...(await host.observe(a)), at };
  }

  private async run(op: D.PrOp, state: State): Promise<D.PrOpResult> {
    const host = this.host;
    const p = state.project;
    const cfg = p.prDelivery;
    if (!host) {
      const missing: D.PreflightReport = {
        ok: false,
        problem: { code: "gh-missing", message: "This service was started without a GitHub connection, so pull requests cannot be opened." },
        requiredChecks: [],
        autoMergeBlockers: [],
        posture: [],
      };
      return op.kind === "preflight" ? { op, preflight: missing } : { op, error: { code: "unknown", message: missing.problem!.message } };
    }
    switch (op.kind) {
      case "preflight": {
        let remoteUrl = "";
        if (this.workspaces) {
          const check = this.workspaces.check(p.repoPath);
          if (!check.ok) return { op, preflight: { ok: false, problem: { code: "remote", message: check.reason ?? "The repository is not usable." }, requiredChecks: [], autoMergeBlockers: [], posture: [] } };
          try {
            remoteUrl = this.workspaces.remoteUrl(p.repoPath, cfg.remote);
          } catch {
            return { op, preflight: { ok: false, problem: { code: "remote", message: `The repository has no remote named ${cfg.remote}. Add it, or choose another remote in Settings.` }, requiredChecks: [], autoMergeBlockers: [], posture: [] } };
          }
        }
        const report = await host.preflight({ remoteUrl, base: cfg.base });
        if (!report.ok || !this.workspaces) return { op, preflight: report };
        // gh answering is not enough: git must reach the remote by its own transport, and the base
        // branch must exist there, or every fetch after a passing check would fail. Read-only.
        try {
          const tip = await this.workspaces.lsRemote({ repoPath: p.repoPath, remote: cfg.remote, branch: cfg.base });
          if (!tip) return { op, preflight: { ...report, ok: false, problem: { code: "remote", message: `The branch ${cfg.base} does not exist on ${cfg.remote} (${report.repo ?? "the repository"}). Choose the base branch in Settings → Delivery.` } } };
        } catch (e) {
          const err = opError(e);
          return { op, preflight: { ...report, ok: false, problem: { code: err.code === "network" || err.code === "timeout" ? "network" : "remote", message: err.code === "git" ? err.message : `git could not read ${cfg.remote}: ${err.message}` } } };
        }
        return { op, preflight: report };
      }
      case "fetch": {
        if (!this.workspaces) return { op, base: { sha: "sim-base" } };
        this.assertSameRemote(state, host, p.github?.repo ?? "");
        const base = await this.workspaces.fetchBase({ repoPath: p.repoPath, projectId: p.id, remote: cfg.remote, base: cfg.base });
        // Local delivery may have left Orchestration's commits on the user's branch that the remote lacks.
        const branch = p.autonomy.autoDeliver.branch;
        const count = this.workspaces.unpushedOrchestration({ repoPath: p.repoPath, projectId: p.id, branch });
        return { op, base: { ...base, ...(count !== undefined ? { unpushed: { branch, count } } : {}) } };
      }
      case "observe": {
        // One repository per read: the one that was checked. Pull requests opened elsewhere are not in it.
        if (op.repo && op.repo !== p.github?.repo) return { op, error: { code: "remote", message: `The remote no longer points at ${op.repo}; nothing was read.` } };
        return { op, observed: await this.observe(host, { repo: this.repoOf(state), prs: op.prs.map((x) => x.number), commits: host.simulated ? op.commits : op.commits.filter((c) => /^[0-9a-f]{40,64}$/.test(c)) }) };
      }
      case "update": {
        const t = state.tasks.find((x) => x.id === op.taskId)!;
        const pr = t.integration!.pr!;
        if (!this.workspaces) return { op, error: { code: "unknown", message: "There is no repository to update the pull request in." } };
        // Local and synchronous: a two-parent merge of the base into the head, made by Orchestration.
        const r = this.workspaces.baseUpdate({ repoPath: p.repoPath, projectId: p.id, taskId: t.id, n: pr.n, base: pr.base, headSha: op.headSha, baseSha: op.baseSha });
        return r.status === "updated" ? { op, updated: { sha: r.sha, baseSha: op.baseSha } } : { op, conflict: { files: r.files } };
      }
      case "push": {
        const t = state.tasks.find((x) => x.id === op.taskId)!;
        const pr = t.integration!.pr!;
        const pending = pr.pendingHead;
        if (!pending) return { op, error: { code: "unknown", message: "There is no newer head to push." } };
        const repo = this.repoFor(state, pr.repo);
        if (this.workspaces) {
          // The same guards as the first push: the push URL, the authorship of every commit, what the
          // remote branch holds. A fast-forward or nothing.
          this.assertSameRemote(state, host, pr.repo);
          const pushed = await this.workspaces.pushHead({ repoPath: p.repoPath, projectId: p.id, remote: pr.remote, branch: pr.branch, sha: pending.sha });
          if (pushed === "diverged") return { op, error: { code: "diverged", message: `${pr.branch} on ${pr.remote} holds commits the app did not push; nothing was pushed` } };
        } else host.pushed?.({ repo, number: pr.number!, headSha: pending.sha });
        return { op, pushed: { sha: pending.sha } };
      }
      case "publish": {
        const t = state.tasks.find((x) => x.id === op.taskId)!;
        const pr = t.integration!.pr!;
        const repo = this.repoFor(state, pr.repo);
        if (this.workspaces) {
          // (1) the push URL, (2) what the remote branch holds, (3) the push. Never forced.
          this.assertSameRemote(state, host, pr.repo);
          const pushed = await this.workspaces.pushHead({ repoPath: p.repoPath, projectId: p.id, remote: pr.remote, branch: pr.branch, sha: pr.headSha });
          if (pushed === "diverged") return { op, error: { code: "diverged", message: `${pr.branch} on ${pr.remote} holds commits the app did not push; nothing was pushed` } };
        }
        // (4) adopt the app's own pull request if an earlier, interrupted attempt already opened it; (5) else open it.
        const marker = D.prMarker(p.id, t.id, pr.n);
        const found = await host.findPr({ repo, head: pr.branch, marker });
        if (found) return { op, published: found };
        const body = redact(D.prBody(state, t)).slice(0, 6000);
        return { op, published: await host.createPr({ repo, base: pr.base, head: pr.branch, title: redact(D.prTitle(t)), body: body.includes(marker) ? body : `${body.slice(0, 5800)}\n\n${marker}`, headSha: pr.headSha }) };
      }
      case "merge": {
        const t = state.tasks.find((x) => x.id === op.taskId)!;
        const pr = t.integration!.pr!;
        const repo = this.repoFor(state, pr.repo);
        let actError: D.OpError | undefined;
        try {
          await host.merge({ repo, number: pr.number!, headSha: op.headSha, subject: redact(D.mergeSubject(t)), body: redact(D.mergeBody(state, t)) });
        } catch (e) {
          actError = opError(e);
        }
        // The exit code records nothing: what GitHub reports afterwards does.
        try {
          return { op, actError, observed: await this.observe(host, { repo, prs: [pr.number!], commits: [] }) };
        } catch (e) {
          return { op, actError, error: opError(e) };
        }
      }
      case "close": {
        const t = state.tasks.find((x) => x.id === op.taskId)!;
        const pr = t.integration!.pr!;
        const repo = this.repoFor(state, pr.repo);
        // An interrupted publish may have opened it without the number being recorded: find the app's own.
        const found = pr.number === undefined ? await host.findPr({ repo, head: pr.branch, marker: D.prMarker(p.id, t.id, pr.n) }) : undefined;
        const number = pr.number ?? found?.number;
        if (number === undefined) return { op, nothingOpen: true };
        let actError: D.OpError | undefined;
        try {
          await host.close({ repo, number, comment: "Closed from Orchestrator." });
        } catch (e) {
          actError = opError(e);
        }
        try {
          return { op, actError, ...(found ? { adopted: found } : {}), observed: await this.observe(host, { repo, prs: [number], commits: [] }) };
        } catch (e) {
          return { op, actError, error: opError(e) };
        }
      }
      case "rerun": {
        // The intent (and its budget) is already recorded. Each job id was seen on the
        // app's own pull request at its current head and is checked as an integer before use.
        const t = state.tasks.find((x) => x.id === op.taskId)!;
        const pr = t.integration!.pr!;
        const repo = this.repoFor(state, pr.repo);
        let actError: D.OpError | undefined;
        try {
          for (const j of op.jobs) {
            if (!Number.isInteger(j.jobId) || j.jobId <= 0) throw new GhError("rejected", `refusing to re-run ${j.check}: no valid job id`);
            await host.rerunJob({ repo, jobId: j.jobId });
          }
        } catch (e) {
          actError = opError(e);
        }
        // The exit code records nothing: what GitHub reports afterwards does.
        try {
          return { op, actError, observed: await this.observe(host, { repo, prs: [pr.number!], commits: [] }) };
        } catch (e) {
          return { op, actError, error: opError(e) };
        }
      }
      case "comment": {
        const t = state.tasks.find((x) => x.id === op.taskId)!;
        const landed = t.integration!.landed!;
        const note = landed.notes.find((n) => n.id === op.noteId)!;
        const repo = this.repoFor(state, D.landedRepo(t));
        const marker = D.noteMarker(p.id, note.id);
        // The marker makes the post idempotent: an earlier, interrupted attempt is found, not repeated.
        const found = await host.findComment({ repo, number: landed.pr!.number, marker });
        if (found) return { op, comment: found };
        return { op, comment: await host.comment({ repo, number: landed.pr!.number, body: `${redact(note.text)}\n\n${marker}` }) };
      }
    }
  }

}
