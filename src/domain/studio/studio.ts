// The vision studio's rules (ORC-029 2c): rounds, artifacts and their versions, the owner's feedback, PE review with
// its loop rule, the owner's overrule, and probes. Pure: each operation returns a new State.
//
// Who calls what. The owner's feedback and overrule are owner commands. Opening and closing rounds, adding artifacts,
// recording the PE's verdicts and a probe's progress are the service's, from the studio's runs (passes 3 and 4);
// clients cannot send them (SERVICE_COMMANDS in commands.ts). The lead never approves: approval is blueprint.ts's.
//
// The loop rule (ORC-029 pass 4). The PE judges every option before the owner sees it. When its pass asks for a change
// (feasible-if) or objects (not-feasible) to a variant, the designer revises the version in the same round and the PE
// reviews the new one, up to three passes in a round. A version reaches the owner when the PE's latest pass finds
// every variant feasible, or once review ends (`LoopEnd`: the third pass, a reproduction of the code, the round
// closed, runs that failed twice, or no provider to run the next step), with the PE's open objections and asked-for
// changes shown. Where review stands is one value, `PeReview`, and the words the owner and the lead see are made from
// it. An objection is never dropped: a later pass on a revision answers it, or the owner overrules it (recorded). A
// kind the PE does not review (`KIND_RULES` in types.ts: what the owner brought, a probe's evidence, the dictionary) is
// not held back: its review is "not-reviewed", from which the same words are made.
//
// Convergence (the second real trial, 2026-10-02: the PE asked for more on each pass, the designer added it all, and
// the loop ended without agreement). Only a change sends a variant back; the product questions the PE notices are
// open cases, for the owner through the lead. On a later pass the PE first checks each change it asked for earlier in
// the round (met or not), and a change then answers an ask that is not met, or a risk the revision created, said so.
// `addPeVerdicts` refuses a later pass that does neither, so the asks cannot grow from pass to pass.

import { draft, event, nextId } from "../model/core";
import { CONTROL_RE, oneLine, stripInvisible, visibleOrEmpty } from "../model/textSafety";
import { ControlError, DEVICES, StaleWriteError, type Device, type ProviderId, type State } from "../types";
import {
  type ArtifactDemo,
  type ArtifactShots,
  type AskCheck,
  type BudgetEstimate,
  type DictionaryEntry,
  type Feedback,
  type LoopEnd,
  type Mark,
  type OpenCase,
  type PeVerdict,
  type Pin,
  type Probe,
  type ProbeStatus,
  type Round,
  type RoundFocus,
  type RowMark,
  type StudioArtifact,
  type StudioArtifactKind,
  type StudioMaker,
  type StudioRun,
  type Verdict,
  type VariantDemo,
  type VariantRules,
  KIND_RULES,
  VERDICT_WORDS,
  isUnderWay,
} from "./types";

/** The PE's passes on an artifact within one round. After the last, the artifact goes to the owner as it is. */
export const MAX_PE_PASSES = 3;
const MAX_VARIANTS = 6;
const MAX_FILES = 100;
const MAX_PINS = 50;
/** The longest element description a pin keeps; the prototype's pin script cuts its own at this length (src/runtime/prototype.ts). */
const MAX_PIN_SELECTOR = 300;

// ---------- text ----------

const CONTROL_G = new RegExp(CONTROL_RE.source, "g");
/** One line of an agent's text: control and invisible characters removed, whitespace collapsed. */
const agentLine = (x: string) => oneLine(x.replace(CONTROL_G, ""));
/** An agent's paragraph: newlines kept, control and invisible characters removed. */
const agentText = (x: string) => visibleOrEmpty(stripInvisible(x.replace(CONTROL_G, "")).replace(/\r\n?/g, "\n").trim());
/** The owner's text is kept as typed, apart from newlines and the ends. */
const ownerText = (x: string) => x.replace(/\r\n?/g, "\n").trim();

function capped(text: string, max: number, what: string): string {
  if (text.length > max) throw new ControlError(`${what} is over ${max} characters.`);
  return text;
}
function required(text: string, max: number, what: string): string {
  if (!text) throw new ControlError(`${what} is empty.`);
  return capped(text, max, what);
}

// ---------- lookups ----------

/** The round in progress, if one is open. */
export function currentRound(s: State): Round | undefined {
  return s.studio.rounds.find((r) => !r.closedAt);
}

function getRound(s: State, n: number): Round {
  const r = s.studio.rounds.find((x) => x.n === n);
  if (!r) throw new ControlError(`There is no round ${n}.`);
  return r;
}

/** Every version of an artifact, oldest first. */
export function versionsOf(s: State, artifactId: string): StudioArtifact[] {
  return s.studio.artifacts.filter((a) => a.id === artifactId).sort((a, b) => a.version - b.version);
}

/** The newest version of an artifact. */
export function latestVersion(s: State, artifactId: string): StudioArtifact | undefined {
  return versionsOf(s, artifactId).at(-1);
}

/** The newest version of every artifact, in the order the artifacts were first added. */
export function latestArtifacts(s: State): StudioArtifact[] {
  const ids = [...new Set(s.studio.artifacts.map((a) => a.id))];
  return ids.map((id) => latestVersion(s, id)!);
}

export function getArtifact(s: State, artifactId: string, version: number): StudioArtifact {
  const all = versionsOf(s, artifactId);
  if (!all.length) throw new ControlError(`Unknown studio artifact ${artifactId}.`);
  const a = all.find((x) => x.version === version);
  if (!a) throw new ControlError(`${all[0].title} has no version ${version}.`);
  return a;
}

/** "Trip plan v2" */
export const artifactName = (a: StudioArtifact) => `${a.title} v${a.version}`;

/** The owner's current feedback on a version: the last record for it. */
export function currentFeedback(s: State, artifactId: string, version: number): Feedback | undefined {
  for (let i = s.studio.feedback.length - 1; i >= 0; i--) {
    const f = s.studio.feedback[i];
    if (f.artifactId === artifactId && f.version === version) return f;
  }
  return undefined;
}

/** The owner's open pins on a version: those of its current feedback. A revision starts with the open pins of the version before. */
export function openPins(s: State, artifactId: string, version: number): Pin[] {
  return currentFeedback(s, artifactId, version)?.pins ?? [];
}

const variantLabel = (a: StudioArtifact, id: string | undefined) => (id === undefined ? "" : (a.variants.find((v) => v.id === id)?.label ?? id));

// ---------- rounds ----------

/**
 * Open the next round (the service, for the lead's run). What already exists is round 0 and only it is about the
 * material: what the owner brought, or "as it is today" for an existing repository. The lead's other rounds count
 * from 1. One round at a time: the open one is closed first.
 */
