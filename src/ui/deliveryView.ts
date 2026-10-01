// The words of a delivery, apart from React: the one verdict line of a pull request
// ("Pull request #1000 · Code ✓ Security ✓ Checks ✓ · 6 files, +167 −12"), the landed line, the label of the
// checklist disclosure, and the confirmations the delivery actions ask. Pure derivations over domain state.

import * as D from "../domain/delivery";
import type { Landed, PrDelivery, RoleId, State, Task } from "../domain/types";
import type { ConfirmOptions } from "./kit/confirmCore";

export type VerdictState = "ok" | "fail" | "pending" | "none";
export type VerdictLabel = "Code" | "Security" | "UX" | "Checks";

export interface VerdictPart {
  label: VerdictLabel;
  state: VerdictState;
  /** Why, in one sentence: what the review found or what the checks say. */
  detail: string;
}

/** The mark after a label: ✓ passed or clean, ✗ failed or open findings, … still running, – not run. */
export const VERDICT_MARK: Record<VerdictState, string> = { ok: "✓", fail: "✗", pending: "…", none: "–" };
/** The mark's meaning, for the title and screen readers. */
export const VERDICT_WORD: Record<VerdictState, string> = { ok: "clean", fail: "not clean", pending: "still running", none: "not run" };

const ROLE_PART: Partial<Record<RoleId, VerdictLabel>> = { code_reviewer: "Code", security_reviewer: "Security", ux_reviewer: "UX" };
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** "Code ✓ Security ✓ Checks ✓" */
export function verdictText(parts: VerdictPart[]): string {
  return parts.map((p) => `${p.label} ${VERDICT_MARK[p.state]}`).join(" ");
}

/**
 * The agent reviews of a task's finished review steps, one part per role (the latest round of a role wins):
 * clean when no finding is still open.
 */
export function reviewParts(state: State, task: Task): VerdictPart[] {
  const byLabel = new Map<VerdictLabel, VerdictPart>();
  for (const r of D.landedReviews(state, task)) {
    const label = ROLE_PART[r.role];
    if (!label) continue;
    byLabel.set(label, { label, state: r.openFindings ? "fail" : "ok", detail: r.openFindings ? `${r.stepId}: ${plural(r.openFindings, "open finding")}` : `${r.stepId}: no open findings` });
  }
  return [...byLabel.values()];
}

/** "Pull request #1000", or "Pull request" before GitHub gave it a number. */
export function prName(pr: Pick<PrDelivery, "number">): string {
  return pr.number ? `Pull request #${pr.number}` : "Pull request";
}

/** "6 files, +167 −12"; a simulated run that touched nothing says so. */
export function changesText(pr: Pick<PrDelivery, "changed" | "simulated">): string {
  if (pr.simulated && pr.changed.files === 0) return "no files changed (simulated)";
  return `${plural(pr.changed.files, "file")}, +${pr.changed.additions} −${pr.changed.deletions}`;
}

export type PrStatus = "ready" | "waiting" | "blocked" | "merged" | "closed" | "preparing";

export interface PrVerdict {
  name: string;
  parts: VerdictPart[];
  changes: string;
  status: PrStatus;
  /** The merge checklist the status comes from (empty once merged or closed). */
  gate: D.GateItem[];
}

const gateState = (s: D.GateItem["state"] | undefined): VerdictState => (s === "ok" ? "ok" : s === "blocked" ? "fail" : s === "waiting" ? "pending" : "none");

/**
 * One truthful line for a task's pull request: the code review from the merge checklist (the same evidence the
 * service uses), the security and UX reviews of the change's own task, and the checks (GitHub's required ones
 * and the service's own), plus the size of the change.
 */
export function prVerdict(state: State, task: Task, nowMs: number): PrVerdict | undefined {
  const integration = task.integration;
  const pr = integration?.pr;
  if (!integration || !pr) return undefined;
  const name = prName(pr);
  const changes = changesText(pr);
  if (integration.status !== "integrated") return { name, parts: [], changes, status: "preparing", gate: [] };
  const live = pr.phase === "built" || pr.phase === "open";
  const byUser = pr.policy !== "auto" || pr.mergeRequested?.headSha === pr.headSha;
  const gate = live ? D.prGate(state, task, nowMs, { byUser }) : undefined;
  const items = gate?.items ?? [];
  const item = (id: D.GateItem["id"]) => items.find((i) => i.id === id);
  // The task whose change the pull request holds now: a fix pushed onto it reviews its own change.
  const changeTask = state.tasks.find((t) => t.id === pr.changeTaskId) ?? task;
  const reviews = reviewParts(state, changeTask);
  const parts: VerdictPart[] = [];
  const review = item("review");
  const code = reviews.find((p) => p.label === "Code");
  if (review) parts.push({ label: "Code", state: gateState(review.state), detail: review.detail });
  else if (code) parts.push(code);
  for (const label of ["Security", "UX"] as const) {
    const p = reviews.find((x) => x.label === label);
    if (p) parts.push(p);
  }
  const checks = [item("checks"), item("service-checks")].filter((i): i is D.GateItem => !!i);
  if (checks.length) {
    const state = checks.some((c) => c.state === "blocked") ? "fail" : checks.some((c) => c.state === "waiting") ? "pending" : "ok";
    parts.push({ label: "Checks", state, detail: checks.map((c) => c.detail).join(" ") });
  } else if (pr.phase === "merged" && integration.landed?.checks?.length) {
    const ok = integration.landed.checks.every((c) => c.conclusion === "SUCCESS");
    parts.push({ label: "Checks", state: ok ? "ok" : "fail", detail: integration.landed.checks.map((c) => `${c.name}: ${(c.conclusion ?? c.status).toLowerCase()}`).join(", ") });
  }
  // A held pull request that only waits for your Merge is ready for you, whatever the checklist's own word for it.
  const status: PrStatus = pr.phase === "merged" ? "merged" : pr.phase === "closed" ? "closed" : live && D.prReady(state, task, nowMs) ? "ready" : (gate?.status ?? "waiting");
  return { name, parts, changes, status, gate: items };
}

