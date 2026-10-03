// ORC-029 pass 2b and pass 5, where state is written: the owner-only start and the owner-only Lock in are structural.
// The store accepts a move from shaping to building only from the owner's startFactory command, and only when it
// recorded exactly one more start. It accepts a new blueprint revision (what the factory builds from) only from the
// owner's lockIn command (exactly one) or startFactory (at most one), and no write may change or remove a revision in
// force. A command with a bug, the scheduler or a runtime report that tries either is refused as a control error,
// logged, and nothing is written. The bugs are injected around the real command table.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as B from "../src/domain/studio/blueprint";
import { startFactoryArgs } from "../src/domain/testing/factory";
import { addScreen, lockInArgs, openRound, peAgrees } from "../src/domain/testing/studio";
import { ControlError, type State } from "../src/domain/types";
import { CommandFailure, Store } from "./store";

/** A bug to inject: after the real command `command` runs, `apply` changes the state it returns. */
const bug = vi.hoisted(() => ({ current: undefined as undefined | { command: string; apply: (s: State) => void } }));

vi.mock("../src/domain/commands", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/domain/commands")>();
  return {
    ...real,
    runCommand: (state: State, name: string, args: unknown, now: string) => {
      const out = real.runCommand(state, name, args, now);
      if (bug.current?.command === name) bug.current.apply(out.state);
      return out;
    },
  };
});

let dir: string;
let store: Store;
let key = 0;
const iso = () => new Date(Date.parse("2026-10-02T09:00:00Z") + key * 1000).toISOString();
const cmd = (name: string, args: object = {}, k = `k${++key}`) => store.command(name, args, k, iso());
const stage = () => store.read().state.project.stage;
let logged: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orc029-guard-"));
  store = new Store(join(dir, "db.sqlite"));
  cmd("initProject", { name: "P", repoPath: join(dir, "repo"), vision: "A calm trip planner.", focus: "" });
  bug.current = undefined;
  logged = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  logged.mockRestore();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The command is refused as a control error, logged, and the stored state is exactly as it was. */
