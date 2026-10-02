// The lead's studio block (ORC-029 pass 4): how the lead runs the studio from its replies in Vision.
//
// A reply to the owner's messages may carry `studio`: open a round (`openRound`), ask for designer runs
// (`designerRuns`, at most 3), ask the owner questions (`questions`, at most 5), and close the round (`closeRound`).
// It is the lead's output, so untrusted data: each part is checked here, anything over a cap or of the wrong shape is
// left out with a note the owner sees under the reply, and the rest stands. Rounds open and close through the studio's
// own rules (studio.ts) and designer runs are asked for through the service's path (runs.ts), queued for the
// scheduler, exactly as the service's own commands would.
//
// What the block cannot do. It has no field that approves an artifact or a round, overrules the PE, locks in a
// vision, starts the factory, or sends the owner's feedback: those are owner commands (commands.ts), and nothing here
// calls them. An unknown field is named in a note and ignored. Only a reply to the owner, in Vision, runs the studio.
// Pure: returns a new State.

import { validateQuestions } from "../model/shaping";
import { CONTROL_RE, stripInvisible, visibleOrEmpty } from "../model/textSafety";
import { ControlError, DEVICES, type Device, type LeadRun, type State } from "../types";
import { requestStudioRun, type StudioRunRequest } from "./runs";
import { artifactName, closeRound, currentRound, latestVersion, openRound } from "./studio";
import { DESIGNER_KINDS, DOCUMENT_KINDS, ROUND_FOCUSES, type RoundFocus, type RoundQuestion, type StudioArtifactKind } from "./types";

/** The most designer runs one reply asks for. */
export const MAX_DESIGNER_RUNS = 3;
/** The most variants the lead asks one designer run for, side by side. */
export const MAX_RUN_VARIANTS = 3;
/** The longest brief the lead writes for one designer run, in characters. */
export const MAX_LEAD_BRIEF = 4000;
const MAX_KINDS = 4;
const BLOCK_FIELDS = ["openRound", "designerRuns", "questions", "closeRound"];

const CONTROL_G = new RegExp(CONTROL_RE.source, "g");
const agentText = (x: string) => visibleOrEmpty(stripInvisible(x.replace(CONTROL_G, "")).replace(/\r\n?/g, "\n").trim());
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** A studio rule's refusal, for a note; anything else is a bug and is thrown on. */
function refusal(e: unknown): string {
  if (e instanceof ControlError) return e.message;
  throw e;
}

export interface StudioBlockResult {
  state: State;
  /** What was left out, and why, for the note under the reply. */
  notes: string[];
  /** The round the block addressed: open after it, or the one it closed. The reply and the questions are stored there. */
  round?: number;
  questions: RoundQuestion[];
  /** The designer runs asked for, queued. */
  runs: string[];
}

/** What the lead asked one designer run for, checked, with the brief the run records. */
type DesignerAsk = { req: Omit<StudioRunRequest, "round">; label: string };

/**
 * One entry of `designerRuns`: a brief, the kinds (designer kinds, 1 to 4), the variants (1 to 3), the devices
 * (within the project's scope; none for documents), and optionally `revises`, an artifact to make the next version of.
 */
function designerAsk(s: State, r: LeadRun, raw: unknown): DesignerAsk | string {
  if (!isObj(raw)) return "not an object";
  if (typeof raw.brief !== "string") return "the brief must be text";
  const lead = agentText(raw.brief);
  if (!lead) return "the brief is empty";
  if (lead.length > MAX_LEAD_BRIEF) return `the brief is over ${MAX_LEAD_BRIEF} characters`;
  const revises = raw.revises === undefined || raw.revises === null ? undefined : raw.revises;
  if (revises !== undefined && typeof revises !== "string") return "revises must be an artifact id";
  const base = revises === undefined ? undefined : latestVersion(s, revises);
  if (revises !== undefined && !base) return `there is no studio artifact ${String(revises).slice(0, 40)} to revise`;
  let kinds: StudioArtifactKind[];
  if (raw.kinds === undefined && base) kinds = [base.kind];
  else {
    if (!Array.isArray(raw.kinds) || !raw.kinds.length || raw.kinds.length > MAX_KINDS) return `kinds lists 1 to ${MAX_KINDS} of ${DESIGNER_KINDS.join(", ")}`;
    const unknown = raw.kinds.filter((k) => !DESIGNER_KINDS.includes(k as StudioArtifactKind));
    if (unknown.length) return `${unknown.map((k) => JSON.stringify(String(k).slice(0, 30))).join(", ")} is not a kind the designer makes (${DESIGNER_KINDS.join(", ")})`;
    kinds = DESIGNER_KINDS.filter((k) => (raw.kinds as unknown[]).includes(k));
    if (base && (kinds.length !== 1 || kinds[0] !== base.kind)) return `${base.title} is a ${base.kind}; its next version keeps that kind`;
  }
  const variants = raw.variants;
  if (typeof variants !== "number" || !Number.isInteger(variants) || variants < 1 || variants > MAX_RUN_VARIANTS) return `variants is a whole number from 1 to ${MAX_RUN_VARIANTS}`;
  const given = raw.devices === undefined || raw.devices === null ? [] : raw.devices;
  if (!Array.isArray(given) || !given.every((d) => DEVICES.includes(d as Device))) return `devices lists ${DEVICES.join(", ")}`;
  const outside = given.filter((d) => !s.project.devices.includes(d as Device));
  if (outside.length) return `${outside.join(", ")} ${outside.length === 1 ? "is" : "are"} outside the project's device scope (${s.project.devices.join(", ")})`;
  const devices = DEVICES.filter((d) => given.includes(d));
  const documents = kinds.every((k) => DOCUMENT_KINDS.includes(k));
  const ask = `The lead asks for: ${kinds.join(", ")}; ${variants === 1 ? "one take" : `${variants} variants side by side, differing in a real choice`}; ${devices.length ? `for ${devices.join(", ")}` : documents ? "documents, with no devices" : "no devices named"}${base ? `; the next version of ${artifactName(base)} (${base.id})` : ""}.`;
  return {
    req: { kind: "designer", brief: `${lead}\n\n${ask}`, ...(base ? { artifactId: base.id } : {}), fromLead: { leadRunId: r.id, kinds, variants, devices } },
    label: lead.split("\n")[0].slice(0, 60),
  };
}

