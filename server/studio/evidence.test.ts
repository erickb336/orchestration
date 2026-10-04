// ORC-029 pass 5, the "Capture evidence" step: the coder's capture plan, checked at the boundary like the studio's
// manifests and tapes. A whole plan of the wrong shape is refused; a refused entry costs only its item; an entry for
// an item the task does not cite is noted and skipped; nothing is read through a link.

import { linkSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CaptureItem } from "../../src/domain/studio/evidence";
import type { EnvironmentAssignment } from "../checks";
import type { PreparedOutcome } from "../environment/prepared";
import { RECORDER_IMAGE, RECORDER_USER, containerArgs, dockerSocket } from "./container";
import { CAPTURE_PLAN, CAPTURE_SCRIPT, MAX_PLANNED_SCREENS, NO_ENVIRONMENT, captureArgs, captureEvidence, checkCapturePlan, collectCapture, parseCaptureOutput, readCapturePlan, readPlainFile, type CaptureJob, type EnvironmentLender } from "./evidence";

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
  it("takes each screen's page and devices, and each tape with its outputs and the session that types it", () => {
    const p = planOf(check({ screens: [{ item: "bi-1", path: "/trips?view=board#top", devices: ["mobile", "desktop"] }], terminals: [{ item: "bi-3", tape: "demo/trips.tape" }, { item: "bi-4", tape: "packing.tape" }] }, { "demo/trips.tape": TAPE, "packing.tape": TAPE }, "bin/trips.js"));
    expect(p.screens).toEqual([{ itemId: "bi-1", path: "/trips?view=board#top", devices: ["desktop", "mobile"] }]);
    expect(p.terminals.map((t) => [t.itemId, t.tape, t.outputs, t.session.size])).toEqual([
      ["bi-3", "demo/trips.tape", { gif: "demo.gif", txt: "demo.txt" }, { cols: 80, rows: 24 }],
      ["bi-4", "packing.tape", { gif: "demo.gif", txt: "demo.txt" }, { cols: 80, rows: 24 }],
    ]);
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
    expect(one("demo/t.tape", { "demo/t.tape": `Set Shell zsh\n${TAPE}` })).toMatch(/a session types into bash only/);
    // A tape a session cannot type is refused for its item only: no other recorder takes it (ORC-030 C3).
    expect(one("demo/t.tape", { "demo/t.tape": `${TAPE}Ctrl+Shift+Left\n` })).toMatch(/^terminals\[0\]: demo\/t\.tape: demo\/t\.tape:\d+: Ctrl\+Shift\+Left cannot be typed in a session/);
    expect(one("demo/t.tape", { "demo/t.tape": TAPE.replace("node bin/trips.js list", "cat canned-output.txt") }, "bin/trips.js")).toMatch(/never types the CLI entry bin\/trips\.js/);
    // A Source is read beside the tape, in the change.
    expect(one("demo/t.tape", { "demo/t.tape": `Source common.tape\n${TAPE}`, "demo/common.tape": "Set FontSize 14\n" })).toBe("");
    expect(one("demo/t.tape", { "demo/t.tape": `Source common.tape\n${TAPE}` })).toMatch(/Source common\.tape was not found/);
  });
});

