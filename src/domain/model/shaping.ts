// A project is shaping (Vision) or building (Factory). Every project begins shaping. While shaping, the lead
// answers messages and may draft the vision and propose a first roadmap, but no worker step is dispatched and no
// planning run starts. A draft is a suggestion: the vision changes only when the user accepts it. Only the owner's
// Start the factory (`startFactory`, called from the command table alone) moves a project to building: it needs a
// vision, locks in the blueprint's draft (the first Lock in), records the owner's agreement (the draft and vision
// revisions they saw, the open items they confirmed) and the settings the factory runs with, and releases the
// roadmap on Autopilot. A project never goes back: Vision stays open while the factory runs (ORC-029 r12), and only
// Pause stops building.

import { deliveryMode, setDeliveryMode, setPrDelivery } from "../delivery";
import * as F from "../findings";
import { assertSummarySeen, blueprintRev, draftChanges, draftRev, lockInSummary, openBlueprintItems, putDraftInForce, summaryDigest } from "../studio/blueprint";
import { unfinishedProbes } from "../studio/studio";
import {
  type Device,
  type FactoryDelivery,
  type FactorySettings,
  type LeadRun,
  type Message,
  type Coverage,
  type CoverageState,
  type LeadQuestion,
  type ShapingArea,
  type State,
  type Task,
  type VisionDraft,
  ControlError,
  COVERAGE_STATES,
  DEVICES,
  SHAPING_AREAS,
  StaleWriteError,
} from "../types";
import { currentVision, draft, event, touch } from "./core";
import { autonomyMode, autopilotAutonomy, setAutonomy } from "./lead";
import { CONTROL_RE, oneLine, stripInvisible, visibleOrEmpty } from "./textSafety";
import { draftVisionText, pushVision, setDraftVisionInto } from "./vision";

const MAX_VISION_TEXT = 8000;
const MAX_VISION_FOCUS = 300;
const MAX_VISION_DRAFTS = 50;

/** The one line shown wherever new work would otherwise be expected to start. Never "Paused". */
export const SHAPING_LABEL = "Vision: new work waits until you start the factory";

/** Why Start the factory is refused, or undefined when it is allowed. */
export function startFactoryBlocker(s: State): string | undefined {
  if (s.project.stage === "building") return "Already building.";
  if (!currentVision(s).text.trim()) return "Write or accept a vision first.";
  return undefined;
}

