// ORC-029 pass 5, the "Capture evidence" step: the coder's capture plan, checked at the boundary like the studio's
// manifests and tapes. A whole plan of the wrong shape is refused; a refused entry costs only its item; an entry for
// an item the task does not cite is noted and skipped; nothing is read through a link.

import { linkSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CaptureItem } from "../../src/domain/studio/evidence";
import { RECORDER_IMAGE, containerArgs } from "./container";
import { CAPTURE_PLAN, CAPTURE_SCRIPT, MAX_PLANNED_SCREENS, captureArgs, checkCapturePlan, collectCapture, installArgs, parseCaptureOutput, readCapturePlan, readPlainFile } from "./evidence";

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

describe("the two container runs", () => {
  const at = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
  const envs = (args: string[]) => args.flatMap((a, i) => (args[i - 1] === "--env" ? [a] : []));

  it("the install gets Docker's network, with every install hook off and its caches in its own folder", () => {
    const args = installArgs({ name: "orc-ev-1-abc", work: "/stage/work", cache: "/stage/cache", argv: ["npm", "ci", "--no-ignore-scripts"], timeoutMs: 600_000 });
    expect(at(args, "--network")).toBe("bridge");
    expect(envs(args)).toEqual(expect.arrayContaining(["npm_config_ignore_scripts=true", "YARN_ENABLE_SCRIPTS=0", "YARN_IGNORE_PATH=1", "npm_config_cache=/out/npm-cache", "npm_config_git=/bin/false"]));
    // The contradicting flag is dropped and --ignore-scripts added, whatever the setting says.
    expect(args.slice(args.indexOf(RECORDER_IMAGE) + 1)).toEqual(["/usr/bin/timeout", "--kill-after=5", "615", "npm", "ci", "--ignore-scripts"]);
    expect(args).toEqual(expect.arrayContaining(["--read-only", "--cap-drop", "ALL", "--user", "10001:10001", "--mount", "type=bind,source=/stage/work,target=/work", "--mount", "type=bind,source=/stage/cache,target=/out"]));
    expect(args).not.toContain("--interactive");
  });

  it("the capture has no network, the same isolation, and reads its job on stdin", () => {
    const args = captureArgs({ name: "orc-ev-1-def", work: "/stage/work", out: "/stage/out", timeoutMs: 100_000 });
    expect(at(args, "--network")).toBe("none");
    expect(args.filter((a) => a === "--network")).toHaveLength(1);
    expect(args).toEqual(expect.arrayContaining(["--interactive", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "10001:10001", "--pull", "never"]));
    expect(envs(args)).toEqual(["HOME=/home/recorder", "LANG=C.UTF-8", "TMPDIR=/tmp"]);
    expect(args.slice(args.indexOf(RECORDER_IMAGE) + 1)).toEqual(["/usr/bin/timeout", "--kill-after=5", "115", "/usr/local/bin/node", "-e", CAPTURE_SCRIPT]);
    // The browser's hardening, as for the studio's screenshot Chrome (shots.ts).
    expect(CAPTURE_SCRIPT).toContain('"--webrtc-ip-handling-policy=disable_non_proxied_udp", "--proxy-server=http://127.0.0.1:" + proxy.address().port, "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE *.localhost"');
  });

  it("refuses an environment variable it could not pass safely", () => {
    expect(() => containerArgs({ name: "orc-ev-1", work: "/w", out: "/o", workdir: "/work", command: ["true"], env: { HOME: "/root" } })).toThrow(/not a container variable/);
    expect(() => containerArgs({ name: "orc-ev-1", work: "/w", out: "/o", workdir: "/work", command: ["true"], env: { "A B": "x" } })).toThrow(/not a container variable/);
    expect(() => containerArgs({ name: "orc-ev-1", work: "/w", out: "/o", workdir: "/work", command: ["true"], env: { A: "x\ny" } })).toThrow(/not a container variable/);
  });
});

