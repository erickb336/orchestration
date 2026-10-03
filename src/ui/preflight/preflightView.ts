// The pre-flight (ORC-029 pass 6, screen 7 of the pass 1 prototype) in words, as pure functions over the state: one
// list of the parts the start puts into force (ORC-030 C1: focus, new or changed, the PE's verdict and estimate), what
// is still open, what the factory will do (the tasks, the agents in one line, the budgets beside the PE's estimate),
// the settings the owner chooses here, and the `startFactory` command for what the screen showed. Start the factory is
// the first Lock in, so the screen also holds the Lock in summary's facts (lockInView.ts). The facts are the domain's:
// the request (`startFactoryRequest`), the plan (`startFactoryPlan`), the blocker (`startFactoryBlocker`) and the
// record (`factoryStarts`). An unknown cost is "no estimate", never $0.

import * as M from "../../domain/model";
import { buildingSpend } from "../../domain/spend";
import * as B from "../../domain/studio/blueprint";
import { unfinishedProbes } from "../../domain/studio/studio";
import type { RoundFocus } from "../../domain/studio/types";
import { ROLES, SHAPING_AREA_LABEL, roleDefaultFor, type FactorySettings, type RoleId, type State } from "../../domain/types";
import { fmtTime } from "../common";
import type { Tone } from "../kit";
import { factorySettingsText } from "../settingsText";
import { itemName } from "../studio/draftView";
import { FOCUS_LABEL, peView, usdRange } from "../studio/studioView";

/** The pre-flight's place: under Vision, where the factory is started. */
export const PREFLIGHT_HASH = "#/vision/pre-flight";

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const usd = (n: number) => `$${n.toFixed(2)}`;
const list = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

// ---------- what the owner saw (compare-and-set) ----------

/**
 * What the start names: the draft and vision revisions the owner saw, the digest of the Lock in summary the screen
 * showed (the start records that summary), and the open items they confirm.
 */
export interface Seen {
  draftRev: number;
  summaryDigest: string;
  visionRev: number;
  open: string[];
}

export function seenNow(s: State): Seen {
  const r = M.startFactoryRequest(s);
  return { draftRev: r.draftRev, summaryDigest: r.summaryDigest, visionRev: r.visionRev, open: r.acceptOpen };
}

export const sameSeen = (a: Seen, b: Seen) => a.draftRev === b.draftRev && a.summaryDigest === b.summaryDigest && a.visionRev === b.visionRev && a.open.join("\n") === b.open.join("\n");

/**
 * Whether the screen moved only because the owner saved the budgets on it (ORC-030 a-pre-budgets): the draft, the
 * vision and what is open are as the screen showed them, and the budgets are the ones the owner saved. The screen then
 * shows the new summary without the stale banner, and keeps the agreement: the owner sees the budgets they typed.
 */
export function ownBudgetsSaved(now: Seen, seen: Seen, budgets: State["project"]["budgets"], saved: State["project"]["budgets"] | null): boolean {
  if (!saved || sameSeen(now, seen)) return false;
  const rest = now.draftRev === seen.draftRev && now.visionRev === seen.visionRev && now.open.join("\n") === seen.open.join("\n");
  return rest && budgets.buildingUsd === saved.buildingUsd && budgets.maintenanceUsdPerMonth === saved.maintenanceUsdPerMonth;
}

/** The `startFactory` command for what the screen showed and the settings chosen on it. A changed draft, summary or vision is refused. */
export function startFactoryCommand(seen: Seen, settings: FactorySettings) {
  return { name: "startFactory" as const, args: { agreed: true as const, draftRev: seen.draftRev, summaryDigest: seen.summaryDigest, visionRev: seen.visionRev, settings, acceptOpen: seen.open } };
}

// ---------- the blueprint: one list of parts, then what is open ----------

export interface OpenLine {
  key: string;
  text: string;
}

const FOCUS_ORDER: RoundFocus[] = ["experience", "data", "flows", "material"];

/**
 * One line per part the start puts into force (ORC-030 a-pre-one-list): the part, the focus of the round that made it,
 * whether it is new or changed (or dropped), the PE's verdict on it, and the PE's estimate for it. In the order of
 * the rounds' focus, then of the draft. It stands for both "The blueprint" and the first Lock in's "What changes".
 */
export interface PartLine {
  itemId: string;
  name: string;
  focus: string;
  change: "new" | "changed" | "dropped";
  /** PE review of the version, as the studio words it ("PE: agreed"); none for a dropped part. */
  pe?: { word: string; tone: Tone; why: string };
  /** The PE's estimate for the part: "building $3–$5, maintenance $0.40–$0.80 a month", or "no estimate". */
  estimate?: string;
}

