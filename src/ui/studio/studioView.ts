// The studio's artifact viewer (ORC-029 pass 3d), as pure functions so it can be tested without a DOM: which rounds
// and artifacts to list, what each artifact shows (a device frame, a terminal window or a plain frame), where its
// prototype is served, which pins to take, and the owner's unsent feedback, sent as one `sendFeedback`.

import { budgetStop } from "../../domain/spend";
import * as S from "../../domain/studio/studio";
import type { Feedback, Mark, Pin, Round, RoundFocus, StudioArtifact, StudioRun } from "../../domain/studio/types";
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

/** Where a version stands for the owner: theirs to mark, still with the PE, or replaced by a newer version. */
export type Standing = { kind: "open" } | { kind: "pe"; text: string } | { kind: "replaced"; by: StudioArtifact };

export function standing(s: State, a: StudioArtifact): Standing {
  const latest = S.latestVersion(s, a.id)!;
  if (latest.version !== a.version) return { kind: "replaced", by: latest };
  if (S.readyForOwner(s, a)) return { kind: "open" };
  const r = S.peReview(s, a);
  return { kind: "pe", text: r.status === "revising" ? `The PE objected on pass ${r.pass}; the designer revises before it reaches you.` : "Waiting for PE review. You can look at it now, and mark it once the PE agrees." };
}

/** How an artifact is shown: a screen in a device frame, a terminal window, or the entry file in a plain frame. */
export type ShowKind = "screen" | "terminal" | "file";
export function showKind(a: StudioArtifact): ShowKind {
  if (a.kind === "screen") return "screen";
  if (a.kind === "terminal-demo" || a.kind === "tui") return "terminal";
  return "file";
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
export type DraftPin = Pin & { selector?: string };

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

/** Pins are the same by place, variant and comment; the selector only describes the place (and the domain does not keep it yet). */
function samePins(a: DraftPin[], b: DraftPin[]) {
  return a.length === b.length && a.every((p, i) => p.x === b[i].x && p.y === b[i].y && p.variant === b[i].variant && p.text.trim() === b[i].text.trim());
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

/** The versions whose draft differs from the owner's current feedback: what Send feedback sends. Only versions the owner can answer (theirs, newest). */
export function changedDrafts(s: State, drafts: Readonly<Record<string, Draft>>): { artifact: StudioArtifact; draft: Draft }[] {
  const out: { artifact: StudioArtifact; draft: Draft }[] = [];
  for (const a of S.latestArtifacts(s)) {
    const d = drafts[draftKey(a)];
    if (!d || standing(s, a).kind !== "open") continue;
    if (!sameDraft(d, draftFrom(S.currentFeedback(s, a.id, a.version)))) out.push({ artifact: a, draft: d });
  }
  return out;
}

/** Why Send feedback cannot send yet, in words, or undefined. */
export function sendBlocker(changed: { artifact: StudioArtifact; draft: Draft }[]): string | undefined {
  if (!changed.length) return "Mark, pick or pin something first.";
  for (const { artifact, draft } of changed) {
    const empty = draft.pins.findIndex((p) => !p.text.trim());
    if (empty >= 0) return `Write a comment for pin ${empty + 1} on ${artifact.title}, or remove it.`;
  }
  return undefined;
}

/** The `sendFeedback` entries for the changed drafts. A pin carries its selector too (kept once the domain records it). */
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

/**
 * Send feedback: every changed draft as one `sendFeedback`, the owner's answer to the round. Returns the drafts it
 * sent (their keys), to clear once the state holds them, or null when nothing was sent (blocked, or refused).
 */
export async function sendDrafts(send: (name: "sendFeedback", args: object) => Promise<{ ok: boolean }>, s: State, drafts: Readonly<Record<string, Draft>>): Promise<string[] | null> {
  const changed = changedDrafts(s, drafts);
  if (sendBlocker(changed)) return null;
  const r = await send("sendFeedback", { entries: feedbackEntries(changed) });
  return r.ok ? changed.map((c) => draftKey(c.artifact)) : null;
}

// ---------- terminal artifacts ----------

/**
 * How a terminal artifact was made, and what to show:
 * - recorded: VHS recorded the designer's tape in the sandbox (a webm or gif, and maybe its text transcript);
 * - hand-written: no recording; a hand-written asciicast (`.cast`, its transcript) or a frame (`.ans`);
 * - not recorded: nothing to play, with the reason.
 */
export type Recording =
  | { status: "recorded"; video?: string; gif?: string; transcript?: string }
  | { status: "hand-written"; cast?: string; frame?: string }
  | { status: "not-recorded"; reason: string };

const firstOf = (paths: string[], ext: string) => paths.find((p) => p.toLowerCase().endsWith(`.${ext}`));

/**
 * The recording status of a terminal artifact version. The service is to record it on the version as `recording`
 * ({ status: "recorded" | "hand-written" | "not-recorded", reason? }); until it does, it is read from the files: a
 * webm or gif means recorded, a .cast or .ans hand-written, anything else not recorded.
 */
export function recordingOf(a: StudioArtifact): Recording {
  const paths = a.files.map((f) => f.path);
  const files = { video: firstOf(paths, "webm"), gif: firstOf(paths, "gif"), transcript: firstOf(paths, "txt"), cast: firstOf(paths, "cast"), frame: firstOf(paths, "ans") };
  const said = (a as { recording?: { status?: unknown; reason?: unknown } }).recording;
  const status = said && typeof said.status === "string" ? said.status : undefined;
  if (status === "not-recorded") return { status, reason: typeof said?.reason === "string" && said.reason ? said.reason : "The service did not say why." };
  if (status === "recorded" || (status === undefined && (files.video || files.gif))) {
    if (files.video || files.gif) return { status: "recorded", ...(files.video ? { video: files.video } : {}), ...(files.gif ? { gif: files.gif } : {}), ...(files.transcript ? { transcript: files.transcript } : {}) };
    return { status: "not-recorded", reason: "It is marked recorded, but no webm or gif is among its files." };
  }
  if (files.cast || files.frame) return { status: "hand-written", ...(files.cast ? { cast: files.cast } : {}), ...(files.frame ? { frame: files.frame } : {}) };
  return { status: "not-recorded", reason: "No recording (webm or gif) and no hand-written .cast or .ans frame is among its files." };
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
