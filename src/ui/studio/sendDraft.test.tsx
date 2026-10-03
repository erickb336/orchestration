// ORC-030 Q-01, Q-06 and Q-22: Send puts each part you mark Keep into the blueprint's draft (`approveArtifact`, with
// your pick) and takes each part you mark Drop out of it (`dropBlueprintItem`): the owner's agreed pass 1 screens
// showed Keep as "approved by you", with no Approve button of its own. Before Send, the studio says what Send will
// do, or why Keep cannot; a Keep that approveArtifact would refuse is never sent. The Vision badge counts only parts
// that still need your mark.

import { describe, expect, it } from "vitest";
import { runCommand } from "../../domain/commands";
import * as M from "../../domain/model";
import { buildSeed } from "../../domain/seed";
import * as B from "../../domain/studio/blueprint";
import * as S from "../../domain/studio/studio";
import { blueprintScene } from "../../domain/testing/blueprintScene";
import { addScreen, lockInAsOwner, openRound, peAgrees, pePass, sha } from "../../domain/testing/studio";
import type { State } from "../../domain/types";
import { renderScreen, testService, visible } from "../testStore";
import { blueprintPlace, draftLines } from "./draftView";
import { Studio } from "./Studio";
import { answerEffects, changedDrafts, draftFrom, draftKey, keptNotInDraft, sendAnswer, waitingForYourMark, type Draft } from "./studioView";

