// The studio's artifact viewer (ORC-029 pass 3d), as pure functions so it can be tested without a DOM: which rounds
// and artifacts to list, what each artifact shows (a device frame, a terminal window or a plain frame), where its
// prototype is served, which pins to take, and the owner's unsent feedback, sent as one `sendFeedback`.

import * as M from "../../domain/model";
import { budgetStop } from "../../domain/spend";
import * as S from "../../domain/studio/studio";
import * as R from "../../domain/studio/runs";
import { UNGATED_KINDS, type BudgetEstimate, type Feedback, type Mark, type Pin, type Round, type RoundFocus, type StudioArtifact, type StudioRun, type Verdict } from "../../domain/studio/types";
import type { Device, State } from "../../domain/types";
import { acceptPinMessage, prototypeOrigin, type PinMessage } from "../../runtime/prototype";

// ---------- rounds and artifacts ----------

export const FOCUS_LABEL: Record<RoundFocus, string> = { material: "What you brought", experience: "The experience", data: "Inputs and outputs", flows: "Flows" };

/** The rounds, newest first. */
export const roundsNewestFirst = (s: State): Round[] => [...s.studio.rounds].sort((a, b) => b.n - a.n);

/** The round to show first: the open one, else the newest. */
export function defaultRound(s: State): number | undefined {
  return (S.currentRound(s) ?? s.studio.rounds.at(-1))?.n;
}

/** The artifacts of a round: for each artifact with a version made in it, its newest version from that round, in the order they were added. */
export function roundArtifacts(s: State, n: number): StudioArtifact[] {
  const ids = [...new Set(s.studio.artifacts.filter((a) => a.round === n).map((a) => a.id))];
  return ids.map((id) => S.versionsOf(s, id).filter((a) => a.round === n).at(-1)!);
}

/**
 * The agents' artifacts waiting for your mark: the newest version of each, passed to you by the PE (or with its
 * objections after the last pass), with no mark from you yet. What you brought and a probe's evidence are not counted.
 */
export function waitingForYourMark(s: State): StudioArtifact[] {
  return S.latestArtifacts(s).filter((a) => !UNGATED_KINDS.includes(a.kind) && S.readyForOwner(s, a) && !S.currentFeedback(s, a.id, a.version)?.mark);
}

/** Where a version stands for the owner: theirs to mark, still with the PE, or replaced by a newer version. */
export type Standing = { kind: "open" } | { kind: "pe"; text: string } | { kind: "replaced"; by: StudioArtifact };

export function standing(s: State, a: StudioArtifact): Standing {
  const latest = S.latestVersion(s, a.id)!;
  if (latest.version !== a.version) return { kind: "replaced", by: latest };
  if (S.readyForOwner(s, a)) return { kind: "open" };
  const r = S.peReview(s, a);
  return { kind: "pe", text: r.status === "revising" ? `The PE objected on pass ${r.pass}; the designer revises before it reaches you.` : "Waiting for PE review. You can look at it now, and mark it once the PE agrees." };
}

/**
 * The kinds shown as documents (pass 4): Markdown with code blocks and tables, and Mermaid diagrams, never in a
 * device frame. `interface`, `algorithm` and `topology` are the kinds pass 4b adds for code products and
 * infrastructure (ORC-029 r9); a string list, so the studio shows them as soon as the domain has them.
 */
export const DOCUMENT_KINDS: readonly string[] = ["interface", "algorithm", "topology", "contract", "flow"];

/** How an artifact is shown: a screen in a device frame, a terminal window, a document, or the entry file in a plain frame. */
export type ShowKind = "screen" | "terminal" | "document" | "file";
export function showKind(a: StudioArtifact): ShowKind {
  if (a.kind === "screen") return "screen";
  if (a.kind === "terminal-demo" || a.kind === "tui") return "terminal";
  if (DOCUMENT_KINDS.includes(a.kind)) return "document";
  return "file";
}

/** What a document file is, by its extension: Markdown, a Mermaid diagram, or plain text; undefined for anything else. */
export function documentType(path: string): "markdown" | "mermaid" | "text" | undefined {
  const ext = /\.([^./]+)$/.exec(path)?.[1].toLowerCase();
  return ext === "md" || ext === "markdown" ? "markdown" : ext === "mmd" || ext === "mermaid" ? "mermaid" : ext === "txt" ? "text" : undefined;
}