/** The label of the checklist disclosure, by what the checklist says. */
export function gateLabel(status: PrStatus): string {
  switch (status) {
    case "ready":
      return "Why it's ready";
    case "blocked":
      return "What stops it";
    case "merged":
      return "How it merged";
    case "closed":
      return "What happened";
    case "preparing":
      return "What is being prepared";
    default:
      return "What it waits for";
  }
}

/** "Landed 3d ago by Orchestrator, pull request #991 into simulated/repository main": the first words of a landed item. */
export function landedWhere(landed: Landed): string {
  return landed.via === "pr" ? `pull request${landed.pr ? ` #${landed.pr.number}` : ""} into ${landed.target}` : `local delivery to ${landed.target}`;
}

export function landedWho(landed: Landed): string {
  return landed.by === "app" ? "Orchestrator" : (landed.mergedBy ?? "a person");
}

/** The agent reviews of a landed task and its checks at merge, as verdict parts ("Code ✓ Security ✓ Checks ✓"). */
export function landedVerdict(state: State, task: Task): VerdictPart[] {
  const landed = task.integration?.landed;
  const parts = reviewParts(state, task);
  if (landed?.checks?.length) {
    const ok = landed.checks.every((c) => c.conclusion === "SUCCESS");
    parts.push({ label: "Checks", state: ok ? "ok" : "fail", detail: landed.checks.map((c) => `${c.name}: ${(c.conclusion ?? c.status).toLowerCase()}`).join(", ") });
  }
  return parts;
}

/** What a landed item's flag means, in words. */
export const LANDED_FLAG_LABEL: Record<Landed["flags"][number], string> = {
  "main-check-failed": "check failed after landing",
  "merged-without-clean-gate": "merged without a clean gate",
  "findings-cleared-by-user": "findings cleared by you",
  "protected-paths": "touches protected files",
  "checks-accepted-failing": "failing checks accepted by you",
  "checks-not-run": "no service checks ran",
  "findings-accepted": "findings accepted as is",
};

/** A landed item is "New" until you mark it as seen; the words "review" and "reviewed" belong to the agents. */
export const LANDED_STATUS_LABEL: Record<Landed["status"], string> = { unreviewed: "New", reviewed: "Seen", "sent-back": "Sent back" };

// ---------- the confirmations ----------

const sha12 = (sha: string) => sha.slice(0, 12);

export const DELIVERY_CONFIRM = {
  merge: (pr: Pick<PrDelivery, "number" | "headSha" | "base">): ConfirmOptions => ({
    title: `Merge ${prName(pr).toLowerCase()} into ${pr.base}?`,
    text: `Exactly commit ${sha12(pr.headSha)} is merged, and only once GitHub's required checks and rules pass for it. Nothing else is pushed.`,
    primaryLabel: "Merge",
  }),
  mergeAutomatically: (pr: Pick<PrDelivery, "number">): ConfirmOptions => ({
    title: `Let ${prName(pr).toLowerCase()} merge by itself?`,
    text: "It merges only when an independent review is clean for exactly this change, every required check passed on its head, GitHub reports it mergeable, and it touches no protected file. The app never bypasses branch rules.",
    primaryLabel: "Merge automatically",
  }),
  fixPr: (cause: string, headSha: string, used: number, limit: number): ConfirmOptions => ({
    title: `Create a fix task for ${cause}?`,
    text: `An agent works on top of ${sha12(headSha)}; its result is pushed onto this pull request and reviewed again. ${used} of ${limit} fix tasks used.`,
    primaryLabel: "Create fix task",
  }),
  allowWorkflowChange: (): ConfirmOptions => ({
    title: "Allow this delivery to change CI workflow files?",
    text: "The checks that gate this pull request run from those files. The permission is for this one delivery.",
    primaryLabel: "Allow",
  }),
  closePr: (pr: Pick<PrDelivery, "number" | "phase">): ConfirmOptions =>
    pr.phase === "open"
      ? { title: `Close ${prName(pr).toLowerCase()} without merging?`, text: "The branch is kept. A closed pull request is never reopened; delivering again opens a new one.", primaryLabel: "Close pull request", danger: true }
      : { title: "Abandon this delivery?", text: "The prepared branch is kept, but nothing is pushed or opened for it.", primaryLabel: "Abandon", danger: true },
  resumeAutoMerge: (reason?: string): ConfirmOptions => ({
    title: "Resume automatic merging?",
    text: [
      `It was paused because ${reason ?? "the check on the base branch failed after a merge the app made"}.`,
      "Once you resume, the app merges pull requests by itself again, under your GitHub account, including the ones already open and waiting. Nothing was reverted: if the base branch is still failing, more work lands on top of it.",
      "The count of failures that keeps it paused starts over.",
    ].join("\n"),
    primaryLabel: "Resume",
  }),
};
