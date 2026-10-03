// Vision documents, domain level. Safe relative paths, admission against the caps, one
// user-authored revision per attach or removal that records the resulting set, replacement at the
// same path, and history that keeps what earlier revisions had.

import { describe, expect, it } from "vitest";
import * as M from "./model";
import { buildSeed } from "./seed";
import { inVision } from "./testing/factory";
import { ControlError, type State } from "./types";

const T0 = Date.parse("2026-09-30T12:00:00Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const seed = () => buildSeed(T0, { inFlightRuns: false });
const hash = (n: number) => n.toString(16).padStart(64, "0");
const doc = (path: string, over: Partial<M.VisionDocInput> = {}): M.VisionDocInput => ({ path, size: 100, hash: hash(path.length + (over.size ?? 100)), text: true, ...over });
const add = (s: State, input: M.VisionDocInput, t = 1) => M.addVisionDoc(s, input, at(t)).state;
const paths = (s: State) => M.currentVisionDocs(s).map((d) => d.path);
const err = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ControlError) return e.message;
    throw e;
  }
  throw new Error("expected a ControlError");
};

describe("V1 safe paths", () => {
  it("normalizes separators and dot segments; refuses .., absolute paths, control characters and empty names", () => {
    expect(M.visionDocPath("docs/brief.md")).toEqual({ ok: true, path: "docs/brief.md" });
    expect(M.visionDocPath("docs\\sub\\brief.md")).toEqual({ ok: true, path: "docs/sub/brief.md" });
    expect(M.visionDocPath("./docs//brief.md/")).toEqual({ ok: true, path: "docs/brief.md" });
    for (const bad of ["../../etc/passwd", "a/../../b", "..\\x", "docs/..", "...", "a/.../b"]) expect(M.visionDocPath(bad)).toMatchObject({ ok: false, why: expect.stringContaining('".."') });
    for (const bad of ["/etc/passwd", "C:\\Users\\x.md", "c:/x.md", "\\\\server\\share\\x.md"]) expect(M.visionDocPath(bad)).toMatchObject({ ok: false, why: expect.stringMatching(/Absolute paths/) });
    expect(M.visionDocPath("")).toMatchObject({ ok: false });
    expect(M.visionDocPath("   ")).toMatchObject({ ok: false });
    expect(M.visionDocPath("./")).toMatchObject({ ok: false, why: expect.stringMatching(/needs a name/) });
    expect(M.visionDocPath("a\u0000b.md")).toMatchObject({ ok: false, why: expect.stringMatching(/control characters/) });
    expect(M.visionDocPath("a\nb.md")).toMatchObject({ ok: false });
    expect(M.visionDocPath(" a.md")).toMatchObject({ ok: false, why: expect.stringMatching(/whitespace/) });
    expect(M.visionDocPath("x".repeat(600))).toMatchObject({ ok: false, why: expect.stringMatching(/over 512/) });
    // A normalized path never contains a segment that could climb: joined under any directory it stays inside it.
    for (const raw of ["docs/brief.md", "a/./b/../c.md"]) {
      const r = M.visionDocPath(raw);
      if (r.ok) expect(r.path.split("/").every((seg) => seg !== ".." && seg !== "" && seg !== ".")).toBe(true);
    }
    expect(M.visionDocPath("a/./b/../c.md")).toMatchObject({ ok: false });
  });
});

