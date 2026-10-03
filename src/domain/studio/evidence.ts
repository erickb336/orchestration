// Evidence of what the factory built (ORC-029 pass 5, docs/design/ORC-029-pass5-design.md, "Evidence of what the
// factory built"): each screen, terminal demo and TUI of the blueprint beside what the built code shows. A builder's
// own pictures are a claim, so the service captures them (the "Capture evidence" step, server/studio/evidence.ts):
// it runs the project's preview on a copy of the task's change at its commit, in the project's environment when it
// has one (docs/design/project-environment.md, unit E2) or else in the recorder's container, and takes the
// screenshots and recordings the coder's capture plan names. Pure, from state only: this module holds the project's
// preview setting, what a capture run captures, its record, and the record per blueprint item that "Design and
// reality" and the lead's brief read.
//
// The record per item names the path it ran by, the commit and the design version it shows, the evidence files
// (served by the app's file route, server/studio/files.ts), and when; or why there is none, with a short log excerpt.

import { isInstall, networkRefusal, validateCommand } from "../checks";
import { currentSpec, draft, event } from "../model/core";
import { ControlError, type Artifact, type State, type Task } from "../types";
import { blueprintItems } from "./blueprint";
import { isInsidePath } from "./studio";
import type { BlueprintItem, StudioArtifactKind } from "./types";

// ---------- what is captured ----------

/** The kinds of blueprint item the service captures: a screen in the browser, a terminal demo or TUI with VHS. */
export const CAPTURED_KINDS = ["screen", "terminal-demo", "tui"] as const satisfies readonly StudioArtifactKind[];
export type CapturedKind = (typeof CAPTURED_KINDS)[number];
export const isCapturedKind = (k: StudioArtifactKind): k is CapturedKind => (CAPTURED_KINDS as readonly string[]).includes(k);
/** A screen is captured on these devices, at the sizes of the studio's screenshots (server/studio/shots.ts). */
export const CAPTURE_DEVICES = ["desktop", "mobile"] as const;
export type CaptureDevice = (typeof CAPTURE_DEVICES)[number];

/** One blueprint item a capture run captures, with the design version the task's spec cited when the run started. */
export interface CaptureItem {
  itemId: string;
  kind: CapturedKind;
  title: string;
  /** The approved design: the studio artifact, its version and its variant. */
  artifactId: string;
  version: number;
  variant?: string;
}

const toCaptureItem = (i: BlueprintItem): CaptureItem => ({ itemId: i.id, kind: i.kind as CapturedKind, title: i.title, artifactId: i.artifactId, version: i.version, ...(i.variant !== undefined ? { variant: i.variant } : {}) });

/** The screens, terminal demos and TUIs of the current blueprint that the task's current spec cites, in its order. */
export function captureItems(s: State, t: Task): CaptureItem[] {
  const refs = currentSpec(t).content.blueprintRefs ?? [];
  const items = blueprintItems(s);
  return refs
    .map((id) => items.find((i) => i.id === id))
    .filter((i): i is BlueprintItem => !!i && isCapturedKind(i.kind))
    .map(toCaptureItem);
}

// ---------- the project's preview setting ----------

/**
 * How the service runs the project to capture it (desired state; only the owner's `setPreview` writes it). Optional:
 * without it, a capture run records "not set up" and nothing runs. Commands are argv lists, never shell strings, under
 * the checks' rules (src/domain/checks.ts, validateCommand).
 */
export interface PreviewSetting {
  /** Bumps on each change. */
  rev: number;
  /**
   * The dependency download in the recorder's image, run with the network and every install hook off (npm, pnpm or
   * yarn). Empty: no install. Not run for a project with an environment: its prepare commands run instead.
   */
  install: string[];
  /** What serves the built screens inside the container, on `port`. Absent for a product with no screens. */
  preview?: string[];
  port?: number;
  /** The CLI's entry file in the repository (`bin/trips.js`): a tape in the capture plan must type it, so it records the real command. */
  cliEntry?: string;
}

