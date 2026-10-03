// Design and reality (ORC-029 pass 5, screen 5) in words: each blueprint item's factory status, its tasks, its rule
// results, its evidence, and one line on why it stands there. The facts come from src/domain/studio/itemStatus.ts,
// ruleResults.ts and evidence.ts; this module only words them and names the files the app shows.

import type { CaptureDevice, EvidenceFile, ItemEvidence, NoEvidence, NoRunYet } from "../../domain/studio/evidence";
import type { CitingTask, ItemFactoryStatus, ItemFactoryView, NotVerified, UxDifference } from "../../domain/studio/itemStatus";
import type { RuleResult, RuleStatus } from "../../domain/studio/ruleResults";
import { fmtTime } from "../common";
import type { Tone } from "../kit";

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const joinAnd = (xs: readonly string[]) => (xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
/** A commit as the app shows it: its first 7 characters. */
export const shortSha = (sha: string) => sha.slice(0, 7);

export const STATUS_WORDS: Record<ItemFactoryStatus, string> = {
  designed: "designed",
  "in-the-draft": "in the draft",
  "being-built": "being built",
  "built-not-verified": "built, not verified",
  "built-and-verified": "built and verified",
  "fails-a-check": "fails a check",
  "in-force": "in force",
};

/** Agents work on it (blue); it waits for your Lock in (amber); the checks prove it (green) or fail (red); else grey. */
export const STATUS_TONE: Record<ItemFactoryStatus, Tone> = {
  designed: "neutral",
  "in-the-draft": "you",
  "being-built": "work",
  "built-not-verified": "neutral",
  "built-and-verified": "done",
  "fails-a-check": "fail",
  "in-force": "neutral",
};

const TASK_STATE: Record<CitingTask["state"], string> = { queued: "not started", running: "running", finished: "finished, not landed", landed: "landed" };

/** "running", or "landed (from before v2)" for work that built an earlier version: a citing task's state. */
export function taskState(t: CitingTask, version: number): string {
  return `${TASK_STATE[t.state]}${t.thisVersion ? "" : ` (from before v${version})`}`;
}

/** "T-001 running": one task that cites the item, and its state. */
export const taskWords = (t: CitingTask, version: number) => `${t.taskId} ${taskState(t, version)}`;

/** "4 of 6 pass · 1 fails · 1 no test": the item's rule results in one line; undefined for an item with no rules. */
export function rulesLine(v: ItemFactoryView): string | undefined {
  if (!v.rules) return undefined;
  const c = v.rules.counts;
  const total = v.rules.results.length;
  return [`${c.passed} of ${total} pass`, c.failed ? `${c.failed} ${c.failed === 1 ? "fails" : "fail"}` : "", c.skipped ? `${c.skipped} skipped` : "", c["no-test"] ? `${c["no-test"]} no test` : ""].filter(Boolean).join(" · ");
}

/**
 * Why there is no evidence, as a clause: "the preview did not start". The record's own label (NO_EVIDENCE_WORDS in
 * evidence.ts) is a short tag; a sentence needs a subject and a verb.
 */
export const NO_EVIDENCE_CLAUSE: Record<NoRunYet["status"] | NoEvidence, string> = {
  "no-run": "no capture has run for it",
  "not-set-up": "the preview is not set up",
  "no-plan": "the coder wrote no capture plan",
  "not-in-plan": "the capture plan does not name it",
  "invalid-plan": "the capture plan was refused",
  unavailable: "the recorder is not available",
  "install-failed": "the install failed",
  "preview-did-not-start": "the preview did not start",
  "page-errors": "the page did not load",
  "capture-failed": "the capture failed",
  stopped: "the capture was stopped",
  simulated: "the capture was simulated, and nothing ran",
};

/** The first gap the checks leave in landed work, in the words that follow "The checks do not prove it yet: ". */
export function gapWords(g: NotVerified, kind: string): string {
  switch (g.why) {
    case "rules-unproved":
      return [g.noTest ? `${count(g.noTest, "rule or example", "rules or examples")} ${g.noTest === 1 ? "has" : "have"} no test` : "", g.skipped ? `${g.skipped} ${g.skipped === 1 ? "test was" : "tests were"} skipped` : ""].filter(Boolean).join(", and ");
    case "no-rules":
      return `the ${kind} has no rules or examples to test`;
    case "kind-not-checked":
      return `no check proves ${/^[aeiou]/.test(kind) ? "an" : "a"} ${kind} yet`;
    case "no-evidence":
      return `${NO_EVIDENCE_CLAUSE[g.reason]}, so there is no evidence`;
    case "evidence-not-landed":
      return "only work that has not landed has evidence";
    case "evidence-older-design":
      return `the evidence shows design v${g.version}, not the current design version`;
    case "evidence-earlier-work":
      return `the evidence is of ${g.taskId}, and ${g.landedTaskId} landed after it`;
    case "evidence-earlier-commit":
      return `the evidence is of commit ${shortSha(g.commit)}, not of the commit that landed (${shortSha(g.landedCommit)})`;
    case "evidence-missing-device":
      return `no screenshot on ${joinAnd(g.devices.map((d) => DEVICE_WORD[d]))}`;
    case "evidence-warning":
      return `the capture has a warning: ${g.warning.replace(/\.$/, "")}`;
    case "no-ux-review":
      return "the UX review has not compared it with the design";
  }
}

const DEVICE_WORD: Record<CaptureDevice, string> = { desktop: "desktop", mobile: "mobile" };

const openOf = (v: ItemFactoryView): UxDifference[] => (v.uxReview?.ofLandedWork ? v.uxReview.differences.filter((d) => d.state === "open") : []);

/** Why the item stands where it does, in one or two sentences. */
export function statusWhy(v: ItemFactoryView): string {
  const running = v.tasks.filter((t) => t.state === "running" || t.state === "finished");
  const landedHere = v.tasks.filter((t) => t.state === "landed" && t.thisVersion);
  const landedBefore = v.tasks.filter((t) => t.state === "landed" && !t.thisVersion);
  const landed = `${landedHere.map((t) => t.taskId).join(", ")} landed`;
  switch (v.status) {
    case "in-force":
      return "A dictionary is not built. It is in force: every agent's brief and the writing check use it.";
    case "fails-a-check": {
      const failed = v.rules?.counts.failed ?? 0;
      const from = [...new Set((v.rules?.results ?? []).filter((r) => r.status === "failed").map((r) => r.from!.taskId))];
      const open = openOf(v);
      return [
        failed ? `${count(failed, "rule or example", "rules or examples")} ${failed === 1 ? "has" : "have"} a failing test, in the checks of ${from.join(", ")}.` : "",
        open.length ? `The UX review of ${v.uxReview!.taskId} found ${count(open.length, "open difference")} from the design.` : "",
      ]
        .filter(Boolean)
        .join(" ");
    }
    case "in-the-draft":
      return v.draft?.change === "dropped"
        ? "Your draft drops it. The factory keeps it until you lock in the draft."
        : `Your draft changes it to v${v.draft?.change === "changed" ? v.draft.item.version : "?"}. The factory builds v${v.item.version} until you lock in the draft.`;
    case "being-built":
      return `${running.map((t) => t.taskId).join(", ")} ${running.length === 1 ? "builds" : "build"} it now.`;
    case "built-not-verified":
      return `${landed}. The checks do not prove it yet: ${gapWords(v.notVerified!, v.item.kind)}.`;
    case "built-and-verified": {
      if (v.rules) return `${landed}, and every rule and example has a passing test.`;
      if (v.item.kind === "screen") {
        const explained = v.uxReview?.differences.filter((d) => d.state === "explained").length ?? 0;
        return `${landed}. Its screenshots are of the landed commit, and the UX review found no open difference from the design${explained ? ` (${count(explained, "difference")} you accepted)` : ""}.`;
      }
      return `${landed}, and its recording is of the landed commit.`;
    }
    case "designed":
      if (landedBefore.length) return `Locked in. The work that landed (${landedBefore.map((t) => t.taskId).join(", ")}) built an earlier version; nothing builds v${v.item.version} yet.`;
      return v.tasks.length ? `Locked in. ${v.tasks.map((t) => t.taskId).join(", ")} ${v.tasks.length === 1 ? "waits" : "wait"} to start.` : "Locked in. No task builds it yet: the lead plans its tasks.";
  }
}

export const RULE_WORDS: Record<RuleStatus, string> = { passed: "passes", failed: "fails", skipped: "skipped", "no-test": "No test" };
export const RULE_TONE: Record<RuleStatus, Tone> = { passed: "done", failed: "fail", skipped: "you", "no-test": "you" };

/** One rule's result for the table: the word, its tone, and the detail (the failing test and its message, or why there is none). */
export function ruleCell(r: RuleResult): { word: string; tone: Tone; detail?: string } {
  return { word: RULE_WORDS[r.status], tone: RULE_TONE[r.status], ...(r.status !== "passed" && r.message ? { detail: r.message } : {}) };
}

// ---------- the evidence ----------

/** A file the service captured, as the app's file route serves it (GET /api/studio/file?evidence=<run>&path=…). */
export const evidenceFileUrl = (e: Pick<ItemEvidence, "from">, f: Pick<EvidenceFile, "path">) => `/api/studio/file?evidence=${encodeURIComponent(e.from.attemptId)}&path=${encodeURIComponent(f.path)}`;

/** The screenshot of a device in a captured record. */
export const shotOf = (e: ItemEvidence, device: CaptureDevice): EvidenceFile | undefined => (e.status === "captured" ? e.files.find((f) => f.type === "png" && f.device === device) : undefined);

/** The recording of a captured terminal record: its WebM or GIF, and its transcript. */
export function recordingOf(e: ItemEvidence): { video?: EvidenceFile; gif?: EvidenceFile; transcript?: EvidenceFile } {
  if (e.status !== "captured") return {};
  const by = (t: EvidenceFile["type"]) => e.files.find((f) => f.type === t);
  const [video, gif, transcript] = [by("webm"), by("gif"), by("txt")];
  return { ...(video ? { video } : {}), ...(gif ? { gif } : {}), ...(transcript ? { transcript } : {}) };
}

/**
 * The caption of the built side: "Built · commit 1a2b3c4 · design v2 · 14:55", and "not the current design version"
 * when the evidence shows an earlier one.
 */
export function evidenceCaption(e: ItemEvidence, current: number): { text: string; older?: string } {
  return {
    text: `Built · commit ${shortSha(e.commit)} · design v${e.design.version} · ${fmtTime(e.at)}${e.from.simulated ? " · simulated" : ""}`,
    ...(e.current ? {} : { older: `not the current design version (v${current} is in force)` }),
  };
}

const DECIDED_BY: Record<NonNullable<UxDifference["decision"]>["by"] & string, string> = { lead: "the lead", pe: "the PE", user: "you", carried: "an earlier decision" };

/** What the UX review's decision on a difference says, in a few words. */
export function differenceState(d: UxDifference): string {
  if (d.state === "explained") return "you accepted it";
  const by = d.decision?.by && DECIDED_BY[d.decision.by];
  switch (d.decision?.status) {
    case undefined:
      return d.action === "auto-fix" ? "open: the repair was to fix it" : "open";
    case "open":
      return "open: waits for a decision";
    case "fix":
      return `open: ${by ?? "a decision"} asked for a fix`;
    case "follow-up":
      return `open: ${d.decision.followUpTaskId ?? "a follow-up task"} is to fix it`;
    case "accept":
      return `open: ${by ?? "an agent"} accepted it, and only you can accept a difference from the design`;
    case "superseded":
      return "open: a later run replaced the review";
  }
}
