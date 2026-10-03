// Labels for the UI: a pull request's state in a few words, and what the service is doing with it.

import { type PrDelivery, type State, type Task } from "../types";
import { awaitingRerun, rerunsUsed } from "./ciTriage";
import { sha12 } from "./core";
import { prGate, prReady, queueAhead, userGate } from "./gate";
import { openSlotsFull, PR_LIMITS, prName } from "./pr";
import { openRepair } from "./repair";

export interface PrLabel {
  text: string;
  tone: "plain" | "strong" | "done" | "danger";
  /** A demo pull request. The chip shows one small "simulated" mark beside the text; the text itself carries none. */
  simulated?: true;
}

/** One short, truthful label for a task's delivery: what it is doing, or exactly what it waits for. */
export function prLabel(s: State, t: Task, nowMs: number): PrLabel | undefined {
  const i = t.integration;
  const pr = i?.pr;
  if (!i || !pr) return undefined;
  const sim: { simulated?: true } = pr.simulated ? { simulated: true } : {};
  // While shaping, delivery says what it waits for, never "queued" or "preparing".
  const shaping = s.project.stage === "shaping" && !s.project.hold;
  const WAITS = "waits until you start the factory";
  if (i.status !== "integrated") return { text: shaping ? `pull request ${pr.n + 1} ${WAITS}` : `preparing pull request ${pr.n + 1}`, tone: "plain", ...sim };
  const name = pr.number ? `PR #${pr.number}` : "PR";
  const plain = (what: string): PrLabel => ({ text: `${name} ${what}`, tone: "plain", ...sim });
  // Finished work that is in main has "landed"; "new" until you mark it as seen under Results.
  if (pr.phase === "merged") return { text: i.landed?.status === "unreviewed" ? "landed · new" : "landed", tone: "done", ...sim };
  if (pr.phase === "closed") return { text: `${name} closed`, tone: "danger", ...sim };
  if (pr.op?.kind === "merge") return { text: `${name} merging`, tone: "strong", ...sim };
  // A cancelled check being re-run, and a review bot's verdict, are named as such.
  const rerunning = pr.op?.kind === "rerun" ? rerunsUsed(pr).filter((u) => u.opId === pr.op!.id) : pr.observed?.checksFor === pr.headSha ? rerunsUsed(pr).filter((u) => pr.observed!.checks.some((c) => c.name === u.check && awaitingRerun(pr, c, nowMs))) : [];
  if (rerunning.length) return plain(`re-running ${[...new Set(rerunning.map((u) => u.check))].join(", ")}`);
  if (pr.attention) {
    const fixing = openRepair(s, pr);
    if (fixing || pr.pendingHead?.kind === "repair") return plain("being fixed");
    if (pr.attention.code === "bot-check") return { text: `${name} bot check · needs you`, tone: "danger", ...sim };
    return { text: `${name} needs you`, tone: "danger", ...sim };
  }
  if (pr.userHold) return plain("kept for you");
  if (pr.phase === "built") return plain(!s.project.prDelivery.enabled ? "not opened: delivery is off" : s.project.hold ? "not opened: paused" : shaping ? `not opened: ${WAITS}` : openSlotsFull(s) ? `not opened: ${openSlotsFull(s)}` : "preparing");
  if (prReady(s, t, nowMs)) return { text: `${name} ready to merge`, tone: "strong", ...sim };
  const byUser = userGate(pr);
  const waits = prGate(s, t, nowMs, { byUser }).items.find((x) => !x.ok && x.id !== "policy");
  if (!waits) return pr.policy === "auto" && !byUser ? { text: `${name} merging next`, tone: "strong", ...sim } : pr.mergeRequested ? { text: `${name} merge requested`, tone: "strong", ...sim } : plain("open");
  switch (waits.id) {
    case "not-paused":
      return plain(pr.closeRequested ? "closing" : shaping && !pr.userHold ? WAITS : "paused");
    case "github":
      return plain("waiting for GitHub");
    case "ours":
      return plain("not seen on GitHub yet");
    case "head":
      return plain(pr.pendingHead?.kind === "update" ? "updating" : pr.pendingHead ? "fix being pushed" : "not seen on GitHub yet");
    case "checks":
      return plain("checks");
    case "mergeable":
      return plain(pr.observed?.mergeStateStatus === "BEHIND" ? "behind the base" : "waiting on GitHub");
    case "review":
      return plain("review");
    case "auto":
      return plain("auto-merge paused");
    case "up-to-date": {
      const ahead = queueAhead(s, t);
      return plain(ahead ? `queued behind #${ahead.integration!.pr!.number}` : "updating");
    }
    default:
      return plain(pr.mergeRequested ? "merge requested" : "waiting");
  }
}

/** What is in flight or wanted for this pull request, in plain words. Undefined when nothing is. */
export function prIntentLine(pr: PrDelivery): string | undefined {
  const n = prName(pr);
  if (pr.phase === "merged" || pr.phase === "closed") return undefined;
  if (pr.op?.kind === "merge") return `Merging ${n} (already sent to GitHub; cannot be interrupted). It shows as merged once GitHub reports it.`;
  if (pr.op?.kind === "close") return `Closing ${n} (already sent to GitHub). It shows as closed once GitHub reports it.`;
  if (pr.op?.kind === "push") return `Pushing ${pr.pendingHead ? sha12(pr.pendingHead.sha) : "a newer head"} onto ${n} as a fast-forward.`;
  if (pr.op?.kind === "rerun") {
    const mine = rerunsUsed(pr).filter((u) => u.opId === pr.op!.id);
    return `Asking GitHub to run ${mine.map((u) => u.check).join(", ") || "the cancelled job"} again on ${n} (GitHub had cancelled it). What GitHub reports afterwards decides; nothing is sent twice.`;
  }
  if (pr.op) return `Pushing ${pr.branch} and opening the pull request.`;
  if (pr.closeRequested) return `You asked to close ${n}; not sent yet.`;
  if (pr.mergeRequested) {
    const refused = pr.counters.mergeAttempts;
    return `You asked to merge ${sha12(pr.mergeRequested.headSha)}; it is sent once GitHub's checks and rules pass.${refused ? ` GitHub refused ${refused} of ${PR_LIMITS.mergeAttempts} attempts${pr.message ? ` (${pr.message})` : ""}; it is tried once more.` : pr.message ? ` The last attempt did not go through (${pr.message}); it is tried again.` : ""}`;
  }
  if (pr.pendingHead) return pr.pendingHead.kind === "update" ? `A newer head (${sha12(pr.pendingHead.sha)}), brought up to date with ${pr.base}, waits to be pushed.` : `A fix (${sha12(pr.pendingHead.sha)}) waits to be pushed onto ${n}.`;
  return undefined;
}
