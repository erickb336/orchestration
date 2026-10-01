// ORC-017 §5: the demo state is valid by construction, tells the sample story, labels nothing by text
// inside titles and summaries, and comes back from Reset sample data.

import { describe, expect, it } from "vitest";
import { splitDone } from "../ui/doneCollapse";
import * as C from "./checks";
import { runCommand } from "./commands";
import { compareRows, DEFAULT_FILTER, groupRows, type MeasureId } from "./compare";
import * as D from "./delivery";
import { DEMO_DOC_TEXT, DEMO_PROJECT_NAME, DEMO_REPO_PATH, buildDemo, olderBugfixSteps } from "./demo";
import { DEMO_AREAS, HISTORY, HISTORY_FIX_IDS, HISTORY_IDS, HISTORY_SENT_BACK } from "./demoScript";
import * as F from "./findings";
import * as M from "./model";
import { computeOutcome } from "./outcomes";
import { builtInCatalog, patternHash } from "./patterns";
import { toDef, validatePipeline } from "./pipeline";
import { buildSeed } from "./seed";
import type { State, Task } from "./types";

const T0 = Date.parse("2026-10-01T12:00:00Z");
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const demo = () => buildDemo(T0);
const task = (s: State, id: string): Task => {
  const t = s.tasks.find((x) => x.id === id);
  if (!t) throw new Error(`no task ${id}`);
  return t;
};
/** The current story's tasks, in creation order. */
const STORY_IDS = ["WT-001", "WT-002", "WT-003", "WT-004", "WT-005", "WT-006", "WT-007", "WT-008", "WT-009", "WT-010", "WT-011", "WT-004.1", "WT-004.2", "WT-004.3"];
/** The history in run order: each fix task follows the task its send-back came after (ORC-018 §7). */
const HISTORY_RUN_ORDER = HISTORY.flatMap((h) => [h.id, ...HISTORY_SENT_BACK.filter((s) => s.after === h.id).map((s) => `${s.origin}-F1`)]);
const OLDER_VERSION_ID = HISTORY.find((h) => h.olderVersion)!.id;