export const DEFAULT_INSTALL = ["npm", "ci", "--ignore-scripts"];
export const PREVIEW_PORTS = { min: 1024, max: 65535 } as const;

/** The owner's input: what the settings form sends. `install` absent takes DEFAULT_INSTALL; an empty list runs no install. */
export interface PreviewInput {
  install?: string[];
  preview?: string[];
  port?: number;
  cliEntry?: string;
}

/** A path segment of a CLI entry: the studio's plain names (server/studio/artifacts.ts). */
const SEGMENT = /^[A-Za-z0-9._ -]+$/;

/** The setting as it is stored (without its revision), or why it is refused. Pure. */
export function normalizePreview(input: PreviewInput): Omit<PreviewSetting, "rev"> | { refused: string } {
  const install = input.install ?? DEFAULT_INSTALL;
  if (install.length) {
    const why = validateCommand({ id: "install", label: "Install", kind: "prepare", argv: install }, { networked: true });
    if (why) return { refused: why.replace(/^install: /, "The install: ") };
    // Only a download gets the network; anything else would run repository code with it on.
    if (!isInstall(install)) return { refused: `The install is a download by npm, pnpm or yarn ("npm ci --ignore-scripts"), because it runs with the network on.` };
    const net = networkRefusal(install);
    if (net) return { refused: `The install: ${net}` };
  }
  const hasPreview = input.preview !== undefined && input.preview.length > 0;
  if (hasPreview !== (input.port !== undefined)) return { refused: "The preview command and its port go together: give both, or neither for a product with no screens." };
  if (hasPreview) {
    const why = validateCommand({ id: "preview", label: "Preview", kind: "check", argv: input.preview! });
    if (why) return { refused: why.replace(/^preview: /, "The preview: ").replace("a check with", "a preview with") };
    const port = input.port!;
    if (!Number.isInteger(port) || port < PREVIEW_PORTS.min || port > PREVIEW_PORTS.max) return { refused: `The port is a whole number from ${PREVIEW_PORTS.min} to ${PREVIEW_PORTS.max}.` };
  }
  if (input.cliEntry !== undefined) {
    const p = input.cliEntry;
    if (!isInsidePath(p) || p.length > 200 || !p.split("/").every((x) => SEGMENT.test(x))) return { refused: `The CLI entry "${p.slice(0, 60)}" is not a file path inside the repository (letters, digits, ".", "_", "-", " " and "/").` };
  }
  return {
    install: [...install],
    ...(hasPreview ? { preview: [...input.preview!], port: input.port! } : {}),
    ...(input.cliEntry !== undefined ? { cliEntry: input.cliEntry } : {}),
  };
}

const argvText = (argv: string[]) => argv.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(" ");

/** The setting in one line, for events and briefs. */
export function previewWords(p: PreviewSetting): string {
  return [
    p.install.length ? `install \`${argvText(p.install)}\`` : "no install",
    p.preview ? `preview \`${argvText(p.preview)}\` on port ${p.port}` : "no preview",
    p.cliEntry ? `CLI entry \`${p.cliEntry}\`` : "",
  ]
    .filter(Boolean)
    .join(", ");
}

/**
 * The owner's command: set the preview setting, or clear it (`null`). The lead may propose a setting in its message;
 * only this command sets one. Refuses an invalid setting with the reason. A capture run already under way keeps the
 * setting it started with (its snapshot).
 */
export function setPreview(state: State, input: PreviewInput | null, now: string): State {
  const prev = state.project.preview;
  if (input === null) {
    if (!prev) return state;
    const s = draft(state);
    delete s.project.preview;
    event(s, now, "user", "config", "Preview cleared: capture runs record \"not set up\"");
    return s;
  }
  const next = normalizePreview(input);
  if ("refused" in next) throw new ControlError(next.refused);
  if (prev && JSON.stringify({ rev: prev.rev, ...next }) === JSON.stringify(prev)) return state;
  const s = draft(state);
  s.project.preview = { rev: (prev?.rev ?? 0) + 1, ...next };
  event(s, now, "user", "config", `Preview r${s.project.preview.rev}: ${previewWords(s.project.preview)}`);
  return s;
}

