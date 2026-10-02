// The vision studio's rules (ORC-029 2c): rounds, artifacts and their versions, the owner's feedback, PE review with
// its loop rule, the owner's overrule, and probes. Pure: each operation returns a new State.
//
// Who calls what. The owner's feedback and overrule are owner commands. Opening and closing rounds, adding artifacts,
// recording the PE's verdicts and a probe's progress are the service's, from the studio's runs (passes 3 and 4);
// clients cannot send them (SERVICE_COMMANDS in commands.ts). The lead never approves: approval is blueprint.ts's.
//
// The loop rule. The PE judges every option before the owner sees it. An artifact version reaches the owner when the
// PE's latest pass on it finds every variant feasible or feasible-if, or after three passes in its round, with the
// open objections attached. An objection is never dropped: a later pass on a revision answers it, or the owner
// overrules it (recorded). What the owner brought and a probe's evidence are not held back.

import { draft, event, nextId } from "../model/core";
import { CONTROL_RE, oneLine, stripInvisible, visibleOrEmpty } from "../model/textSafety";
import { ControlError, DEVICES, StaleWriteError, type Device, type State } from "../types";
import {
  type BudgetEstimate,
  type Feedback,
  type Mark,
  type PeVerdict,
  type Pin,
  type Probe,
  type ProbeStatus,
  type Round,
  type RoundFocus,
  type StudioArtifact,
  type StudioArtifactKind,
  type StudioMaker,
  type Verdict,
  UNGATED_KINDS,
} from "./types";

/** The PE's passes on an artifact within one round. After the last, the artifact goes to the owner as it is. */
export const MAX_PE_PASSES = 3;
const MAX_VARIANTS = 6;
const MAX_FILES = 100;
const MAX_PINS = 50;

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
 * Open the next round (the service, for the lead's run). What the owner brought is round 0 and only it is about the
 * material; the lead's rounds count from 1. One round at a time: the open one is closed first.
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

/** Close a round (the service, once the owner answered it or the lead moved on). The summary, when given, replaces the opening one. */
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
  variants: { id: string; label: string }[];
  files: { path: string; sha256: string }[];
  devices: Device[];
  madeBy: StudioMaker;
  supersedes?: string;
}

