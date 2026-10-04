// The studio's artifact viewer (ORC-029 pass 3d), as pure functions so it can be tested without a DOM: which rounds
// and artifacts to list, what each artifact shows (a device frame, a terminal window or a plain frame), where its
// prototype is served, which pins to take, and the owner's unsent feedback, sent as one `sendFeedback`.

import * as M from "../../domain/model";
import { budgetStop } from "../../domain/spend";
import * as B from "../../domain/studio/blueprint";
import * as S from "../../domain/studio/studio";
import * as R from "../../domain/studio/runs";
import {
  DOCUMENT_KINDS,
  KIND_RULES,
  VERDICT_WORDS,
  isUnderWay,
  type BudgetEstimate,
  type Feedback,
  type Mark,
  type PeVerdict,
  type Pin,
  type Round,
  type RoundFocus,
  type RoundLead,
  type RoundQuestion,
  type RowMark,
  type StudioArtifact,
  type StudioRun,
  type VariantRules,
  type Verdict,
} from "../../domain/studio/types";
import { PROJECT_DOMAINS, type Device, type ProjectDomain, type State } from "../../domain/types";
import { acceptPinMessage, prototypeOrigin, type PinMessage } from "../../runtime/prototype";

// ---------- rounds and artifacts ----------

export const FOCUS_LABEL: Record<RoundFocus, string> = { material: "What you brought", experience: "The experience", data: "Inputs and outputs", flows: "Flows" };

/** Round 0 of an existing repository: the designer's reproductions of what the code does now (pass 4, "as is"). */
export const AS_IS_LABEL = "As it is today";

/** A round's name: its focus, or "As it is today" for a round 0 that holds the designer's "as is" reproductions. */
export function roundLabel(s: State, r: Round): string {
  return r.focus === "material" && s.studio.artifacts.some((a) => a.round === r.n && a.provenance?.asIs) ? AS_IS_LABEL : FOCUS_LABEL[r.focus];
}

/** How many of an "as is" artifact's files show before "Show all". */
export const AS_IS_FILES_SHOWN = 6;

// ---------- the product's kinds (project domains) ----------

/**
 * The kinds of product the owner chooses from (`setDomains`), in Settings › Project and in the studio's prompt: what
 * each is, by who uses it, and what the designer makes for it.
 */
export const DOMAIN_CHOICES: readonly { value: ProjectDomain; label: string; use: string; makes: string }[] = [
  { value: "screen", label: "Screen product", use: "People use it on a screen: in a browser, on a desktop or a phone, or in a terminal.", makes: "The designer makes screens and terminal demos." },
  { value: "code", label: "Code product", use: "Other programs use it: a library, an engine or a compiler.", makes: "The designer makes the interface and the core algorithms." },
  { value: "infrastructure", label: "Infrastructure", use: "It runs other software: servers, queues or deployment.", makes: "The designer makes the topology, what fails and how it recovers, and the scale and cost." },
];

/** The kinds with `d` added, or taken away when it is there; always in the fixed order. */
export function toggleDomain(chosen: readonly ProjectDomain[], d: ProjectDomain): ProjectDomain[] {
  const next = chosen.includes(d) ? chosen.filter((x) => x !== d) : [...chosen, d];
  return PROJECT_DOMAINS.filter((x) => next.includes(x));
}

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
 * The artifacts waiting for your mark: the newest version of each artifact whose kind asks for your mark
 * (`KIND_RULES`), once it reaches you (the PE agreed, its review ended, or the PE does not review the kind), with no
 * mark from you yet. What you brought and a probe's evidence are not counted, nor a part the blueprint settled: this
 * version in the draft or in force, or the part dropped.
 */
export function waitingForYourMark(s: State): StudioArtifact[] {
  return S.latestArtifacts(s).filter((a) => KIND_RULES[a.kind].ownerMark === "asked" && S.readyForOwner(s, a) && !answered(a, S.currentFeedback(s, a.id, a.version)) && !settled(s, a));
}

/** Whether the blueprint settled this version: the draft holds it approved, or drops its part. */
function settled(s: State, a: StudioArtifact): boolean {
  const item = B.draftItems(s).find((i) => i.artifactId === a.id) ?? (a.supersedes ? B.draftItems(s).find((i) => i.artifactId === a.supersedes) : undefined);
  return !!item && (item.status === "dropped" || (item.status === "approved" && item.artifactId === a.id && item.version === a.version));
}

/** Whether the owner answered a version: a mark on it, or (a dictionary, a flow with rules) a mark on every row. */
function answered(a: StudioArtifact, f: Feedback | undefined): boolean {
  if (f?.mark) return true;
  const rows = tableRows(a);
  return rows.length > 0 && rows.every((r) => f?.rows?.some((m) => m.row === r.row && m.variant === r.variant));
}