describe("V2 attaching", () => {
  it("records the document and a user-authored revision with the set; the text and focus carry over; the event says what happened", () => {
    const s0 = seed();
    const s = add(s0, doc("docs/brief.md", { size: 1234 }));
    const v = M.currentVision(s);
    expect(v).toMatchObject({ rev: 2, author: "user", text: s0.project.visions[0].text, focus: s0.project.visions[0].focus });
    expect(v.docIds).toHaveLength(1);
    const d = s.project.visionDocs[0];
    expect(d).toMatchObject({ id: v.docIds![0], name: "brief.md", path: "docs/brief.md", size: 1234, text: true, addedAt: at(1) });
    expect(v.source).toEqual({ docsAdded: [d.id] });
    expect(v.reason).toBe("Attached 1 document: docs/brief.md");
    expect(s.events[s.events.length - 1].message).toBe("Vision r2: attached 1 document (1 in total, 1.2 KB)");
    expect(s0.project.visionDocs).toEqual([]); // pure
    expect(M.currentVisionDocs(s0)).toEqual([]);
  });

  it("three Markdown files and a folder of five text files list eight documents, in the order attached", () => {
    let s = seed();
    const files = ["a.md", "b.md", "c.md", "notes/1.txt", "notes/2.txt", "notes/sub/3.txt", "notes/4.csv", "notes/5.json"];
    files.forEach((p, i) => (s = add(s, doc(p, { hash: hash(i + 1) }), i + 1)));
    expect(paths(s)).toEqual(files);
    expect(M.currentVision(s).rev).toBe(9);
    expect(M.visionDocsBytes(M.currentVisionDocs(s))).toBe(800);
    expect(M.currentVisionDocs(s).map((d) => d.name)).toEqual(["a.md", "b.md", "c.md", "1.txt", "2.txt", "3.txt", "4.csv", "5.json"]);
  });

  it("a file that is not text is kept and marked; office formats are recognised for the interface note", () => {
    const s = add(seed(), doc("logo.png", { text: false }));
    expect(M.currentVisionDocs(s)[0].text).toBe(false);
    expect(M.currentVision(s).reason).toMatch(/not readable as text; the lead sees its name only/);
    expect(M.isOfficeDoc({ name: "report.PDF" })).toBe(true);
    expect(M.isOfficeDoc({ name: "brief.docx" })).toBe(true);
    expect(M.isOfficeDoc({ name: "brief.md" })).toBe(false);
  });

  it("a newer file at the same path replaces the older one in the current set only; the same file again is refused", () => {
    let s = add(seed(), doc("docs/brief.md", { hash: hash(1), size: 100 }), 1);
    const old = M.currentVisionDocs(s)[0];
    expect(err(() => add(s, doc("docs/brief.md", { hash: hash(1), size: 100 }), 2))).toBe("docs/brief.md is already attached (the same content).");
    expect(err(() => add(s, doc("docs\\brief.md", { hash: hash(1), size: 100 }), 2))).toMatch(/already attached/); // same path once normalized
    s = add(s, doc("docs/brief.md", { hash: hash(2), size: 300 }), 2);
    const cur = M.currentVisionDocs(s);
    expect(cur).toHaveLength(1);
    expect(cur[0]).toMatchObject({ path: "docs/brief.md", hash: hash(2), size: 300 });
    expect(cur[0].id).not.toBe(old.id);
    expect(M.currentVision(s)).toMatchObject({ rev: 3, source: { docsAdded: [cur[0].id], docsRemoved: [old.id] } });
    expect(M.currentVision(s).reason).toBe("Attached 1 document: docs/brief.md (1 replaced an earlier copy)");
    // History: r2 still has the old copy; the registry keeps both.
    expect(M.visionDocsOf(s, s.project.visions[1]).map((d) => d.hash)).toEqual([hash(1)]);
    expect(s.project.visionDocs.map((d) => d.hash)).toEqual([hash(1), hash(2)]);
    // The old copy's size no longer counts against the total.
    expect(M.visionDocsBytes(M.currentVisionDocs(s))).toBe(300);
  });
});

describe("V3 caps", () => {
  it("2 MB per file: exactly 2 MB is admitted, one byte more is refused; an empty file is refused", () => {
    const s = seed();
    expect(M.visionDocAdmission(s, doc("big.md", { size: M.MAX_VISION_DOC_BYTES }))).toBeUndefined();
    expect(M.visionDocAdmission(s, doc("big.md", { size: M.MAX_VISION_DOC_BYTES + 1 }))).toBe("The file is 2.0 MB; the limit is 2.0 MB per file.");
    expect(M.visionDocAdmission(s, doc("big.md", { size: 3 * 1024 * 1024 }))).toBe("The file is 3.0 MB; the limit is 2.0 MB per file.");
    expect(M.visionDocAdmission(s, doc("empty.md", { size: 0 }))).toBe("The file is empty.");
    expect(M.visionDocAdmission(s, doc("neg.md", { size: -1 }))).toMatch(/whole number/);
    expect(M.visionDocAdmission(s, doc("x.md", { hash: "nothex" }))).toMatch(/SHA-256/);
    expect(M.visionDocAdmission(s, doc("../x.md"))).toMatch(/\.\./);
  });

  it("200 files: the 200th is admitted, the 201st refused; a replacement at an existing path does not count as a new file", () => {
    let s = seed();
    for (let i = 1; i <= 200; i++) s = add(s, doc(`f/${i}.txt`, { size: 10, hash: hash(i) }), i);
    expect(M.currentVisionDocs(s)).toHaveLength(200);
    expect(err(() => add(s, doc("f/201.txt", { size: 10, hash: hash(201) }), 201))).toBe("The vision already has 200 documents; remove one first.");
    expect(M.visionDocAdmission(s, doc("f/7.txt", { size: 10, hash: hash(999) }))).toBeUndefined(); // replaces #7
    s = M.removeVisionDoc(s, M.currentVisionDocs(s)[0].id, at(202));
    expect(M.visionDocAdmission(s, doc("f/201.txt", { size: 10, hash: hash(201) }))).toBeUndefined();
  });

  it("20 MB per project: exactly 20 MB is admitted, one byte more refused; removing or replacing frees its share", () => {
    let s = seed();
    const two = M.MAX_VISION_DOC_BYTES;
    for (let i = 1; i <= 10; i++) s = add(s, doc(`big/${i}.txt`, { size: two, hash: hash(i) }), i);
    expect(M.visionDocsBytes(M.currentVisionDocs(s))).toBe(M.MAX_VISION_DOCS_BYTES);
    expect(err(() => add(s, doc("one.txt", { size: 1, hash: hash(11) }), 11))).toBe("Attaching one.txt (1 B) would bring the documents to 20 MB; the limit is 20 MB per project.");
    // Replacing big/1.txt with a smaller file frees room.
    s = add(s, doc("big/1.txt", { size: 1000, hash: hash(12) }), 12);
    expect(M.visionDocAdmission(s, doc("one.txt", { size: two - 1000, hash: hash(13) }))).toBeUndefined();
    expect(M.visionDocAdmission(s, doc("one.txt", { size: two - 999, hash: hash(13) }))).toMatch(/limit is 20 MB per project/);
    s = M.removeVisionDoc(s, M.currentVisionDocs(s)[1].id, at(13));
    expect(M.visionDocAdmission(s, doc("one.txt", { size: two, hash: hash(13) }))).toBeUndefined();
  });
});