const MAX_DOCUMENT_FILES = 12;

/**
 * The files a document artifact shows for a variant, in order: its entry when it is a document, then the other
 * document files beside it. An artifact with one take or none shows all its document files. Read through the app's
 * own service (`serviceFileUrl`), never from the prototype server.
 */
export function documentFiles(a: StudioArtifact, variantId: string | undefined): string[] {
  const docs = a.files.map((f) => f.path).filter((p) => documentType(p));
  const entry = a.variants.find((v) => v.id === variantId)?.entry;
  const first = (xs: string[]) => (entry !== undefined && xs.includes(entry) ? [entry, ...xs.filter((p) => p !== entry)] : xs);
  if (a.variants.length <= 1) return first(docs).slice(0, MAX_DOCUMENT_FILES);
  if (entry === undefined) return [];
  return first(docs.filter((p) => folderOf(p) === folderOf(entry))).slice(0, MAX_DOCUMENT_FILES);
}

/** A path a document refers to (an image), resolved inside its version's folder, or undefined when it leaves the folder or is a URL. */
export function resolveInVersion(from: string, ref: string): string | undefined {
  if (!ref || /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("/") || ref.startsWith("#")) return undefined;
  const parts = folderOf(from) ? folderOf(from).split("/") : [];
  for (const seg of ref.split(/[?#]/)[0].split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (!parts.length) return undefined;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/") || undefined;
}

/** "screen · 2 variants", "terminal demo · v2". */
export function artifactLine(a: StudioArtifact): string {
  const kind = a.kind.replace("-", " ");
  const parts = [kind, a.variants.length > 1 ? `${a.variants.length} variants` : "", a.version > 1 ? `v${a.version}` : ""].filter(Boolean);
  return parts.join(" · ");
}

/** Who made it, in a few words: "You brought it", "Designer · Claude · claude-x". */
export function madeByLine(a: StudioArtifact, providerLabel: (p: "claude" | "codex") => string): string {
  const m = a.madeBy;
  if (m.role === "user") return "You brought it";
  const role = m.role === "pe" ? "PE" : `${m.role[0].toUpperCase()}${m.role.slice(1)}`;
  return `${role} · ${providerLabel(m.provider)} · ${m.model}`;
}

// ---------- devices ----------

export type ScreenDevice = Extract<Device, "desktop" | "mobile">;
export const DEVICE_LABEL: Record<ScreenDevice, string> = { desktop: "Desktop", mobile: "Mobile" };
/** The frame sizes, in CSS pixels: desktop 1280×800, mobile 390×844 (the sizes the screenshots use). */
export const DEVICE_SIZE: Record<ScreenDevice, { width: number; height: number }> = { desktop: { width: 1280, height: 800 }, mobile: { width: 390, height: 844 } };

/** The devices a screen can be shown on: within the project's device scope, and among the artifact's own devices when it names any. */
export function deviceOptions(projectDevices: readonly Device[], a: StudioArtifact): ScreenDevice[] {
  return (["desktop", "mobile"] as const).filter((d) => projectDevices.includes(d) && (a.devices.length === 0 || a.devices.includes(d)));
}

// ---------- where a variant is served ----------

/**
 * A variant's entry file: the one the designer named in studio.json, which the version records on the variant. An
 * artifact without variants (what the owner brought) shows its first HTML file, else its first file. Undefined for a
 * variant that names none.
 */
export function variantEntry(a: StudioArtifact, variantId: string | undefined): string | undefined {
  if (!a.variants.length) return a.files.find((f) => /\.html?$/i.test(f.path))?.path ?? a.files[0]?.path;
  return a.variants.find((x) => x.id === variantId)?.entry;
}

/** A path in a version's folder as a URL path: each segment encoded. */
const urlPath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

/** Where a file of an artifact version is served: its own origin on the prototype port (runtime/prototype.ts). */
export function prototypeUrl(a: StudioArtifact, path: string, port: number): string {
  return `${prototypeOrigin(a.id, a.version, port)}/${urlPath(path)}`;
}

/** What the app can read of a version's files through its own service: terminal text and screenshots (see the report of pass 3d). */
export function serviceFileUrl(a: StudioArtifact, path: string): string {
  return `/api/studio/file?artifact=${encodeURIComponent(a.id)}&version=${a.version}&path=${encodeURIComponent(path)}`;
}

/** A variant's screenshot on a device, as the service names it: shots/<variant>-<device>.png. */
export const shotPath = (variantId: string, device: ScreenDevice) => `shots/${variantId}-${device}.png`;

// ---------- pins ----------

/**
 * A pin from a prototype frame, or null. Only while Pin mode is on, and only what acceptPinMessage accepts: a
 * well-formed pin posted by that frame's own window. Everything else (another window, another type, a pin while
 * Pin mode is off) is ignored.
 */
export function pinFromMessage(pinMode: boolean, event: { source: unknown; data: unknown }, frameWindow: unknown): PinMessage | null {
  if (!pinMode) return null;
  return acceptPinMessage(event, frameWindow);
}

// ---------- the owner's feedback ----------

/** A pin as the viewer keeps it: the domain's, with the clicked element's selector when the prototype sent one. */
export type DraftPin = Pin;

/** The owner's unsent answer on one version: what `sendFeedback` takes for it. */
export interface Draft {
  mark: Mark | null;
  pickedVariant?: string;
  pins: DraftPin[];
  note: string;
}

export const draftKey = (a: { id: string; version: number }) => `${a.id}@${a.version}`;

/** The draft a version starts from: the owner's current feedback on it (with any pins carried from the version before). */
export function draftFrom(f: Feedback | undefined): Draft {
  return { mark: f?.mark ?? null, ...(f?.pickedVariant ? { pickedVariant: f.pickedVariant } : {}), pins: (f?.pins ?? []).map((p) => ({ ...p })), note: f?.note ?? "" };
}

/** Pins are the same by place, variant, comment and element. */
function samePins(a: DraftPin[], b: DraftPin[]) {
  return a.length === b.length && a.every((p, i) => p.x === b[i].x && p.y === b[i].y && p.variant === b[i].variant && p.text.trim() === b[i].text.trim() && p.selector === b[i].selector);
}

export function sameDraft(a: Draft, b: Draft): boolean {
  return a.mark === b.mark && a.pickedVariant === b.pickedVariant && a.note.trim() === b.note.trim() && samePins(a.pins, b.pins);
}

/** A pin from the frame, added to a draft with an empty comment for the owner to write. Variant: the one shown, for an artifact with several. */
export function addPin(d: Draft, pin: PinMessage, variant: string | undefined): Draft {
  return { ...d, pins: [...d.pins, { x: pin.x, y: pin.y, ...(variant !== undefined ? { variant } : {}), text: "", ...(pin.selector ? { selector: pin.selector } : {}) }] };
}

/** "Keep, picked B · Day by day, 2 pins, a note"; "" for an empty draft. */
export function draftSummary(a: StudioArtifact, d: Draft): string {
  const label = (id: string) => a.variants.find((v) => v.id === id)?.label ?? id;
  const mark = d.mark ? `${d.mark[0].toUpperCase()}${d.mark.slice(1)}` : "";
  return [mark, d.pickedVariant ? `picked ${label(d.pickedVariant)}` : "", d.pins.length ? `${d.pins.length} pin${d.pins.length === 1 ? "" : "s"}` : "", d.note.trim() ? "a note" : ""].filter(Boolean).join(", ");
}

/** The versions whose draft differs from the owner's current feedback: the marks Send sends. Only versions the owner can answer (theirs, newest). */
export function changedDrafts(s: State, drafts: Readonly<Record<string, Draft>>): { artifact: StudioArtifact; draft: Draft }[] {
  const out: { artifact: StudioArtifact; draft: Draft }[] = [];
  for (const a of S.latestArtifacts(s)) {
    const d = drafts[draftKey(a)];
    if (!d || standing(s, a).kind !== "open") continue;
    if (!sameDraft(d, draftFrom(S.currentFeedback(s, a.id, a.version)))) out.push({ artifact: a, draft: d });
  }
  return out;
}

/** The `sendFeedback` entries for the changed drafts. A pin carries the element it is on, when the prototype said. */
export function feedbackEntries(changed: { artifact: StudioArtifact; draft: Draft }[]) {
  return changed.map(({ artifact, draft }) => ({
    artifactId: artifact.id,
    version: artifact.version,
    mark: draft.mark,
    ...(draft.pickedVariant ? { pickedVariant: draft.pickedVariant } : {}),
    pins: draft.pins.map((p) => ({ x: p.x, y: p.y, ...(p.variant !== undefined ? { variant: p.variant } : {}), text: p.text.trim(), ...(p.selector ? { selector: p.selector } : {}) })),
    note: draft.note.trim(),
  }));
}

// ---------- the lead's panel, and your answer to the round ----------

/** One of the lead's questions for a round: what it asks, why, and the answers it suggests. */
export interface RoundQuestion {
  text: string;
  reason?: string;
  options?: string[];
}

/** The lead's words for a round, which the lead's run records on the round (pass 4b): its message and its questions. */
export interface RoundLead {
  message: string;
  questions: RoundQuestion[];
}

const trimmed = (x: unknown) => (typeof x === "string" ? x.trim() : "");

/**
 * The lead's message and questions for a round, from the round's `lead` record (pass 4b), or undefined when it has
 * none (a round opened before pass 4, or by the service alone). Read defensively, and ORC-012's question shape
 * (`question`, `why`) is read too, so the panel shows what is there rather than nothing.
 */
export function roundLead(r: Round | undefined): RoundLead | undefined {
  const raw = (r as { lead?: unknown } | undefined)?.lead;
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const questions = (Array.isArray(o.questions) ? o.questions : []).flatMap((q): RoundQuestion[] => {
    if (!q || typeof q !== "object") return [];
    const x = q as Record<string, unknown>;
    const text = trimmed(x.text) || trimmed(x.question);
    if (!text) return [];
    const reason = trimmed(x.reason) || trimmed(x.why);
    const options = Array.isArray(x.options) ? x.options.map(trimmed).filter(Boolean) : [];
    return [{ text, ...(reason ? { reason } : {}), ...(options.length ? { options } : {}) }];
  });
  const message = trimmed(o.message);
  return message || questions.length ? { message, questions } : undefined;
}

/** The longest message the conversation takes (domain/model/lead.ts postMessage). */
export const MAX_MESSAGE = 8000;

/** Your answer to a round, before it is sent: your changed marks, your answers to the lead's questions, and your message. */
export interface Answer {
  round: number | undefined;
  questions: RoundQuestion[];
  answers: string[];
  message: string;
  changed: { artifact: StudioArtifact; draft: Draft }[];
}

/**
 * The one message to the lead, in the conversation the header's Message the lead opens: your message, then your
 * answers (ORC-012's "Send answers" form; unanswered questions are left out), then a line for each artifact you
 * marked (the marks, picks, pins and notes themselves are recorded on each version). "" when there is nothing to send.
 */
export function answerMessage(x: Answer): string {
  const parts: string[] = [];
  if (x.message.trim()) parts.push(x.message.trim());
  const qa = M.answersMessage(
    x.questions.map((q) => ({ question: q.text, why: q.reason ?? "" })),
    x.answers,
  );
  if (qa) parts.push(`My answers${x.round !== undefined ? ` to round ${x.round}` : ""}:\n\n${qa}`);
  if (x.changed.length) parts.push(`My feedback, recorded on each version:\n${x.changed.map(({ artifact: a, draft }) => `- ${a.title} v${a.version}: ${draftSummary(a, draft) || "cleared"}`).join("\n")}`);
  return parts.join("\n\n");
}

/** What Send would send, in a few words each, for the summary above it: "2 answers", "a message". */
export function answerParts(x: Answer): string[] {
  const answered = x.questions.filter((_, i) => (x.answers[i] ?? "").trim()).length;
  return [answered ? `${answered} answer${answered === 1 ? "" : "s"} to the lead's questions` : "", x.message.trim() ? "a message to the lead" : ""].filter(Boolean);
}

/** Why Send cannot send yet, in words, or undefined. */
export function answerBlocker(x: Answer): string | undefined {
  for (const { artifact, draft } of x.changed) {
    const empty = draft.pins.findIndex((p) => !p.text.trim());
    if (empty >= 0) return `Write a comment for pin ${empty + 1} on ${artifact.title}, or remove it.`;
  }
  const text = answerMessage(x);
  if (!text) return "Mark, pick or pin something, answer a question, or write to the lead first.";
  if (text.length > MAX_MESSAGE) return `Together this is over ${MAX_MESSAGE} characters; shorten your message or your answers.`;
  return undefined;
}

type Send = (name: "sendFeedback" | "postMessage", args: object) => Promise<{ ok: boolean }>;

/**
 * Send to the lead: your changed marks as one `sendFeedback`, recorded on each version (compare-and-set on the
 * version you saw), then everything as one `postMessage`, the one message the lead answers. The marks go first, so
 * the message never speaks of marks the service refused. Returns the drafts recorded (their keys, to clear) and
 * whether the message was posted, or null when nothing was sent (blocked, or the marks were refused).
 */
export async function sendAnswer(send: Send, s: State, drafts: Readonly<Record<string, Draft>>, x: Omit<Answer, "changed">): Promise<{ recorded: string[]; posted: boolean } | null> {
  const answer = { ...x, changed: changedDrafts(s, drafts) };
  if (answerBlocker(answer)) return null;
  if (answer.changed.length && !(await send("sendFeedback", { entries: feedbackEntries(answer.changed) })).ok) return null;
  const posted = (await send("postMessage", { text: answerMessage(answer) })).ok;
  return { recorded: answer.changed.map((c) => draftKey(c.artifact)), posted };
}

// ---------- terminal artifacts ----------

/**
 * How one variant of a terminal demo or TUI is shown, from what the service recorded on the version (`demo`):
 * - pending: the service is recording it;
 * - recorded: VHS recorded the designer's tape in the sandbox (a webm or gif, and maybe its text transcript); `error`
 *   when the recording shows a failure the designer did not mean to show (its first failing line);
 * - hand-written: not recorded (`reason`, when the tape was not); the designer's asciicast (`.cast`, shown as its
 *   transcript) or frame (`.ans`);
 * - not recorded: nothing to play, with the reason.
 * Paths are relative to the version's folder.
 */
export type DemoView =
  | { status: "pending" }
  | { status: "recorded"; video?: string; gif?: string; transcript?: string; error?: string }
  | { status: "hand-written"; cast?: string; frame?: string; reason?: string }
  | { status: "not-recorded"; reason: string };

const firstOf = (paths: readonly string[], ext: string) => paths.find((p) => p.toLowerCase().endsWith(`.${ext}`));
const folderOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

/**
 * What to show of a terminal variant. The service records it on the version after import (`demo`); a version it
 * records none for (no media service) shows the hand-written .cast or .ans beside the variant's entry, if any.
 */
export function variantDemo(a: StudioArtifact, variantId: string | undefined): DemoView {
  const d = a.demo;
  if (d?.status === "pending") return { status: "pending" };
  if (d?.status === "done") {
    const v = d.variants.find((x) => x.variant === variantId);
    if (!v) return { status: "not-recorded", reason: "The service recorded nothing for this variant." };
    if (v.status === "recorded" || v.status === "recorded-with-errors") return { status: "recorded", ...(v.webm ? { video: v.webm } : {}), ...(v.gif ? { gif: v.gif } : {}), ...(v.txt ? { transcript: v.txt } : {}), ...(v.status === "recorded-with-errors" ? { error: v.reason } : {}) };
    if (v.status === "hand-written") {
      const cast = firstOf(v.files, "cast");
      const frame = firstOf(v.files, "ans");
      return { status: "hand-written", ...(cast ? { cast } : {}), ...(frame ? { frame } : {}), ...(v.reason ? { reason: v.reason } : {}) };
    }
    return { status: "not-recorded", reason: v.reason };
  }
  const entry = a.variants.find((v) => v.id === variantId)?.entry;
  const beside = a.files.map((f) => f.path).filter((p) => entry !== undefined && folderOf(p) === folderOf(entry));
  const cast = firstOf(beside, "cast");
  const frame = firstOf(beside, "ans");
  if (cast || frame) return { status: "hand-written", ...(cast ? { cast } : {}), ...(frame ? { frame } : {}) };
  return { status: "not-recorded", reason: "This service records no terminal demos, and the variant has no hand-written .cast or .ans." };
}

// ---------- PE review ----------

/** One verdict of the PE's latest pass, as the studio shows it. */
export interface VerdictLine {
  id: string;
  /** The variant's label, or "The whole artifact". */
  label: string;
  verdict: Verdict;
  reasons: string;
  change?: string;
  budget?: BudgetEstimate;
  overruled?: { at: string; why: string };
}

/** Where PE review of a version stands, for the right column. */
export interface PeView {
  tone: "work" | "you" | "done" | "fail" | "neutral";
  /** The state in a few words: "Agreed", "Objects: waiting for you", "Reviewing"… */
  state: string;
  text: string;
  /** "Codex · gpt-x", the PE that made the latest pass (or is reviewing). */
  by?: string;
  /**
   * Set when the PE ran on the designer's own provider, so its review is not independent (ORC-029 r5: the PE runs on
   * the other provider by default): "Not independent: the PE ran on the designer's own provider (Claude)."
   */
  notIndependent?: string;
  simulated: boolean;
  verdicts: VerdictLine[];
}

export const VERDICT_LABEL: Record<Verdict, string> = { feasible: "Feasible", "feasible-if": "Feasible if changed", "not-feasible": "Not feasible" };
export const VERDICT_TONE: Record<Verdict, "done" | "you" | "fail"> = { feasible: "done", "feasible-if": "you", "not-feasible": "fail" };

/** "$40–$90", "$5–$5 a month" as "$5 a month". */
export function usdRange([lo, hi]: [number, number], perMonth = false): string {
  const usd = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
  return `${lo === hi ? usd(lo) : `${usd(lo)}–${usd(hi)}`}${perMonth ? " a month" : ""}`;
}

/**
 * PE review of a version, for the owner: its verdicts per variant and what it means for them. Undefined for what the
 * owner brought and a probe's evidence, which the PE does not review.
 */
export function peView(s: State, a: StudioArtifact, providerLabel: (p: "claude" | "codex") => string): PeView | undefined {
  if (UNGATED_KINDS.includes(a.kind)) return undefined;
  const r = S.peReview(s, a);
  const runs = S.peRunsOf(s, a.id, a.version);
  const run = runs.at(-1);
  const mine = s.studio.verdicts.filter((v) => v.artifactId === a.id && v.version === a.version);
  const pass = mine.length ? Math.max(...mine.map((v) => v.pass)) : 0;
  const latest = mine.filter((v) => v.pass === pass);
  const label = (id: string | undefined) => (id === undefined ? "The whole artifact" : (a.variants.find((v) => v.id === id)?.label ?? id));
  const verdicts = latest.map((v) => ({ id: v.id, label: label(v.variant), verdict: v.verdict, reasons: v.reasons, ...(v.change ? { change: v.change } : {}), ...(v.budget ? { budget: v.budget } : {}), ...(v.overruled ? { overruled: v.overruled } : {}) }));
  const madeBy = latest.find((v) => v.by)?.by;
  const byRun = madeBy ? s.studio.runs.find((x) => x.id === madeBy.runId) : run;
  const by = madeBy ? `${providerLabel(madeBy.provider)} · ${madeBy.model}` : run ? `${providerLabel(run.provider)} · ${run.actualModel ?? run.model}` : undefined;
  // The PE's provider: its latest pass's run, or the run reviewing now; compared with the provider of the designer's run that made the version.
  const peProvider = madeBy?.provider ?? run?.provider;
  const designer = a.madeBy.role === "user" ? undefined : a.madeBy.provider;
  const notIndependent = peProvider && peProvider === designer ? `Not independent: the PE ran on the designer's own provider (${providerLabel(peProvider)}).` : undefined;
  const base = { ...(by ? { by } : {}), ...(notIndependent ? { notIndependent } : {}), simulated: !!byRun?.simulated, verdicts };
  const names = (vs: { label: string }[]) => vs.map((v) => v.label).join(", ");
  switch (r.status) {
    case "agreed":
      return { ...base, tone: "done", state: "Agreed", text: `The PE agreed on pass ${r.pass}: every option is feasible${verdicts.some((v) => v.verdict === "feasible-if") ? ", some only with the change it states" : ""}. It is yours to mark.` };
    case "ended": {
      const open = verdicts.filter((v) => v.verdict === "not-feasible" && !v.overruled);
      const asks = verdicts.filter((v) => v.verdict === "feasible-if");
      if (r.objections.length && !open.length && !asks.length) return { ...base, tone: "done", state: "Overruled", text: "You overruled the PE's objections; they stay recorded." };
      const said = open.length ? `The PE still objects to ${names(open)}` : asks.length ? `The PE still asks for changes to ${names(asks)}` : "The PE did not review it";
      return {
        ...base,
        tone: "you",
        state: open.length ? "Objects: waiting for you" : "Waiting for you",
        text: `${said}. PE review ended: ${S.LOOP_END_WORDS[r.ended]}${r.note ? ` (${r.note})` : ""}. This is waiting for you: mark it Keep, Change or Drop, pick a variant, and say what you decide in your note.`,
      };
    }
    case "revising":
      return { ...base, tone: "work", state: "Revising", text: `The PE objected on pass ${r.pass}; the designer revises before it reaches you.` };
  }
  // Waiting for the PE: why, from its runs.
  if (a.shots?.status === "pending" || a.demo?.status === "pending") return { ...base, tone: "neutral", state: "Waiting", text: `The PE reviews it once the ${a.shots?.status === "pending" ? "screenshots are taken" : "recording is made"}.` };
  if (run && (run.status === "running" || run.status === "stopping")) return { ...base, tone: "work", state: "Reviewing", text: "The PE is reading this version: its files, screenshots and recordings." };
  if (run?.status === "queued") return { ...base, tone: "neutral", state: "Queued", text: runLine(s, run, providerLabel).text };
  if (run &&(run.status === "failed" || run.status === "lost" || run.status === "stopped")) {
    const why = run.note ?? `its run was ${run.status}`;
    return R.peRunDue(s, a)
      ? { ...base, tone: "work", state: "Asking again", text: `The PE's run ended without a verdict (${why}); it is asked again.` }
      : { ...base, tone: "fail", state: "No verdict", text: `The PE's runs ended without a verdict: ${why} It is not asked again on its own; the studio's next pass adds a way to ask.` };
  }
  return { ...base, tone: "neutral", state: "Waiting", text: "Waiting for PE review." };
}

// ---------- an artifact's versions (the PE loop, pass 4c) ----------

/** One version of an artifact, as its history shows it: the PE's pass on it, your mark, and whether it is the current one. */
export interface VersionLine {
  version: number;
  round: number;
  /** The newest version: the one the PE and you answer. */
  current: boolean;
  tone: "work" | "you" | "done" | "fail" | "neutral";
  /** Where PE review of it ended, in a word or two: "agreed", "objected", "waiting for you"… */
  state: string;
  text: string;
}

/**
 * An artifact's versions, oldest first (v1 → v2 → v3): the PE's pass on each and what came of it, your mark, and
 * which is current. The designer revises after an objection while passes remain; an objection that stands after the
 * last pass waits for you, and is never dropped.
 */
export function versionHistory(s: State, a: StudioArtifact): VersionLine[] {
  const all = S.versionsOf(s, a.id);
  const newest = all.at(-1)?.version;
  return all.map((v) => {
    const next = all.find((x) => x.version > v.version);
    const label = (id: string | undefined) => (id === undefined ? "the whole artifact" : (v.variants.find((x) => x.id === id)?.label ?? id));
    const names = (vs: { variant?: string }[]) => vs.map((x) => label(x.variant)).join(", ");
    const line = (tone: VersionLine["tone"], state: string, text: string): VersionLine => {
      const mark = S.currentFeedback(s, v.id, v.version)?.mark;
      return { version: v.version, round: v.round, current: v.version === newest, tone, state, text: mark ? `${text} You marked it ${mark}.` : text };
    };
    if (UNGATED_KINDS.includes(v.kind)) return line("neutral", v.kind === "material" ? "you brought it" : "evidence", "The PE does not review it.");
    const r = S.peReview(s, v);
    switch (r.status) {
      case "waiting":
        return next ? line("neutral", "not reviewed", `Replaced by v${next.version} before the PE reviewed it.`) : line("neutral", "with the PE", "Waiting for PE review.");
      case "agreed":
        return line("done", "agreed", `PE pass ${r.pass}: agreed.`);
      case "revising":
        return next
          ? line("neutral", "objected", `PE pass ${r.pass}: objected to ${names(r.objections)}; the designer revised it as v${next.version}.`)
          : line("work", "revising", `PE pass ${r.pass}: objects to ${names(r.objections)}; the designer is revising it.`);
      case "ended": {
        const open = r.objections.filter((o) => !o.overruled);
        if (r.objections.length && !open.length && !r.asks.length) return line("done", "overruled", `PE pass ${r.pass}: you overruled its objections.`);
        const said = [open.length ? `still objects to ${names(open)}` : "", r.asks.length ? `still asks for changes to ${names(r.asks)}` : ""].filter(Boolean).join("; ");
        const why = `review ended: ${S.LOOP_END_WORDS[r.ended]}`;
        const head = r.pass ? `PE pass ${r.pass}: ${said ? `${said}; ` : ""}${why}` : `PE ${why}`;
        return next ? line("neutral", "ended", `${head}. It went to you, and v${next.version} followed.`) : line("you", "waiting for you", `${head}. This is waiting for you.`);
      }
    }
  });
}

// ---------- the designer's runs ----------

/** A designer's run as a line in the left column: what it is doing, or why it waits or failed. */
export interface RunLine {
  id: string;
  tone: "work" | "fail" | "neutral";
  title: string;
  text: string;
}

/**
 * The studio runs of a round worth showing: every run not finished (queued, running, stopping), and the newest
 * finished one when it did not complete (failed, stopped or lost), so a failure stays visible until a later run
 * completes.
 */
export function roundRuns(s: State, n: number): StudioRun[] {
  const mine = s.studio.runs.filter((r) => r.round === n);
  const live = mine.filter((r) => r.status === "queued" || r.status === "running" || r.status === "stopping");
  const last = mine.filter((r) => !live.includes(r)).at(-1);
  return last && last.status !== "completed" ? [...live, last] : live;
}

export function runLine(s: State, r: StudioRun, providerLabel: (p: "claude" | "codex") => string): RunLine {
  const who = `${r.kind === "pe" ? "PE" : r.kind === "probe" ? "Probe" : "Designer"} · ${providerLabel(r.provider)} · ${r.model}${r.simulated ? " (simulated)" : ""}`;
  switch (r.status) {
    case "queued": {
      const why = s.project.hold
        ? "It waits until you resume the project."
        : s.project.stage !== "shaping"
          ? "It waits until the project is back in Vision."
          : budgetStop(s)
            ? "It waits: the building budget is reached."
            : "Waiting to start.";
      return { id: r.id, tone: "neutral", title: `${who}: queued`, text: why };
    }
    case "running":
      return { id: r.id, tone: "work", title: `${who}: working`, text: r.activity ?? "The designer is making this round's artifacts." };
    case "stopping":
      return { id: r.id, tone: "work", title: `${who}: stopping`, text: r.note ?? "Asked to stop; waiting for the runtime to confirm." };
    case "failed":
      return { id: r.id, tone: "fail", title: `${who}: failed`, text: r.note ?? "It failed without a reason." };
    case "lost":
      return { id: r.id, tone: "fail", title: `${who}: lost`, text: r.note ?? "Its process is gone." };
    case "stopped":
      return { id: r.id, tone: "neutral", title: `${who}: stopped`, text: r.note ?? "It was stopped before it finished." };
    default:
      return { id: r.id, tone: "neutral", title: `${who}: done`, text: "" };
  }
}
