// Test fixture (pure): what the factory captured of the built parts and what the UX review found, for the tests of
// "Design and reality" (ORC-029 pass 5, screen 5) and its seeded browser pass. Records are written as the engine
// leaves them: the Feature flow's Capture evidence step (E1) and UX review step (S4) on the task, a service attempt
// and its evidence artifact, and a UX review attempt whose input is that evidence. The decisions on the review's
// ask-user findings are made by the real `createDecisions`. Not used by the application.

import { createDecisions, blockingCount } from "../findings";
import { instantiate } from "../pipeline";
import type { Artifact, Finding, RunSnapshot, State } from "../types";
import { blueprintItems } from "../studio/blueprint";
import type { CaptureDevice, CaptureItem, CapturedKind, EvidenceFile, EvidenceRun, ItemCapture, NoEvidence } from "../studio/evidence";
import { noCapture } from "../studio/evidence";
import { landedChangeSha } from "../studio/ruleResults";
import { blueprintScene, citingTask, landTask, type BlueprintScene } from "./blueprintScene";
import { DESIGNER, lockInAsOwner, peAgrees, run, sha } from "./studio";

/** The commit that landed for a task landed by `landTask` (blueprintScene.ts), in full: it writes one byte repeated. */
export function landedCommit(s: State, taskId: string): string {
  const prefix = landedChangeSha(s, s.tasks.find((t) => t.id === taskId)!);
  if (!prefix) throw new Error(`${taskId} has no landed change`);
  return prefix.slice(0, 2).repeat(20);
}

/** An item as a capture run records it: the blueprint's item as it is in force now. */
export function captureItem(s: State, itemId: string): CaptureItem {
  const i = blueprintItems(s).find((x) => x.id === itemId)!;
  return { itemId: i.id, kind: i.kind as CapturedKind, title: i.title, artifactId: i.artifactId, version: i.version, ...(i.variant !== undefined ? { variant: i.variant } : {}) };
}

const digest = (text: string, n: number) => {
  let h = 0x811c9dc5;
  for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0").repeat(Math.ceil(n / 8)).slice(0, n);
};

/** A screenshot the run brought back, as `collectCapture` records it. */
export const shotFile = (itemId: string, device: CaptureDevice, bytes = 2048): EvidenceFile => ({ path: `${itemId}/${device}.png`, type: "png", device, bytes, sha256: digest(`${itemId}/${device}`, 64) });
/** A terminal recording the run brought back: its GIF and its transcript. */
export const recordingFiles = (itemId: string): EvidenceFile[] => [
  { path: `${itemId}/demo.gif`, type: "gif", bytes: 4096, sha256: digest(`${itemId}/gif`, 64) },
  { path: `${itemId}/demo.txt`, type: "txt", bytes: 120, sha256: digest(`${itemId}/txt`, 64) },
];

/** Captured, with these files (and warnings). */
export const capturedAs = (s: State, itemId: string, files: EvidenceFile[], warnings?: string[]): ItemCapture => ({ ...captureItem(s, itemId), status: "captured", files, ...(warnings?.length ? { warnings } : {}) });
/** Not captured, and why. */
export const notCaptured = (s: State, itemId: string, reason: NoEvidence, detail: string, log?: string): ItemCapture => noCapture(captureItem(s, itemId), reason, detail, log);

const snapshot = (o: Partial<RunSnapshot>): RunSnapshot => ({ provider: "claude", model: "claude-model", source: "project-role", routingReason: "fixture", specRev: 1, stepRev: 1, visionRev: 1, workspace: "", pipelineRev: 1, purpose: "", inputs: [], ...o });

/** The task's Capture evidence (E1) and UX review (S4) steps, done, beside the steps it has. */
function withFeatureSteps(s: State, taskId: string) {
  const t = s.tasks.find((x) => x.id === taskId)!;
  const add = instantiate([
    { id: "E1", purpose: "Capture evidence of the built screens and CLIs", role: "evidence", dependsOn: [], inputs: [], outputs: [{ name: "evidence", kind: "evidence" }] },
    { id: "S4", purpose: "UX review", role: "ux_reviewer", dependsOn: ["E1"], inputs: [{ step: "E1", output: "evidence" }], outputs: [{ name: "findings", kind: "review-findings" }] },
  ]).filter((st) => !t.steps.some((x) => x.id === st.id));
  t.steps.push(...add.map((st) => ({ ...st, state: "done" as const })));
  return t;
}

/**
 * The service captured `items` of the task's work at `at`, on its landed commit unless `sha` is given. Returns the
 * evidence artifact's id, for the UX review that compares it.
 */
