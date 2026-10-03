// Vision documents, the harder cases at domain level: document-only revisions never invalidate the lead's
// focus changes, invisible characters are handled by context and never altered in the user's own text, a
// batch attaches as one revision, and Start building's labels tell the truth.

import { describe, expect, it } from "vitest";
import * as M from "./model";
import { inVision, startFactoryAsOwner } from "./testing/factory";
import { setPipeline } from "./testing/pipelines";
import { buildSeed } from "./seed";
import type { LeadRun, State, VisionDoc } from "./types";

const T0 = Date.parse("2026-09-30T12:00:00Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const seed = () => buildSeed(T0, { inFlightRuns: false });
const hash = (n: number) => n.toString(16).padStart(64, "0");
const doc = (path: string, n: number, size = 100): M.VisionDocInput => ({ path, size, hash: hash(n), text: true });
const messageRun: LeadRun = { id: "lead-x", trigger: "message", provider: "claude", model: "m", startedAt: at(0), outcome: "running", messageIds: ["msg-1"], visionRev: 1 };

/** Post a message, start a message run, do something meanwhile, complete the run with a steering block. */
function steerRun(s0: State, steer: unknown, during: (s: State) => State = (s) => s) {
  let s = M.postMessage(s0, "Focus on speed", at(1));
  const r = M.startLeadRun(s, { provider: "claude", model: "m", trigger: "message" }, at(2));
  s = during(r.state);
  s = M.completeLeadRun(s, r.runId, { reply: "ok", proposals: [], steer }, at(4));
  return { state: s, set: s.steering.find((cs) => cs.leadRunId === r.runId)!, runId: r.runId };
}

// Legitimate text that earlier stripping damaged.
const FAMILY = "\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}";
const SCOTLAND = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}";
const PERSIAN = "می‌خواهم"; // می‌خواهم, ZWNJ between letters
const DEVANAGARI = "क्‌ष"; // ka, virama, ZWNJ, ssa
const HEBREW = "‏שלום"; // RLM then שלום
const ARABIC = "‏مرحبا"; // RLM then مرحبا
const HEART = "❤️"; // variation selector
const LEGIT = [FAMILY, SCOTLAND, PERSIAN, DEVANAGARI, HEBREW, ARABIC, HEART];
// Hostile: overrides, isolates, BOM, word joiner, zero-width space, C1 controls, lone and malformed tags.
const HOSTILE = "‮‪⁦⁩﻿⁠​\u0085\u009F\u{E0041}\u{E0001}";

