// Design and reality (ORC-029 pass 5, screen 5) in words: each blueprint item's factory status, its tasks, its rule
// results, and one line on why it stands there. The facts come from src/domain/studio/itemStatus.ts and
// ruleResults.ts. The built side of the evidence (a screenshot, a CLI recording) comes from the factory's evidence
// capture, which records nothing yet: `builtEvidence` is the one place that reads it.

import type { CitingTask, ItemFactoryStatus, ItemFactoryView } from "../../domain/studio/itemStatus";
import type { RuleResult, RuleStatus } from "../../domain/studio/ruleResults";
import type { State } from "../../domain/types";
import type { Tone } from "../kit";

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const STATUS_WORDS: Record<ItemFactoryStatus, string> = {
  designed: "designed",
  "in-the-draft": "in the draft",
  "being-built": "being built",
  "built-and-verified": "built and verified",
  "fails-a-check": "fails a check",
  "in-force": "in force",
};

/** Agents work on it (blue); it waits for your Lock in (amber); the checks prove it (green) or fail (red). */
export const STATUS_TONE: Record<ItemFactoryStatus, Tone> = {
  designed: "neutral",
  "in-the-draft": "you",
  "being-built": "work",
  "built-and-verified": "done",
  "fails-a-check": "fail",
  "in-force": "neutral",
};

const TASK_STATE: Record<CitingTask["state"], string> = { queued: "not started", running: "running", finished: "finished, not landed", landed: "landed" };

/** "T-001 running" or "T-002 landed (built v1)": one task that cites the item, and its state. */
export function taskWords(t: CitingTask, version: number): string {
  return `${t.taskId} ${TASK_STATE[t.state]}${t.thisVersion ? "" : ` (from before v${version})`}`;
}

/** "4 of 6 pass · 1 fails · 1 no test": the item's rule results in one line; undefined for an item with no rules. */
export function rulesLine(v: ItemFactoryView): string | undefined {
  if (!v.rules) return undefined;
  const c = v.rules.counts;
  const total = v.rules.results.length;
  return [`${c.passed} of ${total} pass`, c.failed ? `${c.failed} ${c.failed === 1 ? "fails" : "fail"}` : "", c.skipped ? `${c.skipped} skipped` : "", c["no-test"] ? `${c["no-test"]} no test` : ""].filter(Boolean).join(" · ");
}

/** Why the item stands where it does, in one or two sentences. */
export function statusWhy(v: ItemFactoryView): string {
  const running = v.tasks.filter((t) => t.state === "running" || t.state === "finished");
  const landedHere = v.tasks.filter((t) => t.state === "landed" && t.thisVersion);
  const landedBefore = v.tasks.filter((t) => t.state === "landed" && !t.thisVersion);
  const c = v.rules?.counts;
  const unproved = c ? [c["no-test"] ? `${count(c["no-test"], "rule or example", "rules or examples")} ${c["no-test"] === 1 ? "has" : "have"} no test` : "", c.skipped ? `${c.skipped} ${c.skipped === 1 ? "test was" : "tests were"} skipped` : ""].filter(Boolean).join(", and ") : "";
  switch (v.status) {
    case "in-force":
      return "A dictionary is not built. It is in force: every agent's brief and the writing check use it.";
    case "fails-a-check": {
      const from = [...new Set(v.rules!.results.filter((r) => r.status === "failed").map((r) => r.from!.taskId))];
      return `${count(c!.failed, "rule or example", "rules or examples")} ${c!.failed === 1 ? "has" : "have"} a failing test, in the checks of ${from.join(", ")}.`;
    }
    case "in-the-draft":
      return v.draft?.change === "dropped"
        ? "Your draft drops it. The factory keeps it until you lock in the draft."
        : `Your draft changes it to v${v.draft?.change === "changed" ? v.draft.item.version : "?"}. The factory builds v${v.item.version} until you lock in the draft.`;
    case "being-built":
      if (running.length) return `${running.map((t) => t.taskId).join(", ")} ${running.length === 1 ? "builds" : "build"} it now.`;
      return `${landedHere.map((t) => t.taskId).join(", ")} landed. The checks do not prove it yet${unproved ? `: ${unproved}` : v.rules ? "" : ": the factory has not captured evidence for this part"}.`;
    case "built-and-verified":
      return `${landedHere.map((t) => t.taskId).join(", ")} landed, and every rule and example has a passing test.`;
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

/**
 * What the factory captured of the built part: a screenshot or a CLI recording, with when and on which commit. The
 * factory records none yet (the evidence capture, ORC-029 pass 5 U2, is not merged), so there is none for any item;
 * once it records one, this reads it and the detail shows it beside the design.
 */
export interface BuiltEvidence {
  kind: "screenshot" | "recording";
  url: string;
  capturedAt: string;
  commit: string;
}

export function builtEvidence(_s: State, _itemId: string): BuiltEvidence | undefined {
  return undefined;
}

export const NO_EVIDENCE = "No evidence yet: the factory has not captured this part.";
