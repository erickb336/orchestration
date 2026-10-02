// ORC-029 pass 2b, where state is written: the owner-only start is structural. The store accepts a move from
// shaping to building only from the owner's startFactory command, and only when it recorded exactly one more
// start. A command with a bug, the scheduler or a runtime report that tries it is refused as a control error,
// logged, and nothing is written. The bugs are injected around the real command table.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startFactoryArgs } from "../src/domain/testing/factory";
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

  it("the owner's startFactory is accepted with its one record; leaving the factory, a reset to the sample, and every other write are untouched", () => {
    cmd("startFactory", startFactoryArgs(store.read().state));
    expect(stage()).toBe("building");
    expect(store.read().state.project.factoryStarts).toHaveLength(1);
    // Building to shaping, and writes within a stage, are not the guard's.
    cmd("startVision");
    expect(stage()).toBe("shaping");
    store.update((s) => ({ ...s, project: { ...s.project, name: "Renamed" } }), iso());
    expect(store.read().state.project.name).toBe("Renamed");
    // Replacing everything with the sample project (fake runtime only) is a new project, not a start.
    cmd("resetSampleData");
    expect(store.read().state.project).toMatchObject({ sample: true, stage: "building" });
    expect(logged).not.toHaveBeenCalled();
  });
});
