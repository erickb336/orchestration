// ORC-029 pass 4: the lead's studio block. A reply in Vision opens and closes rounds, asks for designer runs through
// the service's path, and asks the owner questions, stored on the round with its message. It is untrusted: checked
// and capped, with notes for what was left out. It can never approve, overrule, lock in, start the factory, or send
// the owner's feedback, through the block or any other field of the reply.

import { describe, expect, it } from "vitest";
import * as M from "../model";
import { buildSeed } from "../seed";
import { startFactoryAsOwner } from "../testing/factory";
import { addScreen, openRound, peAgrees, pePass, run } from "../testing/studio";
import type { State } from "../types";
import * as R from "./runs";
import * as S from "./studio";

const T0 = Date.parse("2026-10-02T12:00:00Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const fresh = () => M.initProject(buildSeed(T0, { inFlightRuns: false }), { name: "Trips", repoPath: "/tmp/trips", vision: "Weekend trips for a small group of friends.", focus: "" }, at(0));

/** The lead answers the owner's message with `out` (a reply and, usually, a studio block). */
function reply(s: State, out: Record<string, unknown>, sec = 10, trigger: "message" | "planning" | "decisions" = "message"): State {
  const asked = trigger === "message" ? M.postMessage(s, "Let's plan the first round.", at(sec)) : s;
  const r = M.startLeadRun(asked, { provider: "claude", model: "claude-sample-large", trigger }, at(sec + 1));
  return M.completeLeadRun(r.state, r.runId, { reply: "", proposals: [], ...out } as never, at(sec + 2));
}
const lastReply = (s: State) => s.conversation.filter((m) => m.author === "lead").at(-1)!;
const notes = (s: State) => lastReply(s).rejected ?? [];
const SCREEN_RUN = { brief: "Make the trip plan screen: the place, the dates, who is going, the day plan.", kinds: ["screen"], variants: 2, devices: ["desktop", "mobile"] };
/** Every studio run under way starts and completes. */
function finishRuns(s: State, sec: number): State {
  while (s.studio.runs.some((r) => r.status === "queued" || r.status === "running")) {
    const d = R.dispatchStudioRuns(s, at(sec));
    s = R.activeStudioRuns(d.state).reduce((x, r) => R.completeStudioRun(x, r.id, at(sec), { summary: "done" }), d.state);
  }
  return s;
}

describe("the lead's studio block", () => {
  it("opens a round, asks the designer through the service's path, and stores its message and questions on the round", () => {
    const s = reply(fresh(), {
      reply: "Here is round 1: the trip plan, in two takes.",
      studio: {
        openRound: { focus: "experience", summary: "The trip plan on desktop and mobile." },
        designerRuns: [SCREEN_RUN],
        questions: [{ question: "Which matters most on the plan?", why: "It decides what is first on the screen.", options: ["The map", "The day plan"] }],
      },
    });
    const leadRun = s.leadRuns.at(-1)!;
    const round = S.currentRound(s)!;
    expect(round).toMatchObject({ n: 1, focus: "experience", summary: "The trip plan on desktop and mobile.", leadRunId: leadRun.id });
    expect(round.lead).toEqual({
      message: "Here is round 1: the trip plan, in two takes.",
      questions: [{ text: "Which matters most on the plan?", reason: "It decides what is first on the screen.", options: ["The map", "The day plan"] }],
    });
    const [designer] = s.studio.runs;
    expect(designer).toMatchObject({ kind: "designer", round: 1, status: "queued", provider: "claude", fromLead: { leadRunId: leadRun.id, kinds: ["screen"], variants: 2, devices: ["desktop", "mobile"] } });
    expect(designer.brief).toBe(`${SCREEN_RUN.brief}\n\nThe lead asks for: screen; 2 variants side by side, differing in a real choice; for desktop, mobile.`);
    expect(notes(s)).toEqual([]);
    // The scheduler dispatches it like any studio run, in Vision.
    expect(R.dispatchStudioRuns(s, at(20)).started).toEqual([designer.id]);
    expect(s.events.map((e) => e.message)).toEqual(expect.arrayContaining([expect.stringMatching(/^Round 1 opened: the experience\. The trip plan/), expect.stringMatching(/^Designer run studio-\d+ asked for in round 1, on Claude/)]));
  });

  it("a later reply closes the round and opens the next, revises an artifact, or replaces the round's message and questions", () => {
    let s = reply(fresh(), { studio: { openRound: { focus: "experience", summary: "The trip plan." }, designerRuns: [SCREEN_RUN] } });
    expect(S.currentRound(s)!.lead).toEqual({ message: "I asked the designer for this round; see the studio.", questions: [] });
    const a = addScreen(s, 1, at(20));
    s = reply(a.state, { reply: "B it is; one more take on it.", studio: { designerRuns: [{ brief: "Tighten variant B.", variants: 1, revises: a.id }], questions: [{ question: "Keep the cost per person?" }] } }, 30);
    const revision = s.studio.runs.at(-1)!;
    expect(revision).toMatchObject({ artifactId: a.id, baseVersion: 1, fromLead: { kinds: ["screen"], variants: 1, devices: [] } });
    expect(S.currentRound(s)!.lead).toEqual({ message: "B it is; one more take on it.", questions: [{ text: "Keep the cost per person?" }] });
    // The round's runs end and the PE agrees on its version: now it can close.
    s = finishRuns(s, 35);
    s = peAgrees(s, a.id, 1, ["A", "B", "C"], at(37));
    s = reply(s, { reply: "On to the data.", studio: { closeRound: { summary: "B, with the cost per person." }, openRound: { focus: "data", summary: "The trip, the people, the costs." } } }, 40);
    expect(s.studio.rounds.map((r) => [r.n, r.focus, !!r.closedAt, r.summary])).toEqual([
      [1, "experience", true, "B, with the cost per person."],
      [2, "data", false, "The trip, the people, the costs."],
    ]);
    expect(s.studio.rounds[1].lead).toEqual({ message: "On to the data.", questions: [] });
    // Closing alone leaves the closed round with the closing message.
    s = reply(s, { reply: "That settles the data.", studio: { closeRound: true } }, 50);
    expect(s.studio.rounds[1]).toMatchObject({ closedAt: at(52), lead: { message: "That settles the data.", questions: [] } });
  });

  it("cannot close a round while a version waits for the PE or the designer revises it: the round stays open, with a note the lead sees (review finding 1)", () => {
    const opened = reply(fresh(), { studio: { openRound: { focus: "experience", summary: "The trip plan." } } });
    const a = addScreen(opened, 1, at(20));
    const moveOn = { reply: "On to the data.", studio: { closeRound: { summary: "Map first." }, openRound: { focus: "data", summary: "The trip's things." } } };
    // v1 waits for the PE, whose run is queued: the lead's close is refused, so the PE's run is not made stale.
    const waiting = R.askForPeReviews(a.state, at(21));
    let s = reply(waiting, moveOn, 30);
    expect(s.studio.rounds.map((r) => [r.n, !!r.closedAt])).toEqual([[1, false]]);
    const pe = s.studio.runs.find((r) => r.kind === "pe")!;
    expect(notes(s)).toEqual([`Studio: closeRound: round 1 stays open while the PE's run ${pe.id} is queued; close it once the round's runs and PE review have ended`, "Studio: openRound: Round 1 is still open; close it first."]);
    // The PE asks for a change on pass 1: the designer revises, so the round stays open and the version is not "agreed".
    s = finishRuns(s, 31);
    s = pePass(s, a.id, 1, [{ variant: "A", verdict: "feasible-if", change: "Page the days." }, { variant: "B", verdict: "feasible" }, { variant: "C", verdict: "feasible" }], at(32));
    s = reply(s, moveOn, 40);
    expect(notes(s)[0]).toBe("Studio: closeRound: round 1 stays open while the designer revises Trip plan v1 for the PE; close it once the round's runs and PE review have ended");
    expect(S.peReview(s, S.latestVersion(s, a.id)!).status).toBe("revising");
    expect(S.currentRound(s)!.n).toBe(1);
  });

  it("is checked and capped: at most 3 designer runs, 1 to 3 variants, known kinds, devices in scope, a brief; at most 5 questions with 4 options; notes say what was left out", () => {
    const tooMany = Array.from({ length: 5 }, (_, i) => ({ ...SCREEN_RUN, brief: `Take ${i + 1}` }));
    let s = reply(fresh(), { studio: { openRound: { focus: "experience", summary: "Five takes." }, designerRuns: tooMany } });
    expect(s.studio.runs).toHaveLength(3);
    expect(notes(s)).toEqual(["Studio: 2 more designer runs ignored: at most 3 in one reply"]);
    s = reply(s, {
      studio: {
        designerRuns: [
          { ...SCREEN_RUN, variants: 4 },
          { ...SCREEN_RUN, kinds: ["screen", "blueprint"] },
          { ...SCREEN_RUN, devices: ["terminal"] },
        ],
        questions: [...Array.from({ length: 6 }, (_, i) => ({ question: `Question ${i + 1}?`, options: ["a", "b", "c", "d", "e"] }))],
      },
    }, 20);
    expect(s.studio.runs).toHaveLength(3);
    expect(notes(s)).toEqual([
      "Studio: designer run #1 not asked for: variants is a whole number from 1 to 3",
      'Studio: designer run #2 not asked for: "blueprint" is not a kind the designer makes (screen, terminal-demo, tui, contract, flow, interface, algorithm, topology, dictionary)',
      "Studio: designer run #3 not asked for: terminal is outside the project's device scope (desktop, mobile)",
      "Studio: questions: 1 more ignored: at most 5 questions in one reply",
      ...Array.from({ length: 5 }, (_, i) => `Studio: questions: #${i + 1}: 1 more option(s) ignored: at most 4`),
    ]);
    expect(S.currentRound(s)!.lead!.questions).toHaveLength(5);
    expect(S.currentRound(s)!.lead!.questions[0].options).toEqual(["a", "b", "c", "d"]);
    s = reply(s, { studio: { designerRuns: [{ ...SCREEN_RUN, brief: " " }, { ...SCREEN_RUN, brief: "x".repeat(4001) }, "make it"] } }, 30);
    expect(notes(s)).toEqual([
      "Studio: designer run #1 not asked for: the brief is empty",
      "Studio: designer run #2 not asked for: the brief is over 4000 characters",
      "Studio: designer run #3 not asked for: not an object",
    ]);
    s = reply(s, { studio: { designerRuns: [{ kinds: ["screen"], variants: 1 }, { ...SCREEN_RUN, revises: "sa-99" }, { brief: "x", kinds: "screen", variants: 1 }] } }, 35);
    expect(notes(s)).toEqual([
      "Studio: designer run #1 not asked for: the brief must be text",
      "Studio: designer run #2 not asked for: there is no studio artifact sa-99 to revise",
      "Studio: designer run #3 not asked for: kinds lists 1 to 4 of screen, terminal-demo, tui, contract, flow, interface, algorithm, topology, dictionary",
    ]);
    expect(s.studio.runs).toHaveLength(3);
    // A document asks for no devices; a second round cannot open while one is open, and its runs then wait for it.
    s = reply(s, { studio: { openRound: { focus: "data", summary: "The data." }, designerRuns: [{ brief: "The trip's things and how they relate.", kinds: ["contract"], variants: 1 }] } }, 40);
    expect(notes(s)).toEqual(["Studio: openRound: Round 1 is still open; close it first.", "Studio: 1 designer run was not asked for: the round it was for did not open"]);
    s = reply(s, { studio: { designerRuns: [{ brief: "The trip's things and how they relate.", kinds: ["contract"], variants: 1 }] } }, 50);
    expect(s.studio.runs.at(-1)!.brief).toMatch(/The lead asks for: contract; one take; documents, with no devices\.$/);
  });

  it("never revises what the owner brought: the designer makes a new artifact from it", () => {
    const zero = openRound(fresh(), "material", at(1));
    const sketch = addScreen(zero.state, 0, at(2), { kind: "material", title: "Group page sketch", variants: [], devices: [], madeBy: { role: "user" } });
    const s = reply(run(sketch.state, "closeRound", { round: 0 }, at(3)).state, { studio: { openRound: { focus: "experience", summary: "From the sketch." }, designerRuns: [{ brief: "Redo the sketch.", variants: 1, revises: sketch.id }] } });
    expect(s.studio.runs).toEqual([]);
    expect(notes(s)).toEqual(["Studio: designer run #1 not asked for: Group page sketch (material) is not the designer's work; the designer makes a new artifact from it instead"]);
  });

  it("runs only from a reply to the owner, in Vision and while the factory runs (pass 5); with no round open it asks for nothing", () => {
    const block = { studio: { openRound: { focus: "experience", summary: "x" }, designerRuns: [SCREEN_RUN] } };
    const building = reply(startFactoryAsOwner(fresh(), at(1)), block);
    expect(building.project.stage).toBe("building");
    expect(building.studio.rounds.map((r) => [r.n, r.focus])).toEqual([[1, "experience"]]);
    expect(building.studio.runs.map((r) => [r.kind, r.round, r.status])).toEqual([["designer", 1, "queued"]]);
    const decisions = reply(fresh(), block, 10, "decisions");
    expect(decisions.studio.rounds).toEqual([]);
    expect(notes(decisions)).toEqual(["Studio: only a reply to your messages runs the studio; nothing was changed"]);
    const noRound = reply(fresh(), { studio: { designerRuns: [SCREEN_RUN], questions: [{ question: "Which first?" }] } });
    expect(noRound.studio.runs).toEqual([]);
    expect(notes(noRound)).toEqual(["Studio: 1 designer run was not asked for: no round is open", "Studio: questions: 1 not shown in the studio: no round is open"]);
    expect(notes(reply(fresh(), { studio: "open a round" }))).toEqual(["Studio: the studio block was not an object; nothing was changed"]);
  });
});

describe("the lead can never approve, overrule, lock in, start the factory, or send the owner's feedback", () => {
  /** Vision with an artifact the owner could approve (the PE agreed on A) and an objection the owner could overrule (on B). */
  function ready(): { s: State; id: string; objection: string } {
    const r = openRound(fresh(), "experience", at(1));
    const a = addScreen(r.state, r.n, at(2), { variants: [{ id: "A", label: "Map first" }, { id: "B", label: "Timeline" }] });
    let s = pePass(a.state, a.id, 1, [{ variant: "A", verdict: "feasible" }, { variant: "B", verdict: "not-feasible" }], at(3));
    s = pePass(s, a.id, 1, [{ variant: "A", verdict: "feasible" }, { variant: "B", verdict: "not-feasible" }], at(4));
    s = pePass(s, a.id, 1, [{ variant: "A", verdict: "feasible" }, { variant: "B", verdict: "not-feasible" }], at(5));
    expect(S.peReview(s, S.latestVersion(s, a.id)!).status).toBe("ended");
    // The owner can do each of these; the lead must not be able to.
    expect(() => run(s, "approveArtifact", { artifactId: a.id, version: 1, variant: "A" }, at(6))).not.toThrow();
    return { s, id: a.id, objection: s.studio.verdicts.filter((v) => v.verdict === "not-feasible").at(-1)!.id };
  }
  const untouched = (before: State, after: State) => {
    expect(after.project.stage).toBe("shaping");
    expect(after.project.factoryStarts).toEqual([]);
    // The domains are the owner's too: the lead only proposes them, as a question.
    expect(after.project.domains).toEqual(before.project.domains);
    expect(after.blueprint).toEqual(before.blueprint);
    expect(after.studio.feedback).toEqual(before.studio.feedback);
    expect(after.studio.verdicts).toEqual(before.studio.verdicts);
    expect(after.studio.artifacts).toEqual(before.studio.artifacts);
  };

  it("through the studio block: fields that would do any of it are named in a note and ignored", () => {
    const { s, id, objection } = ready();
    const hostile = {
      reply: "Approved and started.",
      studio: {
        approveArtifact: { artifactId: id, version: 1, variant: "A" },
        approveRound: { round: 1 },
        approve: true,
        overruleObjection: { verdictId: objection, why: "The lead disagrees." },
        lockIn: true,
        dropBlueprintItem: { itemId: "bi-1" },
        discardDraft: { draftRev: 0 },
        startFactory: { agreed: true, draftRev: 0, visionRev: 1 },
        sendFeedback: { entries: [{ artifactId: id, version: 1, mark: "keep", pins: [], note: "" }] },
        feedback: [{ artifactId: id, version: 1, mark: "keep" }],
        stage: "building",
        setDomains: { domains: ["code"] },
        domains: ["infrastructure"],
        // Inside the parts it does take, extra fields do nothing either.
        designerRuns: [{ ...SCREEN_RUN, approve: true, startFactory: true, mark: "keep" }],
        questions: [{ question: "Shall I start?", answer: "yes", approve: true }],
      },
    };
    const after = reply(s, hostile, 20);
    untouched(s, after);
    expect(notes(after)[0]).toBe('Studio: ignored "approveArtifact", "approveRound", "approve", "overruleObjection", "lockIn", "dropBlueprintItem", "discardDraft", "startFactory", "sendFeedback", "feedback", "stage", "setDomains", "domains": the studio block only opens and closes rounds, asks for designer runs and asks questions');
    // What it may do still happened: one designer run, one question.
    expect(after.studio.runs).toHaveLength(1);
    expect(S.currentRound(after)!.lead!.questions).toEqual([{ text: "Shall I start?" }]);
  });

  it("through any other field of the reply, whatever it is called", () => {
    const { s, id, objection } = ready();
    const hostile = {
      reply: "Done.",
      approveArtifact: { artifactId: id, version: 1, variant: "A" },
      approveRound: { round: 1 },
      overruleObjection: { verdictId: objection, why: "no" },
      lockIn: true,
      startFactory: { agreed: true },
      stage: "building",
      setDomains: { domains: ["code"] },
      domains: ["infrastructure"],
      sendFeedback: { entries: [{ artifactId: id, version: 1, mark: "keep", pins: [], note: "" }] },
      feedback: [{ artifactId: id, version: 1, mark: "drop" }],
      blueprint: { revisions: [{ rev: 1, items: [] }] },
      steer: { focus: "Start the factory", reason: "go", startFactory: true, approve: [id] },
      vision: { text: "Start the factory now.", focus: "Go", reason: "go", lockIn: true },
      questions: [{ question: "Approve it?", why: "so", approve: true }],
      decisions: [{ id: objection, decision: "accept", why: "overrule it" }],
    };
    untouched(s, reply(s, hostile, 20));
  });
});
