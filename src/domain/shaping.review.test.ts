// ORC-012 review findings, domain level. The roadmap's hold is its own flag and Start building never
// overrides the user's hold (2); a draft records the revision the run saw (3); Edit and accept is
// compare-and-set on the draft and the revision (4); invisible characters are stripped everywhere the
// lead writes and from document names (5); no empty vision while building (6); coverage: none reported
// is all open, an empty block keeps the previous one, an earlier session's is not reused (8); a no-op
// accept is refused (9); repeated options are dropped (10); a dependency wait is shown while shaping (13).

import { describe, expect, it } from "vitest";
import * as M from "./model";
import { buildEmptyProject, buildSeed } from "./seed";
import { SHAPING_AREAS, StaleWriteError, type LeadRun, type State } from "./types";

const T0 = Date.parse("2026-09-30T12:00:00Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const seed = () => buildSeed(T0, { inFlightRuns: false });
const task = (s: State, id: string) => s.tasks.find((t) => t.id === id)!;
const running = (s: State, id?: string) => M.activeAttempts(s, id);
const shaping = (s: State) => M.startShaping(s, at(0));
const roomy = (s: State) => M.setAutonomy(s, { ...s.project.autonomy, maxOpenProposals: 50 }, at(0));
const autopilot = (s: State) => M.setAutonomy(s, { ...s.project.autonomy, enabled: true, holdLeadProposals: false, maxOpenProposals: 50 }, at(0));
const checkin = (s: State) => M.setAutonomy(s, { ...s.project.autonomy, enabled: true, holdLeadProposals: true, maxOpenProposals: 50 }, at(0));
const promote = (s: State, t = 4) => M.dispatchEligible(M.leadPromoteProposals(s, at(t)), at(t));

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
    patternId: "change",
    priority: 2,
    ...over,
  };
}
const draft = (over: Record<string, unknown> = {}) => ({ text: "Problem: notes are slow.\nFor: daily writers.\nGoals: fast capture.", focus: "Fast capture first", reason: "From what you said about speed.", ...over });

/** Post a message at `t`, start a run at `t + 1` and complete it at `t + 2` with the given reply. */
function leadReply(s: State, out: { vision?: unknown; proposals?: M.LeadProposal[]; steer?: unknown; coverage?: unknown; questions?: unknown }, t = 1) {
  const posted = M.postMessage(s, "I want fast note capture; deployment can wait", at(t));
  const r = M.startLeadRun(posted, { provider: "claude", model: "m", trigger: "message" }, at(t + 1));
  const state = M.completeLeadRun(r.state, r.runId, { reply: "ok", proposals: out.proposals ?? [], steer: out.steer, vision: out.vision, coverage: out.coverage, questions: out.questions }, at(t + 2));
  const message = state.conversation.filter((m) => m.author === "lead").pop()!;
  return { state, runId: r.runId, message, draft: state.visionDrafts.find((d) => d.leadRunId === r.runId) };
}
const messageRun: LeadRun = { id: "lead-x", trigger: "message", provider: "claude", model: "m", startedAt: at(0), outcome: "running", messageIds: ["msg-1"], visionRev: 1 };

