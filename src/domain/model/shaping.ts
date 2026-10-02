// A project is shaping or building. While shaping, the lead answers messages and may draft the vision
// and propose a first roadmap, but no worker step is dispatched and no planning run starts. A draft is
// a suggestion: the vision changes only when the user accepts it. Start building needs a vision and
// releases the roadmap on Autopilot; going back to shaping stops nothing that is running.

import {
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
  SHAPING_AREAS,
  StaleWriteError,
} from "../types";
import { activeAttempts, currentVision, draft, event, touch } from "./core";
import { CONTROL_RE, oneLine, stripInvisible, visibleOrEmpty } from "./textSafety";
import { pushVision } from "./vision";

const MAX_VISION_TEXT = 8000;
const MAX_VISION_FOCUS = 300;
const MAX_VISION_DRAFTS = 50;

/** The one line shown wherever new work would otherwise be expected to start. Never "Paused". */
export const SHAPING_LABEL = "Shaping: new work waits until you start building";

/** Why Start building is refused, or undefined when it is allowed. */
export function startBuildingBlocker(s: State): string | undefined {
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
 * What Start building would do now. It uses the involvement setting at the moment it
 * runs, never one recorded earlier, and lifts only the roadmap's own hold: `roadmap` are the planned
 * tasks it releases or hands to the user's release; `userHeld` are planned tasks whose hold the user
 * took over, which keep waiting for the user either way.
 */
export function startBuildingPlan(s: State): { release: boolean; roadmap: Task[]; userHeld: Task[] } {
  const a = s.project.autonomy;
  const open = roadmapTasks(s);
  return { release: a.enabled && !a.holdLeadProposals, roadmap: open.filter((t) => t.heldForShaping), userHeld: open.filter((t) => !t.heldForShaping && t.holdBeforeStart) };
}

/**
 * Start building. Refused without a vision. On Autopilot (autonomy on and lead proposals not held) the
 * roadmap starts; with Check-in or Manual it keeps waiting for the user, as lead proposals do.
 */
export function startBuilding(state: State, now: string): State {
  const why = startBuildingBlocker(state);
  if (why) throw new ControlError(why);
  const s = draft(state);
  s.project.stage = "building";
  const { release } = startBuildingPlan(s);
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
  event(s, now, "user", "config", `Building started${released.length ? `; roadmap released: ${released.join(", ")}` : waiting ? `; ${waiting} planned task${waiting === 1 ? "" : "s"} wait${waiting === 1 ? "s" : ""} for your go-ahead` : ""}`);
  return s;
}

/** Back to shaping: nothing running is stopped and nothing new starts. Available at any time. */
export function startShaping(state: State, now: string): State {
  if (state.project.stage === "shaping") throw new ControlError("Already shaping.");
  const s = draft(state);
  s.project.stage = "shaping";
  // A new shaping session; coverage the lead reported in an earlier one is not reused.
  s.project.shapingSince = now;
  // Continuing past the building budget lasted while building; the next start meets the budget stop again.
  delete s.project.budgetContinued;
  const running = activeAttempts(s).length;
  event(s, now, "user", "config", `Shaping the vision; new work waits until you start building${running ? ` (${running} running step${running === 1 ? " finishes" : "s finish"} normally)` : ""}`);
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
  if (text === cur.text.trim() && focus === oneLine(cur.focus)) return { ok: false, why: "the draft is the same as the current vision" };
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
  if (text === cur.text.trim() && focus === oneLine(cur.focus)) throw new ControlError("Nothing differs from the current vision; change the text or dismiss the draft.");
  const s = draft(state);
  const draftRec = getVisionDraft(s, draftId);
  const rev = pushVision(
    s,
    // A draft the simulated lead wrote stays labelled once it is the vision, edited or not.
    { author: "user", text, focus, reason: `${edited ? "Accepted the lead's draft with edits" : "Accepted the lead's draft"} (${d.id}): ${d.reason}`, source: { draftId: d.id, leadRunId: d.leadRunId, messageIds: [...d.messageIds] }, ...(d.simulated ? { simulated: true as const } : {}) },
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
