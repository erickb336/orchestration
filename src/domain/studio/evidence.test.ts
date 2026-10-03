// ORC-029 pass 5, evidence of what the factory built: the owner's preview setting (only the owner's command sets it;
// it runs only in the project's environment, so only its shape is checked), what a capture run captures (the screens, demos and TUIs the task's spec
// cites), and the record per blueprint item: the newest run's evidence, naming its commit and design version, or why
// there is none.

import { describe, expect, it } from "vitest";
import { ControlError, runCommand } from "../commands";
import * as M from "../model";
import { buildSeed } from "../seed";
import type { Artifact, SpecContent, State } from "../types";
import type { BlueprintItem } from "./types";
import * as E from "./evidence";
import { IMAGE_TABLE } from "../environment";

const T0 = Date.parse("2026-10-01T12:00:00Z");
const IMAGE = IMAGE_TABLE[0].image;
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

describe("the preview setting", () => {
  const ok = (input: E.PreviewInput) => {
    const r = E.normalizePreview(input);
    if ("refused" in r) throw new Error(r.refused);
    return r;
  };
  const refused = (input: E.PreviewInput) => {
    const r = E.normalizePreview(input);
    if (!("refused" in r)) throw new Error("expected a refusal");
    return r.refused;
  };

  it("has no install: the project's environment prepares the copy (ORC-030 C3)", () => {
    expect(ok({ preview: ["npm", "run", "preview", "--", "--port", "4173"], port: 4173 })).toEqual({ preview: ["npm", "run", "preview", "--", "--port", "4173"], port: 4173 });
    expect(ok({ cliEntry: "bin/trips.js" })).toEqual({ cliEntry: "bin/trips.js" });
    expect(refused({})).toMatch(/Give the preview command and its port, or the CLI entry/);
  });

  it("takes any program as the preview, for any language, and checks only the command's shape; it wants its port", () => {
    // It runs only in the project's container with no network, as the environment's prepare commands do.
    for (const preview of [["python3", "-m", "http.server", "8000"], ["go", "run", "./cmd/web"], ["bundle", "exec", "rails", "server"], ["bash", "-c", "vite preview"]]) expect(ok({ preview, port: 8000 }).preview).toEqual(preview);
    expect(refused({ preview: ["--port", "4173"], port: 4173 })).toMatch(/^The preview command: the first argument is the program/);
    expect(refused({ preview: ["npm", "run\npreview"], port: 4173 })).toMatch(/no newline/);
    expect(refused({ preview: ["npm", "run", "preview"] })).toMatch(/go together/);
    expect(refused({ port: 4173 })).toMatch(/go together/);
    expect(refused({ preview: ["npm", "run", "preview"], port: 80 })).toMatch(/1024 to 65535/);
    expect(refused({ preview: ["npm", "run", "preview"], port: 4173.5 })).toMatch(/whole number/);
    expect(ok({ preview: ["node", "server.js"], port: 8080 }).preview).toEqual(["node", "server.js"]);
  });

  it("takes a CLI entry only as a plain path inside the repository", () => {
    for (const p of ["../bin/x.js", "/usr/bin/node", "bin/$(x).js", "bin//x.js", ""]) expect(refused({ cliEntry: p })).toMatch(/not a file path inside the repository/);
  });

  it("only the owner's command sets it; a change bumps its revision, the same setting changes nothing, and null clears it", () => {
    let s = fresh();
    expect(s.project.preview).toBeUndefined();
    s = runCommand(s, "setPreview", { preview: { preview: ["npm", "run", "preview"], port: 4173, cliEntry: "bin/trips.js" } }, at(1)).state;
    expect(s.project.preview).toEqual({ rev: 1, preview: ["npm", "run", "preview"], port: 4173, cliEntry: "bin/trips.js" });
    expect(s.events.at(-1)).toMatchObject({ actor: "user", kind: "config", message: "Preview r1: preview `npm run preview` on port 4173, CLI entry `bin/trips.js`" });
    expect(runCommand(s, "setPreview", { preview: { preview: ["npm", "run", "preview"], port: 4173, cliEntry: "bin/trips.js" } }, at(2)).state).toBe(s);
    s = runCommand(s, "setPreview", { preview: { preview: ["npm", "run", "preview"], port: 4174 } }, at(3)).state;
    expect(s.project.preview).toEqual({ rev: 2, preview: ["npm", "run", "preview"], port: 4174 });
    expect(failure(() => runCommand(s, "setPreview", { preview: { port: 4174 } }, at(4)))).toBeInstanceOf(ControlError);
    s = runCommand(s, "setPreview", { preview: null }, at(5)).state;
    expect(s.project.preview).toBeUndefined();
    expect(s.events.at(-1)?.message).toMatch(/Preview cleared/);
  });
});

