// ORC-017 §5: the demo state is valid by construction, tells the sample story, labels nothing by text
// inside titles and summaries, and comes back from Reset sample data. ORC-021: it runs all six flows,
// every finished code task has a security review beside each code review, and one security finding
// (WT-004.1) was repaired in the loop.

import { describe, expect, it } from "vitest";
import * as C from "./checks";
import { runCommand } from "./commands";
import * as D from "./delivery";
import { DEMO_DOC_TEXT, DEMO_PROJECT_NAME, DEMO_REPO_PATH, buildDemo } from "./demo";
import { DEMO_AREAS } from "./demoScript";
import * as F from "./findings";
import * as M from "./model";
import { builtInCatalog } from "./flows";
import { toDef, validatePipeline } from "./pipeline";
import { buildSeed } from "./seed";
import type { State, Task } from "./types";

const T0 = Date.parse("2026-10-01T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const demo = () => buildDemo(T0);
const task = (s: State, id: string): Task => {
  const t = s.tasks.find((x) => x.id === id);
  if (!t) throw new Error(`no task ${id}`);
  return t;
};

/** Structural checks any state the service writes must pass. */
function validate(s: State) {
  expect(s.version).toBe(17);
  const catalog = builtInCatalog();
  const ids = new Set<string>();
  for (const t of s.tasks) {
    expect(ids.has(t.id), `duplicate task id ${t.id}`).toBe(false);
    ids.add(t.id);
    expect(validatePipeline(t.steps.map(toDef)).filter((i) => i.severity === "error"), `${t.id} pipeline`).toEqual([]);
    expect(t.pipelineHistory.length, `${t.id} history`).toBe(t.pipelineRev);
    expect(t.flowSince).toBeLessThanOrEqual(t.pipelineRev);
    expect(t.flow.source).toBe("built-in");
    const p = catalog.find((x) => x.id === t.flow.id);
    expect(p, `${t.id} flow ${t.flow.id}`).toBeDefined();
    expect(t.flow.hash).toBe(p!.hash);
    expect(t.pipelineHistory[0].flow?.id).toBe(t.flow.id);
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
    // ORC-022: a sent note row names a note that exists; a note names its row back.
    for (const c of set.changes) if (c.kind === "note" && c.noteId) expect(s.notes.find((n) => n.id === c.noteId)?.from).toMatchObject({ by: "lead", changeSetId: set.id, changeId: c.id });
  }
  // ORC-022: every note is addressed to a step that exists; a bound one names a run of that step; statuses and their fields agree.
  const noteIds = new Set<string>();
  for (const n of s.notes) {
    expect(noteIds.has(n.id), `duplicate note id ${n.id}`).toBe(false);
    noteIds.add(n.id);
    const t = task(s, n.taskId);
    expect(t.steps.some((st) => st.id === n.stepId), `${n.id} step ${n.stepId}`).toBe(true);
    if (n.attemptId) expect(s.attempts.find((a) => a.id === n.attemptId)?.stepId, `${n.id} run`).toBe(n.stepId);
    if (n.status === "queued") expect(n.attemptId, `${n.id} queued without a run`).toBeUndefined();
    if (n.status === "delivered" || n.status === "not-delivered") expect(n.settledAt, `${n.id} settledAt`).toBeDefined();
    if (n.status === "delivered") expect(n.reason, `${n.id} reason`).toBeUndefined();
    if (n.status === "not-delivered") expect(n.reason, `${n.id} reason`).toBeDefined();
    expect(n.text.length).toBeGreaterThan(0);
    expect(n.text.length).toBeLessThanOrEqual(500);
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
  for (const n of s.notes) out.push({ where: n.id, text: n.text });
  return out;
}

describe("the demo state (ORC-017 §5)", () => {
  it("is valid by construction and deterministic for a clock; the test fixture is untouched", () => {
    const s = demo();
    validate(s);
    expect(JSON.stringify(buildDemo(T0))).toBe(JSON.stringify(s));
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
      ["note", "applied", "WT-002"],
    ]);
    expect(set.reason).not.toMatch(/\(Simulated/);
    expect(task(s, "WT-010").deferral).toMatchObject({ by: "lead", changeSetId: set.id });
    expect(M.column(s, task(s, "WT-010"))).toBe("deferred");
    expect(M.currentFocusChange(s)?.set.id).toBe(set.id);
    // Undo works: the focus goes back and the deferral is lifted; the note has no Undo and is skipped.
    const undone = M.undoSteering(s, set.id, undefined, iso(T0));
    expect(undone.result).toEqual({ undone: [set.changes[1].id, set.changes[0].id], left: [] });
    expect(M.currentVision(undone.state).focus).toBe("Trip sharing first.");
    expect(task(undone.state, "WT-010").deferral).toBeUndefined();
    expect(undone.state.steering[0].changes[2].status).toBe("applied");
    expect(M.pendingMessages(s)).toEqual([]);
  });

  it("ORC-022: the lead's note to WT-002's coder waits for its run (the step has not started) and is delivered at start by the first dispatch", () => {
    const s = demo();
    expect(s.notes).toHaveLength(1);
    const n = s.notes[0];
    const row = s.steering[0].changes[2];
    expect(n).toMatchObject({ taskId: "WT-002", stepId: "S1", status: "queued", simulated: true, text: "Show the age of the cached map in whole hours, not minutes; the owner asked for it." });
    expect(n.from).toEqual({ by: "lead", leadRunId: s.steering[0].leadRunId, changeSetId: s.steering[0].id, changeId: row.id, messageIds: [s.conversation[0].id] });
    expect(row).toMatchObject({ kind: "note", status: "applied", appliedBy: "lead", noteId: n.id, stepId: "S1", after: n.text });
    expect(s.conversation[0].text).toMatch(/tell whoever builds the offline banner/);
    expect(s.conversation[1].text).toMatch(/I sent the coder of the offline banner a note/);
    expect(s.events.some((e) => e.taskId === "WT-002" && e.message.startsWith(`Note ${n.id} queued for S1's next run (the step has not started)`))).toBe(true);
    // The service's first dispatch binds it to WT-002 S1's run and writes it into the run's instructions; a confirmed start delivers it.
    const now = iso(T0 + 1000);
    const d = M.dispatchEligible(M.leadPromoteProposals(s, now), now);
    const run = M.activeAttempts(d, "WT-002").find((a) => a.stepId === "S1")!;
    expect(d.notes[0]).toMatchObject({ status: "sending", via: "start", attemptId: run.id });
    expect(M.notesAtStart(d, run.id).map((x) => x.id)).toEqual([n.id]);
    const delivered = M.reportNoteOutcome(d, { attemptId: run.id, noteId: n.id, outcome: "delivered" }, iso(T0 + 2000), true);
    expect(delivered.notes[0]).toMatchObject({ status: "delivered", via: "start", simulated: true });
  });

  it("shows each capability once: the tasks and their states at the start of the demo", () => {
    const s = demo();
    expect(s.tasks.map((t) => t.id)).toEqual(["WT-001", "WT-002", "WT-003", "WT-004", "WT-005", "WT-006", "WT-007", "WT-008", "WT-009", "WT-010", "WT-011", "WT-012", "WT-013", "WT-004.1", "WT-004.2", "WT-004.3"]);
    const col = (id: string) => M.column(s, task(s, id));

    // WT-001: a failing check became a finding, the repair ran, the loop ran once more clean; merged, in Review.
    const wt1 = task(s, "WT-001");
    expect(col("WT-001")).toBe("done");
    expect(wt1.steps.map((x) => `${x.id}:${x.state}`)).toEqual(["S1:done", "C1:done", "S2:done", "SR1:done", "S3:done", "C1-i2:done", "S2-i2:done", "SR1-i2:done", "S3-i2:skipped", "C2:done", "S4:done"]);
    expect(M.acceptedOutput(s, wt1, "SR1", "findings")?.openFindings).toBe(0); // ORC-021: the security review beside the code review
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
    expect(task(s, "WT-003").flow.id).toBe("feature");
    expect(M.currentSpec(task(s, "WT-003")).content.options.map((o) => o.name)).toEqual(["Download by trail", "Download by map rectangle"]);
    expect(col("WT-006")).toBe("ready");

    // WT-004: a goal whose plan became three children; it waits on them.
    const goal = task(s, "WT-004");
    expect(goal.flow.id).toBe("goal");
    expect(M.stateLabel(s, goal)).toBe("Waiting for 2 child tasks");
    expect(M.childTasks(s, goal).map((c) => c.id)).toEqual(["WT-004.1", "WT-004.2", "WT-004.3"]);
    expect(M.acceptedOutput(s, goal, "S1", "plan")?.items).toHaveLength(3);
    // WT-004.1: Codex's code review was clean; Claude's security review beside it found that a link opened any trip
    // (ORC-021). The repair ran, the loop reviewed the repaired change again, clean; merged and reviewed.
    const invite = task(s, "WT-004.1");
    expect(invite).toMatchObject({ parentTaskId: "WT-004", lifecycle: "done" });
    expect(invite.steps.map((x) => `${x.id}:${x.state}`)).toEqual(["S1:done", "C1:done", "S2:done", "SR1:done", "S3:done", "C1-i2:done", "S2-i2:done", "SR1-i2:done", "S3-i2:skipped", "C2:done", "S4:done"]);
    expect(invite.roleOverrides).toEqual({ coder: { provider: "claude", model: "claude-sample-large" }, code_reviewer: { provider: "codex", model: "codex-sample-large" } });
    const codeReview = M.acceptedOutput(s, invite, "S2", "findings")!;
    expect(codeReview.openFindings).toBe(0);
    expect(s.attempts.find((a) => a.id === codeReview.attemptId)?.snapshot).toMatchObject({ provider: "codex", source: "task-role" });
    const security = M.acceptedOutput(s, invite, "SR1", "findings")!;
    expect(security.openFindings).toBe(1);
    expect(security.findings).toEqual([expect.objectContaining({ source: "review", severity: "error", action: "auto-fix", title: "Invite links are not scoped to the trip", file: "src/server/links.ts", line: 48 })]);
    expect(security.findings![0].detail).toMatch(/a valid link for one trip opened another/);
    // The security reviewer follows the code reviewer's project default (Claude), not the task's code-reviewer override.
    expect(s.attempts.find((a) => a.id === security.attemptId)?.snapshot).toMatchObject({ provider: "claude", source: "project-role" });
    const repair = M.acceptedOutput(s, invite, "S3", "change")!;
    expect(repair.summary).toMatch(/refuses a link opened on another trip/);
    expect(M.acceptedOutput(s, invite, "SR1-i2", "findings")?.openFindings).toBe(0);
    expect(M.acceptedOutput(s, invite, "S2-i2", "findings")?.openFindings).toBe(0);
    // The pull request's review evidence is the clean Codex review of the repaired change.
    expect(invite.integration?.pr?.review).toMatchObject({ ok: true, source: "pipeline", provider: "codex" });
    expect(invite.integration?.pr?.review.forSha?.startsWith(repair.ref!.split(" ")[0])).toBe(true);
    expect(invite.integration?.pr?.changeAuthors).toEqual(["claude"]);
    expect(invite.integration?.landed).toMatchObject({ status: "reviewed", simulated: true, flags: [] });
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
    expect(vo.flow.id).toBe("feature");
    expect(vo.steps.map((x) => `${x.id}:${x.state}`)).toEqual(["S1:pending", "S2:pending", "C1:pending", "S3:pending", "SR1:pending", "S4:pending", "S5:pending", "C2:pending", "S6:pending"].map((x) => (x.startsWith("S1:") || x.startsWith("S2:") || x.startsWith("C1:") || x.startsWith("S4:") ? x.replace("pending", "done") : x)));
    const decision = s.decisions.find((d) => d.taskId === "WT-007");
    expect(s.decisions).toHaveLength(1);
    expect(decision).toMatchObject({ status: "open", routedTo: "user", finding: { title: "Read distances in miles or kilometres?" } });
    expect(decision!.finding.why).toMatch(/Recommendation: follow the phone's region setting/);
    expect(F.awaitingDecision(s, vo)).toEqual({ count: 1, lead: 0, user: 1 });

    // WT-008: merged and reviewed.
    expect(task(s, "WT-008").integration?.landed).toMatchObject({ status: "reviewed", simulated: true });

    // WT-009: paused by you during S2; the runtime acknowledged.
    const bug = task(s, "WT-009");
    expect(bug.flow.id).toBe("bugfix");
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

    // WT-011: your own Change task, implemented by Codex, reviewed clean (code and security), merged; in Review.
    const search = task(s, "WT-011");
    expect(search.flow).toMatchObject({ id: "change", chosenBy: "user" });
    expect(search.steps.map((x) => `${x.id}:${x.state}`)).toEqual(["S1:done", "C1:done", "S2:done", "SR1:done", "S3:skipped", "C2:done", "S4:done"]);
    expect(search.integration?.landed).toMatchObject({ status: "unreviewed", simulated: true });
    expect(search.integration?.pr?.changeAuthors).toEqual(["codex"]);

    // The review-later list: unreviewed first, newest first. The two tasks without code (WT-012, WT-013) are not in it.
    expect(D.landedTasks(s).map((t) => `${t.id}:${t.integration!.landed!.status}`)).toEqual(["WT-011:unreviewed", "WT-001:unreviewed", "WT-004.1:reviewed", "WT-008:reviewed"]);
    expect(D.unreviewedCount(s)).toBe(2);
  });

  it("runs all six flows, and every finished code task has a finished security review beside each code review (ORC-021)", () => {
    const s = demo();
    const flows = builtInCatalog()
      .map((f) => f.id)
      .sort();
    expect(flows).toEqual(["bugfix", "change", "design", "feature", "goal", "investigation"]);
    expect([...new Set(s.tasks.map((t) => t.flow.id))].sort()).toEqual(flows);
    // A code task is one whose steps produce a code change. Each of its code reviews has a security review beside it:
    // the same round, finished, with an accepted findings artifact, and it read the same change the code review read.
    const codeTasks = s.tasks.filter((t) => t.lifecycle === "done" && t.steps.some((st) => st.outputs.some((o) => o.kind === "code-change")));
    expect(codeTasks.map((t) => t.id).sort()).toEqual(["WT-001", "WT-004.1", "WT-005", "WT-008", "WT-011"]);
    const changeInputs = (attemptId: string | undefined) =>
      s.attempts
        .find((a) => a.id === attemptId)!
        .snapshot.inputs.filter((i) => i.output === "change")
        .map((i) => i.artifactId);
    for (const t of codeTasks) {
      const codeReviews = t.steps.filter((st) => st.role === "code_reviewer");
      const securityReviews = t.steps.filter((st) => st.role === "security_reviewer");
      expect(codeReviews.length, t.id).toBeGreaterThan(0);
      expect(securityReviews.map((st) => st.iteration ?? 1), t.id).toEqual(codeReviews.map((st) => st.iteration ?? 1));
      for (const st of securityReviews) {
        expect(st.state, `${t.id} ${st.id}`).toBe("done");
        const art = M.acceptedOutput(s, t, st.id, "findings");
        expect(art?.kind, `${t.id} ${st.id}`).toBe("review-findings");
        const beside = codeReviews.find((c) => (c.iteration ?? 1) === (st.iteration ?? 1))!;
        expect(changeInputs(art!.attemptId), `${t.id} ${st.id}`).toEqual(changeInputs(M.acceptedOutput(s, t, beside.id, "findings")?.attemptId));
      }
    }
    // The security review is visible: exactly one found something (WT-004.1's first round), and its repair round was clean.
    const securityRuns = new Set(s.attempts.filter((a) => a.snapshot.role === "security_reviewer").map((a) => a.id));
    const found = s.artifacts.filter((a) => securityRuns.has(a.attemptId) && (a.findings?.length ?? 0) > 0);
    expect(found.map((a) => `${a.taskId} ${a.stepId}`)).toEqual(["WT-004.1 SR1"]);
    // Design and Investigation produce no code, so neither has one.
    for (const id of ["WT-012", "WT-013"]) expect(task(s, id).steps.some((st) => st.role === "security_reviewer"), id).toBe(false);
  });

  it("tells the Investigation and the Design: evidence, review and follow-up spec; design, UX finding, revise round and brief; nothing to integrate", () => {
    const s = demo();
    // WT-012: the coder's evidence (Codex), the reviewer's one note that blocks nothing (Claude), the lead's follow-up spec.
    const inv = task(s, "WT-012");
    expect(inv).toMatchObject({ lifecycle: "done", flow: { id: "investigation", chosenBy: "lead" }, integration: { status: "not-needed" } });
    expect(M.currentSpec(inv).content).toMatchObject({ area: "Reliability", title: "Why does the map drain the battery on long hikes?" });
    expect(inv.steps.map((x) => `${x.id}:${x.state}`)).toEqual(["S1:done", "S2:done", "S3:done"]);
    const report = M.acceptedOutput(s, inv, "S1", "report")!;
    expect(report.kind).toBe("report");
    expect(report.summary).toMatch(/GPS is polled once a second for the whole hike, screen off included/);
    expect(s.attempts.find((a) => a.id === report.attemptId)?.snapshot.provider).toBe("codex");
    const evidence = M.acceptedOutput(s, inv, "S2", "findings")!;
    expect(evidence.findings).toEqual([expect.objectContaining({ severity: "info", action: "no-op", title: "Figures from one phone on one hike" })]);
    expect(evidence.openFindings).toBe(0);
    expect(F.awaitingDecision(s, inv)).toBeUndefined();
    const brief = M.acceptedOutput(s, inv, "S3", "brief")!;
    expect(brief.kind).toBe("brief");
    expect(brief.summary).toMatch(/polls the location every 30 seconds while the screen is off/);
    expect(s.attempts.find((a) => a.id === brief.attemptId)?.snapshot).toMatchObject({ provider: "claude", role: "lead" });

    // WT-013: the design, a UX review with one finding, the revise round, a clean second review, the lead's brief.
    const design = task(s, "WT-013");
    expect(design).toMatchObject({ lifecycle: "done", flow: { id: "design", chosenBy: "lead" }, integration: { status: "not-needed" } });
    expect(M.currentSpec(design).content).toMatchObject({ area: "Trip sharing", title: "Design the invite screen for a trip" });
    expect(design.steps.map((x) => `${x.id}:${x.state}`)).toEqual(["S1:done", "S2:done", "S3:done", "S2-i2:done", "S3-i2:skipped", "S4:done"]);
    expect(design.pipelineRev).toBe(2); // the revise round appended the loop's second iteration
    expect(M.acceptedOutput(s, design, "S1", "design")?.kind).toBe("design");
    const ux = M.acceptedOutput(s, design, "S2", "findings")!;
    expect(ux.findings).toEqual([expect.objectContaining({ severity: "warning", action: "auto-fix", title: "The expiry is shown as a date only" })]);
    expect(s.attempts.find((a) => a.id === ux.attemptId)?.snapshot).toMatchObject({ provider: "claude", model: "claude-sample-fast", role: "ux_reviewer" });
    expect(M.acceptedOutput(s, design, "S3", "design")?.summary).toMatch(/Expires in 6 days/);
    expect(M.acceptedOutput(s, design, "S2-i2", "findings")?.openFindings).toBe(0);
    expect(M.acceptedOutput(s, design, "S4", "brief")?.summary).toMatch(/The invite-link part of trip sharing builds from this/);
    // The design sits behind the first trip-sharing part: named in its plan, and finished before WT-004.1 started.
    expect(M.currentSpec(task(s, "WT-004.1")).content.options[0].approach).toMatch(/designed in WT-013/);
    const inviteStart = s.attempts
      .filter((a) => a.taskId === "WT-004.1")
      .map((a) => a.startedAt)
      .sort()[0];
    expect(design.integration!.at! < inviteStart).toBe(true);

    // Both are settled history: in the past, no run, nothing to integrate, nowhere in the review-later list, in the Done column.
    expect(s.events.some((e) => /Published specs for WT-012 and WT-013 from vision r1/.test(e.message))).toBe(true);
    for (const t of [inv, design]) {
      expect(Date.parse(t.createdAt), t.id).toBeLessThan(Date.parse(task(s, "WT-004.1").createdAt));
      expect(Date.parse(t.updatedAt), t.id).toBeLessThan(T0 - 60 * 60_000);
      expect(M.activeAttempts(s, t.id), t.id).toEqual([]);
      expect(s.attempts.filter((a) => a.taskId === t.id).every((a) => a.outcome === "completed"), t.id).toBe(true);
      expect(M.column(s, t), t.id).toBe("done");
      expect(M.stateLabel(s, t), t.id).toBe("Done");
      expect(t.integration?.pr, t.id).toBeUndefined();
      expect(t.integration?.landed, t.id).toBeUndefined();
      expect(s.artifacts.some((a) => a.taskId === t.id && a.kind === "code-change"), t.id).toBe(false);
      expect(s.events.some((e) => e.taskId === t.id && /Nothing to integrate \(no code change\)/.test(e.message)), t.id).toBe(true);
    }
    expect(D.landedTasks(s).map((t) => t.id)).toEqual(expect.not.arrayContaining(["WT-012", "WT-013"]));
  });

  it("dispatches three agents at the worker limit, with WT-007's security review next in the queue and WT-003 after it; the paused, deferred and held tasks stay put", () => {
    const s0 = demo();
    const now = iso(T0 + 1000);
    const s = M.dispatchEligible(M.leadPromoteProposals(s0, now), now);
    const active = M.activeAgentAttempts(s).map((a) => `${a.taskId} ${a.stepId} ${a.snapshot.provider}`);
    expect(active).toEqual(["WT-002 S1 codex", "WT-004.2 S1 claude", "WT-007 S3 claude"]);
    expect(M.column(s, task(s, "WT-007"))).toBe("reviewing");
    // The settled tasks, the two without code among them (ORC-021), never dispatch.
    for (const id of ["WT-003", "WT-006", "WT-009", "WT-010", "WT-004.3", "WT-012", "WT-013"]) expect(M.activeAttempts(s, id), id).toEqual([]);
    // WT-004.3 was promoted (the lead moves published specs to Ready) and still waits for you.
    expect(task(s, "WT-004.3")).toMatchObject({ lifecycle: "ready", holdBeforeStart: true });
    expect(M.stateLabel(s, task(s, "WT-004.3"))).toBe("Waiting for your go-ahead");
    // One more slot goes to WT-007's security review (ORC-021: beside its code review), the next after that to WT-003's designer step on Claude.
    const wider = M.dispatchEligible({ ...s, project: { ...s.project, workerLimit: 4 } }, iso(T0 + 2000));
    expect(M.activeAgentAttempts(wider).map((a) => `${a.taskId} ${a.stepId} ${a.snapshot.provider}`)).toEqual([...active, "WT-007 SR1 claude"]);
    // With Claude's own limit of three full, the fifth slot goes to WT-006's coder on Codex; WT-003's designer step waits for Claude.
    const widest = M.dispatchEligible({ ...wider, project: { ...wider.project, workerLimit: 5 } }, iso(T0 + 3000));
    expect(M.activeAgentAttempts(widest).map((a) => `${a.taskId} ${a.stepId} ${a.snapshot.provider}`)).toEqual([...active, "WT-007 SR1 claude", "WT-006 S1 codex"]);
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
    // "(simulated)" appears in no visible text: simulated things are labelled by their records instead.
    expect(texts.filter((t) => /\(simulated\)/i.test(t.text))).toEqual([]);
    // Simulated things are labelled by their records instead.
    expect(s.attempts.filter((a) => a.snapshot.provider === "service").every((a) => s.artifacts.find((x) => x.attemptId === a.id)?.checkRun?.simulated)).toBe(true);
    expect(s.tasks.filter((t) => t.integration?.pr).every((t) => t.integration!.pr!.simulated)).toBe(true);
    expect(s.tasks.filter((t) => t.integration?.landed).every((t) => t.integration!.landed!.simulated)).toBe(true);
  });

  it("Reset sample data restores the demo, keeps the flows, and never reuses ids", () => {
    const s0 = demo();
    let s = M.pauseTask(s0, "WT-002", iso(T0 + 1000));
    s = M.postMessage(s, "Hello", iso(T0 + 2000));
    const r = runCommand(s, "resetSampleData", {}, iso(T0 + 3000)).state;
    expect(r.project.name).toBe(DEMO_PROJECT_NAME);
    expect(r.tasks.map((t) => t.id)).toEqual(s0.tasks.map((t) => t.id));
    expect(task(r, "WT-002").hold).toBe(false);
    expect(r.conversation).toHaveLength(4);
    expect(r.notes).toHaveLength(1);
    expect(r.flows).toEqual(s.flows);
    expect(r.seq).toBeGreaterThan(s.seq);
    // ORC-021: the six flows and the security review's history come back with it.
    expect([...new Set(r.tasks.map((t) => t.flow.id))].sort()).toEqual(["bugfix", "change", "design", "feature", "goal", "investigation"]);
    expect(task(r, "WT-004.1").steps.map((x) => `${x.id}:${x.state}`)).toEqual(task(s0, "WT-004.1").steps.map((x) => `${x.id}:${x.state}`));
    expect(M.acceptedOutput(r, task(r, "WT-004.1"), "SR1", "findings")?.openFindings).toBe(1);
    for (const id of ["WT-012", "WT-013"]) expect(task(r, id)).toMatchObject({ lifecycle: "done", integration: { status: "not-needed" } });
    validate(r);
  });
});
