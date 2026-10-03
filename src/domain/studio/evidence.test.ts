// ORC-029 pass 5, evidence of what the factory built: the owner's preview setting (only the owner's command sets it,
// and it is checked like the check commands), what a capture run captures (the screens, demos and TUIs the task's spec
// cites), and the record per blueprint item: the newest run's evidence, naming its commit and design version, or why
// there is none.

import { describe, expect, it } from "vitest";
import { ControlError, runCommand } from "../commands";
import * as M from "../model";
import { buildSeed } from "../seed";
import type { Artifact, SpecContent, State } from "../types";
import type { BlueprintItem } from "./types";
import * as E from "./evidence";

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

  it("takes npm ci --ignore-scripts when no install is given, and runs none for an empty list", () => {
    expect(ok({ preview: ["npm", "run", "preview", "--", "--port", "4173"], port: 4173 })).toEqual({ install: ["npm", "ci", "--ignore-scripts"], preview: ["npm", "run", "preview", "--", "--port", "4173"], port: 4173 });
    expect(ok({ install: [], cliEntry: "bin/trips.js" })).toEqual({ install: [], cliEntry: "bin/trips.js" });
  });

  it("gives the network only to a download with every install hook off", () => {
    expect(refused({ install: ["npm", "ci"] })).toMatch(/--ignore-scripts/);
    expect(refused({ install: ["npm", "ci", "--ignore-scripts", "--no-ignore-scripts"] })).toMatch(/network/);
    expect(refused({ install: ["npm", "run", "build"] })).toMatch(/prepare command/);
    expect(refused({ install: ["bun", "install", "--ignore-scripts"] })).toMatch(/bun installs run offline/);
    expect(refused({ install: ["node", "setup.js"] })).toMatch(/download by npm, pnpm or yarn/);
    expect(ok({ install: ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts", "--ignore-pnpmfile"] }).install[0]).toBe("pnpm");
  });

  it("checks the preview command like a check command, and wants its port", () => {
    expect(refused({ preview: ["bash", "-c", "vite preview"], port: 4173 })).toMatch(/not one of the programs/);
    expect(refused({ preview: ["node", "-e", "require('http')"], port: 4173 })).toMatch(/inline code/);
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
    expect(s.project.preview).toEqual({ rev: 1, install: ["npm", "ci", "--ignore-scripts"], preview: ["npm", "run", "preview"], port: 4173, cliEntry: "bin/trips.js" });
    expect(s.events.at(-1)).toMatchObject({ actor: "user", kind: "config", message: "Preview r1: install `npm ci --ignore-scripts`, preview `npm run preview` on port 4173, CLI entry `bin/trips.js`" });
    expect(runCommand(s, "setPreview", { preview: { preview: ["npm", "run", "preview"], port: 4173, cliEntry: "bin/trips.js" } }, at(2)).state).toBe(s);
    s = runCommand(s, "setPreview", { preview: { install: [], preview: ["npm", "run", "preview"], port: 4174 } }, at(3)).state;
    expect(s.project.preview).toEqual({ rev: 2, install: [], preview: ["npm", "run", "preview"], port: 4174 });
    expect(failure(() => runCommand(s, "setPreview", { preview: { install: ["npm", "ci"] } }, at(4)))).toBeInstanceOf(ControlError);
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
    const run = E.notSetUpRun({ target: { artifactId: "art-1", ref: SHA }, items: [item("bi-1"), item("bi-3")] }, at(20));
    expect(run.items.map((i) => i.status === "none" && i.reason)).toEqual(["not-set-up", "not-set-up"]);
    expect(E.evidenceSummary(run)).toMatch(/^Evidence of aaaaaaaaaaaa: 0 of 2 items captured\.\n- bi-1 Trip board \(screen v2\): no evidence, not set up\. The project has no preview setting/);
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

  it("a simulated run is labelled as simulated", () => {
    const t = taskCiting(withBlueprint(fresh()), ["bi-1"], 10);
    const s = capture(t.s, t.id, { sha: SHA, at: at(30), durationMs: 0, simulated: true, items: [E.noCapture(item("bi-1"), "simulated", "The fake runtime ran nothing.")] }, 30);
    expect(E.itemEvidence(s, "bi-1")).toMatchObject({ status: "none", reason: "simulated", from: { simulated: true } });
    expect(s.artifacts.at(-1)!.summary).toMatch(/^\(simulated\) Evidence of aaaaaaaaaaaa/);
  });
});