export function partLines(s: State): PartLine[] {
  const c = B.draftChanges(s);
  const estimates = new Map(B.lockInSummary(s).budgets.items.map((e) => [e.itemId, e.estimate]));
  const focusOf = (item: Parameters<typeof B.citedArtifact>[1]): RoundFocus => {
    const a = B.citedArtifact(s, item);
    return (a && s.studio.rounds.find((r) => r.n === a.round)?.focus) ?? "material";
  };
  const line = (item: Parameters<typeof B.citedArtifact>[1], change: PartLine["change"]): PartLine & { order: number } => {
    const a = B.citedArtifact(s, item);
    const v = a && change !== "dropped" ? peView(s, a, M.providerLabel) : undefined;
    const e = estimates.get(item.id);
    const estimate =
      change === "dropped"
        ? undefined
        : e && (e.buildUsd || e.maintenanceUsdPerMonth)
          ? [e.buildUsd ? `building ${usdRange(e.buildUsd)}` : "building: no estimate", e.maintenanceUsdPerMonth ? `maintenance ${usdRange(e.maintenanceUsdPerMonth, true)}` : "maintenance: no estimate"].join(", ")
          : "no estimate";
    const focus = focusOf(item);
    return { itemId: item.id, name: itemName(s, item), focus: FOCUS_LABEL[focus], change, ...(v ? { pe: { word: `PE: ${v.state.toLowerCase()}`, tone: v.tone, why: v.text } } : {}), ...(estimate ? { estimate } : {}), order: FOCUS_ORDER.indexOf(focus) };
  };
  const lines = [...c.added.map((i) => line(i, "new")), ...c.changed.map((x) => line(x.item, "changed")), ...c.dropped.map((i) => line(i, "dropped"))];
  return lines.map((l, i) => ({ l, i })).sort((x, y) => x.l.order - y.l.order || x.i - y.i).map(({ l: { order: _, ...rest } }) => rest);
}

/** Under the list: how many of the parts no task builds yet, and who plans their tasks. Undefined when every part has one. */
export function newWorkLine(s: State): string | undefined {
  const n = B.lockInSummary(s).newWork.length;
  if (!n) return undefined;
  const all = n === partLines(s).filter((l) => l.change === "new").length;
  return `${all ? (n === 1 ? "No task builds this part yet" : "No task builds these parts yet") : `${count(n, "part")} ${n === 1 ? "has" : "have"} no task yet`}. The lead plans the tasks after the start${s.project.peReviewsNewWork ? ", and the PE reviews them before they start" : ""}.`;
}

/** What is still open, by name: the vision's open areas, the draft's open items, and the probes without their evidence. */
export function openLines(s: State): OpenLine[] {
  const areas = M.openAreas(s);
  const lines: OpenLine[] = [];
  if (!M.coverageOf(s)) lines.push({ key: "areas", text: "The lead has not reported which areas of the vision are clear yet, so all nine count as open." });
  else if (areas.length) lines.push({ key: "areas", text: `${areas.length === 1 ? "An area" : "Areas"} of the vision not clear yet: ${list(areas.map((a) => `"${SHAPING_AREA_LABEL[a]}"`))}.` });
  for (const o of B.openBlueprintItems(s)) lines.push({ key: o.item.id, text: `${itemName(s, o.item)}: ${o.why}. It stays in the draft.` });
  for (const p of unfinishedProbes(s)) lines.push({ key: p.id, text: `A PE probe is ${p.status === "running" ? "still running" : "waiting to start"}: ${p.question}` });
  return lines;
}

// ---------- what the factory will do ----------

export interface PlannedTask {
  id: string;
  title: string;
  flow: string;
  outcome: string;
}

/**
 * The tasks planned from the blueprint (`startFactoryPlan`), with what the start does to each under the chosen
 * settings: on Autopilot the roadmap starts; otherwise it waits for your go-ahead. A task you set to wait keeps waiting.
 */
export function plannedTasks(s: State, x: FactorySettings): { summary: string; tasks: PlannedTask[] } {
  const plan = M.startFactoryPlan(s);
  const release = x.autonomy === "autopilot";
  const tasks = [
    ...plan.roadmap.map((t) => ({ t, outcome: release ? "Starts when the factory starts" : "Waits for your go-ahead" })),
    ...plan.userHeld.map((t) => ({ t, outcome: "Waits for your go-ahead: you set it to wait" })),
  ].map(({ t, outcome }) => ({ id: t.id, title: M.currentSpec(t).content.title, flow: t.flow.name, outcome }));
  if (!tasks.length) return { summary: `No task is planned yet. After the start, the lead plans the tasks from the blueprint${s.project.peReviewsNewWork ? ", and the PE reviews them before they start" : ""}.`, tasks };
  const byFlow = new Map<string, number>();
  for (const t of tasks) byFlow.set(t.flow, (byFlow.get(t.flow) ?? 0) + 1);
  return { summary: `${count(tasks.length, "planned task")}: ${list([...byFlow].map(([flow, n]) => `${n} ${flow}`))}.`, tasks };
}