// ---------- what a run captures, and the record per item ----------

const ITEMS: BlueprintItem[] = [
  { id: "bi-1", kind: "screen", title: "Trip board", artifactId: "sa-1", version: 2, variant: "B", status: "approved" },
  { id: "bi-2", kind: "flow", title: "Joining a trip", artifactId: "sa-2", version: 1, status: "approved" },
  { id: "bi-3", kind: "terminal-demo", title: "trips CLI", artifactId: "sa-3", version: 1, status: "approved" },
  { id: "bi-4", kind: "tui", title: "Packing TUI", artifactId: "sa-4", version: 1, status: "open" },
];

function withBlueprint(s: State, items = ITEMS, rev = 1): State {
  const next = structuredClone(s);
  next.blueprint.revisions.push({ rev, at: at(rev), visionRev: 1, reason: "approved", items: structuredClone(items) });
  return next;
}

function taskCiting(s: State, refs: string[], sec: number): { s: State; id: string } {
  const c = runCommand(s, "createTask", { title: `Build ${refs.join(" ")}`, area: "Trips", outcome: "x", benefit: "", whyNow: "", approach: "y", acceptance: ["ok"], priority: 1, holdBeforeStart: true, flowId: "feature" }, at(sec));
  const id = (c.result as { newId: string }).newId;
  const t = c.state.tasks.find((x) => x.id === id)!;
  const content: SpecContent = { ...M.currentSpec(t).content, blueprintRefs: refs };
  return { s: runCommand(c.state, "editSpec", { taskId: id, expectedRev: 1, content, reason: "Cites the blueprint" }, at(sec)).state, id };
}

const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);

/** An evidence artifact as the service records it after a capture run of `taskId`. */
function capture(s: State, taskId: string, run: E.EvidenceRun, sec: number, o: { user?: true } = {}): State {
  const next = structuredClone(s);
  const n = next.artifacts.length + 1;
  const art: Artifact = { id: `art-ev-${n}`, taskId, stepId: "E1", attemptId: o.user ? "edit" : `run-ev-${n}`, name: "evidence", kind: "evidence", version: 1, summary: E.evidenceSummary(run), createdAt: at(sec), evidence: run, ...(o.user ? { author: "user" as const } : {}) };
  next.artifacts.push(art);
  return next;
}

const item = (id: string): E.CaptureItem => {
  const i = ITEMS.find((x) => x.id === id)!;
  return { itemId: i.id, kind: i.kind as E.CapturedKind, title: i.title, artifactId: i.artifactId, version: i.version, ...(i.variant ? { variant: i.variant } : {}) };
};
const png = (itemId: string, device: E.CaptureDevice): E.EvidenceFile => ({ path: `${itemId}/${device}.png`, type: "png", device, bytes: 1000, sha256: "c".repeat(64) });

describe("what a capture run captures", () => {
  it("the screens, terminal demos and TUIs the task's spec cites, in its order; flows are proved by tests instead", () => {
    const { s, id } = taskCiting(withBlueprint(fresh()), ["bi-4", "bi-2", "bi-1", "bi-3"], 10);
    expect(E.captureItems(s, s.tasks.find((t) => t.id === id)!).map((i) => i.itemId)).toEqual(["bi-4", "bi-1", "bi-3"]);
    expect(E.captureItems(s, s.tasks.find((t) => t.id === id)!)[1]).toEqual(item("bi-1"));
  });

  it("without a preview setting every item records not set up, and the summary says so", () => {
    const run = E.notSetUpRun({ target: { artifactId: "art-1", ref: SHA }, items: [item("bi-1"), item("bi-3")] }, at(20), E.notSetUpReason(fresh())!);
    expect(run.items.map((i) => i.status === "none" && i.reason)).toEqual(["not-set-up", "not-set-up"]);
    expect(E.evidenceSummary(run)).toMatch(/^Evidence of aaaaaaaaaaaa: 0 of 2 items captured\.\n- bi-1 Trip board \(screen v2\): no evidence, not set up\. The project has no preview setting/);
  });

  it("needs the preview setting and an environment: an image or a dev container the owner confirmed", () => {
    let s = runCommand(fresh(), "setPreview", { preview: { preview: ["npm", "run", "preview"], port: 4173 } }, at(1)).state;
    expect(E.notSetUpReason(s)).toBe("The project has no environment, so nothing ran: evidence runs only in the project's own container. Set an image, or confirm the repository's dev container, in Settings › How your project runs.");
    // Prepare commands alone are no environment.
    s = runCommand(s, "setEnvironment", { environment: { prepare: [["npm", "ci"]] } }, at(2)).state;
    expect(E.notSetUpReason(s)).toMatch(/no environment/);
    expect(E.notSetUpReason(runCommand(s, "setEnvironment", { environment: { image: IMAGE, prepare: [["npm", "ci"]] } }, at(3)).state)).toBeUndefined();
    expect(E.notSetUpReason(runCommand(s, "setEnvironment", { environment: { devcontainer: { file: ".devcontainer/devcontainer.json", sha256: "d".repeat(64) } } }, at(3)).state)).toBeUndefined();
  });
});