export function openRound(state: State, input: { focus: RoundFocus; summary?: string; leadRunId?: string }, now: string): { state: State; n: number } {
  const busy = currentRound(state);
  if (busy) throw new ControlError(`Round ${busy.n} is still open; close it first.`);
  const last = state.studio.rounds.at(-1);
  if (input.focus === "material" && last) throw new ControlError("What the owner brought is round 0, the first round; a later round is about the experience, the data or the flows.");
  const n = input.focus === "material" ? 0 : last ? last.n + 1 : 1;
  const summary = capped(agentText(input.summary ?? ""), 2000, "The round's summary");
  const s = draft(state);
  s.studio.rounds.push({ n, focus: input.focus, openedAt: now, ...(input.leadRunId ? { leadRunId: input.leadRunId } : {}), summary });
  event(s, now, "lead", "vision", `Round ${n} opened: ${FOCUS_WORDS[input.focus]}${summary ? `. ${summary.split("\n")[0]}` : ""}`);
  return { state: s, n };
}

const FOCUS_WORDS: Record<RoundFocus, string> = { material: "what you brought", experience: "the experience", data: "the inputs and outputs", flows: "the flows" };

/**
 * Close a round (the service, once the owner answered it or the lead moved on). The summary, when given, replaces the
 * opening one. The lead's close waits while the round is busy (`roundBusy`, lead.ts); a close here is the mechanism:
 * PE review still going on in the round ends then (`round-closed`), and the version goes to the owner as it is.
 */
export function closeRound(state: State, n: number, summary: string | undefined, now: string): State {
  const r = getRound(state, n);
  if (r.closedAt) throw new ControlError(`Round ${n} is already closed.`);
  const text = summary === undefined ? undefined : capped(agentText(summary), 2000, "The round's summary");
  const s = draft(state);
  const round = getRound(s, n);
  round.closedAt = now;
  if (text) round.summary = text;
  event(s, now, "lead", "vision", `Round ${n} closed${text ? `: ${text.split("\n")[0]}` : ""}`);
  return s;
}

// ---------- artifacts ----------

export interface ArtifactInput {
  /** A new version of this artifact; absent for a new artifact. */
  artifactId?: string;
  round: number;
  kind: StudioArtifactKind;
  title: string;
  /** `entry`: the variant's entry file, one of `files`. */
  variants: { id: string; label: string; entry?: string }[];
  files: { path: string; sha256: string }[];
  devices: Device[];
  madeBy: StudioMaker;
  supersedes?: string;
  /** An "as is" artifact's provenance: the repository files the designer reproduced it from (round 0 only). */
  provenance?: { files: string[] };
  /** A dictionary's terms, checked at the boundary (words.ts `parseDictionary`). A dictionary has them; nothing else does. */
  dictionary?: DictionaryEntry[];
  /** A flow's rules, by variant, checked at the boundary (words.ts `parseRules`). Only a flow has them. */
  rules?: VariantRules[];
}

/** The most repository files an "as is" artifact names as its provenance. */
export const MAX_PROVENANCE = 50;

/**
 * A path that stays inside the folder it is relative to: not absolute, at most 300 characters, with no empty, "." or
 * ".." name, no backslash and no control character (tabs and newlines included). The one check for the studio's paths:
 * a version's files, and the repository files an "as is" artifact came from (here, and at the boundary in
 * server/studio/artifacts.ts).
 */
export const isInsidePath = (p: string) => !!p && p.length <= 300 && !p.startsWith("/") && !p.includes("\\") && !/[\u0000-\u001f\u007f]/.test(p) && p.split("/").every((x) => x !== "" && x !== "." && x !== "..");

/** Repository paths an "as is" artifact came from: each inside the repository, each once. */
function provenanceFiles(files: string[]): string[] {
  if (!files.length || files.length > MAX_PROVENANCE) throw new ControlError(`An as-is artifact names between 1 and ${MAX_PROVENANCE} repository files it came from.`);
  for (const p of files) if (!isInsidePath(p)) throw new ControlError(`"${agentLine(p).slice(0, 80)}" is not a file path inside the repository.`);
  return [...new Set(files)];
}

/** A path inside the studio workspace. */
function studioPath(p: string): string {
  if (!isInsidePath(p)) throw new ControlError(`"${agentLine(p).slice(0, 80)}" is not a file path inside the studio workspace.`);
  return p;
}

function maker(m: StudioMaker): StudioMaker {
  if (m.role === "user") return { role: "user" };
  if (!m.model.trim() || !m.attemptId.trim()) throw new ControlError("An agent's artifact names its model and its run.");
  return { role: m.role, provider: m.provider, model: m.model.trim(), attemptId: m.attemptId.trim() };
}

/**
 * Add an artifact, or a new version of one (the service, from a designer's, the PE's or a probe's run, or the owner's
 * upload into round 0). A new version keeps the artifact's kind and starts with the owner's open pins of the version
 * before. Within a round, the designer revises in answer to the PE only until the PE's three passes are done.
 *
 * Round 0 holds what already exists: what the owner brought (material), and for an existing repository the designer's
 * "as is" reproductions of it, each with its provenance (the repository files it came from). Only round 0 holds
 * as-is artifacts: a later round's are proposals, not what the code does today.
 */