/** What each role does, as a verb, for the agents' one line. The three reviewers review. */
const ROLE_VERB: Record<Exclude<RoleId, "pe" | "checks" | "evidence">, string> = { lead: "leads", designer: "designs", coder: "codes", code_reviewer: "reviews", security_reviewer: "reviews", ux_reviewer: "reviews" };

/**
 * The agents in one line (ORC-030 a-pre-agents), from Settings › Agents: which provider does what, where the PE runs,
 * and how many agents run at once. "Claude leads and designs, Codex codes, the PE reviews on the other provider; at
 * most 3 agents at once." A provider that is not enabled says so.
 */
export function agentsLine(s: State): string {
  const p = s.project;
  const groups = new Map<string, string[]>();
  let pe = "the PE reviews on the other provider";
  for (const role of ROLES as RoleId[]) {
    const sel = role === "lead" ? p.leadSelection : (roleDefaultFor(p, role) ?? (role === "pe" ? undefined : p.defaultSelection));
    if (role === "pe") {
      if (sel) pe = `the PE reviews on ${M.providerLabel(sel.provider)}${p.enabledProviders.includes(sel.provider) ? "" : " (not enabled)"}`;
      continue;
    }
    if (!sel || !(role in ROLE_VERB)) continue;
    const who = `${M.providerLabel(sel.provider)}${p.enabledProviders.includes(sel.provider) ? "" : " (not enabled)"}`;
    const verb = ROLE_VERB[role as keyof typeof ROLE_VERB];
    const verbs = groups.get(who) ?? [];
    if (!verbs.includes(verb)) groups.set(who, [...verbs, verb]);
  }
  const parts = [...groups].map(([who, verbs]) => `${who} ${list(verbs)}`);
  // Commas between providers read well while each does one or two things; with three or more, semicolons keep them apart.
  const sep = [...groups.values()].some((v) => v.length > 2) ? "; " : ", ";
  return `${[...parts, pe].join(sep)}; at most ${count(p.workerLimit, "agent")} at once.`;
}

// ---------- the budgets, on the pre-flight (ORC-030 a-pre-budgets) ----------

/**
 * Under each budget field: what the budget does, the spend so far, and the PE's estimate for the parts the start puts
 * into force. An unknown cost is never $0: a run with no recorded cost says the spend may be higher.
 */
export function budgetsBeside(s: State, building: boolean): { building: string; maintenance: string } {
  const b = B.lockInSummary(s).budgets;
  const unknown = buildingSpend(s).unknown.length;
  const missing = b.items.filter((e) => !e.estimate?.buildUsd).length;
  const estimate = !b.items.length
    ? "No part to estimate: the draft approves none."
    : b.itemsTotal.buildUsd
      ? `The PE's estimate for these parts: ${usdRange(b.itemsTotal.buildUsd)}.`
      : `No total estimate from the PE: ${count(missing, "part")} ${missing === 1 ? "has" : "have"} none.`;
  const m = b.maintenance.estimateUsdPerMonth;
  const missingM = b.items.filter((e) => !e.estimate?.maintenanceUsdPerMonth).length;
  const parts = b.itemsTotal.maintenanceUsdPerMonth
    ? `These parts add ${usdRange(b.itemsTotal.maintenanceUsdPerMonth, true)}.`
    : b.items.length
      ? `No total estimate from the PE for these parts: ${count(missingM, "part")} ${missingM === 1 ? "has" : "have"} none.`
      : "";
  return {
    building: [
      building ? "At it, the factory stops and asks you." : "Not set: the factory does not stop for cost.",
      `${usd(b.building.spentUsd)} spent so far${unknown ? `; ${count(unknown, "run")} ${unknown === 1 ? "has" : "have"} no recorded cost, so the spend may be higher` : ""}.`,
      estimate,
    ].join(" "),
    maintenance: [m === null ? (parts ? "" : "No estimate from the PE yet.") : `What is in force costs about ${usd(m)} a month.`, parts].filter(Boolean).join(" "),
  };
}

// ---------- how the factory runs ----------

export const AUTONOMY_HELP: Record<FactorySettings["autonomy"], string> = {
  autopilot: "Tasks start and are repaired on their own. It asks you only where you say below.",
  checkin: "The lead plans, and each new task waits for your go-ahead. Repairs run on their own.",
  manual: "The lead does not plan, and nothing starts until you start it.",
};