// ---------- a capture run's record ----------

/**
 * Why an item has no evidence from a run:
 * - not-set-up: the project has no preview setting (or none for screens);
 * - no-plan / not-in-plan / invalid-plan: the coder's capture plan is missing, does not name the item, or was refused;
 * - unavailable: Docker, the recorder's image or its probe is not there;
 * - install-failed, preview-did-not-start, page-errors, capture-failed: the run itself (a page that did not load, a recording that failed);
 * - stopped: the run was stopped (a time limit);
 * - simulated: the fake runtime ran nothing.
 */
export type NoEvidence = "not-set-up" | "no-plan" | "not-in-plan" | "invalid-plan" | "unavailable" | "install-failed" | "preview-did-not-start" | "page-errors" | "capture-failed" | "stopped" | "simulated";
export const NO_EVIDENCE: readonly NoEvidence[] = ["not-set-up", "no-plan", "not-in-plan", "invalid-plan", "unavailable", "install-failed", "preview-did-not-start", "page-errors", "capture-failed", "stopped", "simulated"];

export const NO_EVIDENCE_WORDS: Record<NoEvidence, string> = {
  "not-set-up": "not set up",
  "no-plan": "no capture plan",
  "not-in-plan": "not in the capture plan",
  "invalid-plan": "the capture plan was refused",
  unavailable: "the recorder is not available",
  "install-failed": "the install failed",
  "preview-did-not-start": "the preview did not start",
  "page-errors": "page errors",
  "capture-failed": "the capture failed",
  stopped: "stopped",
  simulated: "simulated: nothing ran",
};

/**
 * Which way a capture ran (docs/design/project-environment.md, unit E2):
 * - environment: in the project's own environment, prepared as its checks are (the image, the prepare or its reuse by
 *   key); the screenshots come from the recorder's browser beside it, and the CLIs are recorded as asciicasts;
 * - recorder: in the recorder's image, for a project without an environment (Node only: npm, pnpm or yarn).
 */
export type EvidencePath =
  | { via: "environment"; from: "devcontainer" | "setting"; image: string; imageId?: string; prepare?: "ran" | "reused" | "failed"; key?: string }
  | { via: "recorder"; image: string };

/** The path in a few words, for summaries. */
export function evidencePathWords(p: EvidencePath): string {
  if (p.via === "recorder") return `in the recorder's image ${p.image}`;
  const prep = p.prepare === "reused" ? ", its prepare reused" : p.prepare === "failed" ? ", its prepare failed" : "";
  return `in the project's environment (${p.from === "devcontainer" ? "its dev container" : "the confirmed image"} ${p.image.replace(/@sha256:([0-9a-f]{12})[0-9a-f]+$/, "@sha256:$1…")}${prep})`;
}

/** One file the service captured, relative to the run's evidence folder (`<itemId>/<name>`). */
export interface EvidenceFile {
  path: string;
  /** cast: an asciicast v2 recording of a CLI, made by the service in the project's environment (unit E2). */
  type: "png" | "gif" | "webm" | "txt" | "cast";
  /** A screenshot's device. */
  device?: CaptureDevice;
  bytes: number;
  sha256: string;
}

/** What one run captured of one item. Each names the design version it shows (the item as the run captured it). */
export type ItemCapture =
  | (CaptureItem & { status: "captured"; files: EvidenceFile[]; warnings?: string[] })
  | (CaptureItem & { status: "none"; reason: NoEvidence; detail: string; log?: string });

