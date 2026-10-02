// ORC-029 pass 3: what the service makes of a version after import (media.ts), with stand-ins for Chrome and VHS: a
// screen's screenshots, and per variant of a terminal demo the tape it records, the folder it records from, where the
// recording goes, and what it falls back to (the designer's .cast or .ans) when it is not recorded, with the reason.
// Real Chrome and VHS run in runs.test.ts, through the scheduler.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MediaResult } from "../../src/domain/studio/studio";
import { makeDemo, makeShots, notRecordedReason, systemMedia, type StudioMedia } from "./media";
import type { ShotsOutcome } from "./shots";
import { probeTerminalSandbox, recordTape, type RecordResult } from "./terminal";
import { writeVersion } from "./testFixtures";

const NOW = "2026-10-02T12:00:00.000Z";
/** As the real trial (ORC-029 pass 3) wrote it: demo/demo.tape runs demo/trips.js by its path from the artifact's root. */
const SUBFOLDER = resolve(__dirname, "fixtures/trips-subfolder");
const now = () => NOW;
const variantsOf = (r: MediaResult) => ("demo" in r ? r.demo.variants : []);
let root: string;
let studio: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "orc-media-"));
  studio = join(root, "studio", "p-1");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A stand-in for Chrome and VHS: screenshots as given; a recording writes the tape's outputs, or fails as given. */
function stand(o: { shots?: ShotsOutcome; record?: (tapeDir: string, outDir: string, tape: string) => RecordResult } = {}) {
  const recorded: { tape: string; files: string[]; from: string }[] = [];
  const media: StudioMedia = {
    shots: async () => o.shots ?? { shots: [], failed: [] },
    record: async (tapeDir, outDir, tape) => {
      recorded.push({ tape, files: readdirSync(tapeDir, { recursive: true }).map(String).sort(), from: tapeDir });
      if (o.record) return o.record(tapeDir, outDir, tape);
      mkdirSync(outDir, { recursive: true });
      for (const ext of ["gif", "txt"]) writeFileSync(join(outDir, `demo.${ext}`), ext);
      return { sandbox: "sandbox-exec", gif: join(outDir, "demo.gif"), txt: join(outDir, "demo.txt") };
    },
  };
  return { media, recorded };
}

describe("a screen's screenshots", () => {
  it("are taken, skipped with Chrome's reason, or skipped when every page failed", async () => {
    const shot = { variant: "a", device: "desktop" as const, path: "shots/a-desktop.png" };
    const fail = { variant: "a", device: "mobile" as const, error: "Navigation took longer than 20000 ms" };
    expect(await makeShots(stand({ shots: { shots: [shot], failed: [fail] } }).media, studio, "sa-1", 1, now)).toEqual({ shots: { status: "taken", at: NOW, shots: [shot], failed: [fail] } });
    expect(await makeShots(stand({ shots: { skipped: "no Chrome found" } }).media, studio, "sa-1", 1, now)).toEqual({ shots: { status: "skipped", at: NOW, reason: "no Chrome found" } });
    expect(await makeShots(stand({ shots: { shots: [], failed: [fail] } }).media, studio, "sa-1", 1, now)).toEqual({ shots: { status: "skipped", at: NOW, reason: "every screenshot failed: Navigation took longer than 20000 ms" } });
  });
});

