// ORC-029 pass 5, the "Capture evidence" step: the coder's capture plan, checked at the boundary like the studio's
// manifests and tapes. A whole plan of the wrong shape is refused; a refused entry costs only its item; an entry for
// an item the task does not cite is noted and skipped; nothing is read through a link.

import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CaptureItem } from "../../src/domain/studio/evidence";
import { CAPTURE_PLAN, MAX_PLANNED_SCREENS, checkCapturePlan, readCapturePlan, readPlainFile } from "./evidence";

const SCREEN: CaptureItem = { itemId: "bi-1", kind: "screen", title: "Trip board", artifactId: "sa-1", version: 2, variant: "B" };
const CLI: CaptureItem = { itemId: "bi-3", kind: "terminal-demo", title: "trips CLI", artifactId: "sa-3", version: 1 };
const TUI: CaptureItem = { itemId: "bi-4", kind: "tui", title: "Packing TUI", artifactId: "sa-4", version: 1 };
const ITEMS = [SCREEN, CLI, TUI];
const TAPE = 'Output demo.gif\nOutput demo.txt\nSet Columns 80\nSet Rows 24\nType "node bin/trips.js list"\nEnter\nSleep 1s\n';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orc-evidence-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const files = (fs: Record<string, string>) => (rel: string) => fs[rel];
const check = (plan: unknown, fs: Record<string, string> = {}, cliEntry?: string) => checkCapturePlan(typeof plan === "string" ? plan : JSON.stringify(plan), ITEMS, { readFile: files(fs), ...(cliEntry ? { cliEntry } : {}) });
const planOf = (r: ReturnType<typeof check>) => {
  if (!r.ok) throw new Error(r.error);
  return r.plan;
};
const invalid = (r: ReturnType<typeof check>) => {
  if (r.ok) throw new Error("expected the plan to be refused");
  expect(r.reason).toBe("invalid-plan");
  return r.error;
};

