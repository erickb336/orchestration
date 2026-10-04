// ORC-032 R1-A at the service (QA-F2): the demo's sample runs its simulated agents; the owner starts the import of
// the bundled sample from the Start screen. The sample pauses, the start waits while its agents stop, and the service
// starts the import once none runs. The fake runtime, the scheduler and the store, as the demo has them.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import * as M from "../src/domain/model";
import { buildDemo } from "../src/domain/demo";
import * as I from "../src/domain/studio/import";
import { importStartStatus } from "../src/domain/studio/importStart";
import { TALLY_START } from "../src/domain/testing/import";
import type { State } from "../src/domain/types";
import { FakeAdapter, defaultFakeConfig } from "./runtimes/fake";
import { Scheduler } from "./scheduler";
import { Store } from "./store";
import { tallyRepo } from "./studio/import";

let dir: string;
let store: Store;
let scheduler: Scheduler;
let now = Date.parse("2026-10-04T09:00:00Z");
const state = (): State => store.read().state;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orc032-start-"));
  mkdirSync(join(dir, "data"));
  store = new Store(join(dir, "data", "db.sqlite"), () => buildDemo(now));
  const catalog = state().project.catalog;
  scheduler = new Scheduler(store, { claude: new FakeAdapter("claude", defaultFakeConfig(), catalog.claude), codex: new FakeAdapter("codex", defaultFakeConfig(), catalog.codex) }, { dataDir: join(dir, "data"), leaseMs: 600_000 });
});
afterEach(async () => {
  await scheduler.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

it("starting the bundled sample's import while the sample's agents run pauses them, says so, and starts the import once they stopped", async () => {
  for (let i = 0; i < 50 && !M.hasActiveRuns(state()); i++) scheduler.tick((now += 1000));
  const running = M.activeAttempts(state()).length;
  expect(running).toBeGreaterThan(0);
  const repoPath = tallyRepo(join(dir, "data", "import-demo", "tally"));
  store.command("startImport", { ...TALLY_START, repoPath }, "start-1", new Date((now += 1000)).toISOString());
  // The sample is paused; the screen reads that its agents are pausing.
  expect(state().project).toMatchObject({ sample: true, hold: true });
  const seen = [importStartStatus(state())];
  for (let i = 0; i < 60 && !state().studio.import; i++) {
    scheduler.tick((now += 1000));
    seen.push(importStartStatus(state()));
  }
  expect(seen[0]).toEqual({ status: "pausing", runs: running });
  expect(seen.at(-1)).toBeUndefined();
  const s = state();
  expect(s.project).toMatchObject({ sample: false, name: "tally (sample)", repoPath, hold: false });
  expect(I.importStatus(s)).toBe("reading");
  expect(s.tasks).toEqual([]);
});
