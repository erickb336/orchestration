// The delivery mode (off, a local branch, or GitHub pull requests) and the pull-request settings.

import { ControlError, type PrDeliveryConfig, type State, type Task } from "../types";
import { event } from "./core";
import { dropStaleUpdate, refreshAttention } from "./gate";
import { REVIEW_BOT_SLUG, trackedPrTasks, withNoCiPosture } from "./pr";
import { reviewCoverage } from "./review";

/** Off, the local branch (fast-forward), or GitHub pull requests. The two delivery modes are never on together. */
export type DeliveryMode = "off" | "local" | "pr";

// Neither may start with "-": a name is never read as an option by git or gh.
const BRANCH = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,99}$/;
const REMOTE = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,99}$/;

export function deliveryMode(s: State): DeliveryMode {
  if (s.project.prDelivery.enabled) return "pr";
  return s.project.autonomy.autoDeliver.enabled ? "local" : "off";
}

/** Done tasks whose work is on the integration branch but has not reached the delivery branch. */
export function undeliveredTasks(s: State): Task[] {
  // A fix that was pushed onto another task's pull request is delivered there, never on its own.
  return s.tasks.filter((t) => t.integration?.status === "integrated" && !t.integration.pr && !t.deliverInto && t.integration.delivered?.status !== "delivered");
}

/**
 * Choose how finished work is delivered. Sets `autoDeliver.enabled` and `prDelivery.enabled` together,
 * never both. "local" also queues work that was integrated while delivery was off, and forgets the
 * delivery baseline when the branch changes. "pr" asks for a read-only check of the repository; it
 * publishes nothing by itself.
 */
export function setDeliveryMode(state: State, a: { mode: DeliveryMode; branch?: string }, now: string): State {
  const s = structuredClone(state);
  const p = s.project;
  const before = deliveryMode(state);
  const prevBranch = p.autonomy.autoDeliver.branch;
  if (a.mode === "local") {
    const branch = (a.branch ?? prevBranch).trim();
    if (!BRANCH.test(branch)) throw new ControlError("Choose a valid branch name for delivery.");
    if (before === "local" && branch === prevBranch) return state;
    p.prDelivery.enabled = false;
    p.autonomy.autoDeliver = { enabled: true, branch };
    // The baseline (and the last result) describe the previous branch.
    if (branch !== prevBranch && p.delivery) p.delivery = { pending: p.delivery.pending };
    if (undeliveredTasks(s).length) p.delivery = { ...(p.delivery ?? {}), pending: true };
    event(s, now, "user", "config", `Delivery mode: local branch ${branch} (fast-forward only)`);
    return s;
  }
  if (before === a.mode) return state;
  p.autonomy.autoDeliver = { ...p.autonomy.autoDeliver, enabled: false };
  p.prDelivery.enabled = a.mode === "pr";
  if (a.mode === "pr") {
    p.github = { ...(p.github ?? { ok: false, requiredChecks: [], autoMergeBlockers: [], posture: [] }), recheck: true };
    event(s, now, "user", "config", `Delivery mode: GitHub pull requests (${p.prDelivery.remote}/${p.prDelivery.base}); checking the repository, read-only`);
  } else event(s, now, "user", "config", "Delivery mode: off; finished work stays on the integration branch");
  return s;
}