export function addArtifact(state: State, input: ArtifactInput, now: string): { state: State; artifactId: string; version: number } {
  const round = getRound(state, input.round);
  const asIs = input.provenance !== undefined;
  if (round.n === 0 && input.kind !== "material" && !(asIs && input.madeBy.role === "designer")) {
    throw new ControlError("Round 0 holds what already exists: what the owner brought (material), and the designer's reproductions of the existing code, labelled as is with the repository files they came from.");
  }
  if (asIs && (round.n !== 0 || input.kind === "material" || input.madeBy.role !== "designer")) throw new ControlError("Only the designer's reproductions of the existing code in round 0 (as it is today) are labelled as is.");
  const provenance = asIs ? { asIs: true as const, files: provenanceFiles(input.provenance!.files) } : undefined;
  const title = required(agentLine(input.title), 200, "The title");
  if (input.variants.length > MAX_VARIANTS) throw new ControlError(`At most ${MAX_VARIANTS} variants side by side.`);
  if (!input.files.length || input.files.length > MAX_FILES) throw new ControlError(`An artifact has between 1 and ${MAX_FILES} files.`);
  const files = input.files.map((f) => {
    if (!/^[0-9a-f]{64}$/.test(f.sha256)) throw new ControlError(`${agentLine(f.path).slice(0, 80)}: the SHA-256 is 64 lowercase hex characters.`);
    return { path: studioPath(f.path), sha256: f.sha256 };
  });
  if (new Set(files.map((f) => f.path)).size !== files.length) throw new ControlError("Each file is listed once.");
  const variants = input.variants.map((v) => {
    if (!/^[A-Za-z0-9_-]{1,20}$/.test(v.id)) throw new ControlError(`"${agentLine(v.id).slice(0, 30)}" is not a variant id (letters, digits, - and _, at most 20).`);
    const label = required(agentLine(v.label), 120, `Variant ${v.id}'s label`);
    if (v.entry !== undefined && !files.some((f) => f.path === v.entry)) throw new ControlError(`Variant ${v.id}'s entry "${agentLine(v.entry).slice(0, 80)}" is not one of the artifact's files.`);
    return { id: v.id, label, ...(v.entry !== undefined ? { entry: v.entry } : {}) };
  });
  if (new Set(variants.map((v) => v.id)).size !== variants.length) throw new ControlError("Each variant has its own id.");
  const outside = input.devices.filter((d) => !state.project.devices.includes(d));
  if (outside.length) throw new ControlError(`${outside.join(", ")} ${outside.length === 1 ? "is" : "are"} outside the project's device scope (${state.project.devices.join(", ")}).`);
  const devices = DEVICES.filter((d) => input.devices.includes(d));
  const madeBy = maker(input.madeBy);
  // The project's words and a flow's rules (pass 4d): their shapes were checked at the boundary; here, who has them.
  if ((input.kind === "dictionary") !== !!input.dictionary?.length) throw new ControlError(input.kind === "dictionary" ? "A dictionary lists its terms." : "Only a dictionary lists terms.");
  if (input.rules?.length) {
    if (input.kind !== "flow") throw new ControlError("Only a flow carries rules.");
    for (const r of input.rules) if (!variants.some((v) => v.id === r.variant)) throw new ControlError(`The rules in "${agentLine(r.path).slice(0, 80)}" are for variant ${agentLine(r.variant).slice(0, 30)}, which ${title} does not have.`);
    if (new Set(input.rules.map((r) => r.variant)).size !== input.rules.length) throw new ControlError("Each variant has at most one set of rules.");
  }

  const prev = input.artifactId === undefined ? undefined : latestVersion(state, input.artifactId);
  if (input.artifactId !== undefined && !prev) throw new ControlError(`Unknown studio artifact ${input.artifactId}.`);
  if (prev) {
    if (input.kind !== prev.kind) throw new ControlError(`${prev.title} is a ${prev.kind}; a new version keeps its kind.`);
    if (input.round < prev.round) throw new ControlError(`${artifactName(prev)} is from round ${prev.round}; a new version cannot belong to an earlier round.`);
    if (input.supersedes !== undefined) throw new ControlError("Only a new artifact replaces another.");
    if (input.round === prev.round && passesInRound(state, prev.id, prev.round) >= MAX_PE_PASSES) {
      throw new ControlError(`PE review of ${prev.title} ended after ${MAX_PE_PASSES} passes in round ${prev.round}; it goes to the owner as it is, and a revision comes in a later round.`);
    }
  }
  if (input.supersedes !== undefined && !latestVersion(state, input.supersedes)) throw new ControlError(`Unknown studio artifact ${input.supersedes} to replace.`);

  const s = draft(state);
  const id = prev ? prev.id : nextId(s, "sa");
  const version = prev ? prev.version + 1 : 1;
  const art: StudioArtifact = {
    id,
    round: round.n,
    version,
    ...(input.supersedes ? { supersedes: input.supersedes } : {}),
    kind: input.kind,
    title,
    variants,
    files,
    devices,
    madeBy,
    at: now,
    ...(provenance ? { provenance } : {}),
    ...(input.dictionary?.length ? { dictionary: input.dictionary } : {}),
    ...(input.rules?.length ? { rules: input.rules } : {}),
  };
  s.studio.artifacts.push(art);
  // A pin on a variant the revision no longer has stays, pinned to the artifact as a whole.
  const carried = (prev ? openPins(s, prev.id, prev.version) : []).map(({ variant, ...pin }) => (variant !== undefined && variants.some((v) => v.id === variant) ? { ...pin, variant } : pin));
  if (prev && carried.length) s.studio.feedback.push({ artifactId: id, version, mark: null, pins: carried, note: "", at: now, carriedFrom: prev.version });
  const who = madeBy.role === "user" ? "you brought" : `by the ${madeBy.role === "pe" ? "PE" : madeBy.role} (${madeBy.provider})`;
  const from = provenance ? `; as is, from ${provenance.files.length === 1 ? provenance.files[0] : `${provenance.files.length} repository files`}` : "";
  event(s, now, madeBy.role === "user" ? "user" : "runtime", "vision", `${artifactName(art)} added to round ${round.n}, ${who}${from}${variants.length > 1 ? `; ${variants.length} variants` : ""}${carried.length ? `; ${carried.length} open pin${carried.length === 1 ? "" : "s"} carried from v${prev!.version}` : ""}`);
  return { state: s, artifactId: id, version };
}

// ---------- what the service makes of a version: screenshots and terminal recordings (pass 3) ----------

/** The screen devices a screenshot is taken on. */
const SHOT_DEVICES: Device[] = ["desktop", "mobile"];

/** What the service makes of a version after import: screenshots of a screen designed for a screen device, or the recording of a terminal demo or TUI. */
export function mediaKind(a: StudioArtifact): "shots" | "demo" | undefined {
  if (a.kind === "screen" && a.devices.some((d) => SHOT_DEVICES.includes(d))) return "shots";
  if (a.kind === "terminal-demo" || a.kind === "tui") return "demo";
  return undefined;
}

/**
 * Mark a version's screenshots or recording as being made (the service, in the transaction that imports it, when it
 * makes them). Nothing changes for a kind that has neither.
 */
export function startArtifactMedia(state: State, artifactId: string, version: number): State {
  const kind = mediaKind(getArtifact(state, artifactId, version));
  if (!kind) return state;
  const s = draft(state);
  const a = getArtifact(s, artifactId, version);
  if (kind === "shots") a.shots = { status: "pending" };
  else a.demo = { status: "pending" };
  return s;
}

/** Versions whose screenshots or recording are still being made: the service finishes them, after a restart too. */
export function pendingMedia(s: State): { artifactId: string; version: number; kind: "shots" | "demo" }[] {
  return s.studio.artifacts.flatMap((a) => [
    ...(a.shots?.status === "pending" ? [{ artifactId: a.id, version: a.version, kind: "shots" as const }] : []),
    ...(a.demo?.status === "pending" ? [{ artifactId: a.id, version: a.version, kind: "demo" as const }] : []),
  ]);
}

export type MediaResult = { shots: Exclude<ArtifactShots, { status: "pending" }> } | { demo: Extract<ArtifactDemo, { status: "done" }> };

/** A reason from the service's tools (a browser, VHS): one line of plain text, capped. */
const reasonText = (x: string) => required(agentLine(x).slice(0, 500), 500, "The reason");

/** A path the service wrote in the version's folder: under `folder/`, inside the workspace. */
function servicePath(p: string, folder: string): string {
  if (!p.startsWith(`${folder}/`)) throw new ControlError(`"${agentLine(p).slice(0, 80)}" is not in the version's ${folder}/ folder.`);
  return studioPath(p);
}

/**
 * Record what the service made of a version (the service, when its screenshots or recording finished). Only while
 * they are pending: a late or repeated result changes nothing. Checked against the version: its variants, devices
 * and files.
 */