describe("a terminal demo's variants", () => {
  const TAPE = "Output demo.gif\nOutput demo.txt\nSet Columns 80\nSet Rows 24\nType \"node a/trips.js\"\nEnter\n";
  const FILES = { "a/demo.tape": TAPE, "a/trips.js": "console.log('trips')", "a/demo.cast": '{"version": 3, "term": {"cols": 80, "rows": 24}}\n', "b/plan.ans": "Trips\n", "c/notes.md": "# Later" };
  const VARIANTS = [
    { id: "a", label: "Recorded", entry: "a/demo.tape" },
    { id: "b", label: "Frames", entry: "b/plan.ans" },
    { id: "c", label: "Nothing", entry: "c/notes.md" },
  ];
  const version = () => writeVersion(studio, "sa-2", 1, FILES, { kind: "terminal-demo", devices: [], variants: VARIANTS });

  it("records the tape from a copy of the whole version into recording/<variant>/; frames are hand-written; a variant with neither says so", async () => {
    const dir = version();
    const { media, recorded } = stand();
    const r = await makeDemo(media, studio, "sa-2", 1, ["a", "b", "c"], now);
    expect(r).toEqual({
      demo: {
        status: "done",
        at: NOW,
        variants: [
          { variant: "a", status: "recorded", tape: "a/demo.tape", gif: "recording/a/demo.gif", txt: "recording/a/demo.txt" },
          { variant: "b", status: "hand-written", files: ["b/plan.ans"] },
          { variant: "c", status: "not-recorded", reason: "its entry is not a .tape, and no single .tape, nor a .cast or .ans, is beside it" },
        ],
      },
    });
    // VHS saw every file of the version at its path (the tape's commands name files from the artifact's root), and
    // none of the service's own; the recording sits in the version's folder; the copy is gone.
    expect(recorded).toEqual([{ tape: "a/demo.tape", files: ["a", "a/demo.cast", "a/demo.tape", "a/trips.js", "b", "b/plan.ans", "c", "c/notes.md"], from: expect.any(String) }]);
    expect(readdirSync(join(dir, "recording", "a")).sort()).toEqual(["demo.gif", "demo.txt"]);
    expect(existsSync(recorded[0].from)).toBe(false);
  });

  it("when a tape is not recorded, shows the variant's hand-written file with the reason, or says why there is nothing; a failed recording leaves nothing", async () => {
    version();
    const lone = writeVersion(studio, "sa-3", 1, { "demo.tape": TAPE, "trips.js": "1" }, { kind: "terminal-demo", devices: [], variants: [{ id: "a", label: "A", entry: "demo.tape" }] });
    const notSandboxed = stand({ record: () => ({ sandbox: null, reason: "unavailable", error: "Not recorded: no working sandbox (shellWriteOutside allowed). Nothing runs unsandboxed; use a hand-written .cast or .ans instead." }) });
    const a = await makeDemo(notSandboxed.media, studio, "sa-2", 1, ["a", "b", "c"], now);
    expect(variantsOf(a)[0]).toEqual({ variant: "a", status: "hand-written", files: ["a/demo.cast"], reason: "recording is not available here: no working sandbox (shellWriteOutside allowed)" });
    const failing = stand({
      record: (_t, out) => {
        mkdirSync(out, { recursive: true });
        writeFileSync(join(out, "half.gif"), "GIF8");
        return { sandbox: "sandbox-exec", reason: "timeout", error: "VHS did not finish within 120 s; it was stopped" };
      },
    });
    const b = await makeDemo(failing.media, studio, "sa-3", 1, ["a"], now);
    expect(variantsOf(b)).toEqual([{ variant: "a", status: "not-recorded", reason: "the recording took too long: VHS did not finish within 120 s; it was stopped" }]);
    expect(existsSync(join(lone, "recording", "a"))).toBe(false);
    // The reason of a real refusal (here sandbox-exec is missing), without its advice to the designer.
    const missing = await recordTape(lone, join(root, "out"), { tape: "demo.tape", sandboxExec: join(root, "no-sandbox-exec"), tmpRoot: root });
    expect(missing).toMatchObject({ sandbox: null, reason: "unavailable" });
    const why = process.platform === "darwin" ? `${join(root, "no-sandbox-exec")} is missing` : "terminal recording needs macOS sandbox-exec; this is not macOS";
    expect(notRecordedReason(missing)).toBe(`recording is not available here: ${why}`);
  });

  it("a recording whose transcript shows a failure is recorded with errors, with its first failing line; a variant made to show an error is recorded", async () => {
    const line = "Error: Cannot find module '/private/var/folders/wk/T/orc-vhs-1/work/demo/trips.js'";
    writeVersion(studio, "sa-4", 1, { "a/demo.tape": TAPE, "a/trips.js": "1", "b/demo.tape": TAPE, "b/trips.js": "2" }, { kind: "terminal-demo", devices: [], variants: [{ id: "a", label: "A", entry: "a/demo.tape" }, { id: "b", label: "B · the error path", entry: "b/demo.tape", showsError: true }] });
    const { media } = stand({
      record: (_root, out) => {
        mkdirSync(out, { recursive: true });
        writeFileSync(join(out, "demo.gif"), "GIF8");
        return { sandbox: "sandbox-exec", gif: join(out, "demo.gif"), errorLine: line };
      },
    });
    expect(variantsOf(await makeDemo(media, studio, "sa-4", 1, ["a", "b"], now))).toEqual([
      { variant: "a", status: "recorded-with-errors", tape: "a/demo.tape", gif: "recording/a/demo.gif", reason: line },
      { variant: "b", status: "recorded", tape: "b/demo.tape", gif: "recording/b/demo.gif" },
    ]);
  });

  it("does not record from a file that no longer matches its hash, and says why", async () => {
    const dir = version();
    rmSync(join(dir, "a", "trips.js"), { force: true });
    writeFileSync(join(dir, "a", "trips.js"), "console.log('changed')");
    const { media, recorded } = stand();
    const r = await makeDemo(media, studio, "sa-2", 1, ["a", "b", "c"], now);
    expect(variantsOf(r)[0]).toEqual({ variant: "a", status: "hand-written", files: ["a/demo.cast"], reason: "its files could not be read: a/trips.js is missing or does not match its recorded hash" });
    expect(recorded).toEqual([]);
  });

  it("without a readable version folder, every variant says so", async () => {
    expect(await makeDemo(stand().media, studio, "sa-9", 1, ["a", "b"], now)).toEqual({
      demo: {
        status: "done",
        at: NOW,
        variants: [
          { variant: "a", status: "not-recorded", reason: "the version's folder could not be read" },
          { variant: "b", status: "not-recorded", reason: "the version's folder could not be read" },
        ],
      },
    });
  });
});