/** Change the pull-request settings. The delivery mode itself is switched with setDeliveryMode. */
export function setPrDelivery(state: State, patch: Partial<PrDeliveryConfig>, now: string): State {
  const cur = state.project.prDelivery;
  const next: PrDeliveryConfig = { ...cur, ...patch, enabled: cur.enabled, protectedPaths: [...(patch.protectedPaths ?? cur.protectedPaths)].map((x) => String(x).trim()).filter(Boolean) };
  const int = (n: number, lo: number, hi: number) => Number.isInteger(n) && n >= lo && n <= hi;
  if (!REMOTE.test(next.remote)) throw new ControlError("Choose a valid remote name.");
  if (!BRANCH.test(next.base)) throw new ControlError("Choose a valid base branch name.");
  if (next.merge !== "hold" && next.merge !== "auto") throw new ControlError("Choose hold or auto.");
  if (next.reviewer !== "other-provider" && next.reviewer !== "any-agent") throw new ControlError("Choose which reviewer counts as independent.");
  if (next.protectedPaths.length > 20 || next.protectedPaths.some((x) => x.length > 200)) throw new ControlError("At most 20 protected paths of at most 200 characters each.");
  if (!int(next.maxOpenPrs, 1, 20)) throw new ControlError("Open pull requests: between 1 and 20.");
  if (!int(next.maxAutoMergesPerDay, 0, 100)) throw new ControlError("Automatic merges per day: between 0 and 100.");
  for (const k of ["updateBeforeMerge", "autoRepair", "allowLocalWorkers", "noCi"] as const) if (typeof next[k] !== "boolean") throw new ControlError(`${k} must be true or false.`);
  // ORC-013 §7.5
  if (!int(next.rerunBudget, 0, 3)) throw new ControlError("Re-runs of a cancelled check: between 0 and 3 per check per head.");
  next.reviewBotApps = [...(patch.reviewBotApps ?? cur.reviewBotApps)].map((x) => String(x).trim()).filter(Boolean);
  if (next.reviewBotApps.length > 10) throw new ControlError("At most 10 review bots.");
  if (next.reviewBotApps.some((x) => !REVIEW_BOT_SLUG.test(x))) throw new ControlError("A review bot is named by its GitHub app slug: lowercase letters, digits and hyphens, at most 39 characters.");
  if (JSON.stringify(next) === JSON.stringify(cur)) return state;
  const s = structuredClone(state);
  s.project.prDelivery = next;
  if (next.remote !== cur.remote || next.base !== cur.base) {
    // Another remote or base: check it again, and fetch it before any writer starts from it.
    const gh = s.project.github;
    if (gh) {
      gh.recheck = true;
      delete gh.base;
      delete gh.fetchFailures;
    }
  }
  if (next.noCi !== cur.noCi && s.project.github) s.project.github.posture = withNoCiPosture(s.project.github.posture, next.noCi);
  event(
    s,
    now,
    "user",
    "config",
    `Pull-request settings: ${next.remote}/${next.base}, ${next.merge === "auto" ? `merge automatically after an independent review (${next.reviewer === "any-agent" ? "any agent" : "another provider than the writer"}) and passing required checks, at most ${next.maxAutoMergesPerDay} a day` : "you merge"}, at most ${next.maxOpenPrs} open${next.noCi !== cur.noCi ? (next.noCi ? "; you declared this repository has no CI (your own Merge works with no checks; automatic merging still needs a required check)" : "; the no-CI declaration was withdrawn") : ""}${next.rerunBudget !== cur.rerunBudget ? `; a check GitHub cancelled is re-run ${next.rerunBudget === 0 ? "never" : `${next.rerunBudget} time${next.rerunBudget === 1 ? "" : "s"} per head`}` : ""}`,
  );
  // Another rule for who may review: a dedicated review that could not start is tried again under it.
  if (next.reviewer !== cur.reviewer) {
    for (const t of s.tasks) {
      if (!t.reviewTarget || t.lifecycle === "done" || t.lifecycle === "cancelled") continue;
      for (const st of t.steps) {
        if (st.state !== "blocked") continue;
        st.state = "pending";
        delete st.blockedReason;
      }
    }
  }
  // The project's choice applies to the pull requests that follow it; one the user set by hand keeps its own.
  for (const t of trackedPrTasks(s)) {
    const pr = t.integration!.pr!;
    if (pr.policySource === "project" && pr.policy !== next.merge) {
      pr.policy = next.merge;
      if (next.merge === "auto") delete pr.mergeRequested;
    }
    dropStaleUpdate(s, t, now);
    pr.review = reviewCoverage(s, t);
    refreshAttention(s, t, now);
  }
  return s;
}

/** Automatic merging continues: the user has looked at the failing base branch. Clears the pause and the day's count of failures. */
export function resumeAutoMerge(state: State, now: string): State {
  const gh = state.project.github;
  if (!gh?.autoMergePaused && !gh?.mainBreaks?.length) return state;
  const s = structuredClone(state);
  delete s.project.github!.autoMergePaused;
  delete s.project.github!.mainBreaks;
  event(s, now, "user", "config", "Automatic merging resumed by you");
  return s;
}

/** Run the read-only repository check now. */
export function recheckGitHub(state: State, now: string): State {
  const s = structuredClone(state);
  const gh = s.project.github ?? { ok: false, requiredChecks: [], autoMergeBlockers: [], posture: [] };
  gh.recheck = true;
  if (gh.problem) delete gh.problem.retryAt;
  s.project.github = gh;
  event(s, now, "user", "config", "Checking the GitHub repository again (read-only)");
  return s;
}
