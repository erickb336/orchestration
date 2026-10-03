// The pre-flight (ORC-029 pass 6, screen 7 of the pass 1 prototype) in words, as pure functions over the state: the
// blueprint by focus with PE review on each approved item, what is still open, what the factory will do, the settings
// the owner chooses here, and the `startFactory` command for what the screen showed. Start the factory is the first
// Lock in, so the screen also shows the Lock in summary (lockInView.ts). The facts are the domain's: the request
// (`startFactoryRequest`), the plan (`startFactoryPlan`), the blocker (`startFactoryBlocker`) and the record
// (`factoryStarts`). An unknown cost is "no estimate", never $0.

import * as M from "../../domain/model";
import * as B from "../../domain/studio/blueprint";
import { unfinishedProbes } from "../../domain/studio/studio";
import type { RoundFocus } from "../../domain/studio/types";
import { ROLES, SHAPING_AREA_LABEL, roleDefaultFor, type FactorySettings, type RoleId, type State } from "../../domain/types";
import { ROLE_LABEL, fmtTime } from "../common";
import type { Tone } from "../kit";
import { factorySettingsText } from "../settingsText";
import { itemName } from "../studio/draftView";
import { FOCUS_LABEL, peView } from "../studio/studioView";

/** The pre-flight's place: under Vision, where the factory is started. */
export const PREFLIGHT_HASH = "#/vision/pre-flight";

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const usd = (n: number) => `$${n.toFixed(2)}`;
/** "Code reviewer" → "code reviewer"; an initialism ("PE", "UX reviewer") stays. */
const lowerFirst = (l: string) => (/^[A-Z]{2}/.test(l) ? l : `${l[0].toLowerCase()}${l.slice(1)}`);
const list = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

// ---------- what the owner saw (compare-and-set) ----------

/** What the start names: the draft and vision revisions the owner saw, and the open items they confirm. */
export interface Seen {
  draftRev: number;
  visionRev: number;
  open: string[];
}

export function seenNow(s: State): Seen {
  const r = M.startFactoryRequest(s);
  return { draftRev: r.draftRev, visionRev: r.visionRev, open: r.acceptOpen };
}

export const sameSeen = (a: Seen, b: Seen) => a.draftRev === b.draftRev && a.visionRev === b.visionRev && a.open.join("\n") === b.open.join("\n");

/** The `startFactory` command for what the screen showed and the settings chosen on it. A changed draft or vision is refused. */
export function startFactoryCommand(seen: Seen, settings: FactorySettings) {
  return { name: "startFactory" as const, args: { agreed: true as const, draftRev: seen.draftRev, visionRev: seen.visionRev, settings, acceptOpen: seen.open } };
}

// ---------- the blueprint ----------

export interface BlueprintLine {
  itemId: string;
  name: string;
  /** PE review of the approved version, as the studio words it: "PE: agreed", "PE: not reviewed". */
  pe: { word: string; tone: Tone; why: string };
}

export interface FocusGroup {
  focus: string;
  items: BlueprintLine[];
}

export interface OpenLine {
  key: string;
  text: string;
}

const FOCUS_ORDER: RoundFocus[] = ["experience", "data", "flows", "material"];

/** What the draft approves, by the focus of the round that made each part, each with its PE review. */
export function blueprintByFocus(s: State): FocusGroup[] {
  const groups = new Map<RoundFocus, BlueprintLine[]>();
  for (const item of B.draftItems(s)) {
    if (item.status !== "approved") continue;
    const a = B.citedArtifact(s, item);
    if (!a) continue;
    const focus = s.studio.rounds.find((r) => r.n === a.round)?.focus ?? "material";
    const v = peView(s, a, M.providerLabel);
    const line = { itemId: item.id, name: itemName(s, item), pe: { word: `PE: ${v.state.toLowerCase()}`, tone: v.tone, why: v.text } };
    groups.set(focus, [...(groups.get(focus) ?? []), line]);
  }
  return FOCUS_ORDER.filter((f) => groups.has(f)).map((f) => ({ focus: FOCUS_LABEL[f], items: groups.get(f)! }));
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

/** The roles and the provider and model each runs on, grouped: "Claude · auto: the lead, the coder and the code reviewer." */
export function roleLines(s: State): string[] {
  const p = s.project;
  const groups = new Map<string, string[]>();
  let pe: string | undefined;
  for (const role of ROLES as RoleId[]) {
    const sel = role === "lead" ? p.leadSelection : (roleDefaultFor(p, role) ?? (role === "pe" ? undefined : p.defaultSelection));
    if (!sel) {
      pe = "The PE: the other provider than the one that made the work, so its review is independent.";
      continue;
    }
    const key = `${M.providerLabel(sel.provider)} · ${sel.model}${p.enabledProviders.includes(sel.provider) ? "" : " (not enabled)"}`;
    groups.set(key, [...(groups.get(key) ?? []), `the ${lowerFirst(ROLE_LABEL[role])}`]);
  }
  return [...[...groups].map(([key, roles]) => `${key}: ${list(roles)}.`), ...(pe ? [pe] : [])];
}

/** Agents at once and the run limits, from Settings › Agents. */
export function limitLines(s: State): string[] {
  const p = s.project;
  const per = p.enabledProviders.map((x) => `${M.providerLabel(x)} at most ${p.providerLimits[x]}`);
  const l = p.runLimits;
  return [
    `Up to ${count(p.workerLimit, "agent")} at once${per.length ? ` (${list(per)})` : ""}.`,
    `Each run stops at ${count(l.maxTurns, "turn")} or ${count(l.timeoutMinutes, "minute")}; a Claude run also stops at ${usd(l.maxBudgetUsd)}.`,
  ];
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