/** A capture run's record, on its evidence artifact. Written only by the service. */
export interface EvidenceRun {
  /** The commit captured, in full. */
  sha: string;
  at: string;
  durationMs: number;
  /** The preview setting's revision the run used; absent when it was not set up. */
  previewRev?: number;
  /**
   * Which way it ran (or tried to): the project's environment or the recorder's image. Absent when there was nothing to
   * run (no plan, not set up), in simulated runs, and in records before E2.
   */
  path?: EvidencePath;
  simulated?: true;
  items: ItemCapture[];
  /** What the run noted that belongs to no item (an entry of the plan for an item the task does not cite, say). */
  notes?: string[];
}

/** The snapshot of a capture run (`RunSnapshot.evidence`): what it captures, on which commit, with which setting. */
export interface EvidenceSnapshot {
  target: { artifactId: string; ref: string };
  items: CaptureItem[];
  /** A copy of the setting at dispatch; absent when the project had none. */
  preview?: PreviewSetting;
}

const LOG_CAP = 600;
const DETAIL_CAP = 300;
const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

/** An item without evidence, with the reason and a short excerpt of the log. */
export const noCapture = (item: CaptureItem, reason: NoEvidence, detail: string, log?: string): ItemCapture => ({
  ...item,
  status: "none",
  reason,
  detail: clip(detail, DETAIL_CAP),
  ...(log?.trim() ? { log: log.trim().slice(-LOG_CAP) } : {}),
});

/** The run a step records when the project has no preview setting: every item "not set up", and nothing ran. */
export function notSetUpRun(snap: EvidenceSnapshot, now: string): EvidenceRun {
  return {
    sha: snap.target.ref,
    at: now,
    durationMs: 0,
    items: snap.items.map((i) => noCapture(i, "not-set-up", "The project has no preview setting, so nothing ran. Only the owner sets one.")),
  };
}

/** The artifact's summary: one line per item, in the design's words. */
export function evidenceSummary(run: EvidenceRun): string {
  const lines = run.items.map((i) => {
    const what = `${i.itemId} ${i.title} (${i.kind} v${i.version})`;
    if (i.status === "captured") {
      const shots = i.files.filter((f) => f.type === "png").map((f) => f.device);
      const rec = i.files.filter((f) => f.type !== "png").map((f) => f.type);
      return `- ${what}: captured ${[shots.length ? `on ${shots.join(" and ")}` : "", rec.length ? `as ${rec.join(", ")}` : ""].filter(Boolean).join(", ")}${i.warnings?.length ? `; ${i.warnings.length} warning${i.warnings.length === 1 ? "" : "s"}: ${i.warnings[0]}` : ""}.`;
    }
    return `- ${what}: no evidence, ${NO_EVIDENCE_WORDS[i.reason]}. ${i.detail}`;
  });
  const captured = run.items.filter((i) => i.status === "captured").length;
  return `${run.simulated ? "(simulated) " : ""}Evidence of ${run.sha.slice(0, 12)}: ${captured} of ${run.items.length} item${run.items.length === 1 ? "" : "s"} captured${run.path ? ` ${evidencePathWords(run.path)}` : ""}.\n${lines.join("\n")}${run.notes?.length ? `\n${run.notes.map((n) => `- Note: ${n}`).join("\n")}` : ""}`;
}

// ---------- the record per blueprint item ----------

/**
 * The evidence of one blueprint item, from the newest run that captured it (or tried): what it shows, of which
 * commit and design version, and from which task. `current`: the blueprint's item is still at that design version.
 */
export type ItemEvidence = {
  itemId: string;
  title: string;
  kind: CapturedKind;
  /** The design version the evidence shows. */
  design: { artifactId: string; version: number; variant?: string };
  current: boolean;
  /** The commit captured, in full. */
  commit: string;
  at: string;
  /** Which way the run that made it ran (absent in records before E2). */
  path?: EvidencePath;
  from: { taskId: string; attemptId: string; artifactId: string; landed: boolean; simulated?: true };
} & ({ status: "captured"; files: EvidenceFile[]; warnings?: string[] } | { status: "none"; reason: NoEvidence; detail: string; log?: string });