describe("the Capture evidence step of the Feature flow", () => {
  const running = (s: State, id: string) => M.activeAttempts(s, id);
  const step = (s: State, id: string, stepId: string) => s.tasks.find((t) => t.id === id)!.steps.find((x) => x.id === stepId)!;
  /** A Feature task citing `refs`, on a building project with checks off, run through design and implementation at SHA. */
  function implemented(refs: string[], preview?: E.PreviewInput, environment?: object) {
    let s = buildSeed(T0, { inFlightRuns: false });
    for (const t of s.tasks) t.hold = true;
    if (preview) s = runCommand(s, "setPreview", { preview }, at(1)).state;
    if (environment) s = runCommand(s, "setEnvironment", { environment }, at(1)).state;
    const c = taskCiting(withBlueprint(s), refs, 2);
    s = runCommand(c.s, "startHeldTask", { taskId: c.id }, at(3)).state;
    s = M.dispatchEligible(M.leadPromoteProposals(s, at(4)), at(4));
    s = M.reportCompletion(s, running(s, c.id)[0].id, [], at(5), [{ name: "design", summary: "the design" }]);
    s = M.dispatchEligible(s, at(6));
    s = M.reportCompletion(s, running(s, c.id)[0].id, [], at(7), [{ name: "change", summary: "done", ref: `${SHA.slice(0, 12)} on b` }, { name: "handoff", summary: "h" }]);
    return { s: M.dispatchEligible(s, at(8)), id: c.id };
  }

  it("is skipped, with the reason, when the task's spec cites no screen, terminal demo or TUI; the UX review still runs", () => {
    const { s, id } = implemented(["bi-2"]);
    expect(step(s, id, "C1").state).toBe("skipped");
    expect(step(s, id, "E1").state).toBe("skipped");
    expect(s.events.some((e) => e.taskId === id && e.message === "Skipped E1: nothing to capture: the task's spec cites no screen, terminal demo or TUI of the blueprint")).toBe(true);
    expect(running(s, id).map((a) => a.stepId).sort()).toEqual(["S3", "S4", "SR1"]);
  });

  it("without a preview setting, records every cited item as not set up at once, and the UX review reads that record", () => {
    let { s, id } = implemented(["bi-1", "bi-2", "bi-3"]);
    const art = s.artifacts.find((a) => a.taskId === id && a.stepId === "E1")!;
    expect(art.kind).toBe("evidence");
    expect(art.evidence).toMatchObject({ sha: SHA.slice(0, 12), durationMs: 0, items: [{ itemId: "bi-1", status: "none", reason: "not-set-up" }, { itemId: "bi-3", status: "none", reason: "not-set-up" }] });
    expect(step(s, id, "E1").state).toBe("done");
    expect(s.attempts.find((a) => a.id === art.attemptId)).toMatchObject({ outcome: "completed", snapshot: { provider: "service", model: "evidence", role: "evidence", evidence: { target: { ref: SHA.slice(0, 12) }, items: [item("bi-1"), item("bi-3")] } } });
    s = M.dispatchEligible(s, at(9));
    const ux = running(s, id).find((a) => a.stepId === "S4")!;
    expect(ux.snapshot.inputs.map((i) => `${i.step}.${i.output}`)).toEqual(["S1.design", "S2.change", "E1.evidence"]);
    expect(E.itemEvidence(s, "bi-1")).toMatchObject({ status: "none", reason: "not-set-up", commit: SHA.slice(0, 12), from: { taskId: id } });
  });

  it("with a preview setting but no environment, records every cited item as not set up at once, saying what to set", () => {
    const { s, id } = implemented(["bi-1", "bi-3"], { preview: ["npm", "run", "preview"], port: 4173, cliEntry: "bin/trips.js" });
    const art = s.artifacts.find((a) => a.taskId === id && a.stepId === "E1")!;
    expect(art.evidence?.items.map((i) => i.status === "none" && `${i.reason}: ${i.detail}`)).toEqual([
      "not-set-up: The project has no environment, so nothing ran: evidence runs only in the project's own container. Set an image, or confirm the repository's dev container, in Settings › How your project runs.",
      "not-set-up: The project has no environment, so nothing ran: evidence runs only in the project's own container. Set an image, or confirm the repository's dev container, in Settings › How your project runs.",
    ]);
    expect(step(s, id, "E1").state).toBe("done");
    expect(M.activeServiceAttempts(s)).toEqual([]);
  });

  it("with a preview setting and an environment, starts one service capture with its snapshot; it is not a check run, and its report becomes the artifact's record", () => {
    let { s, id } = implemented(["bi-1"], { preview: ["npm", "run", "preview"], port: 4173 }, { image: IMAGE });
    const cap = running(s, id).find((a) => a.stepId === "E1")!;
    expect(cap.snapshot).toMatchObject({ provider: "service", model: "evidence", routingReason: "Run by the service in the project's environment (preview r1, environment r1)", evidence: { target: { ref: SHA.slice(0, 12) }, items: [item("bi-1")], preview: { rev: 1, preview: ["npm", "run", "preview"], port: 4173 } } });
    expect(M.activeServiceAttempts(s)).toEqual([]);
    // The UX review waits for the evidence.
    expect(step(s, id, "S4").state).toBe("pending");
    const run: E.EvidenceRun = { sha: SHA, at: at(9), durationMs: 20_000, previewRev: 1, items: [{ ...item("bi-1"), status: "captured", files: [png("bi-1", "desktop")] }] };
    s = M.reportCompletion(s, cap.id, [], at(9), [{ name: "evidence", summary: E.evidenceSummary(run), evidence: run }]);
    expect(s.artifacts.find((a) => a.attemptId === cap.id)?.evidence).toEqual(run);
    expect(E.itemEvidence(s, "bi-1")).toMatchObject({ status: "captured", commit: SHA, files: [png("bi-1", "desktop")] });
    s = M.dispatchEligible(s, at(10));
    expect(running(s, id).some((a) => a.stepId === "S4")).toBe(true);
  });
});