export function recordArtifactMedia(state: State, artifactId: string, version: number, result: MediaResult, now: string): State {
  const a = getArtifact(state, artifactId, version);
  const variant = (id: string) => {
    if (!a.variants.some((v) => v.id === id)) throw new ControlError(`${a.title} has no variant ${agentLine(id).slice(0, 30)}.`);
    return id;
  };
  if ("shots" in result) {
    if (a.shots?.status !== "pending") return state;
    const r = result.shots;
    const device = (d: Device) => {
      if (!a.devices.includes(d) || !SHOT_DEVICES.includes(d)) throw new ControlError(`${artifactName(a)} is not designed for ${d}.`);
      return d;
    };
    const shots: ArtifactShots =
      r.status === "skipped"
        ? { status: "skipped", at: now, reason: reasonText(r.reason) }
        : {
            status: "taken",
            at: now,
            shots: r.shots.map((x) => ({ variant: variant(x.variant), device: device(x.device), path: servicePath(x.path, "shots") })),
            failed: r.failed.map((x) => ({ variant: variant(x.variant), device: device(x.device), error: reasonText(x.error) })),
          };
    if (shots.status === "taken" && !shots.shots.length) throw new ControlError("Taken screenshots name at least one; with none, they were skipped.");
    const s = draft(state);
    getArtifact(s, artifactId, version).shots = shots;
    const failed = shots.status === "taken" && shots.failed.length ? `; ${shots.failed.length} failed` : "";
    event(s, now, "system", "vision", shots.status === "taken" ? `Screenshots of ${artifactName(a)}: ${shots.shots.length} taken${failed}` : `No screenshots of ${artifactName(a)}: ${shots.reason}`);
    return s;
  }
  if (a.demo?.status !== "pending") return state;
  const files = new Set(a.files.map((f) => f.path));
  const own = (p: string) => {
    if (!files.has(p)) throw new ControlError(`"${agentLine(p).slice(0, 80)}" is not a file of ${artifactName(a)}.`);
    return p;
  };
  const variants = result.demo.variants.map((v): VariantDemo => {
    const id = variant(v.variant);
    if (v.status === "recorded" || v.status === "recorded-with-errors") {
      const outs = { ...(v.webm ? { webm: servicePath(v.webm, `recording/${id}`) } : {}), ...(v.gif ? { gif: servicePath(v.gif, `recording/${id}`) } : {}), ...(v.txt ? { txt: servicePath(v.txt, `recording/${id}`) } : {}) };
      if (!Object.keys(outs).length) throw new ControlError("A recorded variant names its recording.");
      return v.status === "recorded" ? { variant: id, status: "recorded", tape: own(v.tape), ...outs } : { variant: id, status: "recorded-with-errors", tape: own(v.tape), ...outs, reason: reasonText(v.reason) };
    }
    if (v.status === "hand-written") {
      if (!v.files.length || !v.files.every((f) => /\.(cast|ans)$/.test(f))) throw new ControlError("A hand-written variant names its .cast or .ans files.");
      return { variant: id, status: "hand-written", files: v.files.map(own), ...(v.reason ? { reason: reasonText(v.reason) } : {}) };
    }
    return { variant: id, status: "not-recorded", reason: reasonText(v.reason) };
  });
  if (new Set(variants.map((v) => v.variant)).size !== variants.length || variants.length !== a.variants.length) throw new ControlError(`The recording names each variant of ${artifactName(a)} once.`);
  const s = draft(state);
  getArtifact(s, artifactId, version).demo = { status: "done", at: now, variants };
  const words = (v: VariantDemo) => (v.status === "recorded" ? "recorded" : v.status === "recorded-with-errors" ? `recorded with errors (${v.reason})` : v.status === "hand-written" ? "hand-written, not recorded" : `not recorded (${v.reason})`);
  event(s, now, "system", "vision", `${artifactName(a)}: ${variants.map((v) => `${variants.length > 1 ? `${variantLabel(a, v.variant)} ` : ""}${words(v)}`).join("; ")}`);
  return s;
}

/** What the studio says about a version's screenshots, or nothing (all taken, or none expected). */
export function shotsNote(a: StudioArtifact): string | undefined {
  const sh = a.shots;
  if (!sh || (sh.status === "taken" && !sh.failed.length)) return undefined;
  if (sh.status === "pending") return "Taking screenshots…";
  if (sh.status === "skipped") return `No screenshots: ${sh.reason}`;
  return `${sh.failed.length} of ${sh.shots.length + sh.failed.length} screenshots failed: ${sh.failed[0].error}`;
}

/** What the studio says about how one variant of a terminal demo or TUI is shown, or nothing (it was recorded cleanly, or none expected). */
export function demoNote(a: StudioArtifact, variant: string): string | undefined {
  const d = a.demo;
  if (!d) return undefined;
  if (d.status === "pending") return "Recording…";
  const v = d.variants.find((x) => x.variant === variant);
  if (!v || v.status === "recorded") return undefined;
  if (v.status === "recorded-with-errors") return `Recorded with errors: the demo did not run cleanly in the sandbox (${v.reason})`;
  if (v.status === "hand-written") return v.reason ? `Hand-written, not recorded: ${v.reason}` : "Hand-written, not recorded";
  return `Not recorded: ${v.reason}`;
}

// ---------- PE review ----------

/** How many passes the PE made on an artifact's versions of one round. */
function passesInRound(s: State, artifactId: string, round: number): number {
  const versions = new Set(versionsOf(s, artifactId).filter((a) => a.round === round).map((a) => a.version));
  return Math.max(0, ...s.studio.verdicts.filter((v) => v.artifactId === artifactId && versions.has(v.version)).map((v) => v.pass));
}

/** Whether a verdict covers a variant: a verdict without a variant covers the whole artifact. */
export const covers = (v: PeVerdict, variant: string | undefined) => v.variant === undefined || v.variant === variant;

/** How many of the designer's runs revising one version for the PE may end without a new version before the loop ends: one retry. */
export const MAX_REVISION_RUNS = 2;
/** How many PE runs a version gets that end without a verdict (failed or lost) before its review ends: one retry. */
export const MAX_PE_RUNS = 2;

/** How many of these runs ended without a result: failed, lost, or stopped. A run a pause stopped is not one: it was asked for again. */
export const endedWithoutResult = (runs: StudioRun[]) => runs.filter((r) => r.status === "failed" || r.status === "lost" || (r.status === "stopped" && !r.requeue)).length;

/** The designer's runs revising a version within its round, oldest first: the loop's, and any the lead asked for (`revises`). */
function designerRunsOn(s: State, a: StudioArtifact): StudioRun[] {
  return s.studio.runs.filter((r) => r.kind === "designer" && r.artifactId === a.id && r.baseVersion === a.version && r.round === a.round);
}

/** The loop's revisions of a version: the designer's runs the service asked for in answer to the PE, not the lead's (review finding 8). */
export const revisionRunsOf = (s: State, a: StudioArtifact): StudioRun[] => designerRunsOn(s, a).filter((r) => !r.fromLead);

/** The PE's runs on one version, oldest first. */
export function peRunsOf(s: State, artifactId: string, version: number): StudioRun[] {
  return s.studio.runs.filter((r) => r.kind === "pe" && r.artifactId === artifactId && r.baseVersion === version);
}

/** Why PE review of a version ended, in words that follow "PE review ended: ". `no-provider` comes with its note. */
export const LOOP_END_WORDS: Record<LoopEnd, string> = {
  passes: `the PE made its ${MAX_PE_PASSES} passes in the round`,
  "as-is": "it reproduces the code as it is today, and the designer does not revise a reproduction for the PE",
  "round-closed": "its round closed before the PE agreed",
  "no-revision": `the designer's runs revising it ended ${MAX_REVISION_RUNS} times without a new version`,
  "no-review": `the PE's runs on it ended ${MAX_PE_RUNS} times without a verdict`,
  "no-provider": "no enabled provider could run the next step",
  "earlier-rule": "the PE reviewed it under the studio's earlier rule: one pass, and no revision",
};