describe("review 2: the roadmap hold is its own flag", () => {
  it("Start building lifts only the roadmap hold; a hold the user set stands; the involvement setting decides the rest", () => {
    const { state: s } = leadReply(shaping(autopilot(seed())), { proposals: [proposal({ title: "A" }), proposal({ title: "B" })] });
    const [a, b] = M.roadmapTasks(s);
    expect(a).toMatchObject({ heldForShaping: true, holdBeforeStart: false, fromShaping: true });
    // The user holds A before start: that takes it out of the roadmap hold, and the choice is the user's from then on.
    const held = M.setHoldBeforeStart(s, a.id, true, at(4));
    expect(task(held, a.id)).toMatchObject({ holdBeforeStart: true });
    expect(task(held, a.id).heldForShaping).toBeUndefined();
    expect(held.events.at(-2)!.message).toMatch(/No longer held by the roadmap/);
    const p = promote(held);
    expect(M.stateLabel(p, task(p, a.id))).toBe("Held before start");
    expect(M.stateLabel(p, task(p, b.id))).toBe("Planned; waits until you start building, then starts on Autopilot");
    const built = M.startBuilding(p, at(5));
    expect(task(built, a.id).holdBeforeStart).toBe(true); // never overridden
    expect(task(built, b.id)).toMatchObject({ holdBeforeStart: false });
    expect(task(built, b.id).heldForShaping).toBeUndefined();
    const ran = promote(built, 6);
    expect(running(ran).map((x) => x.taskId)).toContain(b.id);
    expect(running(ran, a.id)).toHaveLength(0);
    expect(M.stateLabel(ran, task(ran, a.id))).toBe("Held before start");
  });

  it("with check-in the roadmap carries both holds and says so; releasing by hand takes it out of the roadmap hold and still waits for Start building", () => {
    const { state: c } = leadReply(shaping(checkin(seed())), { proposals: [proposal()] });
    const [t] = M.roadmapTasks(c);
    expect(t).toMatchObject({ heldForShaping: true, holdBeforeStart: true });
    const p = promote(c);
    expect(M.stateLabel(p, task(p, t.id))).toBe("Planned; waits until you start building, then waits for your release (your involvement setting)");
    const started = M.startHeldTask(p, t.id, at(5));
    expect(task(started, t.id).holdBeforeStart).toBe(false);
    expect(task(started, t.id).heldForShaping).toBeUndefined();
    expect(started.events.at(-1)!.message).toMatch(/once you start building/);
    expect(running(promote(started, 6), t.id)).toHaveLength(0); // the stage still holds it
    const built = M.startBuilding(started, at(7));
    expect(task(built, t.id).holdBeforeStart).toBe(false); // the user's release stands, whatever the involvement setting
    expect(running(promote(built, 8), t.id)).toHaveLength(1);
    // Untouched roadmap tasks under check-in or manual wait for the user after Start building, as before.
    const { state: m } = leadReply(shaping(roomy(seed())), { proposals: [proposal()] });
    const [mt] = M.roadmapTasks(m);
    expect(mt).toMatchObject({ heldForShaping: true, holdBeforeStart: true });
    const mb = M.startBuilding(m, at(5));
    expect(task(mb, mt.id)).toMatchObject({ holdBeforeStart: true });
    expect(task(mb, mt.id).heldForShaping).toBeUndefined();
    expect(mb.events.some((e) => e.taskId === mt.id && /waits for your release/.test(e.message))).toBe(true);
  });
});

describe("review 3: a draft records the revision the run saw", () => {
  it("the vision moving while the lead worked shows as moved: basedOnVisionRev is the run's, not the one current at completion", () => {
    const posted = M.postMessage(shaping(seed()), "draft it", at(1));
    const r = M.startLeadRun(posted, { provider: "claude", model: "m", trigger: "message" }, at(2));
    expect(r.state.leadRuns.at(-1)!.visionRev).toBe(1);
    const moved = M.editVision(r.state, 1, "Edited meanwhile", "f", "edit", at(3));
    const done = M.completeLeadRun(moved, r.runId, { reply: "ok", proposals: [], vision: draft() }, at(4));
    expect(M.currentVision(done).rev).toBe(2);
    expect(M.openVisionDraft(done)).toMatchObject({ basedOnVisionRev: 1 });
    // Accepting against what the user saw (r1) is refused; against r2 it records the draft.
    expect(() => M.acceptVisionDraft(done, M.openVisionDraft(done)!.id, 1, undefined, at(5))).toThrow(StaleWriteError);
    expect(M.currentVision(M.acceptVisionDraft(done, M.openVisionDraft(done)!.id, 2, undefined, at(5))).rev).toBe(3);
  });
});

describe("review 4: Edit and accept is compare-and-set", () => {
  it("a replaced, dismissed or accepted draft is refused with its reason, and so is a moved vision; the right revision accepts the edits", () => {
    const first = leadReply(shaping(seed()), { vision: draft({ focus: "One" }) });
    const second = leadReply(first.state, { vision: draft({ focus: "Two" }) }, 5);
    expect(first.state.visionDrafts[0].status).toBe("open");
    expect(second.state.visionDrafts.map((d) => d.status)).toEqual(["superseded", "open"]);
    expect(() => M.acceptVisionDraft(second.state, first.draft!.id, 1, { text: "my words" }, at(9))).toThrow("A newer draft replaced this one.");
    expect(() => M.acceptVisionDraft(second.state, second.draft!.id, 7, { text: "my words" }, at(9))).toThrow(StaleWriteError);
    const dismissed = M.dismissVisionDraft(second.state, second.draft!.id, at(9));
    expect(() => M.acceptVisionDraft(dismissed, second.draft!.id, 1, { text: "my words" }, at(10))).toThrow("This draft was dismissed.");
    const accepted = M.acceptVisionDraft(second.state, second.draft!.id, 1, undefined, at(9));
    expect(() => M.acceptVisionDraft(accepted, second.draft!.id, 2, { text: "again" }, at(10))).toThrow("This draft was already accepted.");
    const moved = M.editVision(second.state, 1, "Moved", "m", "why", at(9));
    expect(() => M.acceptVisionDraft(moved, second.draft!.id, 1, { text: "mine" }, at(10))).toThrow(StaleWriteError);
    const ok = M.acceptVisionDraft(moved, second.draft!.id, 2, { text: "mine" }, at(10));
    expect(M.currentVision(ok)).toMatchObject({ rev: 3, text: "mine", author: "user", source: { draftId: second.draft!.id } });
  });
});