export function captured(s0: State, taskId: string, items: ItemCapture[], at: string, o: { sha?: string; simulated?: true } = {}): { s: State; evidenceId: string } {
  const s = structuredClone(s0);
  withFeatureSteps(s, taskId);
  const n = s.artifacts.length + 1;
  const sha = o.sha ?? landedCommit(s, taskId);
  const attemptId = `fx-capture-${taskId}-${n}`;
  const run: EvidenceRun = { sha, at, durationMs: 9000, previewRev: 1, items, ...(o.simulated ? { simulated: true as const } : {}) };
  s.attempts.push({ id: attemptId, taskId, stepId: "E1", snapshot: snapshot({ provider: "service", model: "evidence", role: "evidence", evidence: { target: { artifactId: `fx-change-${taskId}`, ref: sha }, items: items.map(({ itemId, kind, title, artifactId, version, variant }) => ({ itemId, kind, title, artifactId, version, ...(variant !== undefined ? { variant } : {}) })) } }), startedAt: at, endedAt: at, outcome: "completed", progress: 100, artifacts: [] });
  const evidenceId = `fx-evidence-${taskId}-${n}`;
  s.artifacts.push({ id: evidenceId, taskId, stepId: "E1", attemptId, name: "evidence", kind: "evidence", version: 1, summary: "evidence", createdAt: at, evidence: run });
  return { s, evidenceId };
}

/** A UX review finding: an id, a title, and what it asks for (ask-user by default, an error). */
export interface FindingInput {
  id?: string;
  title: string;
  detail?: string;
  severity?: Finding["severity"];
  action?: Finding["action"];
}

/**
 * The UX review compared the evidence `evidenceId` with the approved prototype, at `at`, and reported `findings`. The
 * service's decision records follow for the ask-user ones (routed by the project's triage setting).
 */
export function uxReviewed(s0: State, taskId: string, evidenceId: string, findings: FindingInput[], at: string): { s: State; reviewId: string } {
  const s = structuredClone(s0);
  const t = withFeatureSteps(s, taskId);
  const n = s.artifacts.length + 1;
  const attemptId = `fx-ux-${taskId}-${n}`;
  const version = s.artifacts.filter((a) => a.taskId === taskId && a.stepId === "S4").length + 1;
  const list: Finding[] = findings.map((f, i) => ({ id: f.id ?? `F${i + 1}`, key: digest(`review|${f.title}`, 12), source: "review", severity: f.severity ?? "error", action: f.action ?? "ask-user", title: f.title, detail: f.detail ?? f.title, ...(f.action === "ask-user" || f.action === undefined ? { why: "It differs from the approved prototype." } : {}) }));
  s.attempts.push({ id: attemptId, taskId, stepId: "S4", snapshot: snapshot({ role: "ux_reviewer", inputs: [{ step: "E1", output: "evidence", artifactId: evidenceId, version: 1 }] }), startedAt: at, endedAt: at, outcome: "completed", progress: 100, artifacts: [] });
  const art: Artifact = { id: `fx-ux-findings-${taskId}-${n}`, taskId, stepId: "S4", attemptId, name: "findings", kind: "review-findings", version, summary: list.length ? `${list.length} findings` : "The built screens match the approved prototype.", openFindings: blockingCount(list), findings: list, createdAt: at };
  s.artifacts.push(art);
  createDecisions(s, t, art, at);
  return { s, reviewId: art.id };
}

/** The decision on a review's finding. */
export function decisionOn(s: State, reviewId: string, findingId: string) {
  return s.decisions.find((d) => d.artifactId === reviewId && d.findingId === findingId)!;
}

/** The lead decided a finding, as its decision run records it: "accept" or "fix". */
export function leadDecides(s0: State, reviewId: string, findingId: string, status: "accept" | "fix", at: string): State {
  const s = structuredClone(s0);
  const d = s.decisions.find((x) => x.artifactId === reviewId && x.findingId === findingId)!;
  Object.assign(d, { status, decidedBy: "lead", decidedAt: at, leadRunId: "fx-lead-run" });
  return s;
}

// ---------- the Weekend Trips factory, built ----------

export interface RealityBase extends BlueprintScene {
  items: BlueprintScene["items"] & { cli: string; summary: string };
  artifacts: BlueprintScene["artifacts"] & { cli: string; summary: string };
}

/**
 * The Weekend Trips blueprint (blueprintScene.ts) after two Locks in: the first (at 400) puts Trip plan v2 and the
 * Packing list in force; the second (at 610) adds a terminal demo, "trips CLI", and a screen, "Trip summary". The
 * Trip plan screen task, which built v1, landed at 450. Nothing has built the new versions yet.
 */