describe("a document-only revision never invalidates the lead's focus changes", () => {
  it("a focus change applies when only documents changed while the lead worked, with a truthful note; a text edit still holds it", () => {
    const attached = steerRun(seed(), { reason: "you asked", focus: "Speed" }, (s) => M.addVisionDoc(s, doc("brief.md", 1), at(3)).state);
    expect(attached.set.heldBecause).toBeUndefined();
    expect(attached.set.notes).toContain("Your vision documents changed while the lead was working; its reply may not reflect them.");
    expect(attached.set.changes[0]).toMatchObject({ kind: "focus", status: "applied", appliedBy: "lead", after: "Speed" });
    expect(M.currentVision(attached.state)).toMatchObject({ rev: 3, author: "lead", focus: "Speed", docIds: [expect.stringMatching(/^doc-/)] });
    const edited = steerRun(seed(), { reason: "you asked", focus: "Speed" }, (s) => M.editVision(s, 1, "Other text", M.currentVision(s).focus, "hand edit", at(3)));
    expect(edited.set.heldBecause).toBe("You edited the vision while the lead was working.");
    expect(edited.set.changes[0]).toMatchObject({ kind: "focus", status: "rejected", note: "you edited the vision (now r2); your edit stands" });
    expect(edited.set.notes).toEqual([]);
  });

  it("Undo of an applied focus change survives documents attached or removed since; a later text edit still leaves it", () => {
    const { state: s0, set } = steerRun(seed(), { reason: "you asked", focus: "Speed" });
    const focusRow = set.changes[0];
    expect(focusRow).toMatchObject({ kind: "focus", status: "applied", visionRev: 2 });
    let s = M.addVisionDoc(s0, doc("a.md", 1), at(5)).state;
    s = M.addVisionDoc(s, doc("b.md", 2), at(6)).state;
    s = M.removeVisionDoc(s, M.currentVisionDocs(s)[0].id, at(7));
    expect(M.currentVision(s).rev).toBe(5);
    const undone = M.undoSteering(s, set.id, undefined, at(8));
    expect(undone.result).toEqual({ undone: [focusRow.id], left: [] });
    expect(M.currentVision(undone.state)).toMatchObject({ rev: 6, author: "user", focus: M.currentVision(seed()).focus, source: { undoOf: set.id } });
    expect(M.currentVisionDocs(undone.state).map((d) => d.path)).toEqual(["b.md"]);
    // The same undo after a hand edit of the text is left as is, and says so.
    const edited = M.editVision(s, 5, "Changed text", "Speed", "hand edit", at(8));
    const left = M.undoSteering(edited, set.id, undefined, at(9));
    expect(left.result).toEqual({ undone: [], left: [{ id: focusRow.id, why: "the vision changed since (now r6)" }] });
  });

  it("Apply of a suggested focus change survives documents attached since, and is left after a text edit", () => {
    const { state: s0, set } = steerRun(M.setSteeringMode(seed(), "suggest", at(0)), { reason: "you asked", focus: "Speed" });
    const row = set.changes[0];
    expect(row).toMatchObject({ kind: "focus", status: "suggested", visionRev: 1 });
    const withDoc = M.addVisionDoc(s0, doc("a.md", 1), at(5)).state;
    const applied = M.applySteering(withDoc, set.id, row.id, at(6));
    expect(applied.result).toEqual({ applied: [row.id], left: [] });
    expect(M.currentVision(applied.state)).toMatchObject({ rev: 3, author: "user", focus: "Speed" });
    expect(M.currentVisionDocs(applied.state).map((d) => d.path)).toEqual(["a.md"]);
    const edited = M.editVision(withDoc, 2, "Changed text", M.currentVision(withDoc).focus, "hand edit", at(6));
    expect(M.applySteering(edited, set.id, row.id, at(7)).result.left).toEqual([{ id: row.id, why: "the vision changed since (now r3)" }]);
    // The helper behind it all: only text or focus count as movement.
    expect(M.visionContentMovedSince(withDoc, 1)).toBe(false);
    expect(M.visionContentMovedSince(edited, 1)).toBe(true);
    expect(M.visionContentMovedSince(withDoc, 99)).toBe(true);
  });
});