describe("the browser's container run", () => {
  const at = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
  const envs = (args: string[]) => args.flatMap((a, i) => (args[i - 1] === "--env" ? [a] : []));

  it("shares the preview's loopback and nothing else, with the recorder's isolation, and reads its job on stdin", () => {
    const args = captureArgs({ name: "orc-ev-1-def", work: "/stage/browser", out: "/stage/out", timeoutMs: 100_000, network: { container: "orc-env-preview-1-abc" } });
    expect(args.filter((a) => a === "--network")).toHaveLength(1);
    expect(at(args, "--network")).toBe("container:orc-env-preview-1-abc");
    expect(args).toEqual(expect.arrayContaining(["--interactive", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", RECORDER_USER, "--pull", "never"]));
    expect(envs(args)).toEqual(["HOME=/home/recorder", "LANG=C.UTF-8", "TMPDIR=/tmp"]);
    expect(args.slice(args.indexOf(RECORDER_IMAGE) + 1)).toEqual(["/usr/bin/timeout", "--kill-after=5", "115", "/usr/local/bin/node", "-e", CAPTURE_SCRIPT]);
    // The browser's hardening, as for the studio's screenshot Chrome (shots.ts).
    expect(CAPTURE_SCRIPT).toContain('"--webrtc-ip-handling-policy=disable_non_proxied_udp", "--proxy-server=http://127.0.0.1:" + proxy.address().port, "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE *.localhost"');
    // It only looks: no preview, no install and no VHS run in the browser's container (ORC-030 C3).
    expect(CAPTURE_SCRIPT).not.toMatch(/child_process|spawn|vhs/i);
  });

  it("refuses an environment variable it could not pass safely", () => {
    expect(() => containerArgs({ name: "orc-ev-1", work: "/w", out: "/o", workdir: "/work", command: ["true"], env: { HOME: "/root" } })).toThrow(/not a container variable/);
    expect(() => containerArgs({ name: "orc-ev-1", work: "/w", out: "/o", workdir: "/work", command: ["true"], env: { "A B": "x" } })).toThrow(/not a container variable/);
    expect(() => containerArgs({ name: "orc-ev-1", work: "/w", out: "/o", workdir: "/work", command: ["true"], env: { A: "x\ny" } })).toThrow(/not a container variable/);
    expect(() => containerArgs({ name: "orc-ev-1", work: "/w", out: "/o", workdir: "/work", command: ["true"], network: { container: "--privileged" } })).toThrow(/not a container to share a network with/);
    expect(() => containerArgs({ name: "orc-ev-1", work: "/w", out: "/o", workdir: "/work", command: ["true"], network: { container: "orc-x" }, hostGateway: true })).toThrow(/not a container to share a network with/);
  });
});

describe("what comes back from a capture", () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
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
  const listed = (d: string): string[] => readdirSync(d, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name).slice(d.length + 1)).sort();

  it("a preview that does not start: every screen says so, with the end of its log", () => {
    const r = collectCapture({ stageOut: out, outDir: back, items: ITEMS, screens: [screen()], out: { preview: { started: false, log: "Error: Cannot find module 'vite'\n", exit: "exit 1" }, screens: [] }, port: 4173, limits: LIMITS });
    expect(r).toEqual([{ ...SCREEN, status: "none", reason: "preview-did-not-start", detail: "The preview command ended (exit 1) before port 4173 opened.", log: "Error: Cannot find module 'vite'" }]);
    expect(collectCapture({ stageOut: out, outDir: back, items: ITEMS, screens: [screen()], out: { preview: { started: false, log: "" }, screens: [] }, port: 4173, limits: LIMITS })[0]).toMatchObject({ reason: "preview-did-not-start", detail: "Port 4173 did not open within 60 s." });
  });

  it("only the screenshots the plan names come back, each checked by its first bytes; the page's errors are warnings", () => {
    put("bi-1/desktop.png", PNG);
    put("bi-1/mobile.png", "not a png");
    put("bi-1/extra.png", PNG);
    put("bi-9/planted.png", PNG);
    put("planted.txt", "hello");
    const r = collectCapture({
      stageOut: out,
      outDir: back,
      items: ITEMS,
      screens: [screen()],
      out: { preview: { started: true, log: "" }, screens: [{ item: "bi-1", device: "desktop", status: "shot", errors: ["Uncaught ReferenceError: x is not defined"] }, { item: "bi-1", device: "mobile", status: "shot", errors: [] }] },
      port: 4173,
      limits: LIMITS,
    });
    expect(listed(back)).toEqual(["bi-1/desktop.png"]);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ itemId: "bi-1", status: "captured", files: [{ path: "bi-1/desktop.png", type: "png", device: "desktop", bytes: PNG.length }], warnings: ["Not captured on mobile: bi-1/mobile.png is not a PNG file", "Uncaught ReferenceError: x is not defined"] });
  });

  it("never follows a link: a screenshot that is a link, or an output folder that is one, comes back as nothing", () => {
    const outside = mkdtempSync(join(tmpdir(), "orc-evidence-outside-"));
    try {
      writeFileSync(join(outside, "secret.png"), PNG);
      writeFileSync(join(outside, "desktop.png"), PNG);
      put("bi-1/desktop.png", PNG);
      symlinkSync(join(outside, "secret.png"), join(out, "bi-1", "mobile.png"));
      symlinkSync(outside, join(out, "bi-5"));
      const other: CaptureItem = { itemId: "bi-5", kind: "screen", title: "Trip list", artifactId: "sa-5", version: 1 };
      const shot = (item: string, device: "desktop" | "mobile") => ({ item, device, status: "shot" as const, errors: [] });
      const r = collectCapture({ stageOut: out, outDir: back, items: [SCREEN, other], screens: [screen(), { itemId: "bi-5", path: "/list", devices: ["desktop"] }], out: { preview: { started: true, log: "" }, screens: [shot("bi-1", "desktop"), shot("bi-1", "mobile"), shot("bi-5", "desktop")] }, port: 4173, limits: LIMITS });
      expect(listed(back)).toEqual(["bi-1/desktop.png"]);
      expect(r[0]).toMatchObject({ status: "captured", warnings: [expect.stringMatching(/Not captured on mobile: bi-1\/mobile\.png was not written, or is not a regular file .* reached through no link/)] });
      expect(r[1]).toMatchObject({ itemId: "bi-5", status: "none", reason: "page-errors", detail: expect.stringMatching(/bi-5\/desktop\.png was not written/) });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("a page that does not load has page errors and no files", () => {
    const r = collectCapture({ stageOut: out, outDir: back, items: ITEMS, screens: [screen(["desktop"])], out: { preview: { started: true, log: "" }, screens: [{ item: "bi-1", device: "desktop", status: "http", error: "HTTP 404 for /", errors: ["console.error: Failed to load resource: the server responded with a status of 404"] }] }, port: 4173, limits: LIMITS });
    expect(r).toEqual([{ ...SCREEN, status: "none", reason: "page-errors", detail: "The page / did not load: desktop: HTTP 404 for /.", log: "console.error: Failed to load resource: the server responded with a status of 404" }]);
    expect(listed(back)).toEqual([]);
  });

  it("reads the script's result line, and only planned items, devices and statuses from it", () => {
    const job = { screens: [{ item: "bi-1", path: "/", devices: ["desktop" as const] }] };
    const line = JSON.stringify({ orchestratorCapture: 1, preview: { started: true, log: "x".repeat(5000) }, screens: [{ item: "bi-1", device: "desktop", status: "shot", errors: ["a", 5] }, { item: "bi-1", device: "mobile", status: "shot" }, { item: "bi-2", device: "desktop", status: "shot" }, { item: "bi-1", device: "desktop", status: "failed" }], terminals: [{ item: "bi-3", status: "recorded" }], refused: 2 });
    const r = parseCaptureOutput(`noise\n{"orchestratorCapture":1,"screens":[]}\n${line}\n`, job);
    expect(r).toEqual({ preview: { started: true, log: "x".repeat(1500) }, refused: 2, screens: [{ item: "bi-1", device: "desktop", status: "shot", errors: ["a"] }] });
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

describe("where a capture runs: only in the project's environment (unit E2, ORC-030 C3)", () => {
  const ENV: EnvironmentAssignment = { project: "p-env", plan: { source: { from: "setting", image: `python:3.13-slim@sha256:${"a".repeat(64)}` }, prepare: [["python3", "-m", "pip", "install", "--user", "-r", "requirements.txt"]], prepareFrom: "setting", hosts: ["pypi.org"] } };
  const RECORD = { ran: "container" as const, from: "setting" as const, image: ENV.plan.source.from === "setting" ? (ENV.plan.source as { image: string }).image : "", imageId: `sha256:${"c".repeat(64)}`, prepare: "reused" as const, key: "0123456789abcdef", prepareMs: 0 };
  /** A change with a plan for a screen and a CLI. */
  const change = (tape = TAPE) => {
    const src = join(dir, "change");
    mkdirSync(join(src, ".orchestrator"), { recursive: true });
    mkdirSync(join(src, "demo"), { recursive: true });
    writeFileSync(join(src, CAPTURE_PLAN), JSON.stringify({ screens: [{ item: "bi-1", path: "/", devices: ["desktop"] }], terminals: [{ item: "bi-3", tape: "demo/trips.tape" }] }));
    writeFileSync(join(src, "demo/trips.tape"), tape);
    return src;
  };
  /** A lender that records what it was asked, and answers `answer` (or lends a copy with a docker that is not there). */
  const lender = (answer?: PreparedOutcome<void>) => {
    const calls: { workspace: string; sha: string; environment: EnvironmentAssignment; files: string[] }[] = [];
    const l: EnvironmentLender = {
      async withPrepared(o, use) {
        calls.push({ workspace: o.workspace, sha: o.sha, environment: o.environment, files: readdirSync(o.workspace, { recursive: true }).map(String).sort() });
        if (answer) return answer as never;
        const value = await use({ docker: "/nonexistent/docker", denv: { DOCKER_HOST: "tcp://127.0.0.1:2375" }, work: o.workspace, image: RECORD.imageId, imageEnv: {}, record: RECORD, run: () => Promise.reject(new Error("the capture runs no check")), copyWork: () => o.workspace, track: () => {}, untrack: () => {} });
        return { ok: true, value, record: RECORD, prepare: [] };
      },
    };
    return { l, calls };
  };
  const job = (o: Partial<CaptureJob>): CaptureJob => ({ source: o.source ?? change(), sha: "f".repeat(40), items: [SCREEN, CLI], preview: { rev: 3, preview: ["python3", "serve.py"], port: 8000 }, outDir: join(dir, "out"), root: join(dir, "root"), docker: "/nonexistent/docker", env: { PATH: "/nonexistent" }, ...o });

  it("with an environment: prepared there from a copy of the change", async () => {
    const { l, calls } = lender({ ok: false, reason: "prepare-failed", detail: "The prepare failed (Prepare: python3 -m pip install: failed, exit 1).", log: "ERROR: No matching distribution", record: { ...RECORD, prepare: "failed" }, prepare: [] });
    const r = await captureEvidence(job({ environment: ENV, lender: l }));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ sha: "f".repeat(40), environment: ENV });
    expect(calls[0].files).toEqual([".orchestrator", ".orchestrator/capture.json", "demo", "demo/trips.tape"]);
    expect(r.path).toEqual({ via: "environment", from: "setting", image: RECORD.image, imageId: RECORD.imageId, prepare: "failed", key: RECORD.key });
    expect(r.items.map((i) => (i.status === "none" ? [i.reason, i.detail, i.log] : i.status))).toEqual([
      ["install-failed", "The prepare failed (Prepare: python3 -m pip install: failed, exit 1).", "ERROR: No matching distribution"],
      ["install-failed", "The prepare failed (Prepare: python3 -m pip install: failed, exit 1).", "ERROR: No matching distribution"],
    ]);
    expect(r.notes).toBeUndefined();
    // Nothing of the stage stays.
    expect(readdirSync(join(dir, "root"))).toEqual([]);
  });

  it("with an environment that is prepared: the screens wait for the recorder's browser, and a CLI needs the daemon's local socket", async () => {
    const { l } = lender();
    const r = await captureEvidence(job({ environment: ENV, lender: l }));
    expect(r.path).toMatchObject({ via: "environment", prepare: "reused", imageId: RECORD.imageId });
    expect(r.items.map((i) => (i.status === "none" ? [i.itemId, i.reason, i.detail.slice(0, 60)] : i.status))).toEqual([
      ["bi-1", "unavailable", "The recorder's browser is not available: Docker is not insta"],
      ["bi-3", "unavailable", "Recording a CLI in the project's environment needs the Docke"],
    ]);
  });

  it("with an environment that cannot run: every item says why", async () => {
    const { l } = lender({ ok: false, reason: "unavailable", detail: "Docker is not running", prepare: [] });
    const r = await captureEvidence(job({ environment: ENV, lender: l }));
    expect(r.path).toEqual({ via: "environment", from: "setting", image: RECORD.image });
    expect(r.items.map((i) => (i.status === "none" ? [i.reason, i.detail] : i.status))).toEqual([
      ["unavailable", "The project's environment could not run: Docker is not running"],
      ["unavailable", "The project's environment could not run: Docker is not running"],
    ]);
  });

  it("without an environment nothing runs: every item is not set up, says what to set, and the lender is never asked", async () => {
    const { l, calls } = lender();
    const r = await captureEvidence(job({ lender: l }));
    expect(calls).toEqual([]);
    expect(r.path).toBeUndefined();
    expect(r.items.map((i) => (i.status === "none" ? [i.reason, i.detail] : i.status))).toEqual([
      ["not-set-up", NO_ENVIRONMENT],
      ["not-set-up", NO_ENVIRONMENT],
    ]);
    expect(NO_ENVIRONMENT).toMatch(/confirm the dev container or set an image in Settings › How your project runs\.$/);
    // Nothing was copied: no stage was made.
    expect(() => readdirSync(join(dir, "root"))).toThrow();
  });

  it("with nothing to capture, no path is recorded", async () => {
    const r = await captureEvidence(job({ items: [TUI], environment: ENV, lender: lender().l }));
    expect(r.path).toBeUndefined();
    expect(r.items).toMatchObject([{ itemId: "bi-4", status: "none", reason: "not-in-plan" }]);
  });

  it("finds the daemon's local socket from DOCKER_HOST; another kind of address has none", async () => {
    expect(await dockerSocket("/nonexistent/docker", { DOCKER_HOST: "unix:///Users/me/.colima/default/docker.sock" })).toBe("/Users/me/.colima/default/docker.sock");
    expect(await dockerSocket("/nonexistent/docker", { DOCKER_HOST: "tcp://127.0.0.1:2375" })).toBeUndefined();
  });
});