describe("the record per blueprint item", () => {
  it("names the commit and the design version it shows, and serves only the files it recorded", () => {
    const t = taskCiting(withBlueprint(fresh()), ["bi-1", "bi-3"], 10);
    const s = capture(t.s, t.id, { sha: SHA, at: at(30), durationMs: 9000, previewRev: 1, items: [{ ...item("bi-1"), status: "captured", files: [png("bi-1", "desktop"), png("bi-1", "mobile")] }, E.noCapture(item("bi-3"), "capture-failed", "VHS failed", "panic: boom\n")] }, 30);
    expect(E.itemEvidence(s, "bi-1")).toEqual({
      itemId: "bi-1",
      title: "Trip board",
      kind: "screen",
      design: { artifactId: "sa-1", version: 2, variant: "B" },
      current: true,
      commit: SHA,
      at: at(30),
      from: { taskId: t.id, attemptId: "run-ev-" + s.artifacts.length, artifactId: "art-ev-" + s.artifacts.length, landed: false },
      status: "captured",
      files: [png("bi-1", "desktop"), png("bi-1", "mobile")],
    });
    expect(E.itemEvidence(s, "bi-3")).toMatchObject({ status: "none", reason: "capture-failed", detail: "VHS failed", log: "panic: boom", commit: SHA, design: { artifactId: "sa-3", version: 1 } });
    expect(E.itemEvidence(s, "bi-4")).toEqual({ itemId: "bi-4", title: "Packing TUI", kind: "tui", status: "no-run" });
    expect(E.itemEvidence(s, "bi-2")).toBeUndefined();
    const runId = `run-ev-${s.artifacts.length}`;
    expect(E.evidenceFileKnown(s, runId, "bi-1/desktop.png")).toBe(true);
    expect(E.evidenceFileKnown(s, runId, "bi-3/demo.gif")).toBe(false);
    expect(E.evidenceFileKnown(s, "run-other", "bi-1/desktop.png")).toBe(false);
    expect(E.blueprintEvidence(s).map((r) => [r.itemId, r.status])).toEqual([
      ["bi-1", "captured"],
      ["bi-3", "none"],
      ["bi-4", "no-run"],
    ]);
  });

  it("the newest run decides, landed work before work in progress; a cancelled task and a person's edit never count", () => {
    const a = taskCiting(withBlueprint(fresh()), ["bi-1"], 10);
    const b = taskCiting(a.s, ["bi-1"], 11);
    let s = capture(b.s, a.id, { sha: SHA, at: at(30), durationMs: 1, items: [{ ...item("bi-1"), status: "captured", files: [png("bi-1", "desktop")] }] }, 30);
    s = capture(s, b.id, { sha: SHA2, at: at(40), durationMs: 1, items: [E.noCapture(item("bi-1"), "preview-did-not-start", "port 4173 never opened")] }, 40);
    expect(E.itemEvidence(s, "bi-1")).toMatchObject({ commit: SHA2, status: "none", reason: "preview-did-not-start" });
    // a's work landed: it decides over b's newer work in progress.
    const landed = structuredClone(s);
    landed.tasks.find((t) => t.id === a.id)!.integration = { landed: { at: at(50) } } as never;
    expect(E.itemEvidence(landed, "bi-1")).toMatchObject({ commit: SHA, status: "captured", from: { taskId: a.id, landed: true } });
    // b cancelled: its run is not evidence of anything.
    const cancelled = structuredClone(s);
    cancelled.tasks.find((t) => t.id === b.id)!.lifecycle = "cancelled";
    expect(E.itemEvidence(cancelled, "bi-1")).toMatchObject({ commit: SHA, status: "captured" });
    // A person's edit of the output is not a capture.
    const edited = capture(s, b.id, { sha: SHA2, at: at(60), durationMs: 1, items: [{ ...item("bi-1"), status: "captured", files: [png("bi-1", "mobile")] }] }, 60, { user: true });
    expect(E.itemEvidence(edited, "bi-1")).toMatchObject({ commit: SHA2, status: "none" });
  });

  it("evidence of an older design version stays, marked as not current", () => {
    const t = taskCiting(withBlueprint(fresh()), ["bi-1"], 10);
    let s = capture(t.s, t.id, { sha: SHA, at: at(30), durationMs: 1, items: [{ ...item("bi-1"), status: "captured", files: [png("bi-1", "desktop")] }] }, 30);
    s = withBlueprint(s, ITEMS.map((i) => (i.id === "bi-1" ? { ...i, version: 3 } : i)), 2);
    expect(E.itemEvidence(s, "bi-1")).toMatchObject({ design: { artifactId: "sa-1", version: 2, variant: "B" }, current: false, status: "captured" });
  });

  it("says which path made it: the project's environment (with its image and prepare) or the recorder's image", () => {
    const t = taskCiting(withBlueprint(fresh()), ["bi-1", "bi-3"], 10);
    const env: E.EvidencePath = { via: "environment", from: "setting", image: `python:3.13-slim@sha256:${"b".repeat(64)}`, imageId: `sha256:${"c".repeat(64)}`, prepare: "reused", key: "0123456789abcdef" };
    const cast = { path: "bi-3/session.cast", type: "cast" as const, bytes: 900, sha256: "d".repeat(64) };
    let s = capture(t.s, t.id, { sha: SHA, at: at(30), durationMs: 1, path: env, items: [{ ...item("bi-1"), status: "captured", files: [png("bi-1", "desktop")] }, { ...item("bi-3"), status: "captured", files: [cast] }] }, 30);
    expect(E.itemEvidence(s, "bi-1")).toMatchObject({ path: env, commit: SHA, design: { version: 2 } });
    expect(E.itemEvidence(s, "bi-3")).toMatchObject({ path: env, status: "captured", files: [cast] });
    expect(s.artifacts.at(-1)!.summary).toMatch(/captured in the project's environment \(the confirmed image python:3\.13-slim@sha256:bbbbbbbbbbbb…, its prepare reused\)\./);
    s = capture(s, t.id, { sha: SHA2, at: at(40), durationMs: 1, path: { via: "recorder", image: "orchestrator-recorder:2" }, items: [{ ...item("bi-1"), status: "captured", files: [png("bi-1", "mobile")] }] }, 40);
    expect(E.itemEvidence(s, "bi-1")).toMatchObject({ path: { via: "recorder", image: "orchestrator-recorder:2" }, commit: SHA2 });
    expect(s.artifacts.at(-1)!.summary).toMatch(/captured in the recorder's image orchestrator-recorder:2\./);
  });

  it("a simulated run is labelled as simulated", () => {
    const t = taskCiting(withBlueprint(fresh()), ["bi-1"], 10);
    const s = capture(t.s, t.id, { sha: SHA, at: at(30), durationMs: 0, simulated: true, items: [E.noCapture(item("bi-1"), "simulated", "The fake runtime ran nothing.")] }, 30);
    expect(E.itemEvidence(s, "bi-1")).toMatchObject({ status: "none", reason: "simulated", from: { simulated: true } });
    expect(s.artifacts.at(-1)!.summary).toMatch(/^\(simulated\) Evidence of aaaaaaaaaaaa/);
  });
});