describe("the capture plan", () => {
  it("takes each screen's page and devices, and each tape with its Outputs pointed into the item's output folder", () => {
    const p = planOf(check({ screens: [{ item: "bi-1", path: "/trips?view=board#top", devices: ["mobile", "desktop"] }], terminals: [{ item: "bi-3", tape: "demo/trips.tape" }, { item: "bi-4", tape: "packing.tape" }] }, { "demo/trips.tape": TAPE, "packing.tape": TAPE }, "bin/trips.js"));
    expect(p.screens).toEqual([{ itemId: "bi-1", path: "/trips?view=board#top", devices: ["desktop", "mobile"] }]);
    expect(p.terminals.map((t) => [t.itemId, t.tape, t.folder, t.outputs])).toEqual([
      ["bi-3", "demo/trips.tape", "demo", { gif: "demo.gif", txt: "demo.txt" }],
      ["bi-4", "packing.tape", ".", { gif: "demo.gif", txt: "demo.txt" }],
    ]);
    expect(p.terminals[0].normalized.split("\n").filter((l) => l.startsWith("Output"))).toEqual(['Output "/out/bi-3/demo.gif"', 'Output "/out/bi-3/demo.txt"']);
    expect(p.refused).toEqual([]);
    expect(p.notes).toEqual([]);
  });

  it("refuses a plan of the wrong shape as a whole", () => {
    expect(invalid(check("{ not json"))).toMatch(/not valid JSON/);
    expect(invalid(check([]))).toMatch(/not a JSON object/);
    expect(invalid(check({ screens: [], shell: "rm -rf /" }))).toMatch(/unknown field "shell"/);
    expect(invalid(check({ screens: {} }))).toMatch(/"screens" is a list/);
    expect(invalid(check({ screens: Array.from({ length: MAX_PLANNED_SCREENS + 1 }, (_, i) => ({ item: `bi-${i + 10}`, path: "/", devices: ["desktop"] })) }))).toMatch(/at most 12/);
    expect(invalid(check({ screens: ["bi-1"] }))).toMatch(/screens\[0\] is not an object/);
    expect(invalid(check({ screens: [{ item: "../bi-1", path: "/", devices: ["desktop"] }] }))).toMatch(/blueprint item id/);
    expect(invalid(check({ screens: [{ item: "bi-1", path: "/", devices: ["desktop"] }, { item: "bi-1", path: "/x", devices: ["mobile"] }] }))).toMatch(/bi-1 is planned twice/);
  });

  it("notes and skips an item the task does not cite; refuses an entry in the wrong list, for its item only", () => {
    const p = planOf(check({ screens: [{ item: "bi-9", path: "/", devices: ["desktop"] }, { item: "bi-3", path: "/", devices: ["desktop"] }, { item: "bi-1", path: "/", devices: ["desktop"] }] }));
    expect(p.screens.map((s) => s.itemId)).toEqual(["bi-1"]);
    expect(p.notes).toEqual([expect.stringMatching(/names bi-9, which this task's spec does not cite/)]);
    expect(p.refused).toEqual([{ itemId: "bi-3", error: expect.stringMatching(/bi-3 is a terminal-demo, so it belongs in "terminals"/) }]);
  });

  it("refuses a page on another origin or outside the preview, and devices it does not capture", () => {
    for (const path of ["//evil.example/x", "http://evil.example/", "trips", "/a b", "/\\evil", `/${"x".repeat(200)}`]) {
      expect(planOf(check({ screens: [{ item: "bi-1", path, devices: ["desktop"] }] })).refused[0].error).toMatch(/page path on the preview/);
    }
    for (const devices of [[], ["tablet"], ["desktop", "desktop"], "desktop", ["terminal"]]) {
      expect(planOf(check({ screens: [{ item: "bi-1", path: "/", devices }] })).refused[0].error).toMatch(/"devices" lists desktop and\/or mobile/);
    }
  });

  it("checks each tape under the tape rules, in the change, with bash, and typing the CLI entry when one is set", () => {
    const one = (tape: unknown, fs: Record<string, string>, cliEntry?: string) => planOf(check({ terminals: [{ item: "bi-3", tape }] }, fs, cliEntry)).refused.map((r) => r.error).join("\n");
    expect(one("../outside.tape", {})).toMatch(/inside the repository/);
    expect(one("/etc/x.tape", {})).toMatch(/inside the repository/);
    expect(one("demo/trips.sh", {})).toMatch(/inside the repository/);
    expect(one("demo/missing.tape", {})).toMatch(/demo\/missing\.tape is not a regular file/);
    expect(one("demo/t.tape", { "demo/t.tape": "Output ../../escape.gif\nSet Columns 80\nSet Rows 24\n" })).toMatch(/Output must be one path inside/);
    expect(one("demo/t.tape", { "demo/t.tape": "Output a.gif\nSet Columns 80\nSet Rows 24\nCopy\n" })).toMatch(/Copy is not allowed/);
    expect(one("demo/t.tape", { "demo/t.tape": `Set Shell zsh\n${TAPE}` })).toMatch(/recorder has bash only/);
    expect(one("demo/t.tape", { "demo/t.tape": TAPE.replace("node bin/trips.js list", "cat canned-output.txt") }, "bin/trips.js")).toMatch(/never types the CLI entry bin\/trips\.js/);
    // A Source is read beside the tape, in the change.
    expect(one("demo/t.tape", { "demo/t.tape": `Source common.tape\n${TAPE}`, "demo/common.tape": "Set FontSize 14\n" })).toBe("");
    expect(one("demo/t.tape", { "demo/t.tape": `Source common.tape\n${TAPE}` })).toMatch(/Source common\.tape was not found/);
  });
});

describe("reading the plan from the copy of the change", () => {
  const write = (rel: string, text: string) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };

  it("says when the change has no plan, and reads one with its tapes", () => {
    expect(readCapturePlan(dir, ITEMS)).toEqual({ ok: false, reason: "no-plan", error: `The change has no capture plan (${CAPTURE_PLAN}).` });
    write(CAPTURE_PLAN, JSON.stringify({ terminals: [{ item: "bi-3", tape: "demo/trips.tape" }] }));
    write("demo/trips.tape", TAPE);
    const r = readCapturePlan(dir, ITEMS, { cliEntry: "bin/trips.js" });
    expect(r.ok && r.plan.terminals.map((t) => t.itemId)).toEqual(["bi-3"]);
  });

  it("never reads the plan or a tape through a link", () => {
    const outside = mkdtempSync(join(tmpdir(), "orc-evidence-outside-"));
    try {
      writeFileSync(join(outside, "plan.json"), JSON.stringify({ screens: [] }));
      writeFileSync(join(outside, "trips.tape"), TAPE);
      mkdirSync(join(dir, ".orchestrator"), { recursive: true });
      symlinkSync(join(outside, "plan.json"), join(dir, CAPTURE_PLAN));
      expect(readCapturePlan(dir, ITEMS)).toMatchObject({ ok: false, reason: "invalid-plan", error: expect.stringMatching(/reached through no link/) });
      rmSync(join(dir, CAPTURE_PLAN));
      write(CAPTURE_PLAN, JSON.stringify({ terminals: [{ item: "bi-3", tape: "demo/trips.tape" }, { item: "bi-4", tape: "hard.tape" }] }));
      // A folder on the tape's way is a link; the other tape is a hard link to a file outside.
      symlinkSync(outside, join(dir, "demo"));
      linkSync(join(outside, "trips.tape"), join(dir, "hard.tape"));
      const r = readCapturePlan(dir, ITEMS);
      expect(r.ok && r.plan.refused.map((x) => x.itemId)).toEqual(["bi-3", "bi-4"]);
      expect(readPlainFile(dir, "hard.tape", 1024)).toBeUndefined();
      expect(readPlainFile(dir, "../x", 1024)).toBeUndefined();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