describe("what comes back from a capture", () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  const GIF = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(32)]);
  const LIMITS = { startMs: 60_000, maxFileBytes: 1024 * 1024 };
  let out: string;
  let back: string;
  beforeEach(() => {
    out = join(dir, "stage-out");
    back = join(dir, "evidence");
    mkdirSync(out);
    mkdirSync(back);
  });
  const put = (rel: string, data: Buffer | string) => {
    mkdirSync(dirname(join(out, rel)), { recursive: true });
    writeFileSync(join(out, rel), data);
  };
  const screen = (devices: ("desktop" | "mobile")[] = ["desktop", "mobile"]) => ({ itemId: "bi-1", path: "/", devices });
  const terminal = { itemId: "bi-3", tape: "demo/trips.tape", folder: "demo", normalized: "", outputs: { gif: "demo.gif", txt: "demo.txt" } };
  const listed = (d: string): string[] => readdirSync(d, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name).slice(d.length + 1)).sort();

  it("a preview that does not start: every screen says so, with the end of its log", () => {
    const r = collectCapture({ stageOut: out, outDir: back, items: ITEMS, screens: [screen()], terminals: [], out: { preview: { started: false, log: "Error: Cannot find module 'vite'\n", exit: "exit 1" }, screens: [], terminals: [] }, port: 4173, limits: LIMITS });
    expect(r).toEqual([{ ...SCREEN, status: "none", reason: "preview-did-not-start", detail: "The preview command ended (exit 1) before port 4173 opened.", log: "Error: Cannot find module 'vite'" }]);
    expect(collectCapture({ stageOut: out, outDir: back, items: ITEMS, screens: [screen()], terminals: [], out: { preview: { started: false, log: "" }, screens: [], terminals: [] }, port: 4173, limits: LIMITS })[0]).toMatchObject({ reason: "preview-did-not-start", detail: "Port 4173 did not open within 60 s." });
  });

  it("only the files the plan names come back, each checked by its first bytes; the page's errors are warnings", () => {
    put("bi-1/desktop.png", PNG);
    put("bi-1/mobile.png", "not a png");
    put("bi-1/extra.png", PNG);
    put("bi-9/planted.png", PNG);
    put("planted.txt", "hello");
    put("bi-3/demo.gif", GIF);
    put("bi-3/demo.txt", "> node bin/trips.js list\nTypeError: x is not a function\n");
    put("bi-3/notes.txt", "not declared");
    const r = collectCapture({
      stageOut: out,
      outDir: back,
      items: ITEMS,
      screens: [screen()],
      terminals: [terminal],
      out: { preview: { started: true, log: "" }, screens: [{ item: "bi-1", device: "desktop", status: "shot", errors: ["Uncaught ReferenceError: x is not defined"] }, { item: "bi-1", device: "mobile", status: "shot", errors: [] }], terminals: [{ item: "bi-3", status: "recorded" }] },
      port: 4173,
      limits: LIMITS,
    });
    expect(listed(back)).toEqual(["bi-1/desktop.png", "bi-3/demo.gif", "bi-3/demo.txt"]);
    expect(r[0]).toMatchObject({ itemId: "bi-1", status: "captured", files: [{ path: "bi-1/desktop.png", type: "png", device: "desktop", bytes: PNG.length }], warnings: ["Not captured on mobile: bi-1/mobile.png is not a PNG file", "Uncaught ReferenceError: x is not defined"] });
    expect(r[1]).toMatchObject({ itemId: "bi-3", status: "captured", files: [{ path: "bi-3/demo.gif", type: "gif" }, { path: "bi-3/demo.txt", type: "txt" }], warnings: ["The recording shows a failure: TypeError: x is not a function"] });
  });

  it("never follows a link: a screenshot that is a link, or an output folder that is one, comes back as nothing", () => {
    const outside = mkdtempSync(join(tmpdir(), "orc-evidence-outside-"));
    try {
      writeFileSync(join(outside, "secret.png"), PNG);
      writeFileSync(join(outside, "demo.gif"), GIF);
      writeFileSync(join(outside, "demo.txt"), "fine");
      put("bi-1/desktop.png", PNG);
      symlinkSync(join(outside, "secret.png"), join(out, "bi-1", "mobile.png"));
      symlinkSync(outside, join(out, "bi-3"));
      const r = collectCapture({ stageOut: out, outDir: back, items: ITEMS, screens: [screen()], terminals: [terminal], out: { preview: { started: true, log: "" }, screens: [{ item: "bi-1", device: "desktop", status: "shot", errors: [] }, { item: "bi-1", device: "mobile", status: "shot", errors: [] }], terminals: [{ item: "bi-3", status: "recorded" }] }, port: 4173, limits: LIMITS });
      expect(listed(back)).toEqual(["bi-1/desktop.png"]);
      expect(r[0]).toMatchObject({ status: "captured", warnings: [expect.stringMatching(/Not captured on mobile: bi-1\/mobile\.png was not written, or is not a regular file .* reached through no link/)] });
      expect(r[1]).toMatchObject({ itemId: "bi-3", status: "none", reason: "capture-failed", detail: expect.stringMatching(/bi-3\/demo\.gif was not written/) });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("a page that does not load has page errors and no files; a tape that failed keeps nothing", () => {
    const r = collectCapture({ stageOut: out, outDir: back, items: ITEMS, screens: [screen(["desktop"])], terminals: [terminal], out: { preview: { started: true, log: "" }, screens: [{ item: "bi-1", device: "desktop", status: "http", error: "HTTP 404 for /", errors: ["console.error: Failed to load resource: the server responded with a status of 404"] }], terminals: [{ item: "bi-3", status: "timeout", error: "VHS did not finish within 120 s", log: "…" }] }, port: 4173, limits: LIMITS });
    expect(r).toEqual([
      { ...SCREEN, status: "none", reason: "page-errors", detail: "The page / did not load: desktop: HTTP 404 for /.", log: "console.error: Failed to load resource: the server responded with a status of 404" },
      { ...CLI, status: "none", reason: "capture-failed", detail: "VHS did not finish within 120 s", log: "…" },
    ]);
    expect(listed(back)).toEqual([]);
  });

  it("reads the script's result line, and only planned items, devices and statuses from it", () => {
    const job = { screens: [{ item: "bi-1", path: "/", devices: ["desktop" as const] }], terminals: [{ item: "bi-3", folder: ".", tape: "", dirs: [] }] };
    const line = JSON.stringify({ orchestratorCapture: 1, preview: { started: true, log: "x".repeat(5000) }, screens: [{ item: "bi-1", device: "desktop", status: "shot", errors: ["a", 5] }, { item: "bi-1", device: "mobile", status: "shot" }, { item: "bi-2", device: "desktop", status: "shot" }, { item: "bi-1", device: "desktop", status: "failed" }], terminals: [{ item: "bi-3", status: "recorded" }, { item: "bi-4", status: "recorded" }, { item: "bi-3", status: "weird" }], refused: 2 });
    const r = parseCaptureOutput(`noise\n{"orchestratorCapture":1,"screens":[]}\n${line}\n`, job);
    expect(r).toEqual({ preview: { started: true, log: "x".repeat(1500) }, refused: 2, screens: [{ item: "bi-1", device: "desktop", status: "shot", errors: ["a"] }], terminals: [{ item: "bi-3", status: "recorded" }] });
    expect(parseCaptureOutput("no result here", job)).toBe("the capture printed no result");
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