const sandbox = await probeTerminalSandbox();

describe(`a terminal demo recorded for real, as the trial's designer wrote it${sandbox.ok ? "" : ` (skipped: ${sandbox.detail})`}`, () => {
  it.skipIf(!sandbox.ok)(
    "the shell starts at the version's root with all its files, so a script called by its root path prints its real output; a demo that fails on screen is recorded with errors",
    async () => {
      const fixture = (p: string) => readFileSync(join(SUBFOLDER, p), "utf8");
      // b makes the trial's mistake the other way round (a path from its tape's folder), and asks for no transcript.
      const BROKEN = 'Output demo.gif\nSet Columns 80\nSet Rows 24\nSet TypingSpeed 10ms\nType "node trips.js"\nEnter\nSleep 1.5s\n';
      const files = { "demo/demo.tape": fixture("demo/demo.tape"), "demo/setup.tape": fixture("demo/setup.tape"), "demo/trips.js": fixture("demo/trips.js"), "b/demo.tape": BROKEN, "b/trips.js": "console.log('not reached')\n" };
      const dir = writeVersion(studio, "sa-5", 1, files, { kind: "terminal-demo", devices: ["terminal"], variants: [{ id: "a", label: "A", entry: "demo/demo.tape" }, { id: "b", label: "B", entry: "b/demo.tape" }] });
      const [a, b] = variantsOf(await makeDemo(systemMedia(), studio, "sa-5", 1, ["a", "b"], now));
      expect(a).toEqual({ variant: "a", status: "recorded", tape: "demo/demo.tape", gif: "recording/a/demo.gif", txt: "recording/a/demo.txt" });
      const txt = readFileSync(join(dir, "recording", "a", "demo.txt"), "utf8");
      expect(txt.split("\n")).toContain(" 1  Lake Tahoe cabin      3h 40m   $148");
      expect(txt).not.toContain("Cannot find module");
      expect(b).toMatchObject({ variant: "b", status: "recorded-with-errors", tape: "b/demo.tape", gif: "recording/b/demo.gif" });
      expect(b.status === "recorded-with-errors" ? b.reason : "").toMatch(/^Error: Cannot find module '/);
      expect(readdirSync(join(dir, "recording", "b"))).toEqual(["demo.gif"]);
    },
    120_000,
  );
});