describe("V4 removal and history", () => {
  it("removing creates a revision without the document; the previous revision still lists it; the registry keeps it", () => {
    let s = add(seed(), doc("a.md", { hash: hash(1) }), 1);
    s = add(s, doc("b.md", { hash: hash(2) }), 2);
    const [a, b] = M.currentVisionDocs(s);
    s = M.removeVisionDoc(s, a.id, at(3));
    expect(M.currentVision(s)).toMatchObject({ rev: 4, author: "user", reason: "Removed a.md", source: { docRemoved: a.id }, docIds: [b.id] });
    expect(paths(s)).toEqual(["b.md"]);
    expect(M.visionDocsOf(s, s.project.visions[2]).map((d) => d.path)).toEqual(["a.md", "b.md"]);
    expect(M.visionDocsOf(s, s.project.visions[1]).map((d) => d.path)).toEqual(["a.md"]);
    expect(M.visionDocsOf(s, s.project.visions[0])).toEqual([]);
    expect(s.project.visionDocs.map((d) => d.id)).toEqual([a.id, b.id]);
    expect(s.events[s.events.length - 1].message).toBe("Vision r4: removed a.md (1 document left; earlier revisions keep it)");
    expect(err(() => M.removeVisionDoc(s, a.id, at(4)))).toBe("a.md is not attached to the current vision (r4).");
    expect(err(() => M.removeVisionDoc(s, "doc-none", at(4)))).toBe("Unknown document doc-none.");
    // Attaching a.md again is a fresh document (new id), not a resurrection.
    s = add(s, doc("a.md", { hash: hash(1) }), 5);
    expect(M.currentVisionDocs(s).map((d) => d.path)).toEqual(["b.md", "a.md"]);
    expect(M.currentVisionDocs(s)[1].id).not.toBe(a.id);
  });

  it("every other revision carries the set forward: a hand edit, the lead's focus change, an accepted draft, an undo", () => {
    // In Vision, where a hand edit of the text goes into force at once (while building it waits in the draft).
    let s = add(inVision(seed(), at(0)), doc("a.md", { hash: hash(1) }), 1);
    const ids = M.currentVision(s).docIds;
    s = M.editVision(s, 2, "New text", "New focus", "edited", at(2));
    expect(M.currentVision(s)).toMatchObject({ rev: 3, text: "New text", docIds: ids });
    s = M.postMessage(s, "focus on speed", at(3));
    const r = M.startLeadRun(s, { provider: "claude", model: "m", trigger: "message" }, at(4));
    s = M.completeLeadRun(r.state, r.runId, { reply: "ok", proposals: [], steer: { reason: "you asked", focus: "Speed" } }, at(5));
    expect(M.currentVision(s)).toMatchObject({ rev: 4, author: "lead", focus: "Speed", docIds: ids });
    s = M.undoSteering(s, s.steering[0].id, undefined, at(6)).state;
    expect(M.currentVision(s)).toMatchObject({ rev: 5, focus: "New focus", docIds: ids });
    s = inVision(s, at(7));
    s = M.postMessage(s, "draft it", at(8));
    const r2 = M.startLeadRun(s, { provider: "claude", model: "m", trigger: "message" }, at(9));
    s = M.completeLeadRun(r2.state, r2.runId, { reply: "ok", proposals: [], vision: { text: "Drafted", focus: "Drafted focus" } }, at(10));
    s = M.acceptVisionDraft(s, M.openVisionDraft(s)!.id, 5, undefined, at(11));
    expect(M.currentVision(s)).toMatchObject({ rev: 6, text: "Drafted", docIds: ids });
    expect(M.currentVisionDocs(s).map((d) => d.path)).toEqual(["a.md"]);
  });

  it("a new project starts with no documents; the sample seed has none; sizes format as people read them", () => {
    const s = add(seed(), doc("a.md"), 1);
    const fresh = M.initProject(s, { name: "N", repoPath: "/tmp/n", vision: "v", focus: "f" }, at(2));
    expect(fresh.project.visionDocs).toEqual([]);
    expect(M.currentVisionDocs(fresh)).toEqual([]);
    expect(M.currentVision(fresh).docIds).toBeUndefined();
    expect(seed().project.visionDocs).toEqual([]);
    expect([M.fmtBytes(0), M.fmtBytes(999), M.fmtBytes(1536), M.fmtBytes(20 * 1024), M.fmtBytes(1.5 * 1024 * 1024), M.fmtBytes(20 * 1024 * 1024)]).toEqual(["0 B", "999 B", "1.5 KB", "20 KB", "1.5 MB", "20 MB"]);
  });
});
