// ORC-029 2c, the studio: rounds, artifacts and their versions, the owner's feedback, PE review with its loop rule,
// the owner's overrule, and probes. Driven through the command table, as the owner and the service will send them.

import { describe, expect, it } from "vitest";
import { InvalidCommandError, runCommand } from "../commands";
import * as M from "../model";
import { buildSeed } from "../seed";
import { startFactoryAsOwner } from "../testing/factory";
import { ABC, DESIGNER, addScreen, feedback, openRound, peAgrees, pePass, run, sha } from "../testing/studio";
import { ControlError, StaleWriteError, type State } from "../types";
import * as R from "./runs";
import * as S from "./studio";

const T0 = Date.parse("2026-10-01T12:00:00Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const fresh = () => M.initProject(buildSeed(T0, { inFlightRuns: false }), { name: "Trips", repoPath: "/tmp/trips", vision: "Weekend trips for a small group of friends.", focus: "" }, at(0));
const failure = (fn: () => unknown): Error => {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a refusal");
};
const art = (s: State, id: string, version: number) => S.getArtifact(s, id, version);
/** Round 1 (the experience) with the Trip plan screen in three variants. */
function tripPlan() {
  const r = openRound(fresh(), "experience", at(1));
  const a = addScreen(r.state, r.n, at(2));
  return { s: a.state, id: a.id };
}
/** The next round: the open one closed, a new one opened. */
function nextRound(s: State, sec: number, focus = "experience") {
  const cur = S.currentRound(s)!;
  return openRound(runCommand(s, "closeRound", { round: cur.n }, at(sec)).state, focus, at(sec));
}

describe("as it is today: round 0 of an existing repository (pass 4)", () => {
  const asIs = (over: Record<string, unknown> = {}) => ({ title: "Trip list (as is)", variants: [{ id: "a", label: "As it is today", entry: "a/index.html" }], files: [{ path: "a/index.html", sha256: sha("a") }], provenance: { files: ["src/TripList.tsx", "src/trips.css"] }, ...over });

  it("holds the designer's reproductions of the code, labelled as is with the repository files they came from, which the PE reviews", () => {
    const zero = openRound(fresh(), "material", at(1));
    expect(zero.n).toBe(0);
    const a = addScreen(zero.state, 0, at(2), asIs({ provenance: { files: ["src/TripList.tsx", "src/trips.css", "src/TripList.tsx"] } }));
    const v1 = art(a.state, a.id, 1);
    expect(v1).toMatchObject({ round: 0, kind: "screen", provenance: { asIs: true, files: ["src/TripList.tsx", "src/trips.css"] } });
    expect(a.state.events.at(-1)!.message).toBe("Trip list (as is) v1 added to round 0, by the designer (claude); as is, from 2 repository files");
    // Not what the owner brought: the PE reviews it before the owner sees it.
    expect(S.readyForOwner(a.state, v1)).toBe(false);
    const agreed = peAgrees(a.state, a.id, 1, ["a"], at(3));
    expect(S.readyForOwner(agreed, art(agreed, a.id, 1))).toBe(true);
    // A correction in round 0 is still as is, with its provenance; a later round's revision is a proposal and has none.
    const v2 = addScreen(agreed, 0, at(4), asIs({ artifactId: a.id, provenance: { files: ["src/TripList.tsx"] } }));
    expect(art(v2.state, a.id, 2).provenance).toEqual({ asIs: true, files: ["src/TripList.tsx"] });
    const later = openRound(run(v2.state, "closeRound", { round: 0 }, at(5)).state, "experience", at(6));
    const v3 = addScreen(later.state, later.n, at(7), { artifactId: a.id });
    expect(art(v3.state, a.id, 3).provenance).toBeUndefined();
  });

  it("a reproduction is not revised for the PE: what the PE says of its faithfulness goes to the owner at once (review finding 5)", () => {
    const zero = openRound(fresh(), "material", at(1));
    const a = addScreen(zero.state, 0, at(2), asIs());
    const s = pePass(a.state, a.id, 1, [{ verdict: "feasible-if", reasons: "The list matches the code.", change: "The code sorts trips by date; the reproduction does not." }], at(3));
    const v1 = art(s, a.id, 1);
    expect(S.peReview(s, v1)).toMatchObject({ status: "ended", ended: "as-is", pass: 1, objections: [], asks: [{ change: "The code sorts trips by date; the reproduction does not." }] });
    expect(S.revisionDue(s, v1)).toBe(false);
    expect(S.readyForOwner(s, v1)).toBe(true);
    expect(s.events.at(-1)!.message).toBe(
      "PE review of Trip list (as is) v1, pass 1: feasible if changed; review ended: it reproduces the code as it is today, and the designer does not revise a reproduction for the PE; it goes to the owner with the changes the PE asks for",
    );
    // The owner corrects it: a mark, and the round can close.
    expect(S.currentFeedback(feedback(s, a.id, 1, { mark: "change", note: "Sort by date, as the code does." }, at(4)), a.id, 1)?.mark).toBe("change");
    expect(S.roundBusy(s, 0)).toBeUndefined();
  });

  it("refuses as-is artifacts anywhere else, from anyone else, and provenance that is not a path in the repository", () => {
    const zero = openRound(fresh(), "material", at(1));
    const outside = "Only the designer's reproductions of the existing code in round 0 (as it is today) are labelled as is.";
    expect(() => addScreen(zero.state, 0, at(2), asIs({ kind: "material", madeBy: { role: "user" } }))).toThrow(outside);
    expect(() => addScreen(zero.state, 0, at(2), asIs({ madeBy: { ...DESIGNER, role: "probe" } }))).toThrow(/Round 0 holds what already exists/);
    const one = openRound(fresh(), "experience", at(1));
    expect(() => addScreen(one.state, 1, at(2), asIs())).toThrow(outside);
    for (const path of ["../secrets.txt", "/etc/passwd", "src//a.ts", "src\\a.ts", "./a.ts", "a\u0007.ts", ""]) {
      expect(() => addScreen(zero.state, 0, at(2), asIs({ provenance: { files: [path] } }))).toThrow(/is not a file path inside the repository/);
    }
    expect(() => addScreen(zero.state, 0, at(2), asIs({ provenance: { files: [] } }))).toThrow("An as-is artifact names between 1 and 50 repository files it came from.");
    expect(() => addScreen(zero.state, 0, at(2), asIs({ provenance: { files: Array.from({ length: 51 }, (_, i) => `src/f${i}.ts`) } }))).toThrow(/between 1 and 50/);
    expect(() => addScreen(zero.state, 0, at(2), asIs({ provenance: ["src/a.ts"] }))).toThrow(InvalidCommandError);
  });
});

describe("rounds", () => {
  it("round 0 is what the owner brought; the lead's rounds count from 1; one is open at a time", () => {
    let s = fresh();
    const zero = openRound(s, "material", at(1));
    expect(zero.n).toBe(0);
    expect(() => openRound(zero.state, "experience", at(2))).toThrow("Round 0 is still open; close it first.");
    s = run(zero.state, "closeRound", { round: 0, summary: "A sketch of the group page and the old CLI's help." }, at(3)).state;
    const one = openRound(s, "experience", at(4));
    expect(one.n).toBe(1);
    s = run(one.state, "closeRound", { round: 1 }, at(5)).state;
    expect(() => run(s, "closeRound", { round: 1 }, at(6))).toThrow("Round 1 is already closed.");
    expect(() => openRound(s, "material", at(6))).toThrow(/What the owner brought is round 0/);
    const two = openRound(s, "data", at(7));
    expect(two.state.studio.rounds).toEqual([
      { n: 0, focus: "material", openedAt: at(1), closedAt: at(3), summary: "A sketch of the group page and the old CLI's help." },
      { n: 1, focus: "experience", openedAt: at(4), closedAt: at(5), summary: "" },
      { n: 2, focus: "data", openedAt: at(7), summary: "" },
    ]);
    expect(S.currentRound(two.state)?.n).toBe(2);
    // Without anything brought, the lead's first round is round 1.
    expect(openRound(fresh(), "experience", at(1)).n).toBe(1);
    expect(() => openRound(fresh(), "tablets", at(1))).toThrow(InvalidCommandError);
  });
});

describe("artifacts and their versions", () => {
  it("a new version keeps the artifact's id and kind and starts with the owner's open pins; a pin the owner leaves out is resolved", () => {
    let { s, id } = tripPlan();
    expect(art(s, id, 1)).toMatchObject({ id, round: 1, version: 1, kind: "screen", title: "Trip plan", variants: ABC, devices: ["desktop", "mobile"], madeBy: DESIGNER, at: at(2) });
    s = peAgrees(s, id, 1, ["A", "B", "C"], at(3));
    const pins = [
      { x: 0.25, y: 0.1, variant: "B", text: "Make the weather easier to see." },
      { x: 0.5, y: 0.9, text: "Where does the map go on a phone?" },
    ];
    s = feedback(s, id, 1, { mark: "change", pickedVariant: "B", pins, note: "Prefer B on phones." }, at(4));
    const r2 = nextRound(s, 5);
    const v2 = addScreen(r2.state, r2.n, at(6), { artifactId: id });
    expect(v2).toMatchObject({ id, version: 2 });
    s = v2.state;
    expect(S.currentFeedback(s, id, 2)).toEqual({ artifactId: id, version: 2, mark: null, pins, note: "", at: at(6), carriedFrom: 1 });
    expect(s.events.at(-1)?.message).toBe("Trip plan v2 added to round 2, by the designer (claude); 3 variants; 2 open pins carried from v1");
    // The owner keeps one pin open on v2; v3 carries only that one.
    s = peAgrees(s, id, 2, ["A", "B", "C"], at(7));
    s = feedback(s, id, 2, { mark: "change", pins: [pins[0]] }, at(8));
    expect(S.openPins(s, id, 2)).toEqual([pins[0]]);
    // v3 drops variant B: the pin stays, on the artifact as a whole.
    s = addScreen(nextRound(s, 9).state, 3, at(10), { artifactId: id, variants: [ABC[0], ABC[2]] }).state;
    expect(S.openPins(s, id, 3)).toEqual([{ x: 0.25, y: 0.1, text: "Make the weather easier to see." }]);
    // A new version keeps the kind and does not go back to an earlier round.
    expect(() => addScreen(s, 3, at(11), { artifactId: id, kind: "flow" })).toThrow("Trip plan is a screen; a new version keeps its kind.");
    expect(() => addScreen(s, 1, at(11), { artifactId: id })).toThrow(/cannot belong to an earlier round/);
  });

  it("checks what is stored: round 0 holds what already exists, devices within the scope, files inside the workspace with their hashes, one id per variant", () => {
    let s = openRound(fresh(), "material", at(1)).state;
    expect(() => addScreen(s, 0, at(2))).toThrow("Round 0 holds what already exists: what the owner brought (material), and the designer's reproductions of the existing code, labelled as is with the repository files they came from.");
    const brought = addScreen(s, 0, at(2), { kind: "material", title: "Group page sketch", variants: [], devices: [], madeBy: { role: "user" } });
    expect(brought.state.events.at(-1)).toMatchObject({ actor: "user", message: "Group page sketch v1 added to round 0, you brought" });
    s = openRound(run(brought.state, "closeRound", { round: 0 }, at(3)).state, "experience", at(4)).state;
    expect(() => addScreen(s, 1, at(5), { devices: ["terminal"] })).toThrow("terminal is outside the project's device scope (desktop, mobile).");
    for (const path of ["../outside.html", "/etc/passwd", "a//b.html", "a\\b.html", "./a.html"]) {
      expect(() => addScreen(s, 1, at(5), { files: [{ path, sha256: sha("a") }] })).toThrow(/is not a file path inside the studio workspace/);
    }
    expect(() => addScreen(s, 1, at(5), { files: [{ path: "a.html", sha256: "abc" }] })).toThrow(/64 lowercase hex/);
    expect(() => addScreen(s, 1, at(5), { files: [] })).toThrow(/between 1 and 100 files/);
    expect(() => addScreen(s, 1, at(5), { variants: [{ id: "A", label: "One" }, { id: "A", label: "Two" }] })).toThrow("Each variant has its own id.");
    expect(() => addScreen(s, 1, at(5), { madeBy: { role: "designer", provider: "gemini", model: "m", attemptId: "r" } })).toThrow(InvalidCommandError);
    expect(() => addScreen(s, 2, at(5))).toThrow("There is no round 2.");
  });

  it("each variant records the entry file the designer named, which must be one of its files", () => {
    const s = openRound(fresh(), "experience", at(1)).state;
    const files = [
      { path: "a/index.html", sha256: sha("a") },
      { path: "b/plan.html", sha256: sha("b") },
    ];
    const variants = [
      { id: "a", label: "Map first", entry: "a/index.html" },
      { id: "b", label: "Day by day", entry: "b/plan.html" },
    ];
    const r = addScreen(s, 1, at(2), { variants, files });
    expect(art(r.state, r.id, 1).variants).toEqual(variants);
    expect(() => addScreen(s, 1, at(2), { variants: [{ id: "a", label: "Map first", entry: "a/missing.html" }], files })).toThrow('Variant a\'s entry "a/missing.html" is not one of the artifact\'s files.');
  });
});

describe("PE review: the loop rule", () => {
  it("a pass that asks for a change or objects sends the version back to the designer; it reaches the owner once the PE finds every variant feasible", () => {
    let { s, id } = tripPlan();
    expect(S.peReview(s, art(s, id, 1))).toEqual({ status: "waiting", passes: 0 });
    expect(S.readyForOwner(s, art(s, id, 1))).toBe(false);
    expect(S.revisionDue(s, art(s, id, 1))).toBe(false);
    expect(() => feedback(s, id, 1, { mark: "keep" }, at(3))).toThrow("Trip plan v1 is still in PE review; it reaches you once the PE agrees or its review ends.");
    s = pePass(s, id, 1, [{ variant: "A", verdict: "feasible-if" }, { variant: "B", verdict: "not-feasible", reasons: "Hourly forecasts for every trailhead cost too much." }, { variant: "C", verdict: "feasible" }], at(3));
    const one = S.peReview(s, art(s, id, 1));
    expect(one).toMatchObject({ status: "revising", pass: 1 });
    expect(one.status === "revising" && one.asks.map((v) => v.variant)).toEqual(["A"]);
    expect(S.openObjections(s, art(s, id, 1)).map((v) => [v.variant, v.reasons])).toEqual([["B", "Hourly forecasts for every trailhead cost too much."]]);
    expect(S.readyForOwner(s, art(s, id, 1))).toBe(false);
    expect(S.revisionDue(s, art(s, id, 1))).toBe(true);
    expect(s.events.at(-1)?.message).toBe("PE review of Trip plan v1, pass 1: Map first feasible if changed, Timeline not feasible, Day cards feasible; the designer revises");
    // The designer revises in the same round; the PE's second pass still asks for a change: the designer revises again.
    s = addScreen(s, 1, at(4), { artifactId: id }).state;
    expect(S.peReview(s, art(s, id, 2))).toEqual({ status: "waiting", passes: 1 });
    expect(S.revisionDue(s, art(s, id, 1))).toBe(false);
    s = pePass(s, id, 2, [{ variant: "A", verdict: "feasible-if" }, { variant: "B", verdict: "feasible" }, { variant: "C", verdict: "feasible" }], at(5));
    expect(S.peReview(s, art(s, id, 2))).toMatchObject({ status: "revising", pass: 2, objections: [], asks: [expect.objectContaining({ variant: "A" })] });
    expect(S.readyForOwner(s, art(s, id, 2))).toBe(false);
    // The third version is feasible throughout: it goes to the owner.
    s = addScreen(s, 1, at(6), { artifactId: id }).state;
    s = peAgrees(s, id, 3, ["A", "B", "C"], at(7));
    expect(S.peReview(s, art(s, id, 3))).toEqual({ status: "agreed", pass: 3 });
    expect(s.events.at(-1)?.message).toBe("PE review of Trip plan v3, pass 3: Map first feasible, Timeline feasible, Day cards feasible; agreed; it goes to the owner");
    expect(S.readyForOwner(s, art(s, id, 3))).toBe(true);
    expect(S.revisionDue(s, art(s, id, 3))).toBe(false);
    expect(S.currentFeedback(feedback(s, id, 3, { mark: "keep", pickedVariant: "A" }, at(8)), id, 3)).toMatchObject({ mark: "keep", pickedVariant: "A" });
  });

  it("a change the PE still asks for after the third pass goes to the owner with its verdict, never as agreed; with no objection left, nothing waits on an overrule", () => {
    let { s, id } = tripPlan();
    const asks = (v: number, sec: number) => pePass(s, id, v, [{ variant: "A", verdict: "feasible" }, { variant: "B", verdict: "feasible-if", change: `page the days (pass ${v})` }, { variant: "C", verdict: "feasible" }], at(sec));
    s = asks(1, 3);
    s = addScreen(s, 1, at(4), { artifactId: id }).state;
    s = asks(2, 5);
    s = addScreen(s, 1, at(6), { artifactId: id }).state;
    s = asks(3, 7);
    expect(S.peReview(s, art(s, id, 3))).toMatchObject({ status: "ended", ended: "passes", pass: 3, objections: [], asks: [{ variant: "B", change: "page the days (pass 3)" }] });
    expect(S.readyForOwner(s, art(s, id, 3))).toBe(true);
    expect(s.events.at(-1)?.message).toBe(
      "PE review of Trip plan v3, pass 3: Map first feasible, Timeline feasible if changed, Day cards feasible; review ended: the PE made its 3 passes in the round; it goes to the owner with the changes the PE asks for",
    );
    expect(S.revisionDue(s, art(s, id, 3))).toBe(false);
    // Shown, never dropped: the verdict and its change stay on the version the owner sees.
    expect(s.studio.verdicts.filter((v) => v.version === 3 && v.verdict === "feasible-if").map((v) => v.change)).toEqual(["page the days (pass 3)"]);
    expect(S.currentFeedback(feedback(s, id, 3, { mark: "keep", pickedVariant: "B" }, at(8)), id, 3)?.mark).toBe("keep");
  });

  it("after three passes the open objections go to the owner with the artifact; the round's review is over; the next round starts at pass 1", () => {
    let { s, id } = tripPlan();
    const objects = (v: number, sec: number) => pePass(s, id, v, [{ variant: "A", verdict: "feasible" }, { variant: "B", verdict: "not-feasible", reasons: `still too costly (pass ${v})` }, { variant: "C", verdict: "feasible" }], at(sec));
    s = objects(1, 3);
    s = addScreen(s, 1, at(4), { artifactId: id }).state;
    s = objects(2, 5);
    s = addScreen(s, 1, at(6), { artifactId: id }).state;
    s = objects(3, 7);
    const review = S.peReview(s, art(s, id, 3));
    expect(review).toMatchObject({ status: "ended", pass: 3, ended: "passes", asks: [] });
    expect(S.revisionDue(s, art(s, id, 3))).toBe(false);
    expect(S.readyForOwner(s, art(s, id, 3))).toBe(true);
    expect(S.openObjections(s, art(s, id, 3)).map((v) => v.reasons)).toEqual(["still too costly (pass 3)"]);
    expect(s.events.at(-1)?.message).toMatch(/; review ended: the PE made its 3 passes in the round; it goes to the owner with the objections$/);
    // Every objection stays recorded, on the version it was made on.
    expect(s.studio.verdicts.filter((v) => v.verdict === "not-feasible").map((v) => [v.version, v.pass])).toEqual([[1, 1], [2, 2], [3, 3]]);
    expect(() => objects(3, 8)).toThrow("PE review of Trip plan ended after 3 passes in round 1; it went to the owner with the open objections.");
    expect(() => addScreen(s, 1, at(8), { artifactId: id })).toThrow(/ended after 3 passes in round 1; it goes to the owner as it is/);
    // A revision answering the owner, in the next round, is reviewed afresh.
    s = addScreen(nextRound(s, 9).state, 2, at(10), { artifactId: id }).state;
    expect(S.peReview(s, art(s, id, 4))).toEqual({ status: "waiting", passes: 0 });
    expect(run(s, "addPeVerdicts", { artifactId: id, version: 4, verdicts: [{ verdict: "feasible", reasons: "One hourly source now." }] }, at(11)).result).toEqual({ pass: 1 });
  });

  it("the loop ends early when the designer's revisions fail twice or the round closes: the objections go to the owner then, never dropped; the verdicts name the PE's run", () => {
    let { s, id } = tripPlan();
    const by = { provider: "codex" as const, model: "codex-sample-large", runId: "studio-7" };
    const verdicts = [
      { variant: "A", verdict: "feasible" as const, reasons: "Fine." },
      { variant: "B", verdict: "not-feasible" as const, reasons: "Hourly forecasts for every trailhead cost too much.", change: "A forecast source with a free hourly tier." },
      { variant: "C", verdict: "feasible" as const, reasons: "Fine." },
    ];
    s = S.addPeVerdicts(s, { artifactId: id, version: 1, by, verdicts }, at(3)).state;
    expect(s.studio.verdicts.map((x) => [x.variant, x.by])).toEqual([
      ["A", by],
      ["B", by],
      ["C", by],
    ]);
    const objected = s;
    const v = () => art(s, id, 1);
    /** The designer's run revising v1, dispatched; returns its id. */
    const revision = (sec: number) => {
      const r = run<{ runId: string }>(s, "startStudioRun", { kind: "designer", round: 1, artifactId: id, brief: "Revise B for the PE." }, at(sec));
      s = R.dispatchStudioRuns(r.state, at(sec)).state;
      return r.result.runId;
    };
    // A revision under way: nothing else is due. A pause that stops it does not count; its retry runs on resume.
    const first = revision(4);
    expect(S.revisionDue(s, v())).toBe(false);
    s = R.reportStudioRunStopped(M.pauseProject(s, at(5)), first, at(6));
    s = M.resumeProject(s, at(7));
    const retry = s.studio.runs.at(-1)!;
    expect(retry).toMatchObject({ retryOf: first, status: "queued" });
    expect(S.peReview(s, v())).toMatchObject({ status: "revising" });
    s = R.reportStudioRunFailed(R.dispatchStudioRuns(s, at(8)).state, retry.id, "studio.json was refused: it lists no artifact", at(9));
    // One failure: the revision is due again. A second failure ends the loop: the objection goes to the owner.
    expect(S.revisionDue(s, v())).toBe(true);
    const second = revision(10);
    s = R.reportStudioRunFailed(s, second, "studio.json was refused: it lists no artifact", at(11));
    expect(S.peReview(s, v())).toMatchObject({ status: "ended", pass: 1, ended: "no-revision" });
    expect(S.revisionDue(s, v())).toBe(false);
    expect(S.readyForOwner(s, v())).toBe(true);
    // The owner answers: marks it, and overrules the objection with a reason, which is recorded.
    s = feedback(s, id, 1, { mark: "change", pickedVariant: "A" }, at(12));
    const objection = S.openObjections(s, v())[0];
    s = run(s, "overruleObjection", { verdictId: objection.id, why: "The group pays for the forecasts." }, at(13)).state;
    expect(S.openObjections(s, v())).toEqual([]);
    // A round closed while the PE still objects ends its loop too.
    const closed = run(objected, "closeRound", { round: 1 }, at(4)).state;
    expect(S.peReview(closed, art(closed, id, 1))).toMatchObject({ status: "ended", ended: "round-closed" });
    expect(S.revisionDue(closed, art(closed, id, 1))).toBe(false);
    // Outside Vision nothing is revised; back in Vision the loop goes on.
    expect(S.revisionDue(startFactoryAsOwner(objected, at(4)), art(objected, id, 1))).toBe(false);
  });

  it("a pass judges every option the owner will see: one verdict per variant, or one on the whole; feasible-if states its change; an estimate states its basis", () => {
    const { s, id } = tripPlan();
    const pass = (verdicts: object[]) => run(s, "addPeVerdicts", { artifactId: id, version: 1, verdicts }, at(3));
    const ok = (variant?: string) => ({ ...(variant ? { variant } : {}), verdict: "feasible", reasons: "Fine." });
    expect(() => pass([ok("A"), ok("B")])).toThrow("The pass leaves out variant C: the PE judges every option the owner will see.");
    expect(() => pass([ok("A"), ok("B"), ok("D")])).toThrow("Trip plan has no variant D.");
    expect(() => pass([ok("A"), ok("A"), ok("B"), ok("C")])).toThrow("One verdict per variant in a pass.");
    expect(() => pass([ok(), ok("A")])).toThrow("A pass is one verdict on the whole artifact, or one verdict per variant.");
    expect(() => pass([{ verdict: "feasible-if", reasons: "Only with cached tiles." }])).toThrow("Feasible-if states the change that makes it feasible.");
    expect(() => pass([{ verdict: "maybe", reasons: "?" }])).toThrow(InvalidCommandError);
    expect(() => pass([{ ...ok(), budget: { maintenanceUsdPerMonth: [40, 20], basis: "tile provider's price list" } }])).toThrow(/a range of dollars, low to high/);
    expect(() => pass([{ ...ok(), budget: { maintenanceUsdPerMonth: [20, 40] } }])).toThrow(InvalidCommandError);
    const whole = pass([{ ...ok(), budget: { maintenanceUsdPerMonth: [20, 40], basis: "the tile provider's price list, 1,000 users" } }]).state;
    expect(whole.studio.verdicts).toEqual([
      { id: expect.any(String), artifactId: id, version: 1, pass: 1, verdict: "feasible", reasons: "Fine.", budget: { maintenanceUsdPerMonth: [20, 40], basis: "the tile provider's price list, 1,000 users" }, at: at(3) },
    ]);
    expect(S.peReview(whole, art(whole, id, 1))).toEqual({ status: "agreed", pass: 1 });
    // The PE reviews the newest version only.
    const revised = addScreen(s, 1, at(4), { artifactId: id }).state;
    expect(() => pePass(revised, id, 1, [{ verdict: "feasible" }], at(5))).toThrow("Trip plan v1 was revised (v2); the PE reviews the newest version.");
  });

  it("what the owner brought and a probe's evidence are not held back for PE review", () => {
    const s = openRound(fresh(), "material", at(1)).state;
    const brought = addScreen(s, 0, at(2), { kind: "material", title: "Group page sketch", variants: [], devices: [], madeBy: { role: "user" } });
    expect(S.readyForOwner(brought.state, art(brought.state, brought.id, 1))).toBe(true);
    expect(S.currentFeedback(feedback(brought.state, brought.id, 1, { mark: "keep" }, at(3)), brought.id, 1)?.mark).toBe("keep");
  });

  it("the PE gives no verdict on what the owner brought or on a probe's evidence (review finding 9)", () => {
    const s = openRound(fresh(), "material", at(1)).state;
    const brought = addScreen(s, 0, at(2), { kind: "material", title: "Group page sketch", variants: [], devices: [], madeBy: { role: "user" } });
    expect(() => pePass(brought.state, brought.id, 1, [{ verdict: "not-feasible", reasons: "Too costly." }], at(3))).toThrow("Group page sketch is what you brought: the PE does not review it.");
    const r = nextRound(brought.state, 4);
    const evidence = addScreen(r.state, r.n, at(5), { kind: "evidence", title: "Forecast sources", variants: [], devices: [], files: [{ path: "probes/forecasts.md", sha256: sha("b") }], madeBy: { role: "probe", provider: "codex", model: "codex-sample-large", attemptId: "run-probe-1" } });
    expect(() => pePass(evidence.state, evidence.id, 1, [{ verdict: "feasible", reasons: "Fine." }], at(6))).toThrow("Forecast sources is a probe's evidence: the PE does not review it.");
    expect(evidence.state.studio.verdicts).toEqual([]);
  });
});

describe("the owner overrules an objection", () => {
  it("only an open objection they were shown, with a reason, recorded on the verdict", () => {
    let { s, id } = tripPlan();
    const objects = (v: number, sec: number) => pePass(s, id, v, [{ variant: "A", verdict: "feasible" }, { variant: "B", verdict: "not-feasible", reasons: "too costly" }, { variant: "C", verdict: "feasible" }], at(sec));
    s = objects(1, 3);
    const early = S.openObjections(s, art(s, id, 1))[0];
    expect(() => run(s, "overruleObjection", { verdictId: early.id, why: "I accept the cost." }, at(4))).toThrow("The PE is still reviewing Trip plan; it reaches you once the PE agrees or its review ends.");
    s = addScreen(s, 1, at(4), { artifactId: id }).state;
    s = objects(2, 5);
    s = addScreen(s, 1, at(6), { artifactId: id }).state;
    s = objects(3, 7);
    const objection = S.openObjections(s, art(s, id, 3))[0];
    const feasible = s.studio.verdicts.find((v) => v.version === 3 && v.variant === "A")!;
    expect(() => run(s, "overruleObjection", { verdictId: feasible.id, why: "x" }, at(8))).toThrow("Only an objection (not feasible) can be overruled.");
    expect(() => run(s, "overruleObjection", { verdictId: early.id, why: "x" }, at(8))).toThrow(/moved on since this objection/);
    expect(() => run(s, "overruleObjection", { verdictId: objection.id, why: "  " }, at(8))).toThrow("Your reason is empty.");
    s = run(s, "overruleObjection", { verdictId: objection.id, why: "The group pays for the forecasts." }, at(8)).state;
    expect(s.studio.verdicts.find((v) => v.id === objection.id)?.overruled).toEqual({ at: at(8), why: "The group pays for the forecasts." });
    expect(s.events.at(-1)).toMatchObject({ actor: "user", kind: "decision", message: "You overruled the PE's objection to Trip plan v3 (Timeline): The group pays for the forecasts." });
    expect(S.openObjections(s, art(s, id, 3))).toEqual([]);
    // Overruled, not dropped: the objection is still in the latest pass, marked.
    expect(S.peReview(s, art(s, id, 3))).toMatchObject({ status: "ended", objections: [expect.objectContaining({ id: objection.id, reasons: "too costly" })] });
    expect(() => run(s, "overruleObjection", { verdictId: objection.id, why: "again" }, at(9))).toThrow("You already overruled this objection.");
  });
});

describe("the owner's feedback", () => {
  it("one answer per artifact, on the newest version they saw; pins are fractions of the artifact; picks name a variant", () => {
    let { s, id } = tripPlan();
    s = peAgrees(s, id, 1, ["A", "B", "C"], at(3));
    const entry = (over: object) => ({ artifactId: id, version: 1, mark: "change", pins: [], note: "", ...over });
    expect(() => run(s, "sendFeedback", { entries: [] }, at(4))).toThrow("Mark, pick or pin something first.");
    expect(() => run(s, "sendFeedback", { entries: [entry({}), entry({ mark: "keep" })] }, at(4))).toThrow("Trip plan v1 appears twice; send one answer per artifact.");
    expect(() => run(s, "sendFeedback", { entries: [entry({ pins: [{ x: 1.5, y: 0.2, text: "here" }] })] }, at(4))).toThrow(/a fraction \(0 to 1\)/);
    expect(() => run(s, "sendFeedback", { entries: [entry({ pickedVariant: "D" })] }, at(4))).toThrow("Trip plan has no variant D.");
    expect(() => run(s, "sendFeedback", { entries: [entry({ mark: "maybe" })] }, at(4))).toThrow(InvalidCommandError);
    s = run(s, "sendFeedback", { entries: [entry({ pickedVariant: "B", pins: [{ x: 0.2, y: 0.3, variant: "B", text: "Bigger icons" }], note: "Prefer B on phones." })] }, at(4)).state;
    expect(s.events.at(-1)).toMatchObject({ actor: "user", kind: "vision", message: "Your feedback: Trip plan v1 (change, picked Timeline, 1 pin, a note)" });
    // A revision arrived since: an answer on v1 is stale.
    s = addScreen(nextRound(s, 5).state, 2, at(6), { artifactId: id }).state;
    expect(failure(() => run(s, "sendFeedback", { entries: [entry({ mark: "keep" })] }, at(7)))).toBeInstanceOf(StaleWriteError);
  });

  it("a pin keeps the element it is on, as the prototype described it: one line of text, capped, and carried to the next version", () => {
    let { s, id } = tripPlan();
    s = peAgrees(s, id, 1, ["A", "B", "C"], at(3));
    const pin = (selector: string) => ({ artifactId: id, version: 1, mark: null, pins: [{ x: 0.2, y: 0.3, text: "Bigger icons", selector }], note: "" });
    s = run(s, "sendFeedback", { entries: [pin("main > div.map:nth-of-type(2)")] }, at(4)).state;
    expect(S.openPins(s, id, 1)).toEqual([{ x: 0.2, y: 0.3, text: "Bigger icons", selector: "main > div.map:nth-of-type(2)" }]);
    // Untrusted text from the prototype: control characters go, and a long one is refused, not cut silently.
    const cleaned = run(s, "sendFeedback", { entries: [pin("main\u0007 > \nh1")] }, at(5)).state;
    expect(S.openPins(cleaned, id, 1)[0].selector).toBe("main > h1");
    expect(() => run(s, "sendFeedback", { entries: [pin("x".repeat(301))] }, at(5))).toThrow("A pin's element is over 300 characters.");
    // A revision starts with the open pins, elements included.
    s = addScreen(nextRound(s, 6).state, 2, at(7), { artifactId: id }).state;
    expect(S.openPins(s, id, 2)[0].selector).toBe("main > div.map:nth-of-type(2)");
  });
});

describe("probes", () => {
  it("queued, running with its run, then done with an evidence artifact or failed with the reason; nothing else", () => {
    let s = openRound(fresh(), "data", at(1)).state;
    const asked = run<{ probeId: string }>(s, "addProbe", { question: "Which forecast sources allow hourly caching offline, at what cost?" }, at(2));
    s = asked.state;
    const id = asked.result.probeId;
    expect(s.studio.probes).toEqual([{ id, askedBy: "pe", question: "Which forecast sources allow hourly caching offline, at what cost?", status: "queued", at: at(2) }]);
    expect(() => run(s, "setProbeStatus", { probeId: id, status: "done", result: "x" }, at(3))).toThrow(`Probe ${id} is queued; it cannot become done.`);
    expect(() => run(s, "setProbeStatus", { probeId: id, status: "running" }, at(3))).toThrow("A running probe names its run.");
    s = run(s, "setProbeStatus", { probeId: id, status: "running", attemptId: "run-probe-1" }, at(3)).state;
    const screen = addScreen(s, 1, at(4));
    expect(() => run(screen.state, "setProbeStatus", { probeId: id, status: "done", result: screen.id }, at(5))).toThrow("A finished probe's result is an evidence artifact in the studio.");
    const evidence = addScreen(screen.state, 1, at(5), { kind: "evidence", title: "Forecast sources", variants: [], devices: [], files: [{ path: "probes/forecasts.md", sha256: sha("b") }], madeBy: { role: "probe", provider: "codex", model: "codex-sample-large", attemptId: "run-probe-1" } });
    s = run(evidence.state, "setProbeStatus", { probeId: id, status: "done", result: evidence.id }, at(6)).state;
    expect(s.studio.probes[0]).toEqual({ id, askedBy: "pe", question: "Which forecast sources allow hourly caching offline, at what cost?", status: "done", at: at(2), attemptId: "run-probe-1", result: evidence.id });
    expect(s.events.at(-1)?.message).toBe(`Probe ${id} done: Forecast sources`);
    expect(() => run(s, "setProbeStatus", { probeId: id, status: "failed", failure: "late" }, at(7))).toThrow(`Probe ${id} is done; it cannot become failed.`);
    // A queued probe may fail before it runs, with the reason.
    const other = run<{ probeId: string }>(s, "addProbe", { question: "How many councils publish minutes?" }, at(8));
    const failed = run(other.state, "setProbeStatus", { probeId: other.result.probeId, status: "failed", failure: "No network in the sandbox." }, at(9)).state;
    expect(failed.studio.probes[1]).toMatchObject({ status: "failed", failure: "No network in the sandbox." });
    expect(() => run(other.state, "setProbeStatus", { probeId: other.result.probeId, status: "failed" }, at(9))).toThrow("The reason it failed is empty.");
  });
});

describe("studio commands check their arguments at the boundary", () => {
  it("refuses wrong shapes before any rule runs", () => {
    const { s, id } = tripPlan();
    expect(() => runCommand(s, "addStudioArtifact", { round: 1, kind: "poster", title: "x", variants: [], files: [], devices: [], madeBy: DESIGNER }, at(3))).toThrow(InvalidCommandError);
    expect(() => runCommand(s, "addPeVerdicts", { artifactId: id, version: "1", verdicts: [] }, at(3))).toThrow(InvalidCommandError);
    expect(() => runCommand(s, "sendFeedback", { entries: [{ artifactId: id, version: 1, mark: null, pins: "none", note: "" }] }, at(3))).toThrow(InvalidCommandError);
    expect(() => runCommand(s, "closeRound", { round: -1 }, at(3))).toThrow(InvalidCommandError);
    expect(failure(() => runCommand(s, "closeRound", { round: 9 }, at(3)))).toBeInstanceOf(ControlError);
  });
});