/**
 * Why PE review of a version is over before the PE agreed, or undefined while it goes on. `pass` is the PE's latest
 * pass on this version, 0 when it has none. In order: an end the service recorded; the round's last pass; a
 * reproduction of the code, which is not revised (round 0); the round closed; the revisions or the PE's runs failed.
 */
function loopEnd(s: State, a: StudioArtifact, pass: number): LoopEnd | undefined {
  if (a.reviewEnd) return a.reviewEnd.reason;
  if (pass >= MAX_PE_PASSES) return "passes";
  if (pass && a.provenance) return "as-is";
  const round = s.studio.rounds.find((r) => r.n === a.round);
  if (!round || round.closedAt) return "round-closed";
  if (pass && endedWithoutResult(revisionRunsOf(s, a)) >= MAX_REVISION_RUNS) return "no-revision";
  if (!pass && endedWithoutResult(peRunsOf(s, a.id, a.version)) >= MAX_PE_RUNS) return "no-review";
  return undefined;
}

/**
 * Where PE review of an artifact version stands (the loop rule, ORC-029 pass 4): one value, from which every word the
 * owner and the lead see is made.
 * - not-reviewed: the PE does not review this kind (`KIND_RULES`); `why` says why. It is with the owner at once;
 * - waiting: the PE has not reviewed this version yet (`passes`: those made on earlier versions of its round);
 * - revising: the PE's pass `pass` asked for changes or objected, and the designer revises this version;
 * - agreed: the PE's pass `pass` found every variant feasible;
 * - ended: review ended before the PE agreed (`ended` says why; `note` gives the reason the service recorded). The
 *   version goes to the owner with what the PE still asks for and objects to. `pass` is 0 when the PE never reviewed
 *   this version.
 * `asks` are the latest pass's feasible-if verdicts (the changes it asks for), and `objections` its not-feasible
 * ones, overruled ones included (they carry `overruled`).
 */
export type PeReview =
  | { status: "not-reviewed"; why: string }
  | { status: "waiting"; passes: number }
  | { status: "revising"; pass: number; asks: PeVerdict[]; objections: PeVerdict[] }
  | { status: "agreed"; pass: number }
  | { status: "ended"; ended: LoopEnd; note?: string; pass: number; asks: PeVerdict[]; objections: PeVerdict[] };

export function peReview(s: State, a: StudioArtifact): PeReview {
  const rule = KIND_RULES[a.kind];
  if (!rule.peReviews) return { status: "not-reviewed", why: rule.why };
  const mine = s.studio.verdicts.filter((v) => v.artifactId === a.id && v.version === a.version);
  const pass = Math.max(0, ...mine.map((v) => v.pass));
  const latest = mine.filter((v) => v.pass === pass);
  const asks = latest.filter((v) => v.verdict === "feasible-if");
  const objections = latest.filter((v) => v.verdict === "not-feasible");
  if (pass && !asks.length && !objections.length) return { status: "agreed", pass };
  const ended = loopEnd(s, a, pass);
  if (ended) return { status: "ended", ended, ...(a.reviewEnd?.note ? { note: a.reviewEnd.note } : {}), pass, asks, objections };
  return pass ? { status: "revising", pass, asks, objections } : { status: "waiting", passes: passesInRound(s, a.id, a.round) };
}

/**
 * Record that PE review of a version ended because the service could not run its next step (the service, when no
 * enabled provider can run the PE or the designer's revision). The version goes to the owner as it is, with the
 * reason; enabling a provider later does not take it back.
 */
export function endReview(state: State, artifactId: string, version: number, note: string, now: string): State {
  const a = getArtifact(state, artifactId, version);
  const r = peReview(state, a);
  if (r.status !== "waiting" && r.status !== "revising") return state;
  const s = draft(state);
  const art = getArtifact(s, artifactId, version);
  art.reviewEnd = { reason: "no-provider", at: now, note: reasonText(note) };
  event(s, now, "system", "vision", `PE review of ${artifactName(a)}: ${outcomeWords(peReview(s, art))}`);
  return s;
}

/**
 * Whether the designer should revise this version for the PE now: it is the newest version, its review is revising
 * (never so for a kind the PE does not review), and no designer run on it is under way (the loop's, or one the lead
 * asked for). In Vision or while the factory runs alike (pass 5).
 */
export function revisionDue(s: State, a: StudioArtifact): boolean {
  if (latestVersion(s, a.id)?.version !== a.version) return false;
  if (peReview(s, a).status !== "revising") return false;
  return !designerRunsOn(s, a).some(isUnderWay);
}

/** Whether the owner sees this version: PE review is not waiting or revising. A kind the PE does not review is never held back. */
export function readyForOwner(s: State, a: StudioArtifact): boolean {
  const r = peReview(s, a);
  return r.status !== "waiting" && r.status !== "revising";
}

/**
 * The changes the PE asked for so far in a version's round, which its next pass on this version checks first: the
 * feasible-if and not-feasible verdicts on the round's versions up to this one, on the whole artifact or on a variant
 * this version still has, oldest first. None before the round's first pass.
 */
export function earlierAsks(s: State, a: StudioArtifact): PeVerdict[] {
  const before = new Set(versionsOf(s, a.id).filter((v) => v.round === a.round && v.version <= a.version).map((v) => v.version));
  return s.studio.verdicts.filter((v) => v.artifactId === a.id && before.has(v.version) && v.verdict !== "feasible" && (v.variant === undefined || a.variants.some((x) => x.id === v.variant)));
}

/** The earlier asks a verdict on `variant` checks: those on its variant or on the whole artifact; every one for a verdict on the whole. */
export const asksOn = (asks: PeVerdict[], variant: string | undefined): PeVerdict[] => (variant === undefined ? asks : asks.filter((x) => covers(x, variant)));

/** An open case as the owner and the lead see it: the variant it was raised on (none: the whole artifact), on which pass and version. */
export interface RaisedCase extends OpenCase {
  variant?: string;
  pass: number;
  version: number;
}

/**
 * The open cases the PE raised on an artifact in a version's round, up to that version, oldest first: product
 * questions for the owner, which the lead asks about. A later pass does not repeat them, so the earlier passes' count.
 */
export function openCasesOf(s: State, a: StudioArtifact): RaisedCase[] {
  const mine = new Set(versionsOf(s, a.id).filter((v) => v.round === a.round && v.version <= a.version).map((v) => v.version));
  return s.studio.verdicts
    .filter((v) => v.artifactId === a.id && mine.has(v.version) && v.openCases?.length)
    .flatMap((v) => v.openCases!.map((c) => ({ ...c, ...(v.variant !== undefined ? { variant: v.variant } : {}), pass: v.pass, version: v.version })));
}