/** A path inside the studio workspace: relative, with no empty, "." or ".." segment, no backslash and no control character. */
function studioPath(p: string): string {
  const bad = !p || p.length > 300 || p.startsWith("/") || p.includes("\\") || CONTROL_RE.test(p) || p.split("/").some((x) => x === "" || x === "." || x === "..");
  if (bad) throw new ControlError(`"${agentLine(p).slice(0, 80)}" is not a file path inside the studio workspace.`);
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
 */
export function addArtifact(state: State, input: ArtifactInput, now: string): { state: State; artifactId: string; version: number } {
  const round = getRound(state, input.round);
  if (round.n === 0 && input.kind !== "material") throw new ControlError("Round 0 holds what the owner brought (material) only.");
  const title = required(agentLine(input.title), 200, "The title");
  if (input.variants.length > MAX_VARIANTS) throw new ControlError(`At most ${MAX_VARIANTS} variants side by side.`);
  const variants = input.variants.map((v) => {
    if (!/^[A-Za-z0-9_-]{1,20}$/.test(v.id)) throw new ControlError(`"${agentLine(v.id).slice(0, 30)}" is not a variant id (letters, digits, - and _, at most 20).`);
    return { id: v.id, label: required(agentLine(v.label), 120, `Variant ${v.id}'s label`) };
  });
  if (new Set(variants.map((v) => v.id)).size !== variants.length) throw new ControlError("Each variant has its own id.");
  if (!input.files.length || input.files.length > MAX_FILES) throw new ControlError(`An artifact has between 1 and ${MAX_FILES} files.`);
  const files = input.files.map((f) => {
    if (!/^[0-9a-f]{64}$/.test(f.sha256)) throw new ControlError(`${agentLine(f.path).slice(0, 80)}: the SHA-256 is 64 lowercase hex characters.`);
    return { path: studioPath(f.path), sha256: f.sha256 };
  });
  if (new Set(files.map((f) => f.path)).size !== files.length) throw new ControlError("Each file is listed once.");
  const outside = input.devices.filter((d) => !state.project.devices.includes(d));
  if (outside.length) throw new ControlError(`${outside.join(", ")} ${outside.length === 1 ? "is" : "are"} outside the project's device scope (${state.project.devices.join(", ")}).`);
  const devices = DEVICES.filter((d) => input.devices.includes(d));
  const madeBy = maker(input.madeBy);

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
  const art: StudioArtifact = { id, round: round.n, version, ...(input.supersedes ? { supersedes: input.supersedes } : {}), kind: input.kind, title, variants, files, devices, madeBy, at: now };
  s.studio.artifacts.push(art);
  // A pin on a variant the revision no longer has stays, pinned to the artifact as a whole.
  const carried = (prev ? openPins(s, prev.id, prev.version) : []).map(({ variant, ...pin }) => (variant !== undefined && variants.some((v) => v.id === variant) ? { ...pin, variant } : pin));
  if (prev && carried.length) s.studio.feedback.push({ artifactId: id, version, mark: null, pins: carried, note: "", at: now, carriedFrom: prev.version });
  const who = madeBy.role === "user" ? "you brought" : `by the ${madeBy.role === "pe" ? "PE" : madeBy.role} (${madeBy.provider})`;
  event(s, now, madeBy.role === "user" ? "user" : "runtime", "vision", `${artifactName(art)} added to round ${round.n}, ${who}${variants.length > 1 ? `; ${variants.length} variants` : ""}${carried.length ? `; ${carried.length} open pin${carried.length === 1 ? "" : "s"} carried from v${prev!.version}` : ""}`);
  return { state: s, artifactId: id, version };
}

// ---------- PE review ----------

/** How many passes the PE made on an artifact's versions of one round. */
function passesInRound(s: State, artifactId: string, round: number): number {
  const versions = new Set(versionsOf(s, artifactId).filter((a) => a.round === round).map((a) => a.version));
  return Math.max(0, ...s.studio.verdicts.filter((v) => v.artifactId === artifactId && versions.has(v.version)).map((v) => v.pass));
}

/** Whether a verdict covers a variant: a verdict without a variant covers the whole artifact. */
export const covers = (v: PeVerdict, variant: string | undefined) => v.variant === undefined || v.variant === variant;

/**
 * Where PE review of an artifact version stands.
 * - waiting: no pass on this version yet (`passes` were made on earlier versions of its round);
 * - revising: the latest pass objected and passes remain: the designer revises, or the PE asks for evidence;
 * - agreed: the latest pass found every variant feasible or feasible-if;
 * - objections: the third pass still objected; the version goes to the owner with them.
 * `objections` lists the latest pass's not-feasible verdicts, overruled ones included (they carry `overruled`).
 */
export type PeReview =
  | { status: "waiting"; passes: number }
  | { status: "revising"; pass: number; objections: PeVerdict[] }
  | { status: "agreed"; pass: number }
  | { status: "objections"; pass: number; objections: PeVerdict[] };

export function peReview(s: State, a: StudioArtifact): PeReview {
  const mine = s.studio.verdicts.filter((v) => v.artifactId === a.id && v.version === a.version);
  if (!mine.length) return { status: "waiting", passes: passesInRound(s, a.id, a.round) };
  const pass = Math.max(...mine.map((v) => v.pass));
  const objections = mine.filter((v) => v.pass === pass && v.verdict === "not-feasible");
  if (!objections.length) return { status: "agreed", pass };
  return pass >= MAX_PE_PASSES ? { status: "objections", pass, objections } : { status: "revising", pass, objections };
}

/** Whether the owner sees this version: PE review agreed or ran its three passes; what the owner brought and evidence are never held back. */
export function readyForOwner(s: State, a: StudioArtifact): boolean {
  if (UNGATED_KINDS.includes(a.kind)) return true;
  const r = peReview(s, a);
  return r.status === "agreed" || r.status === "objections";
}

/** The objections of the latest pass on a version that the owner has not overruled, optionally only those covering one variant. */
export function openObjections(s: State, a: StudioArtifact, variant?: string): PeVerdict[] {
  const r = peReview(s, a);
  const all = r.status === "revising" || r.status === "objections" ? r.objections : [];
  return all.filter((v) => !v.overruled && (variant === undefined || covers(v, variant)));
}

export interface VerdictInput {
  variant?: string;
  verdict: Verdict;
  reasons: string;
  change?: string;
  budget?: BudgetEstimate;
}

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

/**
 * Record one PE pass on an artifact's newest version (the service, from the PE's run): one verdict per variant, or
 * one verdict on the whole artifact. Passes count within the version's round, up to three. Feasible-if states the
 * change; an estimate states its basis.
 */
export function addPeVerdicts(state: State, input: { artifactId: string; version: number; verdicts: VerdictInput[] }, now: string): { state: State; pass: number } {
  const a = getArtifact(state, input.artifactId, input.version);
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
  const records: PeVerdict[] = vs.map((v) => {
    const reasons = required(agentText(v.reasons), 2000, "The verdict's reasons");
    const change = v.change === undefined ? "" : capped(agentText(v.change), 1000, "The stated change");
    if (v.verdict === "feasible-if" && !change) throw new ControlError("Feasible-if states the change that makes it feasible.");
    return { id: "", artifactId: a.id, version: a.version, ...(v.variant !== undefined ? { variant: v.variant } : {}), pass, verdict: v.verdict, reasons, ...(change ? { change } : {}), ...(v.budget ? { budget: estimate(v.budget) } : {}), at: now };
  });
  const s = draft(state);
  for (const r of records) s.studio.verdicts.push({ ...r, id: nextId(s, "pev") });
  const art = getArtifact(s, a.id, a.version);
  const words: Record<Verdict, string> = { feasible: "feasible", "feasible-if": "feasible if changed", "not-feasible": "not feasible" };
  const r = peReview(s, art);
  const outcome = r.status === "agreed" ? "agreed; it goes to the owner" : r.status === "objections" ? `still objects after ${MAX_PE_PASSES} passes; it goes to the owner with the objections` : "the designer revises";
  event(s, now, "runtime", "vision", `PE review of ${artifactName(a)}, pass ${pass}: ${records.map((x) => `${x.variant ? `${variantLabel(a, x.variant)} ` : ""}${words[x.verdict]}`).join(", ")}; ${outcome}`);
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
  if (!readyForOwner(state, latest)) throw new ControlError(`The PE is still reviewing ${latest.title}; it reaches you once the PE agrees or after ${MAX_PE_PASSES} passes.`);
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
  note: string;
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
    if (!readyForOwner(state, a)) throw new ControlError(`${artifactName(a)} is still in PE review; it reaches you once the PE agrees or after ${MAX_PE_PASSES} passes.`);
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
      return { x: p.x, y: p.y, ...(pv !== undefined ? { variant: pv } : {}), text: required(ownerText(p.text), 1000, "A pinned comment") };
    });
    const note = capped(ownerText(e.note), 4000, "The note");
    return { artifactId: a.id, version: a.version, mark: e.mark, ...(picked !== undefined ? { pickedVariant: picked } : {}), pins, note, at: now };
  });
  const s = draft(state);
  s.studio.feedback.push(...records);
  const line = (f: Feedback) => {
    const a = getArtifact(s, f.artifactId, f.version);
    const parts = [f.mark ?? "", f.pickedVariant ? `picked ${variantLabel(a, f.pickedVariant)}` : "", f.pins.length ? `${f.pins.length} pin${f.pins.length === 1 ? "" : "s"}` : "", f.note ? "a note" : ""].filter(Boolean);
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