/** Roadmap proposals made while shaping that have not started yet, in board order. */
export function roadmapTasks(s: State): Task[] {
  return s.tasks.filter((t) => t.fromShaping && (t.lifecycle === "proposed" || t.lifecycle === "ready")).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

/** The draft the user has not yet accepted or dismissed (at most one: a newer draft supersedes it). */
export function openVisionDraft(s: State): VisionDraft | undefined {
  for (let i = s.visionDrafts.length - 1; i >= 0; i--) if (s.visionDrafts[i].status === "open") return s.visionDrafts[i];
  return undefined;
}

/**
 * What Start the factory would do with the roadmap now. It uses the involvement setting at the moment it
 * runs, never one recorded earlier, and lifts only the roadmap's own hold: `roadmap` are the planned
 * tasks it releases or hands to the user's release; `userHeld` are planned tasks whose hold the user
 * took over, which keep waiting for the user either way.
 */
export function startFactoryPlan(s: State): { release: boolean; roadmap: Task[]; userHeld: Task[] } {
  const a = s.project.autonomy;
  const open = roadmapTasks(s);
  return { release: a.enabled && !a.holdLeadProposals, roadmap: open.filter((t) => t.heldForShaping), userHeld: open.filter((t) => !t.heldForShaping && t.holdBeforeStart) };
}

/** The factory's settings as the project has them now: what a start keeps when the owner changes nothing. */
export function currentFactorySettings(s: State): FactorySettings {
  const p = s.project;
  return {
    autonomy: autonomyMode(p.autonomy),
    delivery: currentDelivery(s),
    pausePoints: {
      // The route as it is, the lead's included: a start that changes nothing keeps it.
      tradeoffs: p.triage.askUserBy,
      changeOrders: p.changeOrders,
      startEachTask: p.autonomy.holdLeadProposals,
    },
  };
}

/** Delivery as it is now: local delivery is automatic, and with delivery off you merge. */
function currentDelivery(s: State): FactoryDelivery {
  const p = s.project;
  const mode = deliveryMode(s);
  if (mode === "pr") return { mode, branch: p.prDelivery.base, merge: p.prDelivery.merge === "auto" ? "auto" : "user" };
  if (mode === "local") return { mode, branch: p.autonomy.autoDeliver.branch, merge: "auto" };
  return { mode, merge: "user" };
}

/** What the owner sends to start the factory. */
export interface FactoryRequest {
  agreed: true;
  /**
   * The blueprint draft's revision the owner saw in the pre-flight (compare-and-set). The start locks the draft in, and
   * nothing else changes what is in force, so this one revision covers both.
   */
  draftRev: number;
  /** The digest of the Lock in summary the pre-flight showed (`summaryDigest`): the start records that summary. */
  summaryDigest: string;
  /**
   * The vision revision the owner saw (compare-and-set). The blueprint stands on the vision, and the vision changes
   * without a blueprint revision (an edit, an accepted draft, a document), so the agreement checks both.
   */
  visionRev: number;
  settings: FactorySettings;
  /** The open items the owner was shown and accepts: open areas by name, open blueprint items and unfinished probes by id. */
  acceptOpen: string[];
}

/** What is still open for the pre-flight: the vision's open areas, the draft's open items, and the probes whose evidence is not in yet. */
function openForPreflight(s: State) {
  return { areas: openAreas(s), items: openBlueprintItems(s).map((o) => o.item), probes: unfinishedProbes(s) };
}

/** The pre-flight's open items as the owner confirms them: areas by name, then blueprint items and probes by id. Never a block: the owner confirms them. */
export function preflightOpenItems(s: State): string[] {
  const o = openForPreflight(s);
  return [...o.areas, ...o.items.map((i) => i.id), ...o.probes.map((p) => p.id)];
}

/**
 * The request as the project stands: agreement on the current revisions, the current settings, and every open
 * item confirmed. Only data: the owner's own action sends it (today the Start building button, after its
 * confirmation lists the open items; the pre-flight screen later).
 */
export function startFactoryRequest(s: State): FactoryRequest {
  return { agreed: true, draftRev: draftRev(s), summaryDigest: summaryDigest(lockInSummary(s)), visionRev: currentVision(s).rev, settings: currentFactorySettings(s), acceptOpen: preflightOpenItems(s) };
}

/**
 * Settings that contradict each other, refused rather than adjusted. Autopilot never waits before a task, and Check-in
 * always does. Local delivery fast-forwards a branch without anyone merging, and with delivery off nothing merges by
 * itself.
 */
function settingsProblem(x: FactorySettings): string | undefined {
  if (x.autonomy === "autopilot" && x.pausePoints.startEachTask) return "Autopilot starts each task without waiting; choose Check-in to give the go-ahead for each task.";
  if (x.autonomy === "checkin" && !x.pausePoints.startEachTask) return "Check-in waits for your go-ahead before each task the lead plans.";
  const d = x.delivery;
  if (d.mode === "local" && d.merge === "user") return `Local delivery fast-forwards ${d.branch ?? "its branch"} without waiting for you; choose pull requests to merge yourself, or turn delivery off.`;
  if (d.mode === "off" && d.merge === "auto") return "With delivery off nothing merges automatically: finished work stays on the integration branch for you. Choose local delivery or pull requests to merge automatically.";
  if (d.mode === "off" && d.branch !== undefined) return "Delivery is off, so there is no branch to deliver to; leave the branch out, or choose local delivery or pull requests.";
  if (d.mode !== "off" && !d.branch) return "Name the branch to deliver to.";
  return undefined;
}

/** Delivery exactly as chosen, through the delivery setters (which check the branch names). */
function applyDelivery(state: State, d: FactoryDelivery, now: string): State {
  if (d.mode !== "pr") return setDeliveryMode(state, { mode: d.mode, branch: d.branch }, now);
  return setPrDelivery(setDeliveryMode(state, { mode: "pr" }, now), { ...(d.branch ? { base: d.branch } : {}), merge: d.merge === "auto" ? "auto" : "hold" }, now);
}

/**
 * Apply the factory's settings through the usual setters, each only where it differs, so each change is recorded as
 * usual. Nothing changes that the settings do not name: delivery is applied as given, and Autopilot's planning
 * numbers apply without the preset's delivery or decision route, which are the settings' own.
 */
function applyFactorySettings(state: State, x: FactorySettings, now: string): State {
  let s = applyDelivery(state, x.delivery, now);
  if (autonomyMode(s.project.autonomy) !== x.autonomy) {
    const a = s.project.autonomy;
    if (x.autonomy === "autopilot") s = setAutonomy(s, autopilotAutonomy(a, a.autoDeliver), now);
    else s = setAutonomy(s, { ...a, enabled: x.autonomy === "checkin", holdLeadProposals: x.autonomy === "checkin" ? true : a.holdLeadProposals }, now);
  }
  if (s.project.autonomy.holdLeadProposals !== x.pausePoints.startEachTask) s = setAutonomy(s, { ...s.project.autonomy, holdLeadProposals: x.pausePoints.startEachTask }, now);
  s = F.setTriageRouting(s, x.pausePoints.tradeoffs, now);
  s = setChangeOrders(s, x.pausePoints.changeOrders, now);
  return s;
}

/**
 * Start the factory: the owner's command, and the only way from shaping to building. Refused without the owner's
 * agreement, without a vision, when the draft or the vision changed since they looked (compare-and-set), or while an
 * open item was not confirmed. Its first step is the first Lock in: the draft's changes go into force as a blueprint
 * revision, with the summary (open items stay in the draft). Then it applies the settings, records the agreement
 * (`factoryStarts`, naming the revision in force), and moves to building; on Autopilot the roadmap starts, otherwise
 * it waits for the owner as lead proposals do. Called only from the command table: no steering change, lead output,
 * scheduler path or timer reaches it.
 */
export function startFactory(state: State, req: FactoryRequest, now: string): State {
  if (req.agreed !== true) throw new ControlError("Starting the factory needs your agreement.");
  const why = startFactoryBlocker(state);
  if (why) throw new ControlError(why);
  const seen = draftRev(state);
  if (req.draftRev !== seen) throw new StaleWriteError(req.draftRev, seen);
  const rev = currentVision(state).rev;
  if (req.visionRev !== rev) throw new StaleWriteError(req.visionRev, rev);
  const { areas, items, probes } = openForPreflight(state);
  const open = preflightOpenItems(state);
  const unconfirmed = open.filter((x) => !req.acceptOpen.includes(x));
  if (unconfirmed.length) throw new ControlError(`Still open and not confirmed: ${unconfirmed.join(", ")}. Confirm them to start, or close them first.`);
  const problem = settingsProblem(req.settings);
  if (problem) throw new ControlError(problem);
  const c = draftChanges(state);
  const locks = c.added.length + c.changed.length + c.dropped.length > 0;
  // The start records the Lock in summary: it must be the one the pre-flight showed.
  if (locks) assertSummarySeen(state, req);
  const locked = draft(state);
  // The first Lock in, while still in Vision: no task is building yet, so it makes no change order.
  if (locks) putDraftInForce(locked, now);
  const bp = blueprintRev(locked);
  const s = draft(applyFactorySettings(locked, req.settings, now));
  s.project.stage = "building";
  s.project.factoryStarts.push({ at: now, by: "user", blueprintRev: bp, visionRev: rev, settings: structuredClone(req.settings), openItems: open });
  const { release } = startFactoryPlan(s);
  const released: string[] = [];
  // Only the roadmap's own hold is lifted. A task the user held before start (which took it
  // out of the roadmap hold) keeps that hold; the involvement setting decides the rest.
  for (const t of s.tasks) {
    if (!t.heldForShaping) continue;
    delete t.heldForShaping;
    if (t.lifecycle !== "proposed" && t.lifecycle !== "ready") continue;
    t.holdBeforeStart = !release;
    touch(t, now);
    if (release) {
      released.push(t.id);
      event(s, now, "user", "control", "Released from the roadmap: building started on Autopilot", t.id);
    } else event(s, now, "user", "control", "Building started; this planned task waits for your go-ahead (your involvement setting)", t.id);
  }
  const waiting = roadmapTasks(s).filter((t) => t.holdBeforeStart).length;
  const confirmed = [
    areas.length ? `${areas.length} open area${areas.length === 1 ? "" : "s"} confirmed (${areas.join(", ")})` : "",
    items.length ? `${items.length} open blueprint item${items.length === 1 ? "" : "s"} confirmed (${items.map((i) => i.title).join(", ")})` : "",
    probes.length ? `${probes.length} unfinished probe${probes.length === 1 ? "" : "s"} confirmed (${probes.map((p) => p.question).join("; ")})` : "",
  ].filter(Boolean);
  const agreed = `you agreed to vision r${rev}${bp ? ` and blueprint r${bp}` : ""}${confirmed.length ? ` with ${confirmed.join(" and ")}` : ""}`;
  event(s, now, "user", "config", `Building started: ${agreed}${released.length ? `; roadmap released: ${released.join(", ")}` : waiting ? `; ${waiting} planned task${waiting === 1 ? "" : "s"} wait${waiting === 1 ? "s" : ""} for your go-ahead` : ""}`);
  return s;
}

/**
 * Who acts first on a change order: the lead updates the affected tasks, or it waits for you. It applies to change
 * orders made from now on; open ones keep theirs.
 */
export function setChangeOrders(state: State, who: "lead" | "user", now: string): State {
  if (state.project.changeOrders === who) return state;
  const s = draft(state);
  s.project.changeOrders = who;
  event(s, now, "user", "config", who === "user" ? "Change orders: the lead asks you before it updates tasks" : "Change orders: the lead updates the affected tasks");
  return s;
}

/**
 * The device scope, chosen in Vision: at least one of desktop, mobile and terminal, each once. Vision stays open
 * while the factory runs, so the owner may change it at any time; it decides what the studio designs next, and the
 * factory builds the devices each blueprint item names.
 */
export function setDevices(state: State, devices: Device[], now: string): State {
  const chosen = DEVICES.filter((d) => devices.includes(d));
  if (!chosen.length) throw new ControlError("Choose at least one device: desktop, mobile or terminal.");
  const s = draft(state);
  s.project.devices = chosen;
  event(s, now, "user", "vision", `Device scope: ${chosen.join(", ")}`);
  return s;
}

/** Control characters other than tab and newline, and invisible characters, removed from every text the lead drafts. */
const CONTROL_G = new RegExp(CONTROL_RE.source, "g");
const cleanText = (x: string) => visibleOrEmpty(stripInvisible(x.replace(CONTROL_G, "")).replace(/\r\n?/g, "\n").trim());
const cleanLine = (x: string) => oneLine(x.replace(CONTROL_G, ""));
/** Text the user typed is never altered beyond newline normalization and trimming; joiners and marks stay. */
const userText = (x: string) => x.replace(/\r\n?/g, "\n").trim();
const userLine = (x: string) => x.replace(/\s+/g, " ").trim();

type ValidatedVisionDraft = { ok: true; draft: { text: string; focus: string; reason: string } } | { ok: false; why: string };

/**
 * Strict validation of the lead's vision draft (untrusted data). Only runs that answer the user's
 * messages may draft. The text keeps its newlines; the focus is one line; both are capped and cleaned.
 * A draft identical to the current vision is refused as nothing to decide.
 */
export function validateVisionDraft(s: State, r: LeadRun, vision: unknown): ValidatedVisionDraft {
  if (r.messageIds.length === 0) return { ok: false, why: "planning runs cannot draft the vision" };
  if (!vision || typeof vision !== "object" || Array.isArray(vision)) return { ok: false, why: "the draft was not an object" };
  const v = vision as Record<string, unknown>;
  if (typeof v.text !== "string") return { ok: false, why: "the draft needs a text" };
  if (v.text.length > MAX_VISION_TEXT * 2) return { ok: false, why: `the text is over ${MAX_VISION_TEXT} characters` };
  const text = cleanText(v.text);
  if (!text) return { ok: false, why: "the text is empty" };
  if (text.length > MAX_VISION_TEXT) return { ok: false, why: `the text is over ${MAX_VISION_TEXT} characters` };
  const cur = currentVision(s);
  let focus = cur.focus;
  if (v.focus !== undefined && v.focus !== null) {
    if (typeof v.focus !== "string") return { ok: false, why: "the focus must be text" };
    focus = cleanLine(v.focus);
    if (focus.length > MAX_VISION_FOCUS) return { ok: false, why: `the focus is over ${MAX_VISION_FOCUS} characters` };
  }
  let reason = "Drafted from your messages";
  if (v.reason !== undefined && v.reason !== null) {
    if (typeof v.reason !== "string") return { ok: false, why: "the reason must be text" };
    reason = cleanLine(v.reason).slice(0, 500) || reason;
  }
  // While building, the text to compare with is the draft's (an edit after the start waits there for Lock in).
  if (text === draftVisionText(s).trim() && focus === oneLine(cur.focus)) return { ok: false, why: "the draft is the same as the current vision" };
  return { ok: true, draft: { text, focus, reason } };
}

/** Record a validated draft as an open suggestion; an older open draft is superseded. Nothing is applied. */
export function draftFromRun(s: State, r: LeadRun, d: { text: string; focus: string; reason: string }, now: string, simulated?: true): VisionDraft {
  for (const old of s.visionDrafts) {
    if (old.status !== "open") continue;
    old.status = "superseded";
    old.resolvedAt = now;
  }
  // The revision the run saw, not the one current at completion, so a vision that moved
  // meanwhile is shown as moved and Accept never silently replaces it.
  // A draft from the simulated lead carries the flag, which Accept copies onto the revision.
  const draft: VisionDraft = { id: `vd-${r.id}`, at: now, leadRunId: r.id, messageIds: [...r.messageIds], text: d.text, focus: d.focus, reason: d.reason, basedOnVisionRev: r.visionRev ?? currentVision(s).rev, status: "open", ...(simulated ? { simulated: true as const } : {}) };
  s.visionDrafts.push(draft);
  if (s.visionDrafts.length > MAX_VISION_DRAFTS) s.visionDrafts.splice(0, s.visionDrafts.length - MAX_VISION_DRAFTS);
  event(s, now, "lead", "vision", `Lead run ${r.id} drafted the vision (${draft.id}) from your message ${r.messageIds.join(", ")}: ${d.reason}. It waits for you to accept, edit or dismiss it.`);
  return draft;
}

const MAX_QUESTIONS = 5;
const MAX_QUESTION_LENGTH = 300;
const MAX_QUESTION_WHY = 200;
const MAX_QUESTION_OPTIONS = 4;
const MAX_OPTION_LENGTH = 120;

const isArea = (v: unknown): v is ShapingArea => typeof v === "string" && (SHAPING_AREAS as string[]).includes(v);
const isCoverageState = (v: unknown): v is CoverageState => typeof v === "string" && (COVERAGE_STATES as string[]).includes(v);

/**
 * Strict validation of the lead's coverage block: only the known areas and states are kept; everything
 * else is ignored with a note. Only runs that answer the user may report coverage.
 */
export function validateCoverage(r: LeadRun, raw: unknown): { ok: true; coverage: Coverage; notes: string[] } | { ok: false; notes: string[] } {
  if (r.messageIds.length === 0) return { ok: false, notes: ["planning runs cannot report coverage"] };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, notes: ["the coverage block was not an object"] };
  const notes: string[] = [];
  const coverage: Coverage = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!isArea(k)) {
      notes.push(`unknown area "${cleanLine(k).slice(0, 40)}" ignored`);
      continue;
    }
    if (!isCoverageState(v)) {
      notes.push(`${k}: "${typeof v === "string" ? cleanLine(v).slice(0, 40) : typeof v}" is not clear, partial or open; ignored`);
      continue;
    }
    coverage[k] = v;
  }
  return { ok: true, coverage, notes };
}