/**
 * Choose how much the factory does on its own. As in the prototype, Autopilot lets the PE decide trade-offs and the
 * other two ask you. Check-in always waits before each task and Autopilot never does; Manual keeps the setting, since
 * on Manual nothing starts without you anyway. Choosing the mode it has already changes nothing.
 */
export function chooseAutonomy(x: FactorySettings, mode: FactorySettings["autonomy"]): FactorySettings {
  if (x.autonomy === mode) return x;
  const startEachTask = mode === "autopilot" ? false : mode === "checkin" ? true : x.pausePoints.startEachTask;
  return { ...x, autonomy: mode, pausePoints: { ...x.pausePoints, tradeoffs: mode === "autopilot" ? "pe" : "user", startEachTask } };
}

/** "Before each task starts": on, it is Check-in; off, it is Autopilot. On Manual it cannot change (nothing starts without you). */
export function chooseWaitBeforeEachTask(x: FactorySettings, wait: boolean): FactorySettings {
  if (x.autonomy === "manual") return x;
  return { ...x, autonomy: wait ? "checkin" : "autopilot", pausePoints: { ...x.pausePoints, startEachTask: wait } };
}

/** Who merges. Only pull requests leave the choice to you: local delivery merges by itself, and with delivery off you merge. */
export function chooseMerge(x: FactorySettings, merge: FactorySettings["delivery"]["merge"]): FactorySettings {
  if (x.delivery.mode !== "pr") return x;
  return { ...x, delivery: { ...x.delivery, merge } };
}

export const chooseTradeoffs = (x: FactorySettings, askMe: boolean): FactorySettings => ({ ...x, pausePoints: { ...x.pausePoints, tradeoffs: askMe ? "user" : "pe" } });
export const chooseChangeOrders = (x: FactorySettings, askMe: boolean): FactorySettings => ({ ...x, pausePoints: { ...x.pausePoints, changeOrders: askMe ? "user" : "lead" } });

/** Where finished work goes, and why the merge choice is or is not yours. */
export function deliveryHelp(x: FactorySettings): string {
  const d = x.delivery;
  if (d.mode === "pr") return `Pull requests against ${d.branch}.`;
  if (d.mode === "local") return `Local delivery: each finished task goes to ${d.branch} by itself, fast-forward only. To merge yourself, choose pull requests in Settings › Project.`;
  return "Delivery is off: finished work stays on the integration branch, and you merge it. To deliver, choose it in Settings › Project.";
}

/** What happens with trade-off decisions while you are not asked. */
export function tradeoffsOffHelp(x: FactorySettings): string {
  return x.pausePoints.tradeoffs === "lead" ? "Off: the lead decides them, as it does now." : "Off: the PE decides them within the budget, and records each decision.";
}

/** The building budget always stops the factory, when there is one. */
export function budgetStopHelp(s: State): string {
  const b = s.project.budgets.buildingUsd;
  return b === null ? "No building budget is set, so the factory does not stop for cost." : `It stops at ${usd(b)} and asks you before it spends more.`;
}

// ---------- the agreement, and the start ----------

/** The owner's agreement: the open items, when there are any, as they are. */
export const agreementWords = (open: number) => (open ? "I have reviewed the blueprint and want the factory to build it, with the open items above as they are." : "I have reviewed the blueprint and want the factory to build it.");

/** Why Start the factory cannot be pressed now, or undefined. */
export function startGate(s: State, agreed: boolean, offline: boolean): string | undefined {
  if (offline) return "The service is offline.";
  const why = M.startFactoryBlocker(s);
  if (why) return why;
  if (!agreed) return "Tick the box first: your agreement is recorded with the start.";
  return undefined;
}

/** What the start recorded: who, when, from what, and how the factory runs. Undefined while the project is in Vision. */
export function startedWords(s: State): { title: string; lines: string[] } | undefined {
  if (s.project.stage !== "building") return undefined;
  const after = "Vision stays open while the factory runs, and each later change goes through Lock in.";
  const start = s.project.factoryStarts.at(-1);
  if (!start) return { title: "The factory is running.", lines: ["No start is recorded: this project was in the factory before the pre-flight existed.", after] };
  const from = start.blueprintRev ? `Lock in ${start.blueprintRev}` : "the vision alone, since nothing was approved yet,";
  const open = start.openItems.length;
  return {
    title: "The factory started.",
    lines: [
      `Started by you, ${fmtTime(start.at)}, from ${from} and vision r${start.visionRev}.`,
      `Recorded with your agreement: ${[start.blueprintRev ? "the Lock in summary" : "", "how the factory runs", open ? `the ${count(open, "open item")} you accepted` : ""].filter(Boolean).join(", ")}.`,
      factorySettingsText(start.settings),
      `Only you can start the factory. ${after}`,
    ],
  };
}