/** The objections of the latest pass on a version that the owner has not overruled, optionally only those covering one variant. */
export function openObjections(s: State, a: StudioArtifact, variant?: string): PeVerdict[] {
  const r = peReview(s, a);
  const all = r.status === "revising" || r.status === "ended" ? r.objections : [];
  return all.filter((v) => !v.overruled && (variant === undefined || covers(v, variant)));
}

/**
 * Why a round cannot close yet, or undefined: one of its studio runs is under way, or one of its versions waits for
 * PE review or for the designer's revision. Closing it then would end PE review early (review finding 1).
 */
export function roundBusy(s: State, n: number): string | undefined {
  const run = s.studio.runs.find((r) => r.round === n && isUnderWay(r));
  if (run) return `${run.kind === "pe" ? "the PE's" : run.kind === "probe" ? "a probe's" : "the designer's"} run ${run.id} is ${run.status}`;
  for (const a of latestArtifacts(s)) {
    if (a.round !== n) continue;
    const r = peReview(s, a);
    if (r.status === "waiting") return `${artifactName(a)} waits for PE review`;
    if (r.status === "revising") return `the designer revises ${artifactName(a)} for the PE`;
  }
  return undefined;
}

export interface VerdictInput {
  variant?: string;
  verdict: Verdict;
  reasons: string;
  change?: string;
  /** On a later pass: the check of each earlier ask on this variant (`earlierAsks`), each once. */
  earlier?: AskCheck[];
  /** On a later pass: the change answers a risk the revision created. */
  fromRevision?: boolean;
  openCases?: OpenCase[];
  budget?: BudgetEstimate;
}

/** The most open cases on one verdict: the PE groups related questions, as the lead's questions are grouped (at most 5 a round). */
export const MAX_OPEN_CASES = 5;

function estimate(b: BudgetEstimate): BudgetEstimate {
  const range = (r: [number, number] | undefined, what: string) => {
    if (r === undefined) return undefined;
    const [lo, hi] = r;
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < 0 || hi < lo) throw new ControlError(`The ${what} estimate is a range of dollars, low to high.`);
    return [lo, hi] as [number, number];
  };
  const buildUsd = range(b.buildUsd, "building");
  const maintenanceUsdPerMonth = range(b.maintenanceUsdPerMonth, "maintenance");
  // No claims without evidence: an estimate states what it is based on.
  const basis = required(agentLine(b.basis), 500, "The estimate's basis");
  return { ...(buildUsd ? { buildUsd } : {}), ...(maintenanceUsdPerMonth ? { maintenanceUsdPerMonth } : {}), basis };
}

/** A cost estimate from an agent's output (untrusted): dollar ranges, low to high, and its basis. Throws a ControlError saying what is wrong. */
export function readEstimate(raw: unknown): BudgetEstimate {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ControlError("The estimate is an object with dollar ranges and a basis.");
  const o = raw as Record<string, unknown>;
  const range = (v: unknown, what: string): [number, number] | undefined => {
    if (v === undefined || v === null) return undefined;
    if (!Array.isArray(v) || v.length !== 2 || !v.every((x) => typeof x === "number")) throw new ControlError(`The ${what} estimate is [low, high] in dollars.`);
    return [v[0], v[1]];
  };
  if (typeof o.basis !== "string") throw new ControlError("The estimate's basis is empty.");
  return estimate({ buildUsd: range(o.buildUsd, "building"), maintenanceUsdPerMonth: range(o.maintenanceUsdPerMonth, "maintenance"), basis: o.basis });
}

export interface PeVerdictsInput {
  artifactId: string;
  version: number;
  verdicts: VerdictInput[];
  /** The PE's run that made them (the service's record). */
  by?: { provider: ProviderId; model: string; runId: string };
}

/** What comes of a version's review next, in words: "the designer revises", "agreed; it goes to the owner"… */
export function outcomeWords(r: PeReview): string {
  switch (r.status) {
    case "not-reviewed":
      return `the PE does not review it: ${r.why}`;
    case "waiting":
      return "the PE reviews it";
    case "revising":
      return "the designer revises";
    case "agreed":
      return "agreed; it goes to the owner";
    case "ended": {
      const what = [r.objections.length ? "the objections" : "", r.asks.length ? "the changes the PE asks for" : ""].filter(Boolean).join(" and ");
      return `review ended: ${LOOP_END_WORDS[r.ended]}${r.note ? ` (${r.note})` : ""}; it goes to the owner${what ? ` with ${what}` : ""}`;
    }
  }
}

/**
 * A verdict's checks of the earlier asks on its variant (`due`): each due ask once, and nothing else, in the order
 * the asks were made. Throws a ControlError that says what is wrong.
 */
function askChecks(due: readonly { id: string }[], given: AskCheck[], on: string): AskCheck[] {
  for (const c of given) {
    if (!due.some((x) => x.id === c.ask)) throw new ControlError(`The verdict on ${on} checks "${agentLine(c.ask).slice(0, 30)}", which is not one of the PE's earlier asks on it in this round.`);
  }
  if (new Set(given.map((c) => c.ask)).size !== given.length) throw new ControlError(`The verdict on ${on} checks an earlier ask twice.`);
  const missing = due.filter((x) => !given.some((c) => c.ask === x.id));
  if (missing.length) throw new ControlError(`The verdict on ${on} leaves out earlier ask ${missing.map((x) => x.id).join(", ")}: on a later pass, the PE first says whether each change it asked for is met.`);
  return due.map((x) => ({ ask: x.id, met: given.find((c) => c.ask === x.id)!.met }));
}

/** A verdict as the PE's run gave it, once checked: what a pass or a round records (`checkVerdict`). */
export interface CheckedVerdict {
  verdict: Verdict;
  reasons: string;
  change?: string;
  earlier?: AskCheck[];
  fromRevision?: true;
  openCases?: OpenCase[];
  budget?: BudgetEstimate;
}

/**
 * One verdict of the PE's, checked by the rules of its loop (pass 4e), for the studio and for PE review of new work in
 * the factory alike. `pass` counts from 1; `asks` are the changes the PE asked for earlier that this verdict checks
 * (each by id, once); `on` names what it judges, for the messages. Reasons are required; feasible-if states its
 * change; on a later pass a verdict that sends the work back has an earlier ask that is not met, or says the
 * revision created the risk (`fromRevision`); open cases are at most 5. Throws a ControlError that says what is wrong.
 */