const T0 = Date.parse("2026-10-03T09:00:00Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();

/** Round 1 with Trip plan v1 in two variants, which the PE agreed on (or, `objects`, objected to B on every pass). */
function round(objects = false): { s: State; id: string } {
  const fresh = M.initProject(buildSeed(T0, { inFlightRuns: false }), { name: "Trips", repoPath: "/tmp/trips", vision: "Weekend trips.", focus: "" }, at(0));
  const r = openRound(fresh, "experience", at(1));
  const a = addScreen(r.state, r.n, at(2), {
    variants: [{ id: "A", label: "Map first", entry: "a/index.html" }, { id: "B", label: "Timeline", entry: "b/index.html" }],
    files: [{ path: "a/index.html", sha256: sha("a") }, { path: "b/index.html", sha256: sha("b") }],
  });
  if (!objects) return { s: peAgrees(a.state, a.id, 1, ["A", "B"], at(3)), id: a.id };
  let s = a.state;
  for (const sec of [3, 4, 5]) s = pePass(s, a.id, 1, [{ variant: "A", verdict: "feasible" }, { variant: "B", verdict: "not-feasible" }], at(sec));
  return { s, id: a.id };
}

/** A send that runs each command against the state, as the service would (a refusal is { ok: false }), and records the calls. */
function service(start: State) {
  const calls: string[] = [];
  let state = start;
  const send = async (name: string, args: object) => {
    calls.push(name);
    try {
      state = runCommand(state, name, args, at(10 + calls.length)).state;
      return { ok: true };
    } catch {
      return { ok: false };
    }
  };
  return { calls, send, after: () => state };
}

const ANSWER = { round: 1, questions: [], answers: [], message: "" };
const marked = (d: Partial<Draft>): Draft => ({ ...draftFrom(undefined), ...d });
const studioText = (s: State) => visible(renderScreen(<Studio />, s, testService({ prototypePort: 5320 })));
/** Send one answer on Trip plan v1, and return the state after it. */
async function sendOn(s: State, id: string, d: Partial<Draft>) {
  const svc = service(s);
  const r = await sendAnswer(svc.send, s, { [draftKey(S.getArtifact(s, id, 1))]: marked(d) }, ANSWER);
  return { r, calls: svc.calls, s: svc.after() };
}

describe("Send puts each part you mark Keep into the draft, and takes each part you mark Drop out of it", () => {
  it("Keep with a pick: Send approves that variant into the draft, then messages the lead; the part says so", async () => {
    const { s, id } = round();
    const after = await sendOn(s, id, { mark: "keep", pickedVariant: "B" });
    expect(after.calls).toEqual(["sendFeedback", "approveArtifact", "postMessage"]);
    expect(B.draftItems(after.s)).toMatchObject([{ artifactId: id, version: 1, variant: "B", status: "approved" }]);
    expect(blueprintPlace(after.s, S.getArtifact(after.s, id, 1))).toBe("in the draft");
    expect(after.r?.draft).toEqual(["Trip plan v1 (Timeline) is in the draft."]);
    expect(studioText(after.s)).toContain("Trip plan screen · 2 variants in the draft keep");
  });

  it("before Send, your feedback says what Send does to the draft", () => {
    const { s, id } = round();
    const key = draftKey(S.getArtifact(s, id, 1));
    const will = (d: Partial<Draft>) => answerEffects(s, changedDrafts(s, { [key]: marked(d) })).map((e) => e.will);
    expect(will({ mark: "keep", pickedVariant: "A" })).toEqual(["Keep puts Trip plan v1 (Map first) in the draft."]);
    // Nothing in the draft to take out, and Change leaves the draft as it is: Send changes nothing there.
    expect(will({ mark: "drop" })).toEqual([]);
    expect(will({ mark: "change", note: "Bigger map." })).toEqual([]);
  });

  it("a Keep that approveArtifact would refuse is shown with its reason, never sent, and stays explained beside the part", async () => {
    const { s, id } = round();
    const key = draftKey(S.getArtifact(s, id, 1));
    expect(answerEffects(s, changedDrafts(s, { [key]: marked({ mark: "keep" }) }))).toMatchObject([{ will: "Keep cannot put Trip plan v1 in the draft yet: your pick between its variants is open.", refused: "your pick between its variants is open" }]);
    const after = await sendOn(s, id, { mark: "keep" });
    expect(after.calls).toEqual(["sendFeedback", "postMessage"]);
    expect(B.draftItems(after.s)).toEqual([]);
    expect(after.r?.draft).toEqual(["Trip plan v1 is not in the draft: your pick between its variants is open."]);
    expect(keptNotInDraft(after.s, S.getArtifact(after.s, id, 1))).toBe("You marked it Keep, but it is not in the draft: your pick between its variants is open.");
    expect(studioText(after.s)).toContain("You marked it Keep, but it is not in the draft: your pick between its variants is open.");
  });

  it("an objection the PE keeps: Keep on that variant is refused until you overrule it; the other variant goes in", () => {
    // The PE objects to B on three passes: its review ends with the objection, which waits for you.
    const { s, id } = round(true);
    const key = draftKey(S.getArtifact(s, id, 1));
    const will = (pick: string) => answerEffects(s, changedDrafts(s, { [key]: marked({ mark: "keep", pickedVariant: pick }) })).map((e) => e.will);
    expect(will("B")).toEqual(["Keep cannot put Trip plan v1 in the draft yet: the PE objects to Timeline (not-feasible for a reason); overrule the objection to approve it."]);
    expect(will("A")).toEqual(["Keep puts Trip plan v1 (Map first) in the draft."]);
  });

  it("Drop takes the part out of the draft, and the screen agrees: no 'in the draft' beside 'drop' (Q-06)", async () => {
    const { s, id } = round();
    const kept = (await sendOn(s, id, { mark: "keep", pickedVariant: "A" })).s;
    const key = draftKey(S.getArtifact(kept, id, 1));
    expect(answerEffects(kept, changedDrafts(kept, { [key]: marked({ mark: "drop", pickedVariant: "A" }) })).map((e) => e.will)).toEqual(["Drop takes Trip plan v1 out of the draft."]);
    const after = await sendOn(kept, id, { mark: "drop", pickedVariant: "A" });
    expect(after.calls).toEqual(["sendFeedback", "dropBlueprintItem", "postMessage"]);
    expect(B.draftItems(after.s)).toMatchObject([{ artifactId: id, status: "dropped" }]);
    expect(B.hasDraft(after.s)).toBe(false);
    expect(blueprintPlace(after.s, S.getArtifact(after.s, id, 1))).toBeUndefined();
    const text = studioText(after.s);
    expect(text).toContain("Trip plan screen · 2 variants drop");
    expect(text).not.toContain("in the draft drop");
  });

  it("after the start, a Drop on the part in force waits in the draft and leaves the design at the next Lock in", async () => {
    const { s, id } = round();
    const started = lockInAsOwner((await sendOn(s, id, { mark: "keep", pickedVariant: "A" })).s, at(30));
    expect(blueprintPlace(started, S.getArtifact(started, id, 1))).toBe("in force");
    const key = draftKey(S.getArtifact(started, id, 1));
    expect(answerEffects(started, changedDrafts(started, { [key]: marked({ mark: "drop", pickedVariant: "A" }) })).map((e) => e.will)).toEqual(["Drop takes Trip plan out of the draft: it leaves the design at your next Lock in."]);
    const after = await sendOn(started, id, { mark: "drop", pickedVariant: "A" });
    expect(draftLines(after.s).map((l) => `${l.kind}: ${l.name}`)).toEqual(["dropped: Trip plan v1, Map first"]);
    expect(blueprintPlace(after.s, S.getArtifact(after.s, id, 1))).toBe("dropped");
  });

  it("after Discard the draft, a kept part stays out until you mark it Keep again and send", async () => {
    const { s, id } = round();
    const kept = (await sendOn(s, id, { mark: "keep", pickedVariant: "A" })).s;
    const discarded = runCommand(kept, "discardDraft", { draftRev: B.draftRev(kept) }, at(40)).state;
    const a = S.getArtifact(discarded, id, 1);
    expect(keptNotInDraft(discarded, a)).toBe("You marked it Keep, but it is not in the draft. To put it in, mark it Keep again and send.");
    // Nothing is sent by itself: only a part you marked again is in your answer.
    expect(changedDrafts(discarded, {})).toEqual([]);
    const again = { [draftKey(a)]: draftFrom(S.currentFeedback(discarded, id, 1)) };
    expect(answerEffects(discarded, changedDrafts(discarded, again)).map((e) => e.will)).toEqual(["Keep puts Trip plan v1 (Map first) in the draft."]);
  });
});

describe("the Vision badge counts only the parts that still need your mark (Q-22)", () => {
  it("not a part whose version is in force or in the draft, nor a dropped part", () => {
    const { s } = blueprintScene();
    // Every part of the scene is approved, in force or dropped by the owner's commands, with no mark: none waits.
    // Round 4's Trip map is open (marked Change), so it is answered too.
    expect(waitingForYourMark(s).map((a) => a.title)).toEqual([]);
    // A new version of a part in force does wait for your mark.
    const plan = S.latestArtifacts(s).find((a) => a.title === "Trip plan")!;
    const v3 = addScreen(s, plan.round, at(50), { artifactId: plan.id, title: "Trip plan", variants: [{ id: "A", label: "Map first", entry: "trip-plan/index.html" }] });
    expect(waitingForYourMark(peAgrees(v3.state, plan.id, v3.version, [], at(51))).map((a) => `${a.title} v${a.version}`)).toEqual(["Trip plan v3"]);
  });
});
