// ORC-017: the structured `simulated` flag. It is set from the run report the server passes for a lead run on
// the fake runtime, never from the text, and it travels: a focus change and its change set carry it, a draft
// carries it and Accept copies it onto the revision. A run reported without it leaves nothing flagged.

import { describe, expect, it } from "vitest";
import * as M from "./model";
import { buildSeed } from "./seed";

const T0 = Date.parse("2026-10-01T12:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

function messageRun(simulated: boolean, out: Parameters<typeof M.completeLeadRun>[2], shaping = false) {
  let s = buildSeed(T0, { inFlightRuns: false });
  if (shaping) s = M.startShaping(s, at(0));
  s = M.postMessage(s, "Build a notes app that syncs offline", at(1));
  const r = M.startLeadRun(s, { provider: "claude", model: "claude-sample-large", trigger: "message" }, at(2));
  return M.completeLeadRun(r.state, r.runId, out, at(3), simulated ? { simulated: true } : {});
}

describe("the simulated flag (ORC-017)", () => {
  it("marks the focus change and the change set of a simulated lead run, and nothing of a real one", () => {
    const steer = { focus: "Sync first", reason: "You asked", tasks: [] };
    const sim = messageRun(true, { reply: "Noted", proposals: [], steer });
    expect(sim.steering[0]).toMatchObject({ simulated: true });
    expect(M.currentVision(sim)).toMatchObject({ rev: 2, author: "lead", focus: "Sync first", simulated: true });
    const real = messageRun(false, { reply: "Noted", proposals: [], steer });
    expect(real.steering[0].simulated).toBeUndefined();
    expect(M.currentVision(real)).toMatchObject({ rev: 2, author: "lead", focus: "Sync first" });
    expect(M.currentVision(real).simulated).toBeUndefined();
    // Undo writes a user revision: the user's own, never flagged.
    const undone = M.undoSteering(sim, sim.steering[0].id, undefined, at(4)).state;
    expect(M.currentVision(undone)).toMatchObject({ rev: 3, author: "user", focus: "Make daily logging simpler" });
    expect(M.currentVision(undone).simulated).toBeUndefined();
  });

  it("marks a draft from a simulated lead run; Accept carries the flag onto the revision, edited or not", () => {
    const vision = { text: "A notes app that syncs offline and never loses a note.", focus: "Offline sync first", reason: "Drafted from your message" };
    const sim = messageRun(true, { reply: "Here is what I understand", proposals: [], vision }, true);
    const draft = M.openVisionDraft(sim)!;
    expect(draft.simulated).toBe(true);
    const accepted = M.acceptVisionDraft(sim, draft.id, M.currentVision(sim).rev, undefined, at(5));
    expect(M.currentVision(accepted)).toMatchObject({ author: "user", focus: "Offline sync first", simulated: true, source: { draftId: draft.id } });
    const edited = M.acceptVisionDraft(sim, draft.id, M.currentVision(sim).rev, { focus: "Sync, then sharing" }, at(5));
    expect(M.currentVision(edited)).toMatchObject({ focus: "Sync, then sharing", simulated: true });
    // A real lead's draft is accepted without the flag.
    const real = messageRun(false, { reply: "Here is what I understand", proposals: [], vision }, true);
    const realDraft = M.openVisionDraft(real)!;
    expect(realDraft.simulated).toBeUndefined();
    expect(M.currentVision(M.acceptVisionDraft(real, realDraft.id, M.currentVision(real).rev, undefined, at(5))).simulated).toBeUndefined();
  });

  it("survives a JSON round trip and loads from a state written before the flag existed (absent means not simulated)", () => {
    const sim = messageRun(true, { reply: "Noted", proposals: [], steer: { focus: "Sync first", reason: "You asked", tasks: [] } });
    const back = JSON.parse(JSON.stringify(sim)) as typeof sim;
    expect(back.steering[0].simulated).toBe(true);
    expect(M.currentVision(back).simulated).toBe(true);
    const old = buildSeed(T0, { inFlightRuns: false });
    expect("simulated" in old.project.visions[0]).toBe(false);
    expect(old.steering).toEqual([]);
  });
});