export function checkVerdict(v: VerdictInput, ctx: { pass: number; asks: readonly { id: string }[]; on: string }): CheckedVerdict {
  const { pass, on } = ctx;
  const reasons = required(agentText(v.reasons), 2000, "The verdict's reasons");
  const change = v.change === undefined ? "" : capped(agentText(v.change), 1000, "The stated change");
  if (v.verdict === "feasible-if" && !change) throw new ControlError("Feasible-if states the change that makes it feasible.");
  const earlier = askChecks(ctx.asks, v.earlier ?? [], on);
  // A later pass asks for no more than it asked before, unless the revision created a new risk (the loop converges).
  if (pass > 1 && v.verdict !== "feasible" && !v.fromRevision && !earlier.some((c) => !c.met)) {
    throw new ControlError(
      `The verdict on ${on} sends it back, but ${earlier.length ? "it finds every earlier ask met" : "the PE asked for no change on it earlier in the round"}. On a later pass, a change is for an earlier ask that is not met, or for a risk this revision created ("fromRevision"); a missing feature or an undecided case is an open case for the owner.`,
    );
  }
  if (v.fromRevision && (pass === 1 || v.verdict === "feasible")) throw new ControlError(`The verdict on ${on} says its change answers a risk the revision created, but it ${pass === 1 ? "is on the round's first take" : "asks for no change"}.`);
  const openCases = (v.openCases ?? []).map((c) => {
    const why = c.why === undefined ? "" : capped(agentLine(c.why), 300, "An open case's why");
    return { text: required(agentLine(c.text), 300, "An open case"), ...(why ? { why } : {}) };
  });
  if (openCases.length > MAX_OPEN_CASES) throw new ControlError(`At most ${MAX_OPEN_CASES} open cases on one verdict; group related questions.`);
  return {
    verdict: v.verdict,
    reasons,
    ...(change ? { change } : {}),
    ...(earlier.length ? { earlier } : {}),
    ...(v.fromRevision ? { fromRevision: true as const } : {}),
    ...(openCases.length ? { openCases } : {}),
    ...(v.budget ? { budget: estimate(v.budget) } : {}),
  };
}

/**
 * Record one PE pass on an artifact's newest version (the service, from the PE's run): one verdict per variant, or
 * one verdict on the whole artifact. Passes count within the version's round, up to three. Feasible-if states the
 * change; an estimate states its basis. A kind the PE does not review (`KIND_RULES`) gets no verdict.
 *
 * On a later pass (convergence): each verdict checks every earlier ask on its variant (met or not), and one that sends
 * the variant back has an ask that is not met, or says that the revision created the risk (`fromRevision`). Open
 * cases (at most 5 a verdict) are recorded for the owner; they never send a variant back.
 */
export function addPeVerdicts(state: State, input: PeVerdictsInput, now: string): { state: State; pass: number } {
  const a = getArtifact(state, input.artifactId, input.version);
  const review = peReview(state, a);
  if (review.status === "not-reviewed") throw new ControlError(`The PE does not review ${a.title}: ${review.why}.`);
  const latest = latestVersion(state, a.id)!;
  if (latest.version !== a.version) throw new ControlError(`${artifactName(a)} was revised (v${latest.version}); the PE reviews the newest version.`);
  const pass = passesInRound(state, a.id, a.round) + 1;
  if (pass > MAX_PE_PASSES) throw new ControlError(`PE review of ${a.title} ended after ${MAX_PE_PASSES} passes in round ${a.round}; it went to the owner with the open objections.`);
  const vs = input.verdicts;
  if (!vs.length) throw new ControlError("A pass has at least one verdict.");
  const whole = vs.filter((v) => v.variant === undefined);
  if (whole.length && vs.length > 1) throw new ControlError("A pass is one verdict on the whole artifact, or one verdict per variant.");
  if (!whole.length) {
    const named = vs.map((v) => v.variant!);
    const unknown = named.filter((id) => !a.variants.some((v) => v.id === id));
    if (unknown.length) throw new ControlError(`${a.title} has no variant ${unknown.join(", ")}.`);
    if (new Set(named).size !== named.length) throw new ControlError("One verdict per variant in a pass.");
    const missing = a.variants.filter((v) => !named.includes(v.id)).map((v) => v.id);
    if (missing.length) throw new ControlError(`The pass leaves out variant ${missing.join(", ")}: the PE judges every option the owner will see.`);
  }
  const asks = earlierAsks(state, a);
  const records: PeVerdict[] = vs.map((v) => ({
    id: "",
    artifactId: a.id,
    version: a.version,
    ...(v.variant !== undefined ? { variant: v.variant } : {}),
    pass,
    ...checkVerdict(v, { pass, asks: asksOn(asks, v.variant), on: v.variant === undefined ? "the whole artifact" : `variant ${v.variant}` }),
    at: now,
    ...(input.by ? { by: { provider: input.by.provider, model: input.by.model, runId: input.by.runId } } : {}),
  }));
  const s = draft(state);
  for (const r of records) s.studio.verdicts.push({ ...r, id: nextId(s, "pev") });
  const art = getArtifact(s, a.id, a.version);
  const r = peReview(s, art);
  event(s, now, "runtime", "vision", `PE review of ${artifactName(a)}, pass ${pass}: ${records.map((x) => `${x.variant ? `${variantLabel(a, x.variant)} ` : ""}${VERDICT_WORDS[x.verdict]}`).join(", ")}; ${outcomeWords(r)}`);
  return { state: s, pass };
}

/**
 * The owner overrules one of the PE's objections, with the reason, which is recorded on the verdict. Only an open
 * objection the owner is shown: of the latest pass on an artifact's newest version, once it reached the owner.
 */
export function overruleObjection(state: State, verdictId: string, why: string, now: string): State {
  const v = state.studio.verdicts.find((x) => x.id === verdictId);
  if (!v) throw new ControlError(`Unknown PE verdict ${verdictId}.`);
  if (v.verdict !== "not-feasible") throw new ControlError("Only an objection (not feasible) can be overruled.");
  if (v.overruled) throw new ControlError("You already overruled this objection.");
  const a = getArtifact(state, v.artifactId, v.version);
  const latest = latestVersion(state, a.id)!;
  if (!readyForOwner(state, latest)) throw new ControlError(`The PE is still reviewing ${latest.title}; it reaches you once the PE agrees or its review ends.`);
  if (latest.version !== a.version || !openObjections(state, a).some((x) => x.id === v.id)) throw new ControlError(`PE review of ${a.title} moved on since this objection; overrule its current objections instead.`);
  const reason = required(ownerText(why), 1000, "Your reason");
  const s = draft(state);
  s.studio.verdicts.find((x) => x.id === verdictId)!.overruled = { at: now, why: reason };
  event(s, now, "user", "decision", `You overruled the PE's objection to ${artifactName(a)}${v.variant ? ` (${variantLabel(a, v.variant)})` : ""}: ${reason}`);
  return s;
}

// ---------- the owner's feedback ----------

export interface FeedbackInput {
  artifactId: string;
  version: number;
  mark: Mark | null;
  pickedVariant?: string;
  pins: Pin[];
  /** Marks on the rows of a dictionary or of a flow's rules. */
  rows?: RowMark[];
  note: string;
}

/** The rows of a version the owner can mark (pass 4d): a dictionary's terms, or the ids of a flow variant's rules. None for other artifacts. */
export function markableRows(a: StudioArtifact, variant?: string): string[] {
  if (a.dictionary) return a.dictionary.map((e) => e.term);
  const v = variant ?? (a.variants.length === 1 ? a.variants[0].id : undefined);
  return a.rules?.find((r) => r.variant === v)?.rules.map((r) => r.id) ?? [];
}

/**
 * The owner's row marks on a version, checked: each names a term of a dictionary, or a rule of a flow's variant (the
 * variant named when the flow has several), each once. A one-variant artifact's marks name no variant.
 */