describe("review 5: invisible characters", () => {
  const zw = "​‌‍﻿⁠";
  const bidi = "‪‮⁦⁩";
  const tags = "\u{E0001}\u{E0041}\u{E007F}";
  const c1 = "\u0085\u009F";
  const junk = zw + bidi + tags + c1;

  it("are stripped from drafts, questions and options; a repeated option is one option; text of only invisibles is empty", () => {
    const { draft: d, message } = leadReply(shaping(seed()), {
      vision: { text: `Problem${junk}: slow${junk}`, focus: `Fast${bidi} capture`, reason: `re${zw}ason` },
      questions: [{ question: `Who${zw}?`, why: `w${bidi}hy`, options: [`A${zw}`, "A", junk, `B${tags}`] }],
    });
    expect(d).toMatchObject({ text: "Problem: slow", focus: "Fast capture", reason: "reason" });
    expect(message.questions).toEqual([{ question: "Who?", why: "why", options: ["A", "B"] }]);
    expect(message.rejected).toEqual(["Questions: #1: a repeated option was ignored", "Questions: #1: an option was ignored: not text"]);
    const empty = leadReply(shaping(seed()), { vision: { text: `${junk} \n ${zw}`, focus: junk } });
    expect(empty.draft).toBeUndefined();
    expect(empty.message.rejected).toEqual(["Vision draft: the text is empty"]);
    expect(M.validateQuestions(messageRun, [{ question: "Q?", options: ["A", "A", "B", "B"] }])).toEqual({ questions: [{ question: "Q?", why: "", options: ["A", "B"] }], notes: ["#1: a repeated option was ignored", "#1: a repeated option was ignored"] });
    expect(M.validateQuestions(messageRun, [{ question: junk }])).toEqual({ questions: [], notes: ["#1 ignored: the question must be text"] });
  });

  it("are stripped from steering text; a focus of only invisibles is rejected as empty", () => {
    const st = leadReply(roomy(seed()), { steer: { reason: `be${zw}cause`, focus: `Ship${bidi} it`, tasks: [{ id: "EX-003", priority: 2, why: `w${tags}hy${c1}` }] } });
    expect(M.currentVision(st.state)).toMatchObject({ author: "lead", focus: "Ship it", reason: "because" });
    const set = st.state.steering.at(-1)!;
    expect(set.reason).toBe("because");
    expect(set.changes.find((c) => c.taskId === "EX-003")!.why).toBe("why");
    const only = leadReply(roomy(seed()), { steer: { focus: `${zw}${bidi}`, reason: "x" } });
    expect(M.currentVision(only.state).rev).toBe(1);
    expect(only.state.steering.at(-1)!.changes[0]).toMatchObject({ kind: "focus", status: "rejected", note: "focus must be 1–500 characters" });
  });

  it("a document name carrying them is refused, never altered (ORC-014 review 3)", () => {
    const refused = { ok: false, why: "The name contains invisible or bidirectional control characters." };
    expect(M.visionDocPath(`docs/${zw}brief${bidi}.md`)).toEqual(refused);
    expect(M.visionDocPath(`a/${zw}/b${tags}.md`)).toEqual(refused);
    expect(M.visionDocPath(junk)).toEqual(refused);
    expect(M.visionDocPath(` ${zw} `)).toEqual(refused);
    expect(M.visionDocPath("docs/brief.md")).toEqual({ ok: true, path: "docs/brief.md" });
    expect(M.stripInvisible(`a${junk}b`)).toBe("ab");
    expect(M.stripInvisible("héllo — wörld")).toBe("héllo — wörld"); // visible text is untouched
  });
});

