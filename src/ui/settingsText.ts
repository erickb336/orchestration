// The words of Settings that depend on the numbers, as pure functions so they are tested
// without a browser. The involvement card describes each mode with the numbers it actually sets, and
// the long consent texts are here, as the in-page confirmations that ask for them.

import { AUTOPILOT, type CheckCommand, type FactorySettings } from "../domain/types";
import type { ConfirmOptions } from "./kit";
import type { Involvement } from "./common";

// ---------- the involvement card ----------

/** The numbers a mode plans with, as the fields hold them. */
export type PlanNumbers = { interval: number; perCycle: number; maxOpen: number; retries: number; hours: { start: string; end: string } | null };

/** Autopilot's own numbers: choosing Autopilot sets these (the applyAutopilot command). */
export const AUTOPILOT_NUMBERS = { interval: AUTOPILOT.planningIntervalMinutes, perCycle: AUTOPILOT.maxProposalsPerCycle, maxOpen: AUTOPILOT.maxOpenProposals, retries: AUTOPILOT.autoRetry };

/** Where finished work goes, as the Autopilot description says it. `branch` is the local branch (or the one Autopilot would turn on). */
export type DeliveryWords = { mode: "off" | "local" | "pr"; branch: string; merge: "hold" | "auto" };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const times = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);

function planSentence(n: PlanNumbers): string {
  const when = n.hours ? ` between ${n.hours.start} and ${n.hours.end}` : "";
  return `The lead plans every ${plural(n.interval, "minute")}${when}, up to ${plural(n.perCycle, "task")} per plan and at most ${n.maxOpen} open.`;
}

function retrySentence(retries: number): string {
  return retries > 0 ? `A failed step is retried ${times(retries)} before it waits for you.` : "A failed step waits for you.";
}

function deliverySentence(d: DeliveryWords): string {
  if (d.mode === "pr") return d.merge === "auto" ? "Pull requests merge automatically after an independent review and passing checks." : "Pull requests wait for you to merge.";
  if (d.mode === "local") return `Finished work is delivered to ${d.branch}, fast-forward only.`;
  return "Finished work is delivered to the branch below, fast-forward only.";
}

/** What a mode does, with the numbers it sets. Manual plans nothing, so it has no numbers. */
export function involvementText(mode: Exclude<Involvement, "custom">, n: PlanNumbers, delivery: DeliveryWords): string {
  if (mode === "manual") return "The lead works only when you message it. Tasks you create still run; nothing new is planned.";
  if (mode === "checkin") return `${planSentence(n)} Each task it proposes waits for your go-ahead; after that it runs by itself. ${retrySentence(n.retries)}`;
  return `${planSentence(n)} Work starts without waiting for you. ${retrySentence(n.retries)} ${deliverySentence(delivery)}`;
}

/**
 * The count of open lead proposals against the limit, said truthfully. The limit caps what planning
 * adds, not what exists: proposals made by hand, by a conversation, or before the limit was lowered can
 * exceed it, so "8 of 5" is never shown as a fraction.
 */
export function proposalsLine(open: number, deferred: number, max: number): string {
  const proposals = (n: number) => `${n} proposal${n === 1 ? "" : "s"}`;
  const openText = open > max ? `Open lead proposals: ${open}, over the limit of ${max}, so planning proposes nothing new until fewer are open.` : `Open lead proposals: ${open} of at most ${max}.`;
  if (!deferred) return openText;
  const deferredText =
    deferred >= max ? `Deferred lead proposals: ${proposals(deferred)}, at the limit of ${max}; they do not count as open, but planning stops until the lead drops some.` : `Deferred lead proposals: ${proposals(deferred)} of at most ${max}; they do not count as open.`;
  return `${openText} ${deferredText}`;
}

// ---------- Start building ----------

const AUTONOMY_WORD = { autopilot: "Autopilot", checkin: "Check-in", manual: "Manual" } as const;

/**
 * How the factory runs once started, in one line: the settings Start building sends and records with the owner's
 * agreement (a stand-in for the pre-flight screen, ORC-029 pass 6). They are changed in Settings before starting.
 */
export function factorySettingsText(x: FactorySettings): string {
  const d = x.delivery;
  const delivery =
    d.mode === "pr"
      ? `pull requests against ${d.branch}, ${d.merge === "auto" ? "merged automatically after an independent review and passing checks" : "which you merge"}`
      : d.mode === "local"
        ? `finished work goes to ${d.branch} by itself, fast-forward only`
        : "delivery off: finished work stays on the integration branch for you to merge";
  const route = x.pausePoints.tradeoffs;
  const decisions = route === "user" ? "findings that need a decision come to you" : route === "pe" ? "the PE decides findings that need a decision, within budget (the lead's runs decide for it until the PE runs its own)" : "the lead decides findings that need a decision";
  return `The factory starts on ${AUTONOMY_WORD[x.autonomy]}; ${delivery}; ${decisions}.`;
}

// ---------- checks ----------