/**
 * Strict validation of the lead's questions: at most 5, each at most 300 characters with a reason of at
 * most 200 and at most 4 options of at most 120, control characters removed. An entry over a cap or of the
 * wrong shape is left out with a note; the rest stand. Only runs that answer the user may ask.
 */
export function validateQuestions(r: LeadRun, raw: unknown): { questions: LeadQuestion[]; notes: string[] } {
  if (r.messageIds.length === 0) return { questions: [], notes: ["planning runs cannot ask the user"] };
  if (!Array.isArray(raw)) return { questions: [], notes: ["the questions block was not a list"] };
  const notes: string[] = [];
  const questions: LeadQuestion[] = [];
  const extra = raw.length - MAX_QUESTIONS;
  if (extra > 0) notes.push(`${extra} more ignored: at most ${MAX_QUESTIONS} questions in one reply`);
  raw.slice(0, MAX_QUESTIONS).forEach((entry: unknown, i: number) => {
    const n = `#${i + 1}`;
    const it = entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as Record<string, unknown>) : undefined;
    if (!it) return notes.push(`${n} ignored: not an object`);
    if (typeof it.question !== "string" || !cleanLine(it.question)) return notes.push(`${n} ignored: the question must be text`);
    const question = cleanLine(it.question);
    if (question.length > MAX_QUESTION_LENGTH) return notes.push(`${n} ignored: the question is over ${MAX_QUESTION_LENGTH} characters`);
    let why = "";
    if (it.why !== undefined && it.why !== null) {
      if (typeof it.why !== "string") return notes.push(`${n} ignored: why must be text`);
      why = cleanLine(it.why);
      if (why.length > MAX_QUESTION_WHY) return notes.push(`${n} ignored: why is over ${MAX_QUESTION_WHY} characters`);
    }
    const q: LeadQuestion = { question, why };
    if (it.area !== undefined && it.area !== null) {
      if (isArea(it.area)) q.area = it.area;
      else notes.push(`${n}: unknown area ignored`);
    }
    if (it.options !== undefined && it.options !== null) {
      if (!Array.isArray(it.options)) notes.push(`${n}: options ignored: not a list`);
      else {
        const more = it.options.length - MAX_QUESTION_OPTIONS;
        if (more > 0) notes.push(`${n}: ${more} more option(s) ignored: at most ${MAX_QUESTION_OPTIONS}`);
        const options: string[] = [];
        for (const o of it.options.slice(0, MAX_QUESTION_OPTIONS)) {
          if (typeof o !== "string" || !cleanLine(o)) {
            notes.push(`${n}: an option was ignored: not text`);
            continue;
          }
          const text = cleanLine(o);
          if (text.length > MAX_OPTION_LENGTH) {
            notes.push(`${n}: an option was ignored: over ${MAX_OPTION_LENGTH} characters`);
            continue;
          }
          // The same option twice is one option.
          if (options.includes(text)) {
            notes.push(`${n}: a repeated option was ignored`);
            continue;
          }
          options.push(text);
        }
        if (options.length) q.options = options;
      }
    }
    questions.push(q);
  });
  return { questions, notes };
}