/** Structural checks any state the service writes must pass. */
function validate(s: State) {
  expect(s.version).toBe(15);
  const catalog = builtInCatalog();
  const ids = new Set<string>();
  for (const t of s.tasks) {
    expect(ids.has(t.id), `duplicate task id ${t.id}`).toBe(false);
    ids.add(t.id);
    expect(validatePipeline(t.steps.map(toDef)).filter((i) => i.severity === "error"), `${t.id} pipeline`).toEqual([]);
    expect(t.pipelineHistory.length, `${t.id} history`).toBe(t.pipelineRev);
    expect(t.patternSince).toBeLessThanOrEqual(t.pipelineRev);
    expect(t.pattern.source).toBe("built-in");
    const p = catalog.patterns.find((x) => x.id === t.pattern.id);
    expect(p, `${t.id} pattern ${t.pattern.id}`).toBeDefined();
    // One history task ran an older Bug fix: its hash is of the steps it ran, not the catalog's (ORC-018 §7).
    if (t.id === OLDER_VERSION_ID) {
      expect(t.pattern.hash).toBe(patternHash(t.pipelineHistory[0].steps));
      expect(t.pattern.hash).not.toBe(p!.hash);
    } else expect(t.pattern.hash, `${t.id} hash`).toBe(p!.hash);
    expect(t.pipelineHistory[0].pattern?.id).toBe(t.pattern.id);
    expect(t.specs.map((x) => x.rev)).toEqual(t.specs.map((_, i) => i + 1));
    const spec = M.currentSpec(t).content;
    expect(spec.options.some((o) => o.id === spec.selectedOptionId), `${t.id} selected option`).toBe(true);
    expect(spec.options.some((o) => o.id === spec.recommendedOptionId), `${t.id} recommended option`).toBe(true);
    for (const d of t.dependsOn) expect(s.tasks.some((x) => x.id === d), `${t.id} depends on ${d}`).toBe(true);
    if (t.parentTaskId) expect(s.tasks.some((x) => x.id === t.parentTaskId)).toBe(true);
    const stepIds = new Set<string>();
    for (const st of t.steps) {
      expect(stepIds.has(st.id), `${t.id} duplicate step ${st.id}`).toBe(false);
      stepIds.add(st.id);
      const active = M.activeAttempts(s, t.id).filter((a) => a.stepId === st.id);
      expect(active.length, `${t.id} ${st.id} active attempts`).toBe(st.state === "running" || st.state === "stopping" ? 1 : 0);
      if (st.state === "done") for (const o of st.outputs) expect(M.acceptedOutput(s, t, st.id, o.name), `${t.id} ${st.id}.${o.name} accepted output`).toBeDefined();
    }
    if (t.lifecycle === "done") {
      expect(t.steps.every(M.isSettled), `${t.id} settled`).toBe(true);
      expect(t.integration, `${t.id} integration`).toBeDefined();
    }
  }
  for (const a of s.attempts) {
    const t = task(s, a.taskId);
    expect(t.steps.some((x) => x.id === a.stepId) || t.pipelineHistory.some((h) => h.steps.some((x) => x.id === a.stepId)), `${a.id} step ${a.stepId}`).toBe(true);
    expect(a.snapshot.specRev).toBeLessThanOrEqual(M.currentSpec(t).rev);
    if (a.outcome === "completed" || a.outcome === "stopped") expect(a.endedAt, `${a.id} endedAt`).toBeDefined();
    expect(a.endedAt === undefined || a.endedAt >= a.startedAt, `${a.id} time order`).toBe(true);
  }
  for (const art of s.artifacts) {
    const t = task(s, art.taskId);
    expect(s.attempts.some((a) => a.id === art.attemptId), `${art.id} attempt`).toBe(true);
    expect(art.pipelineRev ?? 1).toBeLessThanOrEqual(t.pipelineRev);
    if (art.findings) for (const f of art.findings) expect(f.key).toMatch(/^[0-9a-f]{12}$/);
  }
  for (const d of s.decisions) {
    const art = s.artifacts.find((a) => a.id === d.artifactId);
    expect(art?.findings?.some((f) => f.id === d.findingId), `${d.id} finding`).toBe(true);
  }
  for (const m of s.conversation) if (m.leadRunId) expect(s.leadRuns.some((r) => r.id === m.leadRunId), `${m.id} lead run`).toBe(true);
  for (const set of s.steering) {
    expect(s.leadRuns.some((r) => r.id === set.leadRunId)).toBe(true);
    for (const id of set.messageIds) expect(s.conversation.some((m) => m.id === id)).toBe(true);
  }
  expect(s.project.visions.map((v) => v.rev)).toEqual(s.project.visions.map((_, i) => i + 1));
  for (const v of s.project.visions) for (const id of v.docIds ?? []) expect(s.project.visionDocs.some((d) => d.id === id)).toBe(true);
  const eventIds = new Set(s.events.map((e) => e.id));
  expect(eventIds.size).toBe(s.events.length);
  for (let i = 1; i < s.events.length; i++) expect(s.events[i].at >= s.events[i - 1].at, `events in time order at ${s.events[i].id} (${s.events[i].message})`).toBe(true);
  // Serialisable as the store writes it: no functions, no cycles, nothing lost in JSON.
  expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  // Every derivation the pages use works on it.
  for (const t of s.tasks) {
    M.column(s, t);
    M.stateLabel(s, t);
    F.awaitingDecision(s, t);
    if (D.livePr(t)) D.prLabel(s, t, T0);
  }
  D.needsYou(s, T0);
  D.landedTasks(s);
  M.exportMarkdown(s);
  M.coverageOf(s);
}

/** Every text a visitor reads on the board, a task page, the conversation or the vision (not the activity log, which names runs by id). */
function visibleTexts(s: State): { where: string; text: string }[] {
  const out: { where: string; text: string }[] = [];
  for (const t of s.tasks) {
    for (const sp of t.specs) {
      out.push({ where: `${t.id} title`, text: sp.content.title });
      out.push({ where: `${t.id} outcome`, text: sp.content.outcome });
      for (const o of sp.content.options) out.push({ where: `${t.id} option ${o.id}`, text: `${o.name} ${o.approach}` });
    }
    for (const st of t.steps) out.push({ where: `${t.id} ${st.id} purpose`, text: st.purpose });
  }
  for (const a of s.artifacts) {
    out.push({ where: `${a.id} summary`, text: a.summary });
    for (const f of a.findings ?? []) out.push({ where: `${a.id} ${f.id}`, text: `${f.title} ${f.detail}` });
    for (const it of (a.items ?? []) as { title?: string }[]) if (it.title) out.push({ where: `${a.id} item`, text: it.title });
  }
  for (const m of s.conversation) out.push({ where: m.id, text: m.text });
  for (const v of s.project.visions) out.push({ where: `vision r${v.rev}`, text: `${v.text} ${v.focus} ${v.reason}` });
  for (const set of s.steering) {
    out.push({ where: set.id, text: set.reason });
    for (const c of set.changes) out.push({ where: c.id, text: c.why });
  }
  for (const d of s.decisions) out.push({ where: d.id, text: `${d.finding.title} ${d.finding.detail} ${d.finding.why ?? ""}` });
  for (const t of s.tasks) if (t.deferral) out.push({ where: `${t.id} deferral`, text: t.deferral.reason });
  return out;
}