function rowMarks(a: StudioArtifact, given: RowMark[]): RowMark[] {
  if (!given.length) return [];
  if (!a.dictionary && !a.rules) throw new ControlError(`${artifactName(a)} has no rows to mark: only a dictionary's terms and a flow's rules have marks of their own.`);
  const seen = new Set<string>();
  return given.map((r) => {
    const variant = a.variants.length > 1 && !a.dictionary ? r.variant : undefined;
    if (a.rules && a.variants.length > 1 && (variant === undefined || !a.variants.some((v) => v.id === variant))) throw new ControlError(`A mark on a rule of ${a.title} names the variant the rule is on.`);
    if (!markableRows(a, variant).includes(r.row)) throw new ControlError(`${artifactName(a)} has no ${a.dictionary ? "term" : "rule"} "${agentLine(r.row).slice(0, 40)}"${variant ? ` on ${variantLabel(a, variant)}` : ""}.`);
    const key = `${variant ?? ""}\u0000${r.row}`;
    if (seen.has(key)) throw new ControlError(`"${agentLine(r.row).slice(0, 40)}" is marked twice; send one mark per row.`);
    seen.add(key);
    return { row: r.row, ...(variant !== undefined ? { variant } : {}), mark: r.mark };
  });
}

/**
 * The owner's answer to a round: marks, picks, pins and notes on several artifacts, sent together. Each entry is on
 * the newest version they were shown (compare-and-set on the version) and replaces their feedback on it; the pins
 * sent are the version's open pins, so a pin left out is resolved.
 */
export function sendFeedback(state: State, entries: FeedbackInput[], now: string): State {
  if (!entries.length) throw new ControlError("Mark, pick or pin something first.");
  const seen = new Set<string>();
  const records: Feedback[] = entries.map((e) => {
    const a = getArtifact(state, e.artifactId, e.version);
    const latest = latestVersion(state, a.id)!;
    if (latest.version !== a.version) throw new StaleWriteError(a.version, latest.version);
    if (!readyForOwner(state, a)) throw new ControlError(`${artifactName(a)} is still in PE review; it reaches you once the PE agrees or its review ends.`);
    const key = `${a.id}@${a.version}`;
    if (seen.has(key)) throw new ControlError(`${artifactName(a)} appears twice; send one answer per artifact.`);
    seen.add(key);
    const variant = (id: string | undefined) => {
      if (id !== undefined && !a.variants.some((v) => v.id === id)) throw new ControlError(`${a.title} has no variant ${id}.`);
      return id;
    };
    const picked = variant(e.pickedVariant);
    if (e.pins.length > MAX_PINS) throw new ControlError(`At most ${MAX_PINS} pins on one artifact.`);
    const pins = e.pins.map((p) => {
      const inside = (n: number) => Number.isFinite(n) && n >= 0 && n <= 1;
      if (!inside(p.x) || !inside(p.y)) throw new ControlError("A pin's position is a fraction (0 to 1) of the artifact's width and height.");
      const pv = variant(p.variant);
      // The clicked element as the prototype described it: untrusted text, kept as one line.
      const selector = p.selector === undefined ? "" : capped(agentLine(p.selector), MAX_PIN_SELECTOR, "A pin's element");
      return { x: p.x, y: p.y, ...(pv !== undefined ? { variant: pv } : {}), text: required(ownerText(p.text), 1000, "A pinned comment"), ...(selector ? { selector } : {}) };
    });
    const note = capped(ownerText(e.note), 4000, "The note");
    const rows = rowMarks(a, e.rows ?? []);
    return { artifactId: a.id, version: a.version, mark: e.mark, ...(picked !== undefined ? { pickedVariant: picked } : {}), pins, ...(rows.length ? { rows } : {}), note, at: now };
  });
  const s = draft(state);
  s.studio.feedback.push(...records);
  const line = (f: Feedback) => {
    const a = getArtifact(s, f.artifactId, f.version);
    const rows = f.rows?.length ? `${f.rows.length} ${a.dictionary ? "term" : "rule"}${f.rows.length === 1 ? "" : "s"} marked` : "";
    const parts = [f.mark ?? "", f.pickedVariant ? `picked ${variantLabel(a, f.pickedVariant)}` : "", f.pins.length ? `${f.pins.length} pin${f.pins.length === 1 ? "" : "s"}` : "", rows, f.note ? "a note" : ""].filter(Boolean);
    return `${artifactName(a)}${parts.length ? ` (${parts.join(", ")})` : " (cleared)"}`;
  };
  event(s, now, "user", "vision", `Your feedback: ${records.map(line).join("; ")}`);
  return s;
}

// ---------- probes ----------

/** Probes whose evidence is not in yet (queued or running): open items of the pre-flight, by id. */
export function unfinishedProbes(s: State): Probe[] {
  return s.studio.probes.filter((p) => p.status === "queued" || p.status === "running");
}

/** The PE asks for evidence before it agrees (the service, from the PE's run): a small Vision task, queued. */
export function addProbe(state: State, question: string, now: string): { state: State; probeId: string } {
  const q = required(agentLine(question), 500, "The probe's question");
  const s = draft(state);
  const id = nextId(s, "probe");
  s.studio.probes.push({ id, askedBy: "pe", question: q, status: "queued", at: now });
  event(s, now, "runtime", "vision", `The PE asked for a probe (${id}): ${q}`);
  return { state: s, probeId: id };
}

export interface ProbeUpdate {
  status: Exclude<ProbeStatus, "queued">;
  /** The run doing it (running). */
  attemptId?: string;
  /** The evidence artifact it produced (done). */
  result?: string;
  /** Why it failed (failed). */
  failure?: string;
}

/**
 * A probe's progress (the service): queued → running (with its run) → done (with an evidence artifact) or failed
 * (with the reason). A queued probe may also fail before it runs. Done and failed are final.
 */
export function setProbeStatus(state: State, probeId: string, u: ProbeUpdate, now: string): State {
  const p = state.studio.probes.find((x) => x.id === probeId);
  if (!p) throw new ControlError(`Unknown probe ${probeId}.`);
  const allowed: Record<ProbeStatus, ProbeStatus[]> = { queued: ["running", "failed"], running: ["done", "failed"], done: [], failed: [] };
  if (!allowed[p.status].includes(u.status)) throw new ControlError(`Probe ${probeId} is ${p.status}; it cannot become ${String(u.status)}.`);
  const next: Partial<Probe> = { status: u.status };
  let detail = "";
  if (u.status === "running") {
    if (!u.attemptId?.trim()) throw new ControlError("A running probe names its run.");
    next.attemptId = u.attemptId.trim();
    detail = ` (run ${next.attemptId})`;
  } else if (u.status === "done") {
    const evidence = u.result === undefined ? undefined : latestVersion(state, u.result);
    if (!evidence || evidence.kind !== "evidence") throw new ControlError("A finished probe's result is an evidence artifact in the studio.");
    next.result = evidence.id;
    detail = `: ${evidence.title}`;
  } else {
    next.failure = required(agentLine(u.failure ?? ""), 500, "The reason it failed");
    detail = `: ${next.failure}`;
  }
  const s = draft(state);
  Object.assign(s.studio.probes.find((x) => x.id === probeId)!, next);
  event(s, now, "runtime", "vision", `Probe ${probeId} ${u.status}${detail}`);
  return s;
}