/**
 * The coverage as it stands: from the newest completed run that reported one, with every area it did
 * not name counted as open. Undefined until a run has reported coverage.
 */
export function coverageOf(s: State): Record<ShapingArea, CoverageState> | undefined {
  const since = s.project.shapingSince;
  for (let i = s.leadRuns.length - 1; i >= 0; i--) {
    const r = s.leadRuns[i];
    // Coverage from an earlier shaping session (before this one began) is not reused.
    if (since && r.startedAt < since) break;
    const c = r.coverage;
    if (r.outcome !== "completed" || !c) continue;
    const out = {} as Record<ShapingArea, CoverageState>;
    for (const a of SHAPING_AREAS) out[a] = c[a] ?? "open";
    return out;
  }
  return undefined;
}

/** Areas still open by the latest coverage of this shaping session; every area while none was reported. Informational: never a block. */
export function openAreas(s: State): ShapingArea[] {
  const c = coverageOf(s);
  return c ? SHAPING_AREAS.filter((a) => c[a] === "open") : [...SHAPING_AREAS];
}

/** The newest lead questions the user has not written back since (the panel offers inline answers to these). */
export function latestQuestions(s: State): { message: Message; questions: LeadQuestion[] } | undefined {
  for (let i = s.conversation.length - 1; i >= 0; i--) {
    const m = s.conversation[i];
    if (m.author === "user") return undefined;
    if (m.author === "lead") return m.questions?.length ? { message: m, questions: m.questions } : undefined;
  }
  return undefined;
}