/** Where a version stands for the owner: theirs to mark, still with the PE, or replaced by a newer version. */
export type Standing = { kind: "open" } | { kind: "pe"; text: string } | { kind: "replaced"; by: StudioArtifact };

export function standing(s: State, a: StudioArtifact): Standing {
  const latest = S.latestVersion(s, a.id)!;
  if (latest.version !== a.version) return { kind: "replaced", by: latest };
  if (S.readyForOwner(s, a)) return { kind: "open" };
  const r = S.peReview(s, a);
  return { kind: "pe", text: r.status === "revising" ? revisingText(a, r) : "Waiting for PE review. You can look at it now. You can mark it after PE review." };
}

/** How an artifact is shown: a screen in a device frame, a terminal window, a document (the domain's `DOCUMENT_KINDS`), or the entry file in a plain frame. */
export type ShowKind = "screen" | "terminal" | "document" | "dictionary" | "file";
export function showKind(a: StudioArtifact): ShowKind {
  if (a.kind === "screen") return "screen";
  if (a.kind === "dictionary") return "dictionary";
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

/** "screen · 2 variants", "terminal demo · v2", "as is · screen". */
export function artifactLine(a: StudioArtifact): string {
  const kind = a.kind.replace("-", " ");
  const parts = [a.provenance?.asIs ? "as is" : "", kind, a.variants.length > 1 ? `${a.variants.length} variants` : "", a.version > 1 ? `v${a.version}` : ""].filter(Boolean);
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
  /** Marks on a dictionary's terms or a flow's rules (pass 4d). */
  rows: RowMark[];
  note: string;
}

export const draftKey = (a: { id: string; version: number }) => `${a.id}@${a.version}`;

/** The draft a version starts from: the owner's current feedback on it (with any pins carried from the version before). */
export function draftFrom(f: Feedback | undefined): Draft {
  return { mark: f?.mark ?? null, ...(f?.pickedVariant ? { pickedVariant: f.pickedVariant } : {}), pins: (f?.pins ?? []).map((p) => ({ ...p })), rows: (f?.rows ?? []).map((r) => ({ ...r })), note: f?.note ?? "" };
}

/** Row marks are the same when each row has the same mark, whatever order they were made in. */
function sameRows(a: RowMark[], b: RowMark[]) {
  return a.length === b.length && a.every((x) => b.some((y) => y.row === x.row && y.variant === x.variant && y.mark === x.mark));
}

/** Pins are the same by place, variant, comment and element. */
function samePins(a: DraftPin[], b: DraftPin[]) {
  return a.length === b.length && a.every((p, i) => p.x === b[i].x && p.y === b[i].y && p.variant === b[i].variant && p.text.trim() === b[i].text.trim() && p.selector === b[i].selector);
}

export function sameDraft(a: Draft, b: Draft): boolean {
  return a.mark === b.mark && a.pickedVariant === b.pickedVariant && a.note.trim() === b.note.trim() && samePins(a.pins, b.pins) && sameRows(a.rows, b.rows);
}

/** A pin from the frame, added to a draft with an empty comment for the owner to write. Variant: the one shown, for an artifact with several. */
export function addPin(d: Draft, pin: PinMessage, variant: string | undefined): Draft {
  return { ...d, pins: [...d.pins, { x: pin.x, y: pin.y, ...(variant !== undefined ? { variant } : {}), text: "", ...(pin.selector ? { selector: pin.selector } : {}) }] };
}

/** "Keep, picked B · Day by day, 2 pins, 3 terms marked, a note"; "" for an empty draft. */
export function draftSummary(a: StudioArtifact, d: Draft): string {
  const label = (id: string) => a.variants.find((v) => v.id === id)?.label ?? id;
  const mark = d.mark ? `${d.mark[0].toUpperCase()}${d.mark.slice(1)}` : "";
  const rows = d.rows.length ? `${d.rows.length} ${a.kind === "dictionary" ? "term" : "rule"}${d.rows.length === 1 ? "" : "s"} marked` : "";
  return [mark, d.pickedVariant ? `picked ${label(d.pickedVariant)}` : "", d.pins.length ? `${d.pins.length} pin${d.pins.length === 1 ? "" : "s"}` : "", rows, d.note.trim() ? "a note" : ""].filter(Boolean).join(", ");
}

// ---------- tables: a dictionary's terms and a flow's rules (pass 4d) ----------

/** A row the owner can mark: a term of a dictionary, or a rule of a flow's variant (`variant` set when the flow has several). */
export interface TableRow {
  row: string;
  variant?: string;
}

/** Every row of a version the owner can mark: each term of a dictionary, or each rule of each variant of a flow. */
export function tableRows(a: StudioArtifact): TableRow[] {
  if (a.dictionary) return a.dictionary.map((e) => ({ row: e.term }));
  return (a.rules ?? []).flatMap((r) => r.rules.map((x) => ({ row: x.id, ...(a.variants.length > 1 ? { variant: r.variant } : {}) })));
}

/** The owner's mark on one row in a draft, or null. */
export function rowMark(d: Draft, row: string, variant?: string): Mark | null {
  return d.rows.find((r) => r.row === row && r.variant === variant)?.mark ?? null;
}

/** One click on a row's mark: the mark is set, or cleared when the row already has it. */
export function toggleRow(d: Draft, row: string, variant: string | undefined, mark: Mark): Draft {
  const rest = d.rows.filter((r) => !(r.row === row && r.variant === variant));
  return { ...d, rows: rowMark(d, row, variant) === mark ? rest : [...rest, { row, ...(variant !== undefined ? { variant } : {}), mark }] };
}

/** Keep every row the owner has not marked yet, in one click: the cheapest answer to a long table. */
export function keepUnmarked(d: Draft, rows: TableRow[]): Draft {
  const open = rows.filter((r) => rowMark(d, r.row, r.variant) === null);
  return { ...d, rows: [...d.rows, ...open.map((r) => ({ ...r, mark: "keep" as const }))] };
}

/** The rules of the variant shown: its rules.json, or none. */
export function variantRules(a: StudioArtifact, variantId: string | undefined): VariantRules | undefined {
  const v = variantId ?? (a.variants.length === 1 ? a.variants[0].id : undefined);
  return a.rules?.find((r) => r.variant === v);
}

/**
 * Where a dictionary version stands (domain/studio/blueprint.ts): in force (locked in: the factory's agents get it),
 * in the draft (approved: the studio works with it, and the factory's agents get it at your next Lock in), or not in
 * force, and which version is.
 */
export function dictionaryStanding(s: State, a: StudioArtifact): { place: "in force" | "in the draft" | "not in force"; text: string } {
  const is = (d: B.DictionaryInForce | undefined) => !!d && d.artifact.id === a.id && d.artifact.version === a.version;
  const force = B.dictionaryInForce(s);
  const drafted = B.dictionaryInDraft(s);
  if (is(force)) return { place: "in force", text: "These are the project's words. Every agent gets them, and the writing check reports a word to avoid." };
  if (is(drafted)) return { place: "in the draft", text: `The studio uses these words now. The factory's agents get them at your next Lock in${force ? `; until then they keep ${force.artifact.title} v${force.artifact.version}` : ""}.` };
  if (drafted) return { place: "not in force", text: `Not in force. ${drafted.artifact.title} v${drafted.artifact.version} is the project's dictionary until you keep this version: mark it Keep and send.` };
  return { place: "not in force", text: "Not in force yet. Mark it Keep and send to put these words in the draft." };
}

/**
 * The parts of your answer: each version you worked on whose draft differs from your current feedback, or whose Keep
 * or Drop the blueprint's draft does not show yet (you marked it again after a refusal or a Discard). Only versions
 * the owner can answer (theirs, newest).
 */
export function changedDrafts(s: State, drafts: Readonly<Record<string, Draft>>): { artifact: StudioArtifact; draft: Draft }[] {
  const out: { artifact: StudioArtifact; draft: Draft }[] = [];
  for (const a of S.latestArtifacts(s)) {
    const d = drafts[draftKey(a)];
    if (!d || standing(s, a).kind !== "open") continue;
    if (!sameDraft(d, draftFrom(S.currentFeedback(s, a.id, a.version))) || draftEffect(s, a, d)?.command) out.push({ artifact: a, draft: d });
  }
  return out;
}

// ---------- what Send does to the blueprint's draft (ORC-030 Q-01) ----------

/**
 * What Send does to the draft for one part of your answer (the owner's agreed pass 1 screens showed Keep as "approved
 * by you"): Keep puts the version into the draft (`approveArtifact`, with your pick when it has several variants), and
 * Drop takes the part out when the draft holds it (`dropBlueprintItem`). When `approveArtifact` would refuse the Keep,
 * `refused` says why and Send does not ask. Undefined when Send leaves the draft as it is.
 */
export interface DraftEffect {
  key: string;
  command?: { name: "approveArtifact" | "dropBlueprintItem"; args: Record<string, unknown> };
  /** Before Send: what Send will do, or why Keep cannot. */
  will: string;
  /** After Send: what it did, or (`failed`) that the service refused it. */
  did: string;
  failed: string;
  refused?: string;
}

export function draftEffect(s: State, a: StudioArtifact, d: Draft): DraftEffect | undefined {
  const key = draftKey(a);
  const part = S.artifactName(a);
  if (d.mark === "keep") {
    if (B.inDraftAsIs(s, a, d.pickedVariant)) return undefined;
    const refused = B.approvalRefusal(s, a, d);
    if (refused) return { key, will: `Keep cannot put ${part} in the draft yet: ${refused}.`, did: `${part} is not in the draft: ${refused}.`, failed: "", refused };
    const labelOf = (id: string | undefined) => (id === undefined ? undefined : (a.variants.find((v) => v.id === id)?.label ?? id));
    const label = a.variants.length > 1 ? labelOf(d.pickedVariant) : undefined;
    const name = label ? `${part} (${label})` : part;
    // What the draft holds for this part now, which the Keep replaces: another version, or another pick of this one.
    const before = B.droppableItem(s, a);
    const replaces = before?.status !== "approved" ? "" : before.artifactId === a.id && before.version === a.version ? `, in place of ${labelOf(before.variant)}` : `, in place of ${before.title} v${before.version}`;
    return {
      key,
      command: { name: "approveArtifact", args: { artifactId: a.id, version: a.version, ...(label ? { variant: d.pickedVariant } : {}) } },
      will: `Keep puts ${name} in the draft${replaces}.`,
      did: `${name} is in the draft.`,
      failed: `${name} is not in the draft: the service refused it (the notice at the top says why).`,
    };
  }
  if (d.mark === "drop") {
    const item = B.droppableItem(s, a);
    if (!item) return undefined;
    const inForce = B.blueprintItems(s).some((i) => i.id === item.id && i.status !== "dropped");
    const name = `${item.title} v${item.version}`;
    return {
      key,
      command: { name: "dropBlueprintItem", args: { itemId: item.id } },
      will: inForce ? `Drop takes ${item.title} out of the draft: it leaves the design at your next Lock in.` : `Drop takes ${name} out of the draft.`,
      did: inForce ? `${item.title} is dropped in the draft: it leaves the design at your next Lock in.` : `${name} is out of the draft.`,
      failed: `${item.title} is still in the draft: the service refused the Drop (the notice at the top says why).`,
    };
  }
  return undefined;
}

/**
 * Where a version you marked Keep stands when the draft does not hold it and your answer has no change on it: why
 * Keep did not put it in, and how to. Undefined when the draft holds it, or it has no Keep.
 */
export function keptNotInDraft(s: State, a: StudioArtifact): string | undefined {
  const f = S.currentFeedback(s, a.id, a.version);
  if (f?.mark !== "keep" || standing(s, a).kind !== "open" || B.inDraftAsIs(s, a, f.pickedVariant)) return undefined;
  const refused = B.approvalRefusal(s, a, f);
  return refused ? `You marked it Keep, but it is not in the draft: ${refused}.` : "You marked it Keep, but it is not in the draft. To put it in, mark it Keep again and send.";
}

/** The `sendFeedback` entries for the changed drafts. A pin carries the element it is on, when the prototype said. */
export function feedbackEntries(changed: { artifact: StudioArtifact; draft: Draft }[]) {
  return changed.map(({ artifact, draft }) => ({
    artifactId: artifact.id,
    version: artifact.version,
    mark: draft.mark,
    ...(draft.pickedVariant ? { pickedVariant: draft.pickedVariant } : {}),
    pins: draft.pins.map((p) => ({ x: p.x, y: p.y, ...(p.variant !== undefined ? { variant: p.variant } : {}), text: p.text.trim(), ...(p.selector ? { selector: p.selector } : {}) })),
    ...(draft.rows.length ? { rows: draft.rows.map((r) => ({ row: r.row, ...(r.variant !== undefined ? { variant: r.variant } : {}), mark: r.mark })) } : {}),
    note: draft.note.trim(),
  }));
}

// ---------- the lead's panel, and your answer to the round ----------

/**
 * The lead's message and questions for a round, as its run recorded them, checked (domain/studio/lead.ts), or
 * undefined when it wrote neither (a round opened by the service alone).
 */
export function roundLead(r: Round | undefined): RoundLead | undefined {
  const lead = r?.lead;
  return lead && (lead.message.trim() || lead.questions.length) ? lead : undefined;
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
  if (!text) return "Mark, pick or pin something, write a note, or answer a question first.";
  if (text.length > MAX_MESSAGE) return `Together this is over ${MAX_MESSAGE} characters; shorten your message or your answers.`;
  return undefined;
}

type Send = (name: "sendFeedback" | "postMessage" | "approveArtifact" | "dropBlueprintItem", args: object) => Promise<{ ok: boolean }>;

/** What Send does to the draft for your answer, part by part, as `draftEffect` says. */
export const answerEffects = (s: State, changed: Answer["changed"]): DraftEffect[] => changed.flatMap(({ artifact, draft }) => draftEffect(s, artifact, draft) ?? []);

/**
 * Send to the lead: your changed marks as one `sendFeedback`, recorded on each version (compare-and-set on the
 * version you saw); then the draft: each Keep approved and each Drop dropped, as `answerEffects` showed before Send
 * (a Keep it would refuse is not asked); then everything as one `postMessage`, the one message the lead answers. The
 * marks go first, so the message never speaks of marks the service refused. Returns the drafts recorded (their keys,
 * to clear), what happened to the draft, part by part, and whether the message was posted, or null when nothing was
 * sent (blocked, or the marks were refused).
 */
export async function sendAnswer(send: Send, s: State, drafts: Readonly<Record<string, Draft>>, x: Omit<Answer, "changed">): Promise<{ recorded: string[]; draft: string[]; posted: boolean } | null> {
  const answer = { ...x, changed: changedDrafts(s, drafts) };
  if (answerBlocker(answer)) return null;
  const effects = answerEffects(s, answer.changed);
  if (answer.changed.length && !(await send("sendFeedback", { entries: feedbackEntries(answer.changed) })).ok) return null;
  const draft: string[] = [];
  for (const e of effects) draft.push(!e.command ? e.did : (await send(e.command.name, e.command.args)).ok ? e.did : e.failed);
  const posted = (await send("postMessage", { text: answerMessage(answer) })).ok;
  return { recorded: answer.changed.map((c) => draftKey(c.artifact)), draft, posted };
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
//
// Every word about PE review comes from the domain's `PeReview` (studio.ts): where review stands, the latest pass's
// objections (not feasible) and asks (feasible if changed), and why review ended (`LOOP_END_WORDS`). A reproduction
// ("as it is today") is judged only on whether it matches the code, so it is never called feasible.

/** "A", "A and B", "A, B and C". */
const joinAnd = (xs: readonly string[]) => (xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

/** The variants some verdicts are on, in a sentence: "B · Day by day", or "the whole artifact". */
function variantsOf(a: StudioArtifact, vs: readonly PeVerdict[]): string {
  return joinAnd(vs.map((v) => (v.variant === undefined ? "the whole artifact" : (a.variants.find((x) => x.id === v.variant)?.label ?? v.variant))));
}

/** What a pass says, in the present ("objects to A and asks for changes to B") or the past ("objected to A…"). */
function passSays(a: StudioArtifact, objections: readonly PeVerdict[], asks: readonly PeVerdict[], past = false): string {
  return joinAnd([objections.length ? `${past ? "objected" : "objects"} to ${variantsOf(a, objections)}` : "", asks.length ? `${past ? "asked" : "asks"} for changes to ${variantsOf(a, asks)}` : ""].filter(Boolean));
}

/** The version the designer made after this one, if any. */
const versionAfter = (s: State, a: StudioArtifact) => S.versionsOf(s, a.id).find((x) => x.version > a.version);

/** A version the designer revises for the PE, in words: what the PE's pass says, and that it reaches you after the revision. */
function revisingText(a: StudioArtifact, r: Extract<S.PeReview, { status: "revising" }>): string {
  return `On pass ${r.pass} of ${S.MAX_PE_PASSES}, the PE ${passSays(a, r.objections, r.asks)}. The designer revises it before it reaches you.`;
}

/**
 * Why a queued studio run does not start yet, as a sentence about `who`, or undefined when nothing holds it: a pause,
 * or the budget stop with its reason (the order dispatchStudioRuns checks them in). Studio runs go on while the
 * factory runs (pass 5).
 */
export function heldBecause(s: State, who = "It"): string | undefined {
  if (s.project.hold) return `${who} waits until you resume the project.`;
  const stop = budgetStop(s);
  return stop ? `${who} waits at the budget stop. ${stop.why}.` : undefined;
}

/** One verdict of the PE's latest pass, as the studio shows it. */
export interface VerdictLine {
  id: string;
  /** The variant's label, or "The whole artifact". */
  label: string;
  /** The verdict in words: "Feasible if changed"; on a reproduction, how it compares with the code: "Some differences". */
  word: string;
  tone: "done" | "you" | "fail";
  reasons: string;
  /** The verdict's `change`, with what it is: "The change: …", "What would change the verdict: …", "The differences: …". */
  change?: string;
  budget?: BudgetEstimate;
  overruled?: { at: string; why: string };
  /** You can overrule it now: an objection on the newest version, not overruled, once PE review ended. */
  canOverrule: boolean;
}

const VERDICT_TONE: Record<Verdict, VerdictLine["tone"]> = { feasible: "done", "feasible-if": "you", "not-feasible": "fail" };
/** What a verdict's `change` is: the change that makes it feasible, or what would change an objection (server/studio/pe.ts). */
const CHANGE_WORDS: Record<Verdict, string> = { feasible: "The change", "feasible-if": "The change", "not-feasible": "What would change the verdict" };
/**
 * A verdict on a reproduction, in words. The PE judges only whether it matches the code (server/studio/pe.ts):
 * feasible when it does, feasible-if apart from the differences it states, not-feasible when it does not, with what is
 * wrong. The domain has words for feasibility only (`VERDICT_WORDS`).
 */
const REPRODUCTION_WORDS: Record<Verdict, { word: string; change: string }> = {
  feasible: { word: "Matches the code", change: "The differences" },
  "feasible-if": { word: "Some differences", change: "The differences" },
  "not-feasible": { word: "Does not match the code", change: "What is wrong" },
};

/** Where PE review of a version stands, for the right column: the state, what the PE found, its verdicts, then why review ended and what you can do now. */
export interface PeView {
  tone: "work" | "you" | "done" | "fail" | "neutral";
  /** The state in a few words: "Agreed", "Revising", "Objects: waiting for you"… */
  state: string;
  /** What the PE found, or what happens now. Ends with ":" when the verdicts below are its list. */
  text: string;
  /** After the verdicts: why PE review ended, and what you can do now (mark, overrule an objection, or nothing). */
  next?: string;
  /** "Codex · gpt-x", the PE that made the latest pass (or is reviewing). */
  by?: string;
  /**
   * Set when the PE ran on the designer's own provider, so its review is not independent (ORC-029 r5: the PE runs on
   * the other provider by default): "Not independent: the PE ran on the designer's own provider (Claude)."
   */
  notIndependent?: string;
  simulated: boolean;
  verdicts: VerdictLine[];
  /** You can ask the PE again (`askPeAgain`): it gave no verdict on this version, because it could not answer (B-06). */
  canAskAgain?: true;
}

/** "$40–$90", "$5–$5 a month" as "$5 a month". */
export function usdRange([lo, hi]: [number, number], perMonth = false): string {
  const usd = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
  return `${lo === hi ? usd(lo) : `${usd(lo)}–${usd(hi)}`}${perMonth ? " a month" : ""}`;
}

/** What you can do now with a version the PE agreed on or whose review ended; undefined for one a newer version replaced. */
function yourMove(s: State, a: StudioArtifact, r: S.PeReview): string | undefined {
  if (S.latestVersion(s, a.id)?.version !== a.version || (r.status !== "agreed" && r.status !== "ended")) return undefined;
  const objections = r.status === "ended" ? S.openObjections(s, a).length : 0;
  const mark = S.currentFeedback(s, a.id, a.version)?.mark;
  const overrule = objections ? `You can overrule ${objections === 1 ? "the objection" : "an objection"}, with your reason. ` : "";
  const askAgain = S.canAskPeAgain(s, a) ? "You can ask the PE again. " : "";
  if (mark) return `${overrule}${askAgain}You marked it ${mark}.${objections || askAgain ? "" : " Nothing else is needed from you."}`;
  return `${overrule}${askAgain}Mark it Keep, Change or Drop${a.variants.length > 1 ? ", and pick a variant" : ""}.`;
}

/**
 * PE review of a version, for the owner: where it stands, the latest pass's verdict on each variant, and what you can
 * do now. For a kind the PE does not review, why not.
 */
export function peView(s: State, a: StudioArtifact, providerLabel: (p: "claude" | "codex") => string): PeView {
  const r = S.peReview(s, a);
  if (r.status === "not-reviewed") return { tone: "neutral", state: "Not reviewed", text: `The PE does not review it: ${r.why}.`, simulated: false, verdicts: [] };
  const run = S.peRunsOf(s, a.id, a.version).at(-1);
  const asIs = !!a.provenance?.asIs;
  const after = versionAfter(s, a);
  const mine = s.studio.verdicts.filter((v) => v.artifactId === a.id && v.version === a.version);
  const pass = mine.length ? Math.max(...mine.map((v) => v.pass)) : 0;
  const overrulable = new Set(r.status === "ended" && !after ? S.openObjections(s, a).map((v) => v.id) : []);
  const verdicts = mine
    .filter((v) => v.pass === pass)
    .map((v): VerdictLine => {
      const words = asIs ? REPRODUCTION_WORDS[v.verdict] : { word: `${VERDICT_WORDS[v.verdict][0].toUpperCase()}${VERDICT_WORDS[v.verdict].slice(1)}`, change: CHANGE_WORDS[v.verdict] };
      return {
        id: v.id,
        label: v.variant === undefined ? "The whole artifact" : (a.variants.find((x) => x.id === v.variant)?.label ?? v.variant),
        word: words.word,
        tone: VERDICT_TONE[v.verdict],
        reasons: v.reasons,
        ...(v.change ? { change: `${words.change}: ${v.change}` } : {}),
        ...(v.budget ? { budget: v.budget } : {}),
        ...(v.overruled ? { overruled: v.overruled } : {}),
        canOverrule: overrulable.has(v.id),
      };
    });
  const madeBy = mine.find((v) => v.pass === pass && v.by)?.by;
  const byRun = madeBy ? s.studio.runs.find((x) => x.id === madeBy.runId) : run;
  const by = madeBy ? `${providerLabel(madeBy.provider)} · ${madeBy.model}` : run ? `${providerLabel(run.provider)} · ${run.actualModel ?? run.model}` : undefined;
  // The PE's provider: its latest pass's run, or the run reviewing now; compared with the provider of the designer's run that made the version.
  const peProvider = madeBy?.provider ?? run?.provider;
  const designer = a.madeBy.role === "user" ? undefined : a.madeBy.provider;
  const notIndependent = peProvider && peProvider === designer ? `Not independent: the PE ran on the designer's own provider (${providerLabel(peProvider)}).` : undefined;
  const base = { ...(by ? { by } : {}), ...(notIndependent ? { notIndependent } : {}), simulated: !!byRun?.simulated, verdicts, ...(S.canAskPeAgain(s, a) ? { canAskAgain: true as const } : {}) };
  const move = yourMove(s, a, r);
  const view = (tone: PeView["tone"], state: string, text: string, next?: string): PeView => ({ ...base, tone, state, text, ...(next ? { next } : {}) });

  if (r.status === "agreed") return view("done", asIs ? "Matches the code" : "Agreed", asIs ? "The PE checked it against the code: it matches." : `The PE agreed on pass ${r.pass}: every option is feasible.`, move);
  if (r.status === "ended") {
    const ended = [`PE review ended: ${S.LOOP_END_WORDS[r.ended]}${r.note ? ` (${r.note.replace(/\.$/, "")})` : ""}.`, move].filter(Boolean).join(" ");
    const open = r.objections.filter((o) => !o.overruled);
    if (r.objections.length && !open.length && !r.asks.length) return view("done", "Overruled", "You overruled the PE's objections. They stay recorded.", ended);
    const text = !r.pass ? "The PE did not review it." : asIs ? "The PE found differences from the code:" : `The PE still ${passSays(a, open, r.asks)}.`;
    if (after || S.currentFeedback(s, a.id, a.version)?.mark) return view("neutral", "Review ended", text, ended);
    return view("you", open.length ? "Objects: waiting for you" : "Waiting for you", text, ended);
  }
  if (r.status === "revising") {
    if (after) return view("neutral", "Revised", `On pass ${r.pass} of ${S.MAX_PE_PASSES}, the PE ${passSays(a, r.objections, r.asks, true)}. The designer revised it as v${after.version}.`);
    const revision = S.revisionRunsOf(s, a).filter(isUnderWay).at(-1);
    const held = !revision || revision.status === "queued" ? heldBecause(s, "The designer's revision") : undefined;
    return view("work", "Revising", `${revisingText(a, r)}${held ? ` ${held}` : ""}`);
  }
  // Waiting for the PE: why, from its runs.
  if (after) return view("neutral", "Not reviewed", `Replaced by v${after.version} before the PE reviewed it.`);
  if (a.shots?.status === "pending" || a.demo?.status === "pending") return view("neutral", "Waiting", `The PE reviews it once the ${a.shots?.status === "pending" ? "screenshots are taken" : "recording is made"}.`);
  if (run && R.isActiveStudioRun(run)) return view("work", "Reviewing", asIs ? "The PE is checking it against the code." : "The PE is reading this version: its files, screenshots and recordings.");
  if (run?.status === "queued") return view("neutral", "Queued", heldBecause(s, "The PE's run") ?? "Waiting to start.");
  // Waiting with no run under way: the service asks the PE again on its next cycle (`peRunDue`).
  if (run && S.endedWithoutResult([run])) return view("work", "Asking again", `The PE's run ended without a verdict (${run.note ?? `its run was ${run.status}`}). The service asks the PE again.`);
  return view("neutral", "Waiting", r.passes ? `The designer revised it. The PE reviews it next, on pass ${r.passes + 1} of ${S.MAX_PE_PASSES}.` : "Waiting for PE review.");
}

// ---------- an artifact's versions (the PE loop, pass 4c) ----------

/** One version of an artifact, as its history shows it: the PE's pass on it, your mark, and whether it is the current one. */
export interface VersionLine {
  version: number;
  round: number;
  /** The newest version: the one the PE and you answer. */
  current: boolean;
  tone: "work" | "you" | "done" | "fail" | "neutral";
  /** Where PE review of it stands, in a word or two: "agreed", "objected", "asked for changes", "waiting for you"… */
  state: string;
  text: string;
}

/**
 * An artifact's versions, oldest first (v1 → v2 → v3): the PE's pass on each and what came of it, your mark, and
 * which is current. The designer revises after an objection or an ask while passes remain; what the PE still objects
 * to or asks for when review ends waits for you, and is never dropped.
 */
export function versionHistory(s: State, a: StudioArtifact): VersionLine[] {
  const all = S.versionsOf(s, a.id);
  const newest = all.at(-1)?.version;
  return all.map((v) => {
    const next = all.find((x) => x.version > v.version);
    const mark = S.currentFeedback(s, v.id, v.version)?.mark;
    const line = (tone: VersionLine["tone"], state: string, text: string): VersionLine => ({ version: v.version, round: v.round, current: v.version === newest, tone, state, text: mark ? `${text} You marked it ${mark}.` : text });
    const r = S.peReview(s, v);
    switch (r.status) {
      case "not-reviewed":
        return line("neutral", "not reviewed", `The PE does not review it: ${r.why}.`);
      case "waiting":
        return next ? line("neutral", "not reviewed", `Replaced by v${next.version} before the PE reviewed it.`) : line("neutral", "with the PE", "Waiting for PE review.");
      case "agreed":
        return v.provenance?.asIs ? line("done", "matches", `PE pass ${r.pass}: it matches the code.`) : line("done", "agreed", `PE pass ${r.pass}: agreed.`);
      case "revising":
        return next
          ? line("neutral", r.objections.length ? "objected" : "asked for changes", `PE pass ${r.pass}: ${passSays(v, r.objections, r.asks, true)}; the designer revised it as v${next.version}.`)
          : line("work", "revising", `PE pass ${r.pass}: ${passSays(v, r.objections, r.asks)}; the designer is revising it.`);
      case "ended": {
        const open = r.objections.filter((o) => !o.overruled);
        if (r.objections.length && !open.length && !r.asks.length) return line("done", "overruled", `PE pass ${r.pass}: you overruled its objections.`);
        const said = v.provenance?.asIs ? "found differences from the code" : `still ${passSays(v, open, r.asks)}`;
        const why = `review ended: ${S.LOOP_END_WORDS[r.ended]}`;
        const head = r.pass ? `PE pass ${r.pass}: ${said}; ${why}` : `PE ${why}`;
        if (next) return line("neutral", "ended", `${head}. It went to you, and v${next.version} followed.`);
        return mark ? line("neutral", "ended", `${head}.`) : line("you", "waiting for you", `${head}. This is waiting for you.`);
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
  const live = mine.filter(isUnderWay);
  const last = mine.filter((r) => !live.includes(r)).at(-1);
  return last && last.status !== "completed" ? [...live, last] : live;
}

/** What a running studio run does, when it reports no activity of its own: each kind says what it does. */
const RUN_WORK: Record<StudioRun["kind"], string> = {
  designer: "The designer is making this round's artifacts.",
  pe: "The PE is reviewing this round's artifacts.",
  probe: "The probe is gathering the evidence the PE asked for.",
  reader: "The reader is turning the repository's tests and code into rules.",
};

export function runLine(s: State, r: StudioRun, providerLabel: (p: "claude" | "codex") => string): RunLine {
  const who = `${r.kind === "pe" ? "PE" : r.kind === "probe" ? "Probe" : "Designer"} · ${providerLabel(r.provider)} · ${r.model}${r.simulated ? " (simulated)" : ""}`;
  switch (r.status) {
    case "queued":
      return { id: r.id, tone: "neutral", title: `${who}: queued`, text: heldBecause(s) ?? "Waiting to start." };
    case "running":
      return { id: r.id, tone: "work", title: `${who}: working`, text: r.activity ?? RUN_WORK[r.kind] };
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