describe("invisible characters", () => {
  it("lead-authored text keeps emoji ZWJ sequences, subdivision flags, joiners between letters, LRM/RLM and variation selectors, and loses hostile characters", () => {
    for (const t of LEGIT) expect(M.stripInvisible(t)).toBe(t);
    const s = M.stripHostile(`a${HOSTILE}b`);
    expect(s).toEqual({ text: "ab", removed: 11 });
    // A joiner outside its legitimate contexts goes: not between letters, not next to an emoji.
    expect(M.stripInvisible("a‌ b")).toBe("a b");
    expect(M.stripInvisible("1‍2")).toBe("12");
    expect(M.stripInvisible("‍")).toBe("");
    // A malformed tag sequence: the tags go, the base stays.
    expect(M.stripInvisible("\u{1F3F4}\u{E0067}\u{E0062}")).toBe("\u{1F3F4}");
    expect(M.stripInvisible(`x${SCOTLAND}\u{E0041}`)).toBe(`x${SCOTLAND}`);
    // Through the lead's draft, focus and questions.
    const draft = M.validateVisionDraft(seed(), messageRun, { text: `${LEGIT.join(" ")}\n${HOSTILE}Problem${HOSTILE}`, focus: `${PERSIAN} ${FAMILY}‮` });
    expect(draft).toEqual({ ok: true, draft: { text: `${LEGIT.join(" ")}\nProblem`, focus: `${PERSIAN} ${FAMILY}`, reason: "Drafted from your messages" } });
    const steer = M.validateSteer(seed(), messageRun, { focus: `${SCOTLAND} ${HEBREW}⁦` });
    expect(steer.focus).toEqual({ ok: true, value: `${SCOTLAND} ${HEBREW}` });
    expect(M.validateQuestions(messageRun, [{ question: `Which ${FAMILY}?`, options: [`${HEART}`, `B\u{E0041}`] }]).questions).toEqual([{ question: `Which ${FAMILY}?`, why: "", options: [HEART, "B"] }]);
    // Text of only invisible characters is empty, even when they are the kept kind.
    expect(M.validateVisionDraft(seed(), messageRun, { text: "‏‎ ️" })).toEqual({ ok: false, why: "the text is empty" });
    expect(M.validateSteer(seed(), messageRun, { focus: "‏‏" }).focus).toEqual({ ok: false, why: "focus must be 1–500 characters" });
  });

  it("the user's own text is never altered: edit-and-accept, hand edits and messages keep every joiner, mark and tag sequence", () => {
    let s = inVision(seed(), at(0));
    s = M.postMessage(s, `Mine: ${LEGIT.join(" ")}`, at(1));
    expect(s.conversation.at(-1)!.text).toBe(`Mine: ${LEGIT.join(" ")}`);
    const r = M.startLeadRun(s, { provider: "claude", model: "m", trigger: "message" }, at(2));
    s = M.completeLeadRun(r.state, r.runId, { reply: "ok", proposals: [], vision: { text: "Drafted", focus: "Drafted focus" } }, at(3));
    const d = M.openVisionDraft(s)!;
    const accepted = M.acceptVisionDraft(s, d.id, 1, { text: `Edited ${LEGIT.join(" ")}`, focus: `${PERSIAN} ${SCOTLAND}` }, at(4));
    expect(M.currentVision(accepted)).toMatchObject({ text: `Edited ${LEGIT.join(" ")}`, focus: `${PERSIAN} ${SCOTLAND}` });
    const hand = M.editVision(seed(), 1, `Hand ${LEGIT.join(" ")}`, HEBREW, "by hand", at(5));
    expect(M.currentVision(hand)).toMatchObject({ text: `Hand ${LEGIT.join(" ")}`, focus: HEBREW });
  });

  it("document names: line and paragraph separators, bidi controls and tag characters are refused; legitimate joiners stay; two encodings are one name", () => {
    for (const bad of ["a b.md", "a b.md", "a‮b.md", "a⁦b.md", `a${SCOTLAND}.md`, "a\u{E0041}b.md", "a​b.md", "a﻿b.md"]) {
      expect(M.visionDocPath(bad)).toEqual({ ok: false, why: "The name contains invisible or bidirectional control characters." });
    }
    expect(M.visionDocPath(`${PERSIAN}.md`)).toEqual({ ok: true, path: `${PERSIAN}.md` });
    expect(M.visionDocPath(`${FAMILY} ${HEART}.md`)).toEqual({ ok: true, path: `${FAMILY} ${HEART}.md` });
    expect(M.visionDocPath("docs/café.md")).toEqual({ ok: true, path: "docs/café.md" });
  });
});

