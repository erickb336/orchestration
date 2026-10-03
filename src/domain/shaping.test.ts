// Shaping the vision with the lead first, domain level. The stage gates dispatch and planning
// but never stops running work; vision drafts are strictly validated suggestions that apply only when
// the user accepts them; the roadmap is held while shaping and released only on Autopilot; and the
// labels never say Paused.

import { describe, expect, it } from "vitest";
import * as M from "./model";
import { runCommand } from "./commands";
import { inVision, startFactoryAsOwner } from "./testing/factory";
import { setPipeline } from "./testing/pipelines";
import { buildSeed } from "./seed";
import { ControlError, StaleWriteError, type LeadQuestion, type LeadRun, type State } from "./types";

const T0 = Date.parse("2026-09-30T12:00:00Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const seed = () => buildSeed(T0);
/** The sample project without its in-flight runs (initProject refuses to replace live work). */
const quiet = () => buildSeed(T0, { inFlightRuns: false });
const task = (s: State, id: string) => s.tasks.find((t) => t.id === id)!;
const running = (s: State, id?: string) => M.activeAttempts(s, id);
/** The sample as a project in Vision, with its runs (a fixture: no command goes back from the factory since pass 5). */
const shaping = (s: State) => inVision(s, at(0));
const vision = (s: State) => M.currentVision(s);
const oneStep = [{ id: "S1", purpose: "Implement", role: "coder" as const, dependsOn: [], inputs: [], outputs: [{ name: "change", kind: "code-change" as const }] }];

/** Report a run as finished with every output its step declares. */
const complete = (s: State, attemptId: string, t: string) => {
  const a = s.attempts.find((x) => x.id === attemptId)!;
  const st = task(s, a.taskId).steps.find((x) => x.id === a.stepId)!;
  return M.reportCompletion(s, attemptId, [], t, st.outputs.map((o) => ({ name: o.name, summary: "test", ...(o.kind === "review-findings" ? { openFindings: 0 } : {}) })));
};

/** A complete, valid lead proposal. */
function proposal(over: Partial<M.LeadProposal> = {}): M.LeadProposal {
  return {
    title: "Add a greeting",
    area: "Core",
    whyNow: "No greeting yet.",
    outcome: "greet() exists.",
    benefit: "Users can greet.",
    scopeIncluded: ["greet()"],
    scopeExcluded: ["i18n"],
    options: [
      { id: "A", name: "Add greet()", approach: "One function", benefit: "Simple", effort: "Small", risks: "Low", reversibility: "High" },
      { id: "B", name: "Defer", approach: "Do nothing", benefit: "No cost", effort: "None", risks: "No greeting", reversibility: "N/A" },
    ],
    recommendedOptionId: "A",
    rationale: "Smallest useful step.",
    uncertainty: "None.",
    acceptance: ["greet() returns a greeting"],
    flowId: "change",
    priority: 2,
    ...over,
  };
}

const draft = (over: Record<string, unknown> = {}) => ({ text: "Problem: notes are slow.\nFor: daily writers.\nGoals: fast capture.", focus: "Fast capture first", reason: "From what you said about speed.", ...over });

/** Post a message, start a run and complete it with a reply that may carry a draft, proposals and steering. */
function leadReply(s: State, out: { vision?: unknown; proposals?: M.LeadProposal[]; steer?: unknown; coverage?: unknown; questions?: unknown; reply?: string }, opts: { message?: string | false; trigger?: "message" | "planning" } = {}) {
  let st = s;
  if (opts.message !== false) st = M.postMessage(st, opts.message ?? "I want fast note capture; deployment can wait", at(1));
  const r = M.startLeadRun(st, { provider: "claude", model: "m", trigger: opts.trigger ?? (opts.message === false ? "planning" : "message") }, at(2));
  st = M.completeLeadRun(r.state, r.runId, { reply: out.reply ?? "ok", proposals: out.proposals ?? [], steer: out.steer, vision: out.vision, coverage: out.coverage, questions: out.questions }, at(3));
  const message = st.conversation.filter((m) => m.author === "lead").pop()!;
  return { state: st, runId: r.runId, message, draft: st.visionDrafts.find((d) => d.leadRunId === r.runId) };
}

const messageRun: LeadRun = { id: "lead-x", trigger: "message", provider: "claude", model: "m", startedAt: at(0), outcome: "running", messageIds: ["msg-1"], visionRev: 1 };
const planningRun: LeadRun = { ...messageRun, id: "lead-p", trigger: "planning", messageIds: [] };

// The sample board already holds six open lead proposals: raise the cap so new proposals and planning are not refused for that.
const roomy = (s: State) => M.setAutonomy(s, { ...s.project.autonomy, maxOpenProposals: 50 }, at(0));
const autopilot = (s: State) => M.setAutonomy(s, { ...s.project.autonomy, enabled: true, holdLeadProposals: false, maxOpenProposals: 50 }, at(0));
const checkin = (s: State) => M.setAutonomy(s, { ...s.project.autonomy, enabled: true, holdLeadProposals: true, maxOpenProposals: 50 }, at(0));

describe("S1 stage and initProject", () => {
  it("the sample project builds (a fixture); every new project begins shaping, with a vision written or empty", () => {
    expect(seed().project.stage).toBe("building");
    const written = M.initProject(quiet(), { name: "N", repoPath: "/tmp/n", vision: "v", focus: "f" }, at(1));
    expect(written.project.stage).toBe("shaping");
    expect(written.project.factoryStarts).toEqual([]);
    const shaped = M.initProject(quiet(), { name: "N", repoPath: "/tmp/n", vision: "", focus: "" }, at(1));
    expect(shaped.project.stage).toBe("shaping");
    expect(vision(shaped)).toMatchObject({ rev: 1, author: "user", text: "", focus: "" });
    expect(shaped.visionDrafts).toEqual([]);
    expect(shaped.tasks).toEqual([]);
  });

  it("an old project's drafts do not survive a new project", () => {
    const { state: s } = leadReply(shaping(quiet()), { vision: draft() });
    expect(s.visionDrafts).toHaveLength(1);
    expect(M.initProject(s, { name: "N", repoPath: "/tmp/n", vision: "", focus: "" }, at(9)).visionDrafts).toEqual([]);
  });
});

describe("S2 nothing new starts while shaping; running work finishes", () => {
  it("a ready task is not dispatched while shaping and is dispatched once building starts", () => {
    const ready = M.startHeldTask(seed(), "EX-004", at(0));
    expect(running(M.dispatchEligible(ready, at(1)), "EX-004")).toHaveLength(1); // baseline
    let s = M.dispatchEligible(shaping(ready), at(1));
    expect(running(s, "EX-004")).toHaveLength(0);
    expect(M.stateLabel(s, task(s, "EX-004"))).toBe("Ready (shaping)");
    s = M.dispatchEligible(startFactoryAsOwner(s, at(2)), at(3));
    expect(running(s, "EX-004")).toHaveLength(1);
  });

  it("a running step in a project in Vision is never interrupted; its result is accepted; the next step waits for Start building", () => {
    let s = shaping(seed());
    const [a] = running(s, "EX-001");
    expect(a.outcome).toBe("running");
    expect(s.attempts.filter((x) => x.outcome === "stopping")).toHaveLength(0);
    s = M.dispatchEligible(s, at(1));
    expect(running(s, "EX-001")[0].outcome).toBe("running");
    s = complete(s, a.id, at(2));
    expect(s.attempts.find((x) => x.id === a.id)!.outcome).toBe("completed");
    expect(s.artifacts.some((x) => x.attemptId === a.id)).toBe(true);
    expect(task(s, "EX-001").hold).toBe(false);
    s = M.dispatchEligible(s, at(3));
    expect(running(s, "EX-001")).toHaveLength(0);
    expect(M.stateLabel(s, task(s, "EX-001"))).toBe("Next step waits (shaping)");
    s = M.dispatchEligible(startFactoryAsOwner(s, at(4)), at(5));
    expect(running(s, "EX-001").length).toBeGreaterThan(0);
  });

  it("a task whose last step completes while shaping still becomes Done and is queued for integration", () => {
    const r0 = M.createTask(seed(), { title: "Last", area: "", outcome: "x", benefit: "", whyNow: "", approach: "y", acceptance: ["ok"], priority: 1, holdBeforeStart: false, flowId: "change" }, at(0));
    const r = { ...r0, state: setPipeline(r0.state, r0.newId, 1, oneStep, "one step", "user", at(0)) };
    let s = M.dispatchEligible(M.leadPromoteProposals(r.state, at(0)), at(1));
    const [a] = running(s, r.newId);
    s = shaping(s);
    s = complete(s, a.id, at(2));
    expect(task(s, r.newId).lifecycle).toBe("done");
    expect(task(s, r.newId).integration?.status).toBe("pending");
  });

  it("no label says Paused while shaping, and the stage's own label is the truthful one", () => {
    const s = shaping(M.startHeldTask(seed(), "EX-004", at(0)));
    for (const t of s.tasks) if (!t.hold) expect(M.stateLabel(s, t)).not.toMatch(/Paused/);
    expect(M.stateLabel(s, task(s, "EX-005"))).toBe("Paused"); // the user's own hold still reads as it is
    expect(M.SHAPING_LABEL).toBe("Shaping: new work waits until you start building");
    expect(s.project.hold).toBe(false);
  });

  it("startFactory is refused while already building, and no command goes back to Vision (pass 5: Vision stays open, Pause stops building)", () => {
    expect(() => startFactoryAsOwner(seed(), at(0))).toThrow(/Already building/);
    expect(() => runCommand(seed(), "startVision", {}, at(0))).toThrow("Unknown command startVision");
  });
});

describe("S3 planning is off while shaping; messages are still answered", () => {
  it("leadDue: planning is due while building, never while shaping; a message wakes the lead in both", () => {
    const on = autopilot(seed());
    expect(M.leadDue(on, T0 + 60 * 60_000, 12 * 60)).toBe("planning");
    const s = shaping(on);
    expect(M.leadDue(s, T0 + 60 * 60_000, 12 * 60)).toBeNull();
    expect(M.leadDue(s, T0 + 24 * 60 * 60_000, 12 * 60)).toBeNull();
    expect(M.leadDue(M.postMessage(s, "hello", at(1)), T0 + 60 * 60_000, 12 * 60)).toBe("message");
  });
});

describe("S4 vision drafts are validated strictly and never apply by themselves", () => {
  it("a message run's draft is recorded as an open suggestion linked to the run and messages; the vision is unchanged", () => {
    const { state: s, message, draft: d, runId } = leadReply(shaping(seed()), { vision: draft() });
    expect(vision(s).rev).toBe(1);
    expect(d).toMatchObject({ id: `vd-${runId}`, leadRunId: runId, text: "Problem: notes are slow.\nFor: daily writers.\nGoals: fast capture.", focus: "Fast capture first", reason: "From what you said about speed.", basedOnVisionRev: 1, status: "open" });
    expect(d!.messageIds).toEqual([s.conversation.find((m) => m.author === "user")!.id]);
    expect(message.visionDraftId).toBe(d!.id);
    expect(message.rejected).toBeUndefined();
    expect(M.openVisionDraft(s)).toBe(d);
  });

  it("only runs that answer the user may draft: a planning run's draft is rejected with a reason", () => {
    expect(M.validateVisionDraft(seed(), planningRun, draft())).toEqual({ ok: false, why: "planning runs cannot draft the vision" });
    const { state: s, message } = leadReply(autopilot(seed()), { vision: draft(), proposals: [proposal()] }, { message: false });
    expect(s.visionDrafts).toEqual([]);
    expect(message.rejected).toEqual(["Vision draft: planning runs cannot draft the vision"]);
    expect(s.tasks.some((t) => t.specs[0].author === "lead" && t.id !== "EX-003" && t.createdAt === at(3))).toBe(true); // its proposal still counts
  });

  it("malformed and oversized drafts are rejected with a reason; the vision is untouched", () => {
    const s = seed();
    const why = (v: unknown) => {
      const r = M.validateVisionDraft(s, messageRun, v);
      return r.ok ? "ok" : r.why;
    };
    expect(why("just text")).toBe("the draft was not an object");
    expect(why(["a"])).toBe("the draft was not an object");
    expect(why({ focus: "f" })).toBe("the draft needs a text");
    expect(why({ text: 42 })).toBe("the draft needs a text");
    expect(why({ text: "   \n " })).toBe("the text is empty");
    expect(why({ text: "x".repeat(8001) })).toBe("the text is over 8000 characters");
    expect(why({ text: "x".repeat(8000) })).toBe("ok");
    expect(why({ text: "fine", focus: 7 })).toBe("the focus must be text");
    expect(why({ text: "fine", focus: "f".repeat(301) })).toBe("the focus is over 300 characters");
    expect(why({ text: "fine", focus: "f".repeat(300) })).toBe("ok");
    expect(why({ text: "fine", reason: {} })).toBe("the reason must be text");
    expect(why({ text: s.project.visions[0].text, focus: s.project.visions[0].focus })).toBe("the draft is the same as the current vision");
    const { state: after, message } = leadReply(shaping(s), { vision: { text: 1 } });
    expect(after.visionDrafts).toEqual([]);
    expect(message.rejected).toEqual(["Vision draft: the draft needs a text"]);
    expect(vision(after).rev).toBe(1);
  });

  it("control characters are removed; the text keeps its newlines and the focus becomes one line; the reason is capped", () => {
    const r = M.validateVisionDraft(seed(), messageRun, { text: "A\u0000b\r\nsecond\u0007 line\n\n  ", focus: "one\nline\u001b here  ", reason: `${"r".repeat(600)}\nx` });
    expect(r).toEqual({ ok: true, draft: { text: "Ab\nsecond line", focus: "one line here", reason: "r".repeat(500) } });
    const noFocus = M.validateVisionDraft(seed(), messageRun, { text: "new text" });
    expect(noFocus).toMatchObject({ ok: true, draft: { focus: seed().project.visions[0].focus, reason: "Drafted from your messages" } });
  });

  it("a newer draft supersedes an open one; a repeated completion records nothing twice", () => {
    const first = leadReply(shaping(seed()), { vision: draft() });
    const second = leadReply(first.state, { vision: draft({ focus: "Second focus" }) }, { message: "more detail" });
    expect(second.state.visionDrafts.map((d) => d.status)).toEqual(["superseded", "open"]);
    expect(second.state.visionDrafts[0].resolvedAt).toBe(at(3));
    expect(M.openVisionDraft(second.state)!.focus).toBe("Second focus");
    const again = M.completeLeadRun(second.state, second.runId, { reply: "dup", proposals: [], vision: draft({ focus: "Third" }) }, at(9));
    expect(again.visionDrafts).toHaveLength(2);
    expect(again.conversation.filter((m) => m.author === "lead")).toHaveLength(2);
  });

  it("a draft is taken from a message run while building too, as a suggestion on the vision card", () => {
    const { state: s, draft: d } = leadReply(seed(), { vision: draft() });
    expect(d?.status).toBe("open");
    expect(vision(s).rev).toBe(1);
  });
});

describe("S5 accept and dismiss", () => {
  it("accepting creates a user-authored revision that records the draft; compare-and-set on the vision", () => {
    const { state: s, draft: d } = leadReply(shaping(seed()), { vision: draft() });
    expect(() => M.acceptVisionDraft(s, d!.id, 2, undefined, at(4))).toThrow(StaleWriteError);
    const accepted = M.acceptVisionDraft(s, d!.id, 1, undefined, at(4));
    expect(vision(accepted)).toMatchObject({ rev: 2, author: "user", text: d!.text, focus: d!.focus, source: { draftId: d!.id, leadRunId: d!.leadRunId, messageIds: d!.messageIds } });
    expect(vision(accepted).reason).toMatch(/^Accepted the lead's draft \(vd-/);
    expect(accepted.visionDrafts[0]).toMatchObject({ status: "accepted", visionRev: 2, resolvedAt: at(4) });
    expect(M.openVisionDraft(accepted)).toBeUndefined();
    expect(() => M.acceptVisionDraft(accepted, d!.id, 2, undefined, at(5))).toThrow(/already accepted/);
    expect(() => M.dismissVisionDraft(accepted, d!.id, at(5))).toThrow(/already accepted/);
    expect(() => M.acceptVisionDraft(accepted, "vd-none", 2, undefined, at(5))).toThrow(ControlError);
  });

  it("edit and accept keeps the user's text and focus as typed (newlines normalized, one-line focus) and capped; an empty edit is refused", () => {
    const { state: s, draft: d } = leadReply(shaping(seed()), { vision: draft() });
    // The user's own text is never altered: joiners, marks and variation selectors stay.
    const edited = M.acceptVisionDraft(s, d!.id, 1, { text: "My own words ‏שלום\r\nline two \u{1F468}‍\u{1F469}", focus: "  my\nfocus می‌خ " }, at(4));
    expect(vision(edited)).toMatchObject({ rev: 2, author: "user", text: "My own words ‏שלום\nline two \u{1F468}‍\u{1F469}", focus: "my focus می‌خ" });
    expect(vision(edited).reason).toMatch(/^Accepted the lead's draft with edits/);
    expect(() => M.acceptVisionDraft(s, d!.id, 1, { text: "  " }, at(4))).toThrow(/cannot be empty/);
    expect(() => M.acceptVisionDraft(s, d!.id, 1, { text: "x".repeat(8001) }, at(4))).toThrow(/8000/);
    expect(() => M.acceptVisionDraft(s, d!.id, 1, { focus: "f".repeat(301) }, at(4))).toThrow(/300/);
    // Only the focus edited: the draft's text stands.
    expect(vision(M.acceptVisionDraft(s, d!.id, 1, { focus: "just focus" }, at(4)))).toMatchObject({ text: d!.text, focus: "just focus" });
  });

  it("dismissing leaves the vision unchanged and closes the draft; the lead's next envelope sees it through the state", () => {
    const { state: s, draft: d } = leadReply(shaping(seed()), { vision: draft() });
    const dismissed = M.dismissVisionDraft(s, d!.id, at(4));
    expect(vision(dismissed).rev).toBe(1);
    expect(dismissed.visionDrafts[0]).toMatchObject({ status: "dismissed", resolvedAt: at(4) });
    expect(M.openVisionDraft(dismissed)).toBeUndefined();
    expect(() => M.dismissVisionDraft(dismissed, d!.id, at(5))).toThrow(/already dismissed/);
    expect(() => M.acceptVisionDraft(dismissed, d!.id, 1, undefined, at(5))).toThrow(/was dismissed/);
  });
});

describe("S6 the roadmap and Start building", () => {
  it("proposals made while shaping are held and marked, even on Autopilot; while building they start as usual", () => {
    const { state: s } = leadReply(shaping(autopilot(seed())), { proposals: [proposal()] });
    const [t] = M.roadmapTasks(s);
    // The roadmap's hold is its own flag; the hold before start follows the involvement setting (Autopilot: none).
    expect(t).toMatchObject({ heldForShaping: true, holdBeforeStart: false, fromShaping: true, lifecycle: "proposed" });
    const promoted = M.dispatchEligible(M.leadPromoteProposals(s, at(4)), at(4));
    expect(task(promoted, t.id).lifecycle).toBe("ready");
    expect(M.stateLabel(promoted, task(promoted, t.id))).toBe("Planned; waits until you start building, then starts on Autopilot");
    expect(running(promoted, t.id)).toHaveLength(0);
    // Even while building, a task still under the roadmap hold never dispatches: only Start building lifts it.
    const forced = { ...promoted, project: { ...promoted.project, stage: "building" as const } };
    expect(running(M.dispatchEligible(forced, at(5)), t.id)).toHaveLength(0);
    const { state: b } = leadReply(autopilot(seed()), { proposals: [proposal()] });
    const made = b.tasks.find((x) => x.createdAt === at(3))!;
    expect(made.holdBeforeStart).toBe(false);
    expect(made.fromShaping).toBeUndefined();
    expect(M.roadmapTasks(b)).toEqual([]);
  });

  it("Start building is refused with an empty vision, and says why", () => {
    const s = M.initProject(quiet(), { name: "N", repoPath: "/tmp/n", vision: "", focus: "" }, at(0));
    expect(M.startFactoryBlocker(s)).toBe("Write or accept a vision first.");
    expect(() => startFactoryAsOwner(s, at(1))).toThrow(/Write or accept a vision first/);
    expect(s.project.stage).toBe("shaping");
    const { state: drafted, draft: d } = leadReply(s, { vision: draft() });
    expect(() => startFactoryAsOwner(drafted, at(2))).toThrow(/vision first/); // a draft is not a vision
    const accepted = M.acceptVisionDraft(drafted, d!.id, 1, undefined, at(3));
    expect(M.startFactoryBlocker(accepted)).toBeUndefined();
    expect(startFactoryAsOwner(accepted, at(4)).project.stage).toBe("building");
  });

  it("Start building releases the roadmap on Autopilot only; with check-in or manual it keeps waiting", () => {
    const plan = (s: State) => leadReply(s, { proposals: [proposal({ title: "Roadmap A", priority: 1 }), proposal({ title: "Roadmap B", priority: 2 })] }).state;
    const onAuto = startFactoryAsOwner(plan(shaping(autopilot(seed()))), at(5));
    for (const t of onAuto.tasks.filter((x) => x.fromShaping)) expect(t.holdBeforeStart).toBe(false);
    expect(M.roadmapTasks(onAuto).map((t) => M.currentSpec(t).content.title)).toEqual(["Roadmap A", "Roadmap B"]);
    // The roadmap tasks themselves are among what runs, not merely more runs than before
    // (the sample's two active runs plus both roadmap tasks need four worker slots).
    const roadmapIds = M.roadmapTasks(onAuto).map((t) => t.id);
    const runningIds = running(M.dispatchEligible(M.leadPromoteProposals(M.setWorkerLimit(onAuto, 5, at(6)), at(6)), at(6))).map((a) => a.taskId);
    expect(runningIds).toEqual(expect.arrayContaining(roadmapIds));
    // Check-in: planning is on, but lead proposals wait for the user.
    const onCheckin = startFactoryAsOwner(plan(shaping(checkin(seed()))), at(5));
    for (const t of onCheckin.tasks.filter((x) => x.fromShaping)) expect(t.holdBeforeStart).toBe(true);
    // Manual: autonomy off.
    const manual = startFactoryAsOwner(plan(shaping(roomy(seed()))), at(5));
    for (const t of manual.tasks.filter((x) => x.fromShaping)) expect(t.holdBeforeStart).toBe(true);
    expect(manual.project.stage).toBe("building");
    // Choosing Autopilot afterwards does not release what already waits; the user releases it (as today).
    const later = autopilot(manual);
    for (const t of later.tasks.filter((x) => x.fromShaping)) expect(t.holdBeforeStart).toBe(true);
    const started = M.startHeldTask(later, M.roadmapTasks(later)[0].id, at(7));
    expect(M.roadmapTasks(later)[0].holdBeforeStart).toBe(true);
    expect(task(started, M.roadmapTasks(later)[0].id).holdBeforeStart).toBe(false);
  });

  it("a roadmap task the user started by hand while shaping still waits for Start building", () => {
    const { state: s } = leadReply(shaping(autopilot(seed())), { proposals: [proposal()] });
    const id = M.roadmapTasks(s)[0].id;
    const released = M.dispatchEligible(M.leadPromoteProposals(M.startHeldTask(s, id, at(4)), at(4)), at(4));
    expect(task(released, id).holdBeforeStart).toBe(false);
    expect(running(released, id)).toHaveLength(0);
    expect(M.stateLabel(released, task(released, id))).toBe("Ready (shaping)");
  });
});

describe("S8 coverage and questions", () => {
  const q = (over: Record<string, unknown> = {}) => ({ question: "Who is this for first?", why: "The first users decide the first milestone.", area: "audience", options: ["Just you", "A small team"], ...over });
  const cov = (over: Record<string, unknown> = {}) => ({ intent: "clear", audience: "partial", problem: "clear", outcome: "open", scope: "partial", constraints: "open", risks: "open", priorities: "open", material: "open", ...over });

  it("coverage: only known areas and states are kept; the rest is ignored with a note; planning runs cannot report it", () => {
    expect(M.validateCoverage(planningRun, cov())).toEqual({ ok: false, notes: ["planning runs cannot report coverage"] });
    expect(M.validateCoverage(messageRun, "clear")).toEqual({ ok: false, notes: ["the coverage block was not an object"] });
    expect(M.validateCoverage(messageRun, ["intent"])).toEqual({ ok: false, notes: ["the coverage block was not an object"] });
    const r = M.validateCoverage(messageRun, { ...cov(), budget: "clear", risks: "done", scope: 3, "\u0000evil\nkey": "open" });
    expect(r).toEqual({
      ok: true,
      coverage: { intent: "clear", audience: "partial", problem: "clear", outcome: "open", constraints: "open", priorities: "open", material: "open" },
      notes: ['scope: "number" is not clear, partial or open; ignored', 'risks: "done" is not clear, partial or open; ignored', 'unknown area "budget" ignored', 'unknown area "evil key" ignored'],
    });
  });

  it("questions: at most 5, with caps on the question, why and options, control characters removed; bad entries are left out with a note", () => {
    expect(M.validateQuestions(planningRun, [q()])).toEqual({ questions: [], notes: ["planning runs cannot ask the user"] });
    expect(M.validateQuestions(messageRun, { question: "x" })).toEqual({ questions: [], notes: ["the questions block was not a list"] });
    const six = M.validateQuestions(messageRun, [q(), q(), q(), q(), q(), q({ question: "sixth" })]);
    expect(six.questions).toHaveLength(5);
    expect(six.notes).toEqual(["1 more ignored: at most 5 questions in one reply"]);
    const r = M.validateQuestions(messageRun, [
      q({ question: "Who\u0000 is it\nfor?  ", why: "  because\u0007\n reasons " }),
      "not an object",
      { why: "no question" },
      q({ question: "q".repeat(301) }),
      q({ why: "w".repeat(201) }),
    ]);
    expect(r.questions).toEqual([{ question: "Who is it for?", why: "because reasons", area: "audience", options: ["Just you", "A small team"] }]);
    expect(r.notes).toEqual(["#2 ignored: not an object", "#3 ignored: the question must be text", "#4 ignored: the question is over 300 characters", "#5 ignored: why is over 200 characters"]);
    const opts = M.validateQuestions(messageRun, [q({ area: "budget", options: ["a", "b", "c", "d", "e"] }), q({ options: "a, b" }), q({ options: [1, "x".repeat(121), "ok\u0000"] }), q({ why: null, options: [] })]);
    expect(opts.questions.map((x) => [x.area, x.options])).toEqual([
      [undefined, ["a", "b", "c", "d"]],
      ["audience", undefined],
      ["audience", ["ok"]],
      ["audience", undefined],
    ]);
    expect(opts.questions[3].why).toBe("");
    expect(opts.notes).toEqual(["#1: unknown area ignored", "#1: 1 more option(s) ignored: at most 4", "#2: options ignored: not a list", "#3: an option was ignored: not text", "#3: an option was ignored: over 120 characters"]);
  });

  it("a shaping reply carrying a draft, questions and coverage together is stored: the draft open, the questions on the reply, the coverage on the run; the vision unchanged", () => {
    const { state: s, message, runId, draft: d } = leadReply(shaping(seed()), { vision: draft(), coverage: cov(), questions: [q(), q({ question: "How will you know it worked?", area: "outcome", options: undefined })] });
    expect(d?.status).toBe("open");
    expect(vision(s).rev).toBe(1);
    expect(message.visionDraftId).toBe(d!.id);
    expect(message.questions).toEqual([
      { question: "Who is this for first?", why: "The first users decide the first milestone.", area: "audience", options: ["Just you", "A small team"] },
      { question: "How will you know it worked?", why: "The first users decide the first milestone.", area: "outcome" },
    ]);
    expect(message.rejected).toBeUndefined();
    expect(s.leadRuns.find((r) => r.id === runId)!.coverage).toEqual(cov());
    expect(M.coverageOf(s)).toEqual(cov());
    expect(M.openAreas(s)).toEqual(["outcome", "constraints", "risks", "priorities", "material"]);
    expect(M.latestQuestions(s)).toEqual({ message, questions: message.questions });
    // The user writes back: the questions are no longer the ones to answer inline; a later reply's coverage stands.
    const answered = M.postMessage(s, "Just me. I use it daily.", at(5));
    expect(M.latestQuestions(answered)).toBeUndefined();
    const next = leadReply(answered, { coverage: { intent: "clear", audience: "clear" }, questions: [] }, { message: false });
    expect(next.state.leadRuns[next.state.leadRuns.length - 1].messageIds).toHaveLength(1); // the pending answer makes it a message run
    expect(M.coverageOf(next.state)).toEqual({ intent: "clear", audience: "clear", problem: "open", outcome: "open", scope: "open", constraints: "open", risks: "open", priorities: "open", material: "open" });
  });

  it("unreadable coverage and questions are noted under the reply, and a planning run's are refused; nothing else is affected", () => {
    const { state: s, message } = leadReply(shaping(seed()), { coverage: { budget: "clear", intent: "clear" }, questions: [q(), 5] });
    expect(message.rejected).toEqual(['Coverage: unknown area "budget" ignored', "Questions: #2 ignored: not an object"]);
    expect(message.questions).toHaveLength(1);
    expect(M.coverageOf(s)?.intent).toBe("clear");
    const planning = leadReply(autopilot(seed()), { coverage: cov(), questions: [q()] }, { message: false });
    expect(planning.message.rejected).toEqual(["Coverage: planning runs cannot report coverage", "Questions: planning runs cannot ask the user"]);
    expect(planning.message.questions).toBeUndefined();
    expect(planning.state.leadRuns[planning.state.leadRuns.length - 1].coverage).toBeUndefined();
    expect(M.coverageOf(planning.state)).toBeUndefined();
  });

  it("the inline answers become one message: each answered question followed by its answer; unanswered ones are skipped", () => {
    const qs = [q(), q({ question: "How will you know it worked?" }), q({ question: "What must it not do?" })] as unknown as LeadQuestion[];
    expect(M.answersMessage(qs, ["Just you", "  ", "No sync"])).toBe("Q: Who is this for first?\nA: Just you\n\nQ: What must it not do?\nA: No sync");
    expect(M.answersMessage(qs, ["", "", ""])).toBe("");
    expect(M.answersMessage(qs, ["only one"])).toBe("Q: Who is this for first?\nA: only one");
    const s = M.postMessage(shaping(seed()), M.answersMessage(qs, ["Just you", "", "No sync"]), at(1));
    expect(s.conversation.filter((m) => m.author === "user")).toHaveLength(1);
  });

  it("open areas are named but never block Start building; only the empty vision blocks", () => {
    const { state: s } = leadReply(shaping(seed()), { coverage: cov() });
    expect(M.openAreas(s)).toHaveLength(5);
    expect(M.startFactoryBlocker(s)).toBeUndefined();
    expect(startFactoryAsOwner(s, at(5)).project.stage).toBe("building");
    const empty = leadReply(M.initProject(quiet(), { name: "N", repoPath: "/tmp/n", vision: "", focus: "" }, at(0)), { coverage: cov({ outcome: "clear", constraints: "clear", risks: "clear", priorities: "clear", material: "clear" }) });
    expect(M.openAreas(empty.state)).toEqual([]);
    expect(M.startFactoryBlocker(empty.state)).toBe("Write or accept a vision first.");
  });
});

describe("S7 steering still works while shaping", () => {
  it("a message run's focus change applies and its proposal is held as roadmap", () => {
    const { state: s } = leadReply(shaping(roomy(seed())), { steer: { focus: "Local first", reason: "you asked", tasks: [] }, proposals: [proposal()] });
    expect(vision(s)).toMatchObject({ rev: 2, author: "lead", focus: "Local first" });
    expect(s.steering[0].changes).toEqual([expect.objectContaining({ kind: "focus", status: "applied" })]);
    expect(M.roadmapTasks(s)).toHaveLength(1);
    // The draft, if any, is based on the revision the lead saw, and shown against the current one by the UI.
    const { state: s2, draft: d } = leadReply(s, { vision: draft() }, { message: "and the vision?" });
    expect(d!.basedOnVisionRev).toBe(2);
    expect(vision(s2).rev).toBe(2);
  });
});
