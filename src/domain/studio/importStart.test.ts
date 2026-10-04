// ORC-032 R1-A, the start of an import from the running sample (QA-F2): the sample's simulated runs are paused and
// the start waits for them; the service starts the import once none is active. On tally (sample data).

import { describe, expect, it } from "vitest";
import * as M from "../model";
import { buildSeed } from "../seed";
import { TALLY_START, T0, at } from "../testing/import";
import { run } from "../testing/studio";
import { ControlError, type State } from "../types";
import * as I from "./import";
import { importStartStatus, startPendingImport } from "./importStart";

/** The sample project with its two simulated runs active, as the demo has it. */
const busySample = (): State => buildSeed(T0, { inFlightRuns: true });
/** Every active run of the project, confirmed stopped, as the fake runtime confirms a pause. */
const stopAll = (s: State, now: string): State => M.activeAttempts(s).reduce((x, a) => M.acknowledgeStop(x, a.id, now), s);

describe("the start of an import while the sample's runs are active (QA-F2)", () => {
  it("pauses the sample and waits; the service starts the import once its runs have stopped", () => {
    const sample = busySample();
    expect(sample.project.sample).toBe(true);
    expect(M.activeAttempts(sample)).toHaveLength(2);
    const waiting = run(sample, "startImport", TALLY_START, at(1)).state;
    // The sample is paused, its runs asked to stop, and the start waits: the screen says "Pausing the sample's agents…".
    expect(waiting.project).toMatchObject({ sample: true, hold: true, importPending: { at: at(1), input: TALLY_START } });
    expect(M.activeAttempts(waiting).map((a) => a.outcome)).toEqual(["stopping", "stopping"]);
    expect(importStartStatus(waiting)).toEqual({ status: "pausing", runs: 2 });
    expect(waiting.studio.import).toBeUndefined();
    // While a run is still active, the service starts nothing.
    expect(startPendingImport(waiting, at(2))).toBe(waiting);
    const stopped = stopAll(waiting, at(3));
    expect(importStartStatus(stopped)).toEqual({ status: "pausing", runs: 0 });
    const started = startPendingImport(stopped, at(4));
    expect(started.project).toMatchObject({ sample: false, name: "tally (sample)", hold: false });
    expect(started.project.importPending).toBeUndefined();
    expect(I.importStatus(started)).toBe("reading");
    expect(started.studio.import!.startedAt).toBe(at(4));
    expect(importStartStatus(started)).toBeUndefined();
    expect(started.tasks).toEqual([]);
  });

  it("refuses a second start while one waits; resuming the project ends the wait", () => {
    const waiting = run(busySample(), "startImport", TALLY_START, at(1)).state;
    expect(() => run(waiting, "startImport", TALLY_START, at(2))).toThrow("An import is starting already: it waits for the sample's agents to stop.");
    const resumed = run(waiting, "resumeProject", {}, at(3)).state;
    expect(resumed.project.importPending).toBeUndefined();
    expect(resumed.project.hold).toBe(false);
    expect(resumed.events.at(-2)!.message).toBe("The import did not start: you resumed the project");
    expect(startPendingImport(stopAll(resumed, at(4)), at(5)).project.sample).toBe(true);
  });

  it("records a refusal at the start (something changed while it waited); the sample stays, and a new start may follow", () => {
    const waiting = run(busySample(), "startImport", TALLY_START, at(1)).state;
    const changed = stopAll(structuredClone(waiting), at(2));
    changed.project.enabledProviders = ["codex"];
    const refused = startPendingImport(changed, at(3));
    expect(refused.project.sample).toBe(true);
    expect(importStartStatus(refused)).toEqual({ status: "refused", reason: "Claude reads the repository, and it is not enabled. Enable it in Settings, or pick Codex to read it." });
    expect(startPendingImport(refused, at(4))).toBe(refused);
    expect(run(refused, "startImport", { ...TALLY_START, readsOn: "codex" }, at(5)).state.studio.import!.readsOn).toBe("codex");
  });

  it("refuses at once, changing nothing, when another project's runs are active: they are real work", () => {
    const busy = structuredClone(busySample());
    busy.project.sample = false;
    let error: unknown;
    try {
      run(busy, "startImport", TALLY_START, at(1));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ControlError);
    expect((error as Error).message).toBe("Stop all active runs (pause the project and wait for Paused) before starting a new project.");
    // An invalid start is refused before the sample is paused.
    expect(() => run(busySample(), "startImport", { ...TALLY_START, budgetUsd: -1 }, at(1))).toThrow("The import budget is a positive number of dollars.");
  });
});