function expectRefused(run: () => unknown, by: RegExp) {
  const before = store.read();
  let thrown: unknown;
  try {
    run();
  } catch (e) {
    thrown = e;
  }
  expect(thrown instanceof CommandFailure ? thrown.kind : thrown instanceof ControlError ? "control" : thrown).toBe("control");
  expect((thrown as Error).message).toMatch(/^Refused: only the owner's Start the factory moves the project from Vision to the factory/);
  expect((thrown as Error).message).toMatch(by);
  expect(logged).toHaveBeenCalledWith(expect.stringContaining((thrown as Error).message));
  expect(store.read()).toEqual(before);
  expect(stage()).toBe("shaping");
}

describe("the owner-only start, where state is written", () => {
  it("another command that moves the project to building is refused, logged, recorded as refused, and nothing is written", () => {
    bug.current = { command: "markVisited", apply: (s) => void (s.project.stage = "building") };
    expectRefused(() => cmd("markVisited", {}, "visit-1"), /the markVisited command tried to/);
    // A retry with the same key reports the same refusal; nothing is applied.
    expect(() => cmd("markVisited", {}, "visit-1")).toThrow(/^Refused: only the owner's Start the factory/);
    expect(stage()).toBe("shaping");
  });

  it("a command that also writes a start record is still refused: only startFactory may", () => {
    bug.current = {
      command: "setDevices",
      apply: (s) => {
        s.project.stage = "building";
        s.project.factoryStarts.push({ at: iso(), by: "user" } as State["project"]["factoryStarts"][number]);
      },
    };
    expectRefused(() => cmd("setDevices", { devices: ["desktop"] }), /the setDevices command tried to/);
  });

  it("startFactory is refused when it did not record exactly one more start", () => {
    bug.current = { command: "startFactory", apply: (s) => void s.project.factoryStarts.pop() };
    expectRefused(() => cmd("startFactory", startFactoryArgs(store.read().state)), /recorded 0 starts, not 1/);
    bug.current = { command: "startFactory", apply: (s) => void s.project.factoryStarts.push(structuredClone(s.project.factoryStarts[0])) };
    expectRefused(() => cmd("startFactory", startFactoryArgs(store.read().state)), /recorded 2 starts, not 1/);
  });

  it("an internal update (the scheduler, a runtime report) that moves the project to building is refused, logged, and nothing is written", () => {
    expectRefused(
      () =>
        store.update((s) => {
          const next = structuredClone(s);
          next.project.stage = "building";
          return next;
        }, iso()),
      /an internal update tried to/,
    );
  });

  it("an internal update that changes the state it was given in place is judged against what is stored", () => {
    // Review finding 14: the guard compared the state objects, so an in-place change looked like no change.
    expectRefused(
      () =>
        store.update((s) => {
          s.project.stage = "building";
          return s;
        }, iso()),
      /an internal update tried to/,
    );
  });

  it("the owner's startFactory is accepted with its one record; a reset to the sample, and every other write are untouched", () => {
    cmd("startFactory", startFactoryArgs(store.read().state));
    expect(stage()).toBe("building");
    expect(store.read().state.project.factoryStarts).toHaveLength(1);
    // Writes within a stage are not the guard's.
    store.update((s) => ({ ...s, project: { ...s.project, name: "Renamed" } }), iso());
    expect(store.read().state.project.name).toBe("Renamed");
    // Replacing everything with the sample project (fake runtime only) is a new project, not a start.
    cmd("resetSampleData");
    expect(store.read().state.project).toMatchObject({ sample: true, stage: "building" });
    expect(logged).not.toHaveBeenCalled();
  });
});

describe("the owner-only Lock in, where state is written (pass 5)", () => {
  /** A screen the PE agreed to, ready for the owner's approval (the studio's work, written as the service writes it). */
  function agreed(title: string): string {
    let id = "";
    store.update((s) => {
      const open = s.studio.rounds.find((r) => !r.closedAt) ? { state: s, n: s.studio.rounds.at(-1)!.n } : openRound(s, "experience", iso());
      const a = addScreen(open.state, open.n, iso(), { title, variants: [] });
      id = a.id;
      return peAgrees(a.state, a.id, 1, [], iso());
    }, iso());
    return id;
  }
  /** The owner approves it into the draft. */
  const approved = (title: string) => cmd("approveArtifact", { artifactId: agreed(title), version: 1 });
  const blueprint = () => store.read().state.blueprint;
  /** The write is refused as a control error, logged, and the stored state is exactly as it was. */
  function expectRefusedRevision(run: () => unknown, by: RegExp) {
    const before = store.read();
    let thrown: unknown;
    try {
      run();
    } catch (e) {
      thrown = e;
    }
    expect(thrown instanceof CommandFailure ? thrown.kind : thrown instanceof ControlError ? "control" : thrown).toBe("control");
    expect((thrown as Error).message).toMatch(/^Refused: only the owner's Lock in puts the blueprint into force/);
    expect((thrown as Error).message).toMatch(by);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining((thrown as Error).message));
    expect(store.read()).toEqual(before);
  }
  /** A revision as a buggy write would add it: the draft as it stands, put into force. */
  const sneak = (s: State) => void s.blueprint.revisions.push({ rev: B.blueprintRev(s) + 1, at: iso(), visionRev: 1, reason: "sneaked in", items: structuredClone(s.blueprint.draft.items) });

  it("Start the factory locks the draft in (one revision), and the owner's lockIn adds exactly one more", () => {
    approved("Trail search");
    cmd("startFactory", startFactoryArgs(store.read().state));
    expect(blueprint().revisions.map((r) => r.rev)).toEqual([1]);
    approved("Packing list");
    expect(blueprint().revisions).toHaveLength(1); // an approval changes only the draft
    cmd("lockIn", lockInArgs(store.read().state));
    expect(blueprint().revisions.map((r) => r.rev)).toEqual([1, 2]);
    expect(logged).not.toHaveBeenCalled();
  });

  it("another command, a command of the owner's included, that makes a revision is refused, logged, and nothing is written", () => {
    approved("Trail search");
    cmd("startFactory", startFactoryArgs(store.read().state));
    approved("Packing list");
    const group = agreed("Group page");
    bug.current = { command: "approveArtifact", apply: sneak };
    expectRefusedRevision(() => cmd("approveArtifact", { artifactId: group, version: 1 }), /the approveArtifact command made a revision/);
    bug.current = { command: "markVisited", apply: sneak };
    expectRefusedRevision(() => cmd("markVisited"), /the markVisited command made a revision/);
    bug.current = { command: "discardDraft", apply: sneak };
    expectRefusedRevision(() => cmd("discardDraft", { draftRev: blueprint().draft.rev }), /the discardDraft command made a revision/);
  });

  it("lockIn may add exactly one revision, and startFactory at most one", () => {
    approved("Trail search");
    bug.current = { command: "startFactory", apply: sneak };
    expectRefusedRevision(() => cmd("startFactory", startFactoryArgs(store.read().state)), /the startFactory command made 2 revisions/);
    bug.current = undefined;
    cmd("startFactory", startFactoryArgs(store.read().state));
    approved("Packing list");
    bug.current = { command: "lockIn", apply: sneak };
    expectRefusedRevision(() => cmd("lockIn", lockInArgs(store.read().state)), /the lockIn command made 2 revisions/);
  });

  it("no write may change or remove a revision in force: not the owner's lockIn, not an internal update", () => {
    approved("Trail search");
    cmd("startFactory", startFactoryArgs(store.read().state));
    approved("Packing list");
    bug.current = { command: "lockIn", apply: (s) => void (s.blueprint.revisions[0].items = []) };
    expectRefusedRevision(() => cmd("lockIn", lockInArgs(store.read().state)), /the lockIn command changed or removed a revision in force/);
    expectRefusedRevision(
      () =>
        store.update((s) => {
          const next = structuredClone(s);
          next.blueprint.revisions.pop();
          return next;
        }, iso()),
      /an internal update changed or removed a revision in force/,
    );
    // An internal update (the scheduler, a runtime report, a lead run's result) that adds one is refused too.
    expectRefusedRevision(
      () =>
        store.update((s) => {
          const next = structuredClone(s);
          sneak(next);
          return next;
        }, iso()),
      /an internal update made a revision/,
    );
    expect(blueprint().revisions).toHaveLength(1);
  });

  it("an internal update that changes or adds a revision in place, on the state it was given, is refused too", () => {
    approved("Trail search");
    cmd("startFactory", startFactoryArgs(store.read().state));
    const inForce = blueprint().revisions;
    expectRefusedRevision(
      () =>
        store.update((s) => {
          s.blueprint.revisions[0].items = [];
          return s;
        }, iso()),
      /an internal update changed or removed a revision in force/,
    );
    expectRefusedRevision(
      () =>
        store.update((s) => {
          sneak(s);
          return s;
        }, iso()),
      /an internal update made a revision/,
    );
    expect(blueprint().revisions).toEqual(inForce);
  });

  it("a new project and a reset to the sample start a new blueprint: not a Lock in", () => {
    approved("Trail search");
    cmd("startFactory", startFactoryArgs(store.read().state));
    expect(blueprint().revisions).toHaveLength(1);
    cmd("initProject", { name: "Q", repoPath: join(dir, "repo2"), vision: "Another planner.", focus: "" });
    expect(blueprint().revisions).toEqual([]);
    expect(logged).not.toHaveBeenCalled();
  });
});