/** One user message from the inline answers: each answered question followed by its answer; unanswered ones are skipped. */
export function answersMessage(questions: LeadQuestion[], answers: string[]): string {
  const parts: string[] = [];
  questions.forEach((q, i) => {
    const a = (answers[i] ?? "").trim();
    if (a) parts.push(`Q: ${q.question}\nA: ${a}`);
  });
  return parts.join("\n\n");
}

function getVisionDraft(s: State, draftId: string): VisionDraft {
  const d = s.visionDrafts.find((x) => x.id === draftId);
  if (!d) throw new ControlError(`Unknown vision draft ${draftId}`);
  return d;
}

/**
 * Accept a draft, as drafted or with the user's edits: a user-authored vision revision that records the
 * draft. Compare-and-set on the vision revision, like a hand edit.
 */
export function acceptVisionDraft(state: State, draftId: string, expectedRev: number, edits: { text?: string; focus?: string } | undefined, now: string): State {
  const d = getVisionDraft(state, draftId);
  if (d.status !== "open") throw new ControlError(d.status === "accepted" ? "This draft was already accepted." : d.status === "dismissed" ? "This draft was dismissed." : "A newer draft replaced this one.");
  const cur = currentVision(state);
  if (cur.rev !== expectedRev) throw new StaleWriteError(expectedRev, cur.rev);
  const edited = edits?.text !== undefined || edits?.focus !== undefined;
  const text = edits?.text !== undefined ? userText(edits.text) : d.text;
  const focus = edits?.focus !== undefined ? userLine(edits.focus) : d.focus;
  if (!text) throw new ControlError("The vision cannot be empty.");
  if (text.length > MAX_VISION_TEXT) throw new ControlError(`The vision is limited to ${MAX_VISION_TEXT} characters.`);
  if (focus.length > MAX_VISION_FOCUS) throw new ControlError(`The focus is limited to ${MAX_VISION_FOCUS} characters.`);
  // Accepting what already stands would record a revision that changes nothing.
  const base = draftVisionText(state);
  if (text === base.trim() && focus === oneLine(cur.focus)) throw new ControlError("Nothing differs from the current vision; change the text or dismiss the draft.");
  const s = draft(state);
  const draftRec = getVisionDraft(s, draftId);
  const why = `${edited ? "Accepted the lead's draft with edits" : "Accepted the lead's draft"} (${d.id}): ${d.reason}`;
  const source = { draftId: d.id, leadRunId: d.leadRunId, messageIds: [...d.messageIds] };
  if (s.project.stage === "building") {
    // While building (pass 5, r10), the text joins the blueprint's draft until your Lock in; a new focus applies now.
    if (text !== base) setDraftVisionInto(s, { text, reason: why, source, ...(d.simulated ? { simulated: true as const } : {}) }, now);
    const rev = focus !== cur.focus ? pushVision(s, { author: "user", text: cur.text, focus, reason: why, source, ...(d.simulated ? { simulated: true as const } : {}) }, now) : undefined;
    draftRec.status = "accepted";
    draftRec.resolvedAt = now;
    if (rev) draftRec.visionRev = rev.rev;
    return s;
  }
  const rev = pushVision(
    s,
    // A draft the simulated lead wrote stays labelled once it is the vision, edited or not.
    { author: "user", text, focus, reason: why, source, ...(d.simulated ? { simulated: true as const } : {}) },
    now,
    `Vision r${cur.rev + 1} by you: accepted the lead's draft ${d.id}${edited ? " with edits" : ""}`,
  );
  draftRec.status = "accepted";
  draftRec.resolvedAt = now;
  draftRec.visionRev = rev.rev;
  return s;
}

/** Dismiss a draft. The vision is unchanged; the lead sees the dismissal in its next envelope. */
export function dismissVisionDraft(state: State, draftId: string, now: string): State {
  const d = getVisionDraft(state, draftId);
  if (d.status !== "open") throw new ControlError(`This draft is already ${d.status}.`);
  const s = draft(state);
  const rec = getVisionDraft(s, draftId);
  rec.status = "dismissed";
  rec.resolvedAt = now;
  event(s, now, "user", "vision", `Dismissed the lead's vision draft ${d.id}; the vision is unchanged`);
  return s;
}