describe("a batch attaches as one revision", () => {
  it("staged files attach as one revision with the batch's name; the same file again is unchanged; a batch keeps the first of a path replaced by a later file", () => {
    let s = seed();
    const ids: string[] = [];
    for (const [p, n] of [["a.md", 1], ["b.md", 2], ["c.md", 3], ["d.md", 4], ["e.md", 5]] as const) {
      const r = M.stageVisionDoc(s, doc(p, n), at(n));
      s = r.state;
      expect(r.result.status).toBe("staged");
      ids.push(r.result.docId);
    }
    expect(M.stagedVisionDocs(s)).toHaveLength(5);
    expect(M.currentVisionDocs(s)).toEqual([]);
    expect(M.currentVision(s).rev).toBe(1);
    // Staging the same file again before the commit reuses the record.
    expect(M.stageVisionDoc(s, doc("a.md", 1), at(6)).result).toEqual({ docId: ids[0], status: "staged" });
    const r = M.attachVisionDocs(s, ids, "add-1", at(7));
    s = r.state;
    expect(r.result.revision).toBe(2);
    expect(r.result.docs.map((d) => d.status)).toEqual(["added", "added", "added", "added", "added"]);
    const v = M.currentVision(s);
    expect(v).toMatchObject({ rev: 2, author: "user", reason: "Attached 5 documents: a.md, b.md, c.md and 2 more", source: { docsAdded: ids, batchId: "add-1" }, docIds: ids });
    expect(s.events.at(-1)!.message).toBe("Vision r2: attached 5 documents (5 in total, 500 B)");
    expect(M.stagedVisionDocs(s)).toEqual([]);
    expect(s.project.visionDocs.every((d) => d.addedAt === at(7))).toBe(true);
    // One list per revision: every revision carries the whole set, so history stays self-contained.
    expect(v.docIds).toHaveLength(5);
    // Attaching the same ids again (two tabs sharing one staged record): unchanged, no revision.
    expect(M.attachVisionDocs(s, [ids[0]], undefined, at(8)).result).toEqual({ docs: [{ docId: ids[0], path: "a.md", status: "unchanged", attachedAs: ids[0] }] });
    expect(() => M.attachVisionDocs(s, [], undefined, at(8))).toThrow(/names no documents/);
    expect(() => M.attachVisionDocs(s, ["doc-none"], undefined, at(8))).toThrow(/Unknown document/);
    // The same file again: unchanged at staging, nothing recorded.
    expect(M.stageVisionDoc(s, doc("a.md", 1), at(9)).result).toEqual({ docId: ids[0], status: "unchanged" });
    // A newer file at an existing path, and two files at one path in the batch: the later wins, the earlier is reported.
    const n1 = M.stageVisionDoc(s, doc("a.md", 11), at(10));
    expect(n1.result).toEqual({ docId: expect.stringMatching(/^doc-/), status: "staged", replaces: ids[0] });
    const n2 = M.stageVisionDoc(n1.state, doc("a.md", 12), at(11));
    const both = M.attachVisionDocs(n2.state, [n1.result.docId, n2.result.docId], "add-2", at(12));
    expect(both.result.docs).toEqual([
      { docId: n1.result.docId, path: "a.md", status: "refused", why: `a later file in the same batch has the same path (${n2.result.docId})` },
      { docId: n2.result.docId, path: "a.md", status: "replaced", replaced: ids[0] },
    ]);
    expect(M.currentVision(both.state)).toMatchObject({ rev: 3, reason: "Attached 1 document: a.md (1 replaced an earlier copy)", source: { docsAdded: [n2.result.docId], docsRemoved: [ids[0]] } });
    expect(both.state.project.visionDocs.find((d) => d.id === n1.result.docId)).toBeUndefined();
    expect(M.currentVisionDocs(both.state).map((d) => d.hash)).toEqual([hash(12), hash(2), hash(3), hash(4), hash(5)]);
    // Removal stays per document.
    const removed = M.removeVisionDoc(both.state, ids[1], at(13));
    expect(M.currentVision(removed)).toMatchObject({ rev: 4, reason: "Removed b.md" });
  });

  it("a batch that overflows attaches what fits and reports the rest; a staged file attached meanwhile elsewhere is unchanged; stale staged records are dropped", () => {
    // Overflow at the commit itself (the staging pre-check already counts staged files, so this is the
    // authoritative check): twelve 2 MB records staged by hand.
    let s = seed();
    const two = M.MAX_VISION_DOC_BYTES;
    const staged: VisionDoc[] = Array.from({ length: 12 }, (_, i) => ({ id: `doc-s${i}`, name: `${i}.txt`, path: `big/${i}.txt`, size: two, hash: hash(100 + i), text: true, addedAt: at(1), stagedAt: at(1) }));
    s = { ...s, project: { ...s.project, visionDocs: staged } };
    const r = M.attachVisionDocs(s, staged.map((d) => d.id), undefined, at(2));
    expect(r.result.docs.slice(0, 10).every((d) => d.status === "added")).toBe(true);
    expect(r.result.docs[10]).toMatchObject({ status: "refused", why: "Attaching big/10.txt (2.0 MB) would bring the documents to 22 MB; the limit is 20 MB per project." });
    expect(r.result.docs[11]).toMatchObject({ status: "refused" });
    expect(M.currentVisionDocs(r.state)).toHaveLength(10);
    expect(r.state.project.visionDocs).toHaveLength(10); // refused records are dropped
    expect(M.currentVision(r.state).reason).toBe("Attached 10 documents: big/0.txt, big/1.txt, big/2.txt and 7 more");
    // Nothing fits: no revision, and the rows say why.
    const none = M.attachVisionDocs({ ...r.state, project: { ...r.state.project, visionDocs: [...r.state.project.visionDocs, { ...staged[11], id: "doc-x" }] } }, ["doc-x"], undefined, at(3));
    expect(none.result.revision).toBeUndefined();
    expect(none.result.docs[0].status).toBe("refused");
    expect(M.currentVision(none.state).rev).toBe(2);
    // Staged here, and attached from another tab meanwhile (the other tab's upload shares the staged record):
    // this tab's commit reports it unchanged. Replaced since: it must be uploaded again.
    let t = seed();
    const st = M.stageVisionDoc(t, doc("a.md", 1), at(1));
    t = M.addVisionDoc(st.state, doc("a.md", 1), at(2)).state;
    expect(M.currentVisionDocs(t).map((d) => d.id)).toEqual([st.result.docId]);
    const un = M.attachVisionDocs(t, [st.result.docId], undefined, at(3));
    expect(un.result).toEqual({ docs: [{ docId: st.result.docId, path: "a.md", status: "unchanged", attachedAs: st.result.docId }] });
    expect(M.currentVision(un.state).rev).toBe(2);
    const replaced = M.addVisionDoc(t, doc("a.md", 2), at(4)).state;
    expect(M.attachVisionDocs(replaced, [st.result.docId], undefined, at(5)).result.docs[0]).toMatchObject({ status: "refused", why: "it was attached earlier and has since been replaced or removed; attach it again" });
    // A staged record older than the TTL is dropped at the next staging or commit.
    const old = M.stageVisionDoc(seed(), doc("old.md", 1), at(0)).state;
    const later = new Date(T0 + M.STAGED_DOC_TTL_MS + 1000).toISOString();
    const pruned = M.stageVisionDoc(old, doc("new.md", 2), later).state;
    expect(M.stagedVisionDocs(pruned).map((d) => d.path)).toEqual(["new.md"]);
    expect(() => M.attachVisionDocs(pruned, [M.stagedVisionDocs(old)[0].id], undefined, later)).toThrow(/Unknown document/);
    // The staging pre-check counts what is staged, so a batch cannot be built past the caps.
    let u = seed();
    for (let i = 0; i < 10; i++) u = M.stageVisionDoc(u, doc(`b/${i}.txt`, 200 + i, two), at(1)).state;
    expect(M.visionDocAdmission(u, doc("b/10.txt", 210, two))).toBe("Attaching b/10.txt (2.0 MB) would bring the documents to 22 MB; the limit is 20 MB per project.");
  });
});