describe("the demo state (ORC-017 §5)", () => {
  it("is valid by construction and deterministic for a clock; the test fixture is untouched", () => {
    const s = demo();
    validate(s);
    expect(JSON.stringify(buildDemo(T0, { cache: false }))).toBe(JSON.stringify(s));
    expect(M.activeAttempts(s)).toEqual([]); // no run in flight: the service dispatches
    const seed = buildSeed(T0);
    expect(seed.project.name).toBe("Example Notes (sample)");
    expect(seed.tasks.map((t) => t.id)).toEqual(["EX-001", "EX-002", "EX-003", "EX-004", "EX-005", "EX-007", "EX-006"]);
  });

  it("tells the story: project, vision, one document, coverage, the conversation with one steering exchange and Undo", () => {
    const s = demo();
    expect(s.project).toMatchObject({ id: "sample", sample: true, name: DEMO_PROJECT_NAME, repoPath: DEMO_REPO_PATH, stage: "building", workerLimit: 3, steeringMode: "apply" });
    expect(s.project.prDelivery).toMatchObject({ enabled: true, merge: "hold" });
    expect(s.project.github).toMatchObject({ ok: true, simulated: true, repo: "simulated/repository", base: { sha: "sim-base" } });
    expect(C.checksOn(s.project.checks)).toBe(true);
    expect(s.project.checks.commands.map((c) => c.argv.join(" "))).toEqual(["npm test", "npm run lint"]);
    expect(C.checksHeld(s)).toBe(false);
    expect(s.project.catalog.claude[0]).toEqual({ id: "claude-sample-large", label: "Claude large (sample model)" });
    expect(s.project.catalog.codex[0]).toEqual({ id: "codex-sample-large", label: "Codex large (sample model)" });
    // The areas.
    const areas = new Set(s.tasks.map((t) => M.currentSpec(t).content.area));
    expect([...areas].sort()).toEqual([...DEMO_AREAS].sort());
    // The vision: r1 an accepted draft from the simulated lead, r2 the steering focus, both flagged, one document.
    const [r1, r2] = s.project.visions;
    expect(s.project.visions).toHaveLength(2);
    expect(r1).toMatchObject({ author: "user", focus: "Trip sharing first.", simulated: true, docIds: ["doc-1"] });
    expect(r1.source?.draftId).toBeDefined();
    expect(s.visionDrafts).toEqual([expect.objectContaining({ id: r1.source!.draftId, status: "accepted", visionRev: 1, simulated: true })]);
    expect(r2).toMatchObject({ author: "lead", focus: "Offline maps first: the map must work with no signal.", simulated: true, docIds: ["doc-1"] });
    expect(r2.focus).not.toMatch(/\(Simulated/);
    expect(s.project.visionDocs).toHaveLength(1);
    expect(s.project.visionDocs[0]).toMatchObject({ name: "trail-research.md", text: true, size: new TextEncoder().encode(DEMO_DOC_TEXT).length });
    expect(M.fmtBytes(s.project.visionDocs[0].size)).toBe("2.1 KB");
    expect(M.currentVisionDocs(s).map((d) => d.name)).toEqual(["trail-research.md"]);
    const coverage = M.coverageOf(s)!;
    expect(Object.values(coverage)).toHaveLength(9);
    expect(Object.values(coverage).every((c) => c === "clear")).toBe(true);
    // The conversation: four messages, oldest first, and the change set with Undo.
    expect(s.conversation.map((m) => m.author)).toEqual(["user", "lead", "user", "lead"]);
    expect(s.conversation[0].text).toMatch(/offline maps ahead of sharing/);
    expect(s.conversation[1].text).toMatch(/^Done\. Offline maps is now the focus/);
    expect(s.conversation[2].text).toMatch(/Keep the VoiceOver work going/);
    expect(s.conversation[3].text).toMatch(/Claude is reviewing/);
    expect(s.steering).toHaveLength(1);
    const set = s.steering[0];
    expect(set.simulated).toBe(true);
    expect(s.conversation[1].changeSetId).toBe(set.id);
    expect(set.changes.map((c) => [c.kind, c.status, c.taskId])).toEqual([
      ["focus", "applied", undefined],
      ["defer", "applied", "WT-010"],
    ]);
    expect(set.reason).not.toMatch(/\(Simulated/);
    expect(task(s, "WT-010").deferral).toMatchObject({ by: "lead", changeSetId: set.id });
    expect(M.column(s, task(s, "WT-010"))).toBe("deferred");
    expect(M.currentFocusChange(s)?.set.id).toBe(set.id);
    // Undo works: the focus goes back and the deferral is lifted.
    const undone = M.undoSteering(s, set.id, undefined, iso(T0));
    expect(undone.result.undone).toHaveLength(2);
    expect(M.currentVision(undone.state).focus).toBe("Trip sharing first.");
    expect(task(undone.state, "WT-010").deferral).toBeUndefined();
    expect(M.pendingMessages(s)).toEqual([]);
  });

  it("shows each capability once: the tasks and their states at the start of the demo", () => {
    const s = demo();
    // The history came first (it ran weeks earlier); the current story's tasks follow in creation order.
    expect(s.tasks.map((t) => t.id)).toEqual([...HISTORY_RUN_ORDER, ...STORY_IDS]);
    const col = (id: string) => M.column(s, task(s, id));

    // WT-001: a failing check became a finding, the repair ran, the loop ran once more clean; merged, in Review.
    const wt1 = task(s, "WT-001");
    expect(col("WT-001")).toBe("done");
    expect(wt1.steps.map((x) => `${x.id}:${x.state}`)).toEqual(["S1:done", "C1:done", "S2:done", "S3:done", "C1-i2:done", "S2-i2:done", "S3-i2:skipped", "C2:done", "S4:done"]);
    const c1 = M.acceptedOutput(s, wt1, "C1", "checks")!;
    expect(c1.checkRun?.simulated).toBe(true);
    expect(c1.checkRun?.results.map((r) => `${r.id}:${r.status}`)).toEqual(["test:failed", "lint:passed"]);
    expect(c1.findings).toEqual([expect.objectContaining({ source: "check", action: "auto-fix", severity: "error", checkId: "test" })]);
    expect(c1.findings![0].detail).toMatch(/tile-cache evicts oldest first/);
    const s2 = M.acceptedOutput(s, wt1, "S2", "findings")!;
    expect(s2.findings).toHaveLength(1);
    expect(s2.findings![0]).toMatchObject({ source: "review", action: "auto-fix", severity: "warning" });
    expect(s.attempts.find((a) => a.id === s2.attemptId)?.snapshot.provider).toBe("claude");
    expect(M.acceptedOutput(s, wt1, "S1", "change")?.summary).toMatch(/\+214 −18, 6 files/);
    expect(s.attempts.find((a) => a.id === M.acceptedOutput(s, wt1, "S1", "change")!.attemptId)?.snapshot.provider).toBe("codex");
    expect(M.acceptedOutput(s, wt1, "C1-i2", "checks")?.checkRun?.results.every((r) => r.status === "passed")).toBe(true);
    expect(M.acceptedOutput(s, wt1, "S2-i2", "findings")?.openFindings).toBe(0);
    expect(wt1.integration?.pr).toMatchObject({ phase: "merged", simulated: true, number: 991, policy: "hold" });
    expect(wt1.integration?.pr?.review).toMatchObject({ ok: true, source: "pipeline", provider: "claude" });
    expect(wt1.integration?.landed).toMatchObject({ via: "pr", simulated: true, by: "app", status: "unreviewed", flags: [], mainCheck: { state: "success" } });

    // WT-002 ready and first in line; WT-003 ready next (feature: a designer first); WT-006 ready.
    expect(col("WT-002")).toBe("ready");
    expect(M.currentSpec(task(s, "WT-002")).content.benefit).toBe("You always know whether the map is current.");
    expect(col("WT-003")).toBe("ready");
    expect(task(s, "WT-003").pattern.id).toBe("feature");
    expect(M.currentSpec(task(s, "WT-003")).content.options.map((o) => o.name)).toEqual(["Download by trail", "Download by map rectangle"]);
    expect(col("WT-006")).toBe("ready");

    // WT-004: a goal whose plan became three children; it waits on them.
    const goal = task(s, "WT-004");
    expect(goal.pattern.id).toBe("goal");
    expect(M.stateLabel(s, goal)).toBe("Waiting for 2 child tasks");
    expect(M.childTasks(s, goal).map((c) => c.id)).toEqual(["WT-004.1", "WT-004.2", "WT-004.3"]);
    expect(M.acceptedOutput(s, goal, "S1", "plan")?.items).toHaveLength(3);
    expect(task(s, "WT-004.1")).toMatchObject({ parentTaskId: "WT-004", lifecycle: "done" });
    expect(task(s, "WT-004.1").integration?.landed).toMatchObject({ status: "reviewed", simulated: true });
    expect(task(s, "WT-004.1").roleOverrides).toEqual({ coder: { provider: "claude", model: "claude-sample-large" }, code_reviewer: { provider: "codex", model: "codex-sample-large" } });
    expect(task(s, "WT-004.1").integration?.pr?.review).toMatchObject({ ok: true, provider: "codex" });
    expect(col("WT-004.2")).toBe("ready");
    expect(M.resolveStep(s, task(s, "WT-004.2"), task(s, "WT-004.2").steps[0])).toMatchObject({ ok: true, selection: { provider: "claude" }, source: "task-role" });
    const guest = task(s, "WT-004.3");
    expect(col("WT-004.3")).toBe("proposed");
    expect(guest.holdBeforeStart).toBe(true);
    expect(M.currentSpec(guest).rev).toBe(2);
    expect(M.currentSpec(guest).content.options.map((o) => o.name)).toEqual(["Guest link", "One-time code"]);
    expect(M.currentSpec(guest).content.recommendedOptionId).toBe("A");
    expect(M.currentSpec(guest).content.uncertainty).toMatch(/what data is kept/);
    expect(guest.decisionAt > s.project.lastVisitAt).toBe(true);

    // WT-005: done, its pull request built (the service publishes it at start); review and checks count.
    const packing = task(s, "WT-005");
    expect(col("WT-005")).toBe("done");
    const pr5 = D.livePr(packing)!;
    expect(pr5).toMatchObject({ phase: "built", simulated: true, policy: "hold", n: 1 });
    expect(pr5.review).toMatchObject({ ok: true, source: "pipeline", provider: "claude", forSha: pr5.changeSha });
    expect(C.checkEvidence(s, pr5.changeSha).ok).toBe(true);
    expect(pr5.attention).toBeUndefined();

    // WT-007: the UX review raised a finding that needs you; the code review is the next step.
    const vo = task(s, "WT-007");
    expect(vo.pattern.id).toBe("feature");
    expect(vo.steps.map((x) => `${x.id}:${x.state}`)).toEqual(["S1:pending", "S2:pending", "C1:pending", "S3:pending", "S4:pending", "S5:pending", "C2:pending", "S6:pending"].map((x) => (x.startsWith("S1:") || x.startsWith("S2:") || x.startsWith("C1:") || x.startsWith("S4:") ? x.replace("pending", "done") : x)));
    const decision = s.decisions.find((d) => d.taskId === "WT-007");
    expect(s.decisions).toHaveLength(1);
    expect(decision).toMatchObject({ status: "open", routedTo: "user", finding: { title: "Read distances in miles or kilometres?" } });
    expect(decision!.finding.why).toMatch(/Recommendation: follow the phone's region setting/);
    expect(F.awaitingDecision(s, vo)).toEqual({ count: 1, lead: 0, user: 1 });

    // WT-008: merged and reviewed.
    expect(task(s, "WT-008").integration?.landed).toMatchObject({ status: "reviewed", simulated: true });

    // WT-009: paused by you during S2; the runtime acknowledged.
    const bug = task(s, "WT-009");
    expect(bug.pattern.id).toBe("bugfix");
    expect(bug.hold).toBe(true);
    expect(M.stateLabel(s, bug)).toBe("Paused");
    const fix = s.attempts.filter((a) => a.taskId === "WT-009" && a.stepId === "S2");
    expect(fix).toHaveLength(1);
    expect(fix[0]).toMatchObject({ outcome: "stopped", stopReason: "pause" });
    expect(bug.steps.find((x) => x.id === "S2")?.state).toBe("paused");
    expect(Date.parse(iso(T0)) - Date.parse(fix[0].endedAt!)).toBeCloseTo(120 * 60_000, -4);
    expect(s.events.some((e) => e.taskId === "WT-009" && /holding until offline maps lands/.test(e.message))).toBe(true);

    // WT-010: deferred by the lead's steering.
    expect(M.stateLabel(s, task(s, "WT-010"))).toBe("Deferred by lead");

    // WT-011: the best-of experiment, chosen by you, compared and merged; in Review.
    const search = task(s, "WT-011");
    expect(search.pattern).toMatchObject({ id: "change-best-of-two", experimental: true, chosenBy: "user" });
    expect(search.steps.filter((x) => x.copyOf === "S1").map((x) => `${x.id}:${x.selection?.provider}`)).toEqual(["S1:claude", "S1-c2:codex"]);
    expect(search.bestOf).toEqual({ S1: "S1" });
    expect(M.acceptedOutput(s, search, "S2", "comparison")?.summary).toMatch(/S1 is simpler/);
    expect(search.integration?.landed).toMatchObject({ status: "unreviewed", simulated: true });
    expect(search.integration?.pr?.changeAuthors).toEqual(["claude"]);

    // The review-later list: unreviewed first, newest first; the history follows, every item reviewed or sent back.
    const landed = D.landedTasks(s).map((t) => `${t.id}:${t.integration!.landed!.status}`);
    expect(landed.slice(0, 4)).toEqual(["WT-011:unreviewed", "WT-001:unreviewed", "WT-004.1:reviewed", "WT-008:reviewed"]);
    expect(landed.slice(4).every((x) => /^WT-1\d\d(-F1)?:(reviewed|sent-back)$/.test(x))).toBe(true);
    expect(D.unreviewedCount(s)).toBe(2);
  });

  it("dispatches three agents at the worker limit, with WT-003 next in the queue; the paused, deferred and held tasks stay put", () => {
    const s0 = demo();
    const now = iso(T0 + 1000);
    const s = M.dispatchEligible(M.leadPromoteProposals(s0, now), now);
    const active = M.activeAgentAttempts(s).map((a) => `${a.taskId} ${a.stepId} ${a.snapshot.provider}`);
    expect(active).toEqual(["WT-002 S1 codex", "WT-004.2 S1 claude", "WT-007 S3 claude"]);
    expect(M.column(s, task(s, "WT-007"))).toBe("reviewing");
    for (const id of ["WT-003", "WT-006", "WT-009", "WT-010", "WT-004.3"]) expect(M.activeAttempts(s, id), id).toEqual([]);
    // WT-004.3 was promoted (the lead moves published specs to Ready) and still waits for you.
    expect(task(s, "WT-004.3")).toMatchObject({ lifecycle: "ready", holdBeforeStart: true });
    expect(M.stateLabel(s, task(s, "WT-004.3"))).toBe("Held before start");
    // One more slot goes to WT-003's designer step on Claude, and to nothing else first.
    const wider = M.dispatchEligible({ ...s, project: { ...s.project, workerLimit: 4 } }, iso(T0 + 2000));
    expect(M.activeAgentAttempts(wider).map((a) => `${a.taskId} ${a.stepId} ${a.snapshot.provider}`)).toEqual([...active, "WT-003 S1 claude"]);
  });

  it("labels nothing by text: no 'Simulated part', no '(sample)' outside the project name, no run id used as a name, no '(Simulated)' prefix", () => {
    const s = demo();
    const texts = visibleTexts(s);
    expect(texts.length).toBeGreaterThan(100);
    for (const { where, text } of texts) {
      expect(text, where).not.toMatch(/Simulated part/);
      expect(text, where).not.toMatch(/\(sample\)/);
      expect(text, where).not.toMatch(/\brun-\d+\b/);
      expect(text, where).not.toMatch(/\(Simulated\)/);
    }
    expect(s.project.name).toContain("(sample)");
    // "(simulated)" survives only where the design keeps it: the comparison's measurement.
    const keep = texts.filter((t) => /\(simulated\)/i.test(t.text));
    expect(keep.map((t) => t.where)).toEqual(s.artifacts.filter((a) => a.taskId === "WT-011" && a.name === "comparison").map((a) => `${a.id} summary`));
    // Simulated things are labelled by their records instead.
    expect(s.attempts.filter((a) => a.snapshot.provider === "service").every((a) => s.artifacts.find((x) => x.attemptId === a.id)?.checkRun?.simulated)).toBe(true);
    expect(s.tasks.filter((t) => t.integration?.pr).every((t) => t.integration!.pr!.simulated)).toBe(true);
    expect(s.tasks.filter((t) => t.integration?.landed).every((t) => t.integration!.landed!.simulated)).toBe(true);
  });

  it("Reset sample data restores the demo, keeps the catalog and the retired templates, and never reuses ids", () => {
    const s0 = demo();
    let s = M.pauseTask(s0, "WT-002", iso(T0 + 1000));
    s = M.postMessage(s, "Hello", iso(T0 + 2000));
    s = { ...s, retiredTemplates: [{ id: "old", name: "Old", description: "", steps: [], kind: "custom", retiredAt: iso(T0) }] };
    const r = runCommand(s, "resetSampleData", {}, iso(T0 + 3000)).state;
    expect(r.project.name).toBe(DEMO_PROJECT_NAME);
    expect(r.tasks.map((t) => t.id)).toEqual(s0.tasks.map((t) => t.id));
    expect(task(r, "WT-002").hold).toBe(false);
    expect(r.conversation).toHaveLength(4);
    expect(r.patterns).toEqual(s.patterns);
    expect(r.retiredTemplates).toEqual(s.retiredTemplates);
    expect(r.seq).toBeGreaterThan(s.seq);
    validate(r);
  });
});

describe("the demo history (ORC-018 §7)", () => {
  const s = demo();
  const history = [...HISTORY_IDS, ...HISTORY_FIX_IDS].map((id) => task(s, id));
  const groups = groupRows(s, compareRows(s), DEFAULT_FILTER);
  const group = (name: string, older = false) => {
    const g = groups.find((x) => x.name === name && (older ? !x.currentHash : !!x.currentHash));
    if (!g) throw new Error(`no group ${name}${older ? " (older)" : ""}`);
    return g;
  };
  const median = (name: string, id: MeasureId) => group(name).stats[id].median!;

  it("has 24 tasks and two fixes sent back, settled 30 to 9 days ago, every outcome equal to computeOutcome on the settled state", () => {
    expect(HISTORY_IDS).toEqual(Array.from({ length: 24 }, (_, i) => `WT-${101 + i}`));
    expect(HISTORY_FIX_IDS).toEqual(["WT-105-F1", "WT-113-F1"]);
    for (const t of history) {
      expect(["done", "cancelled"], t.id).toContain(t.lifecycle);
      const o = t.outcome;
      expect(o, `${t.id} outcome`).toBeDefined();
      const age = T0 - Date.parse(o!.settledAt);
      expect(age, `${t.id} settled ${(age / DAY).toFixed(1)} days ago`).toBeGreaterThanOrEqual(9 * DAY);
      expect(age, `${t.id} settled ${(age / DAY).toFixed(1)} days ago`).toBeLessThanOrEqual(30 * DAY);
      expect(o, `${t.id} outcome equals computeOutcome`).toEqual(computeOutcome(s, t, o!.settledAt));
      expect(o!.result).toBe(t.lifecycle);
      // Usage as the adapters report it: every completed agent run has tokens; only Claude's carry a cost. (A stopped run reports none.)
      for (const a of s.attempts.filter((a) => a.taskId === t.id && a.snapshot.provider !== "service" && a.outcome === "completed")) {
        expect(a.usage?.inputTokens, `${a.id} tokens`).toBeGreaterThan(0);
        expect(a.usage?.costUsd !== undefined, `${a.id} cost`).toBe(a.snapshot.provider === "claude");
      }
    }
    // Nothing of the history is in flight or waiting: it is never dispatched, and it needs nobody.
    for (const t of history) expect(M.activeAttempts(s, t.id), t.id).toEqual([]);
    const fixes = HISTORY_FIX_IDS.map((id) => task(s, id));
    expect(fixes.map((t) => [t.followUpOf, t.pattern.id, t.pattern.chosenBy])).toEqual([
      ["WT-105", "bugfix", "service"],
      ["WT-113", "bugfix", "service"],
    ]);
    expect(task(s, "WT-105").integration?.landed).toMatchObject({ status: "sent-back", followUps: [{ taskId: "WT-105-F1", kind: "fix" }] });
    expect(task(s, "WT-113").integration?.landed).toMatchObject({ status: "sent-back", followUps: [{ taskId: "WT-113-F1", kind: "fix" }] });
  });

  it("groups on the Compare page as intended: Change 9 (one cancelled), cross-review 8, Bug fix 7, and the older Bug fix apart as too few", () => {
    expect(groups.map((g) => [g.name, g.rows.length, g.tooFew, !!g.currentHash])).toEqual([
      ["Change", 9, false, true],
      ["Change, reviewed by the other provider", 8, false, true],
      ["Bug fix", 7, false, true],
      ["Bug fix", 1, true, false],
    ]);
    // The cancelled Change joins with "Done and cancelled"; merging versions puts the two Bug fix versions together.
    const all = groupRows(s, compareRows(s), { ...DEFAULT_FILTER, results: ["done", "cancelled"] });
    expect(all.find((g) => g.name === "Change" && g.currentHash)?.rows.map((r) => r.result).filter((r) => r === "cancelled")).toEqual(["cancelled"]);
    const merged = groupRows(s, compareRows(s), { ...DEFAULT_FILTER, mergeVersions: true });
    expect(merged.find((g) => g.name === "Bug fix")).toMatchObject({ rows: expect.any(Array), hashes: expect.any(Array) });
    expect(merged.find((g) => g.name === "Bug fix")!.rows).toHaveLength(8);
    expect(merged.find((g) => g.name === "Bug fix")!.hashes).toHaveLength(2);
    expect(task(s, OLDER_VERSION_ID).pattern.hash).toBe(patternHash(olderBugfixSteps()));
    // Every row is simulated (the project is the sample), and the two fixes were chosen by the service.
    expect(compareRows(s).every((r) => r.simulated)).toBe(true);
    expect(compareRows(s).filter((r) => r.pattern.chosenBy === "service").map((r) => r.taskId)).toEqual(HISTORY_FIX_IDS);
  });

  it("shows spread without a verdict: bug fixes are quick, cross-review takes a little longer with overlapping spreads, and no landed task has open findings or a cost", () => {
    const change = group("Change").stats;
    const cross = group("Change, reviewed by the other provider").stats;
    const bug = group("Bug fix").stats;
    expect(median("Bug fix", "timeToDone")).toBeLessThan(median("Change", "timeToDone"));
    expect(cross.agentTime.median!).toBeGreaterThan(change.agentTime.median!);
    expect(cross.agentTime.q1!).toBeLessThan(change.agentTime.q3!); // the spreads overlap
    // A pull request is built only on a clean independent review, so every landed task ends with nothing open...
    for (const g of [change, cross, bug]) expect(g.openAtEnd.values.every((v) => v === 0)).toBe(true);
    // ...and every landed task had a Codex run (Codex writes, or reviews what Claude wrote), so none reports a cost: tokens are reported instead.
    for (const g of [change, cross, bug]) {
      expect(g.cost.n).toBe(0);
      expect(g.inputTokens.n).toBe(g.inputTokens.of);
    }
    // The cancelled Change is the one with findings still open; it is out of the default view.
    const cancelled = task(s, HISTORY.find((h) => h.cancelled)!.id);
    expect(cancelled.lifecycle).toBe("cancelled");
    expect(cancelled.outcome?.findings.openAtEnd).toBe(2);
    // Delivery varies: landed at your request in the app, merged by you on GitHub, closed without merging, sent back.
    expect(change.landed.count).toBe(8);
    expect(change.landed.n).toBe(9);
    expect(group("Change").rows.filter((r) => r.m.landed === 0).map((r) => r.taskId)).toEqual([HISTORY.find((h) => h.delivery === "github-close")!.id]);
    for (const h of HISTORY.filter((x) => x.delivery === "github-merge")) expect(task(s, h.id).integration?.landed?.by, h.id).toBe("person");
    expect((change.sentBack.count ?? 0) + (cross.sentBack.count ?? 0)).toBe(2);
    expect(change.repairRounds.values).toContain(2);
    expect(change.failedCheckRuns.values).toContain(1);
  });

  it("folds under Done earlier on the board, while the current story's done tasks stay in view", () => {
    const done = s.tasks.filter((t) => M.column(s, t) === "done");
    const { recent, earlier } = splitDone(s, done, T0);
    expect(recent.map((t) => t.id)).toEqual(["WT-001", "WT-005", "WT-008", "WT-011", "WT-004.1"]);
    expect(earlier.map((t) => t.id).sort()).toEqual([...HISTORY_IDS.filter((id) => task(s, id).lifecycle === "done"), ...HISTORY_FIX_IDS].sort());
    expect(earlier).toHaveLength(25);
  });

  it("comes back whole from Reset sample data", () => {
    const r = runCommand(s, "resetSampleData", {}, iso(T0 + 3000)).state;
    for (const id of [...HISTORY_IDS, ...HISTORY_FIX_IDS]) {
      const t = task(r, id);
      expect(t.outcome, id).toBeDefined();
      expect(t.outcome).toEqual(computeOutcome(r, t, t.outcome!.settledAt));
    }
    expect(groupRows(r, compareRows(r), DEFAULT_FILTER).map((g) => [g.name, g.rows.length, g.tooFew])).toEqual(groups.map((g) => [g.name, g.rows.length, g.tooFew]));
  });
});