/** An item no run has captured yet. */
export interface NoRunYet {
  itemId: string;
  title: string;
  kind: CapturedKind;
  status: "no-run";
}

/**
 * Evidence artifacts the service made, newest first: of tasks not cancelled, landed work before work in progress.
 * A person's edit of an output is not a capture.
 */
function evidenceArtifacts(s: State): { art: Artifact; run: EvidenceRun; task: Task }[] {
  const out: { art: Artifact; run: EvidenceRun; task: Task }[] = [];
  for (const art of s.artifacts) {
    if (art.kind !== "evidence" || !art.evidence || art.author === "user") continue;
    const task = s.tasks.find((t) => t.id === art.taskId);
    if (!task || task.lifecycle === "cancelled") continue;
    out.push({ art, run: art.evidence, task });
  }
  const landed = (t: Task) => (t.integration?.landed ? 1 : 0);
  return out.sort((a, b) => landed(b.task) - landed(a.task) || b.art.createdAt.localeCompare(a.art.createdAt));
}

function recordOf(item: BlueprintItem, hit: { art: Artifact; run: EvidenceRun; task: Task }, cap: ItemCapture): ItemEvidence {
  const base = {
    itemId: item.id,
    title: item.title,
    kind: item.kind as CapturedKind,
    design: { artifactId: cap.artifactId, version: cap.version, ...(cap.variant !== undefined ? { variant: cap.variant } : {}) },
    current: cap.artifactId === item.artifactId && cap.version === item.version && cap.variant === item.variant,
    commit: hit.run.sha,
    at: hit.run.at,
    ...(hit.run.path ? { path: hit.run.path } : {}),
    from: { taskId: hit.task.id, attemptId: hit.art.attemptId, artifactId: hit.art.id, landed: !!hit.task.integration?.landed, ...(hit.run.simulated ? { simulated: true as const } : {}) },
  };
  return cap.status === "captured"
    ? { ...base, status: "captured", files: cap.files, ...(cap.warnings?.length ? { warnings: cap.warnings } : {}) }
    : { ...base, status: "none", reason: cap.reason, detail: cap.detail, ...(cap.log ? { log: cap.log } : {}) };
}

function evidenceFor(item: BlueprintItem, runs: ReturnType<typeof evidenceArtifacts>): ItemEvidence | NoRunYet {
  for (const hit of runs) {
    const cap = hit.run.items.find((i) => i.itemId === item.id);
    if (cap) return recordOf(item, hit, cap);
  }
  return { itemId: item.id, title: item.title, kind: item.kind as CapturedKind, status: "no-run" };
}

/** The evidence of one blueprint item; undefined when it is not in the blueprint or is not a screen, demo or TUI. */
export function itemEvidence(s: State, itemId: string): ItemEvidence | NoRunYet | undefined {
  const item = blueprintItems(s).find((i) => i.id === itemId);
  return item && isCapturedKind(item.kind) ? evidenceFor(item, evidenceArtifacts(s)) : undefined;
}

/** The evidence of every screen, terminal demo and TUI in the current blueprint, in the blueprint's order. */
export function blueprintEvidence(s: State): (ItemEvidence | NoRunYet)[] {
  const runs = evidenceArtifacts(s);
  return blueprintItems(s)
    .filter((i) => isCapturedKind(i.kind))
    .map((i) => evidenceFor(i, runs));
}

/** Whether a file is one the run recorded: the file route serves nothing else. */
export function evidenceFileKnown(s: State, attemptId: string, path: string): boolean {
  return s.artifacts.some((a) => a.kind === "evidence" && a.attemptId === attemptId && !!a.evidence?.items.some((i) => i.status === "captured" && i.files.some((f) => f.path === path)));
}