/** "On · 2 commands" / "Off · no commands": the one line Quality shows for checks. */
export function checksSummary(enabled: boolean, commands: Pick<CheckCommand, "kind">[]): string {
  const n = commands.length;
  return `${enabled ? "On" : "Off"} · ${n ? plural(n, "command") : "no commands"}`;
}

/** A command as it would be typed: `npm run lint`. */
export const argvText = (argv: string[]) => argv.join(" ");

// ---------- in-page confirmations ----------

export const CONFIRM_CHECKS_ON: ConfirmOptions = {
  title: "Turn checks on?",
  text: [
    "Checks run the repository's own code on this computer: its test scripts, its build, and whatever those start, including code agents wrote.",
    "The Codex sandbox blocks writes outside a temporary copy of the change, and blocks the network for everything except npm, pnpm and yarn dependency downloads, which run with every install hook off. It does not stop that code from reading your files.",
    "Turn checks on only for repositories whose agents' work you are willing to run.",
  ].join("\n\n"),
  primaryLabel: "Turn checks on",
};

export const CONFIRM_NO_SANDBOX: ConfirmOptions = {
  title: "Run checks without a sandbox?",
  text: [
    "Every check will run with your permissions: it can read and write anywhere you can and reach the network. Code an agent wrote will run that way. The app never chooses this by itself; every such run is labelled as unsandboxed.",
    "Choose this only if the Codex sandbox cannot work on this computer and you accept the risk.",
  ].join("\n\n"),
  primaryLabel: "Run without a sandbox",
  danger: true,
};

export const CONFIRM_RESET_BASELINE: ConfirmOptions = {
  title: "Forget what was delivered before?",
  text: "The next local delivery starts from the branch as it is now. Do this after you decided what the branch should contain.",
  primaryLabel: "Reset baseline",
};

export function confirmRedeliver(ids: string[]): ConfirmOptions {
  return { title: `Open ${plural(ids.length, "pull request")}?`, text: `One for each of ${ids.join(", ")}.`, primaryLabel: ids.length === 1 ? "Open it" : "Open them" };
}

/** The confirmation before resuming automatic merging, from the text the task page uses too. */
export function confirmResumeAutoMerge(text: string): ConfirmOptions {
  const [title, ...rest] = text.split("\n");
  return { title, text: rest.join("\n").trim(), primaryLabel: "Resume automatic merging" };
}

/** The confirmation before replacing the project; `full` is initProjectConfirm's sentence, which starts with the question. */
export function confirmNewProject(name: string, full: string): ConfirmOptions {
  const title = `Start a new project "${name}"?`;
  return { title, text: full.startsWith(title) ? full.slice(title.length).trim() : full, primaryLabel: "Start project", danger: true };
}

/** What the person confirms before automatic merging is turned on, or loosened. */
export type AutoMergeConsent = {
  turningOn: boolean;
  /** Open pull requests that follow the project's setting (by number, or task id while unnumbered). */
  following: string[];
  /** Protected files that would no longer be protected. */
  unprotected: string[];
  /** The daily cap, when it goes up. */
  cap?: { from: number; to: number };
  reviewer: "other-provider" | "any-agent";
  warnings: string[];
};

export function confirmAutoMerge(c: AutoMergeConsent): ConfirmOptions {
  const n = c.following.length;
  const lines = [
    ...(c.turningOn
      ? [
          n
            ? `This applies to new pull requests and to the ${plural(n, "pull request")} already open (${c.following.slice(0, 8).join(", ")}${n > 8 ? ", …" : ""}): ${n === 1 ? "it" : "they"} will merge by ${n === 1 ? "itself" : "themselves"} too. Hold any you want to merge yourself.`
            : "This applies to new pull requests and to any pull request already open that follows the project's setting.",
          "",
        ]
      : []),
    ...(!c.turningOn && c.unprotected.length ? [`No longer protected: ${c.unprotected.join(", ")}. Pull requests that touch ${c.unprotected.length === 1 ? "it" : "them"}, including ones already open, may then merge automatically.`, ""] : []),
    ...(!c.turningOn && c.cap ? [`The daily limit goes from ${c.cap.from} to ${c.cap.to} automatic merges. Pull requests that were waiting for tomorrow may merge today.`, ""] : []),
    "The app will merge a pull request by itself, under your GitHub account, only when all of this holds for the exact commit:",
    `- an independent agent review is clean (${c.reviewer === "any-agent" ? "by any agent" : "by another provider than the one that wrote the change"});`,
    "- every check the repository requires has passed;",
    "- GitHub reports it mergeable;",
    "- it touches no protected file, and nothing is paused or held.",
    "",
    "It never bypasses branch rules, never uses GitHub's own auto-merge and never forces a push. An agent review is not a human review.",
    ...(c.warnings.length ? ["", "Before you confirm:", ...c.warnings.map((w) => `- ${w}`)] : []),
  ];
  return {
    title: c.turningOn ? "Merge pull requests automatically?" : "Save these changes to automatic merging?",
    text: lines.join("\n"),
    primaryLabel: c.turningOn ? "Merge automatically" : "Save changes",
  };
}