/**
 * Apply the studio block of a completed lead run: close the open round, open the next, ask for the designer runs in
 * the round then open, and check the questions. Returns the new state, the notes, and the round the block addressed
 * (completeLeadRun stores the reply and the questions there).
 */
export function applyStudioBlock(state: State, r: LeadRun, raw: unknown, now: string): StudioBlockResult {
  const none = (note: string): StudioBlockResult => ({ state, notes: [note], questions: [], runs: [] });
  if (r.messageIds.length === 0) return none("only a reply to your messages runs the studio; nothing was changed");
  if (state.project.stage !== "shaping") return none("the studio runs in Vision; nothing was changed");
  if (!isObj(raw)) return none("the studio block was not an object; nothing was changed");
  const notes: string[] = [];
  const ignored = Object.keys(raw).filter((k) => !BLOCK_FIELDS.includes(k));
  // Approving, overruling, locking in, starting the factory and the owner's feedback are the owner's; the block names none of them.
  if (ignored.length) notes.push(`ignored ${ignored.map((k) => JSON.stringify(k.slice(0, 40))).join(", ")}: the studio block only opens and closes rounds, asks for designer runs and asks questions`);
  let s = state;
  let addressed: number | undefined;

  if (raw.closeRound !== undefined && raw.closeRound !== null && raw.closeRound !== false) {
    const c = raw.closeRound;
    const open = currentRound(s);
    if (c !== true && !(isObj(c) && (c.summary === undefined || typeof c.summary === "string"))) notes.push('closeRound is true or { "summary": "<what came of it>" }; the round stays open');
    else if (!open) notes.push("closeRound: no round is open");
    else {
      try {
        s = closeRound(s, open.n, isObj(c) && typeof c.summary === "string" ? c.summary : undefined, now);
        addressed = open.n;
      } catch (e) {
        notes.push(`closeRound: ${refusal(e)}`);
      }
    }
  }

  let opened = true;
  if (raw.openRound !== undefined && raw.openRound !== null) {
    const o = raw.openRound;
    if (!isObj(o) || !ROUND_FOCUSES.includes(o.focus as RoundFocus) || (o.summary !== undefined && typeof o.summary !== "string")) {
      notes.push(`openRound is { "focus": ${ROUND_FOCUSES.map((f) => `"${f}"`).join(" | ")}, "summary": "<what the round explores>" }; no round was opened`);
      opened = false;
    } else {
      try {
        const next = openRound(s, { focus: o.focus as RoundFocus, summary: o.summary as string | undefined, leadRunId: r.id }, now);
        s = next.state;
        addressed = next.n;
      } catch (e) {
        notes.push(`openRound: ${refusal(e)}`);
        opened = false;
      }
    }
  }
  const open = currentRound(s);
  if (open) addressed = open.n;

  const runs: string[] = [];
  if (raw.designerRuns !== undefined && raw.designerRuns !== null) {
    const list = raw.designerRuns;
    if (!Array.isArray(list)) notes.push("designerRuns was not a list; no designer run was asked for");
    else if (!opened) notes.push(`${list.length} designer run${list.length === 1 ? " was" : "s were"} not asked for: the round ${list.length === 1 ? "it was" : "they were"} for did not open`);
    else if (!open) notes.push(`${list.length} designer run${list.length === 1 ? " was" : "s were"} not asked for: no round is open`);
    else {
      if (list.length > MAX_DESIGNER_RUNS) notes.push(`${list.length - MAX_DESIGNER_RUNS} more designer run${list.length - MAX_DESIGNER_RUNS === 1 ? "" : "s"} ignored: at most ${MAX_DESIGNER_RUNS} in one reply`);
      list.slice(0, MAX_DESIGNER_RUNS).forEach((entry: unknown, i: number) => {
        const ask = designerAsk(s, r, entry);
        if (typeof ask === "string") return void notes.push(`designer run #${i + 1} not asked for: ${ask}`);
        try {
          const asked = requestStudioRun(s, { ...ask.req, round: open.n }, now);
          s = asked.state;
          runs.push(asked.runId);
        } catch (e) {
          notes.push(`designer run #${i + 1} ("${ask.label}") not asked for: ${refusal(e)}`);
        }
      });
    }
  }

  let questions: RoundQuestion[] = [];
  if (raw.questions !== undefined && raw.questions !== null) {
    const q = validateQuestions(r, raw.questions);
    notes.push(...q.notes.map((n) => `questions: ${n}`));
    questions = q.questions.map((x) => ({ text: x.question, ...(x.why ? { reason: x.why } : {}), ...(x.options?.length ? { options: [...x.options] } : {}) }));
    if (questions.length && addressed === undefined) {
      notes.push(`questions: ${questions.length} not shown in the studio: no round is open`);
      questions = [];
    }
  }
  return { state: s, notes, ...(addressed !== undefined ? { round: addressed } : {}), questions, runs };
}

/** Store the lead's reply and questions on the round its studio block addressed (mutates a draft). */
export function setRoundLead(s: State, n: number, message: string, questions: RoundQuestion[]) {
  const round = s.studio.rounds.find((x) => x.n === n);
  if (round) round.lead = { message, questions };
}