describe("Start building's labels tell the truth", () => {
  const oneStep = [{ id: "S1", purpose: "Implement", role: "coder" as const, dependsOn: [], inputs: [], outputs: [{ name: "change", kind: "code-change" as const }] }];
  /** A ready roadmap task under the shaping hold, and a proposed task it depends on. */
  function roadmap(): { state: State; id: string; dep: string } {
    let s = inVision(seed(), at(0));
    // Tasks come from a flow; the one-step pipeline is applied through the internal setPipeline.
    const dep0 = M.createTask(s, { title: "Dep", area: "", outcome: "x", benefit: "", whyNow: "", approach: "y", acceptance: ["ok"], priority: 1, holdBeforeStart: false, flowId: "change" }, at(1));
    const dep = { ...dep0, state: setPipeline(dep0.state, dep0.newId, 1, oneStep, "one step", "user", at(1)) };
    const t0 = M.createTask(dep.state, { title: "Planned", area: "", outcome: "x", benefit: "", whyNow: "", approach: "y", acceptance: ["ok"], priority: 2, holdBeforeStart: true, flowId: "change" }, at(2));
    const t = { ...t0, state: setPipeline(t0.state, t0.newId, 1, oneStep, "one step", "user", at(2)) };
    s = structuredClone(t.state);
    const task = s.tasks.find((x) => x.id === t.newId)!;
    task.lifecycle = "ready";
    task.fromShaping = true;
    task.heldForShaping = true;
    task.dependsOn = [dep.newId];
    return { state: s, id: t.newId, dep: dep.newId };
  }
  const autopilot = (s: State) => M.setAutonomy(s, { ...s.project.autonomy, enabled: true, holdLeadProposals: false }, at(3));
  const checkin = (s: State) => M.setAutonomy(s, { ...s.project.autonomy, enabled: true, holdLeadProposals: true }, at(3));

  it("the label and the plan read the involvement setting as it is now, and a dependency wait shows under the shaping hold", () => {
    const { state, id, dep } = roadmap();
    const a = autopilot(state);
    expect(M.startFactoryPlan(a)).toMatchObject({ release: true, roadmap: [expect.objectContaining({ id })], userHeld: [] });
    expect(M.stateLabel(a, a.tasks.find((t) => t.id === id)!)).toBe(`Planned; waits until you start building and on ${dep}, then starts on Autopilot`);
    const c = checkin(a);
    expect(M.startFactoryPlan(c).release).toBe(false);
    expect(M.stateLabel(c, c.tasks.find((t) => t.id === id)!)).toBe(`Planned; waits until you start building and on ${dep}, then waits for your go-ahead (your involvement setting)`);
    // The setting changed after the proposal: what Start building does follows the setting now, as the label said.
    const started = startFactoryAsOwner(c, at(4)).tasks.find((t) => t.id === id)!;
    expect(started.holdBeforeStart).toBe(true);
    expect(started.heldForShaping).toBeUndefined();
    const startedA = startFactoryAsOwner(autopilot(c), at(4)).tasks.find((t) => t.id === id)!;
    expect(startedA.holdBeforeStart).toBe(false);
    expect(startedA.heldForShaping).toBeUndefined();
  });

  it("the plan counts only tasks under the roadmap's own hold; a task the user held is listed apart and stays held", () => {
    const { state, id } = roadmap();
    const held = M.setHoldBeforeStart(autopilot(state), id, true, at(3));
    expect(M.startFactoryPlan(held)).toMatchObject({ release: true, roadmap: [], userHeld: [expect.objectContaining({ id })] });
    expect(M.stateLabel(held, held.tasks.find((t) => t.id === id)!)).toBe("Waiting for your go-ahead");
    const started = startFactoryAsOwner(held, at(4));
    expect(started.tasks.find((t) => t.id === id)).toMatchObject({ holdBeforeStart: true });
  });
});