describe("review 6: no empty vision while building", () => {
  it("an empty project of your own starts by shaping; clearing the vision is refused while building and allowed while shaping", () => {
    const empty = buildEmptyProject(T0);
    expect(empty.project.stage).toBe("shaping");
    expect(empty.project.shapingSince).toBe(at(0));
    expect(M.currentVision(empty).text).toBe("");
    expect(M.startBuildingBlocker(empty)).toBe("Write or accept a vision first.");
    expect(seed().project.stage).toBe("building"); // the sample keeps working as before
    expect(() => M.editVision(seed(), 1, "   ", "f", "clear", at(1))).toThrow("The vision cannot be empty while building. Go back to shaping to clear it.");
    expect(M.currentVision(seed()).rev).toBe(1);
    const cleared = M.editVision(shaping(seed()), 1, "", "", "clear", at(1));
    expect(M.currentVision(cleared)).toMatchObject({ rev: 2, text: "" });
    expect(() => M.startBuilding(cleared, at(2))).toThrow(/Write or accept a vision first/);
    // A real edit while building is unaffected.
    expect(M.currentVision(M.editVision(seed(), 1, "New", "f", "why", at(1))).text).toBe("New");
  });
});

describe("review 8: coverage", () => {
  it("none reported means every area is open; a block with no valid entry keeps the previous coverage; a new shaping session starts from nothing", () => {
    const s0 = shaping(seed());
    expect(M.coverageOf(s0)).toBeUndefined();
    expect(M.openAreas(s0)).toEqual(SHAPING_AREAS);
    const first = leadReply(s0, { coverage: { intent: "clear", scope: "partial" } });
    expect(M.openAreas(first.state)).toEqual(SHAPING_AREAS.filter((a) => a !== "intent" && a !== "scope"));
    const empty = leadReply(first.state, { coverage: { bogus: "clear", intent: "maybe" } }, 5);
    expect(empty.message.rejected).toEqual(['Coverage: unknown area "bogus" ignored', 'Coverage: intent: "maybe" is not clear, partial or open; ignored', "Coverage: no valid entries; the previous coverage stands"]);
    expect(empty.state.leadRuns.at(-1)!.coverage).toBeUndefined();
    expect(M.coverageOf(empty.state)).toEqual(M.coverageOf(first.state));
    expect(M.openAreas(empty.state)).toEqual(M.openAreas(first.state));
    // An earlier session's coverage is not reused once the user starts building and comes back to shaping.
    const built = M.startBuilding(M.editVision(empty.state, 1, "Vision", "f", "w", at(9)), at(10));
    const again = M.startShaping(built, at(11));
    expect(again.project.shapingSince).toBe(at(11));
    expect(M.coverageOf(again)).toBeUndefined();
    expect(M.openAreas(again)).toEqual(SHAPING_AREAS);
    const fresh = leadReply(again, { coverage: { audience: "clear" } }, 12);
    expect(M.coverageOf(fresh.state)).toMatchObject({ audience: "clear", intent: "open", scope: "open" });
    // The order of the notes above matters less than this: nothing from the first session leaked through.
    expect(M.openAreas(fresh.state)).toEqual(SHAPING_AREAS.filter((a) => a !== "audience"));
  });
});

describe("review 9 and 13", () => {
  it("accepting edits identical to the current vision is refused; a real change is recorded", () => {
    const { state: s, draft: d } = leadReply(shaping(seed()), { vision: draft() });
    const cur = M.currentVision(s);
    expect(() => M.acceptVisionDraft(s, d!.id, cur.rev, { text: cur.text, focus: cur.focus }, at(5))).toThrow("Nothing differs from the current vision; change the text or dismiss the draft.");
    expect(s.visionDrafts[0].status).toBe("open");
    expect(M.currentVision(M.acceptVisionDraft(s, d!.id, cur.rev, { text: cur.text, focus: "Changed" }, at(5)))).toMatchObject({ rev: 2, focus: "Changed" });
  });

  it("a dependency wait is shown while shaping, with shaping noted, before the stage's own label", () => {
    const s = shaping(seed());
    expect(M.stateLabel(s, task(s, "EX-007"))).toBe("Waiting on EX-002 (shaping)");
    const ready = { ...s, tasks: s.tasks.map((t) => (t.id === "EX-007" ? { ...t, lifecycle: "ready" as const } : t)) };
    expect(M.stateLabel(ready, task(ready, "EX-007"))).toBe("Waiting on EX-002 (shaping)");
    expect(M.stateLabel(seed(), task(seed(), "EX-007"))).toBe("Waiting on EX-002");
    const free = { ...ready, tasks: ready.tasks.map((t) => (t.id === "EX-007" ? { ...t, dependsOn: [] } : t)) };
    expect(M.stateLabel(free, task(free, "EX-007"))).toBe("Ready (shaping)");
  });
});