export function realityBase(): RealityBase {
  const sc = blueprintScene();
  const { at } = sc;
  let s = lockInAsOwner(sc.s, at(400));
  s = landTask(s, sc.tasks.plan, at(450));
  const round = s.studio.rounds.at(-1)!.n;
  const add = (sec: number, args: Record<string, unknown>) => run<{ artifactId: string; version: number }>(s, "addStudioArtifact", { round, madeBy: DESIGNER, ...args }, at(sec));
  const cli = add(600, { kind: "terminal-demo", title: "trips CLI", devices: [], variants: [{ id: "A", label: "Plan in the terminal", entry: "trips-cli/demo.tape" }], files: [{ path: "trips-cli/demo.tape", sha256: sha("1") }, { path: "trips-cli/plan.ans", sha256: sha("2") }] });
  s = run(peAgrees(cli.state, cli.result.artifactId, 1, [], at(601)), "approveArtifact", { artifactId: cli.result.artifactId, version: 1 }, at(602)).state;
  const summary = add(603, { kind: "screen", title: "Trip summary", devices: ["desktop", "mobile"], variants: [{ id: "A", label: "One card", entry: "trip-summary/index.html" }], files: [{ path: "trip-summary/index.html", sha256: sha("3") }] });
  s = run(peAgrees(summary.state, summary.result.artifactId, 1, [], at(604)), "approveArtifact", { artifactId: summary.result.artifactId, version: 1 }, at(605)).state;
  s = lockInAsOwner(s, at(610));
  const id = (title: string) => s.blueprint.revisions.at(-1)!.items.find((i) => i.title === title)!.id;
  return { ...sc, s, items: { ...sc.items, cli: id("trips CLI"), summary: id("Trip summary") }, artifacts: { ...sc.artifacts, cli: cli.result.artifactId, summary: summary.result.artifactId } };
}

/** A new task that builds `itemIds` (its spec cites them at `sec`), landed at `sec + 80`. */
export function builtBy(s0: State, sc: Pick<BlueprintScene, "at">, title: string, itemIds: string[], sec: number): { s: State; taskId: string } {
  const c = citingTask(s0, title, itemIds, sc.at(sec));
  return { s: landTask(c.s, c.taskId, sc.at(sec + 80)), taskId: c.taskId };
}

export interface RealityScene extends RealityBase {
  /** The tasks that built the new versions: Trip plan v2, the Packing list, trips CLI and Trip summary. */
  built: { plan: string; packing: string; cli: string; summary: string };
  /** The evidence artifacts, and the UX reviews of the screens. */
  evidence: { plan: string; packing: string; cli: string; summary: string };
  reviews: { plan: string; packing: string };
}

/**
 * The seeded state of the browser pass, as the prototype's screen 5 shows it, with evidence:
 * - Trip plan v2: built; the UX review found the map first, and nobody has decided it, so it fails a check;
 * - Packing list v1: built, captured on desktop and mobile, the UX review clean: built and verified;
 * - trips CLI v1: built, its recording captured: built and verified;
 * - Trip summary v1: built; the preview did not start, so there is no evidence: built, not verified;
 * - and the scene's own: Trip data (no rules: not verified), Words (in force), Join flow (a failing rule), Share costs
 *   (verified).
 */
export function realityScene(): RealityScene {
  const b = realityBase();
  const { at, items } = b;
  const plan = builtBy(b.s, b, "Trip plan: day list first", [items.plan], 620);
  const packing = builtBy(plan.s, b, "Packing list screen", [items.packing], 630);
  const cli = builtBy(packing.s, b, "trips CLI", [items.cli], 640);
  const summary = builtBy(cli.s, b, "Trip summary screen", [items.summary], 650);
  const s = summary.s;
  const ePlan = captured(s, plan.taskId, [capturedAs(s, items.plan, [shotFile(items.plan, "desktop"), shotFile(items.plan, "mobile")])], at(690));
  const rPlan = uxReviewed(ePlan.s, plan.taskId, ePlan.evidenceId, [{ title: `${items.plan}: the map comes first; the design puts it below the days`, detail: "On desktop and mobile the built screen shows the map above the day list. Trip plan v2 puts the day list first and the map below it." }], at(695));
  const ePack = captured(rPlan.s, packing.taskId, [capturedAs(s, items.packing, [shotFile(items.packing, "desktop"), shotFile(items.packing, "mobile")])], at(700));
  const rPack = uxReviewed(ePack.s, packing.taskId, ePack.evidenceId, [], at(705));
  const eCli = captured(rPack.s, cli.taskId, [capturedAs(s, items.cli, recordingFiles(items.cli))], at(710));
  const eSummary = captured(eCli.s, summary.taskId, [notCaptured(s, items.summary, "preview-did-not-start", "Port 4173 did not open within 60 s.", "> trips@0.1.0 preview\n> vite preview --port 4173\n\nError: Cannot find module 'vite'\n    at node:internal/modules/cjs/loader:1228:15")], at(720));
  return {
    ...b,
    s: eSummary.s,
    built: { plan: plan.taskId, packing: packing.taskId, cli: cli.taskId, summary: summary.taskId },
    evidence: { plan: ePlan.evidenceId, packing: ePack.evidenceId, cli: eCli.evidenceId, summary: eSummary.evidenceId },
    reviews: { plan: rPlan.reviewId, packing: rPack.reviewId },
  };
}
