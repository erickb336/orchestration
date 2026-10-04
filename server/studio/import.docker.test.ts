// ORC-032 for real: the import's service steps on tally, the bundled sample, in Docker. The baseline test run runs
// tally's tests in the project's environment with no network and reads their JUnit report; the capture types each
// terminal demo's tape into tally's own CLI in the project's image and records it. Nothing runs on this computer.
// Gated on Docker: skipped, with the reason, when it is not running. Pulls the official Python image by digest the
// first time.

import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IMAGE_TABLE, environmentPlan, environmentSource } from "../../src/domain/environment";
import { PreparedEnvironments } from "../environment/prepared";
import { removeTree } from "../environment/copy";
import { dockerEnv, findDocker, runDocker } from "./container";
import { EnvironmentImport, TALLY_FIXTURE, reportCases, tallyRepo, type CapturePart } from "./import";

const docker = findDocker(process.env);
const up = docker ? await runDocker(docker, ["version", "--format", "{{.Server.Version}}"], { env: dockerEnv(process.env), timeoutMs: 20_000 }) : undefined;
const ready = !!up && up.code === 0 && !!up.stdout.trim();
const WEB_FIXTURE = resolve(__dirname, "fixtures", "import-web", "repo");
const skipReason = ready ? "" : ` (skipped: ${docker ? "Docker is not running" : "Docker is not installed"})`;

/** The test's project, so its prepared images (orc-env-<project>:<key>) are removed afterwards, and only its. */
const PROJECT = `importtest-${Math.random().toString(36).slice(2, 8)}`;
let root = "";
let scratch = "";
let runner: EnvironmentImport;

beforeAll(() => {
  if (!ready) return;
  // Under the home folder: Colima shares only it with its VM.
  root = mkdtempSync(join(homedir(), ".cache", "orchestrator-import-test-"));
  scratch = mkdtempSync(join(tmpdir(), "orc-import-real-"));
  runner = new EnvironmentImport({ lender: new PreparedEnvironments({ root, log: (m) => console.log(m) }), recorderRoot: join(root, "recorder"), log: (m) => console.log(m) });
});
afterAll(async () => {
  if (ready) {
    const images = await runDocker(docker!, ["images", "--format", "{{.Repository}}:{{.Tag}}"], { env: dockerEnv(process.env), timeoutMs: 30_000 });
    const ours = images.stdout.split("\n").filter((x) => x.startsWith(`orc-env-${PROJECT}`));
    if (ours.length) await runDocker(docker!, ["image", "rm", ...ours], { env: dockerEnv(process.env), timeoutMs: 120_000 });
  }
  if (root) removeTree(root);
  if (scratch) removeTree(scratch);
});

/** tally's environment, as the owner confirms it on the Start screen: the proposed Python image, which installs nothing. */
function environment() {
  const python = IMAGE_TABLE.find((r) => r.markers.includes("requirements.txt"))!;
  const setting = { rev: 1, image: python.image, prepare: [["python3", "-m", "pip", "install", "--user", "-r", "requirements.txt"]], hosts: [] };
  return { plan: environmentPlan(environmentSource(undefined, setting).source!, setting), project: PROJECT };
}

describe(`the import of tally, in Docker${skipReason}`, () => {
  it.skipIf(!ready)("runs tally's 22 tests in the project's environment with no network, and keeps their JUnit report", async () => {
    const repo = tallyRepo(join(scratch, "tally"));
    const out = join(scratch, "import");
    const result = await runner.checks({
      source: repo,
      commit: "0".repeat(40),
      commands: [{ id: "test", label: "tally's tests", argv: ["python3", "tests/run.py"], timeoutMs: 5 * 60_000 }],
      testReport: "reports/junit.xml",
      environment: environment(),
      outDir: out,
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ status: "read", counts: { passed: 22, failed: 0, skipped: 0, error: 0 }, reportFile: "checks/report.json" });
    expect(reportCases(out).map((c) => `${c.suite}::${c.name}`)).toContain("test_add.py::test_records_expense");
  }, 600_000);

  it.skipIf(!ready)("records each terminal demo by typing its tape into tally's own CLI in the project's image", async () => {
    const repo = tallyRepo(join(scratch, "tally"));
    const out = join(scratch, "capture");
    const parts: CapturePart[] = ["add", "split", "report"].map((key, i) => ({ artifactId: `art-${i + 1}`, version: 1, kind: "terminal-demo", title: `tally ${key}`, tape: { path: `${key}/demo.tape`, text: readFileSync(join(TALLY_FIXTURE, "parts", key, "demo.tape"), "utf8") } }));
    const capture = await runner.capture({ source: repo, commit: "0".repeat(40), parts, environment: environment(), outDir: out, signal: new AbortController().signal });
    expect(capture.parts.map((p) => `${p.artifactId} ${p.status}${p.status === "none" ? `: ${p.detail}` : ""}`)).toEqual(["art-1 captured", "art-2 captured", "art-3 captured"]);
    const transcript = (i: number) => {
      const p = capture.parts[i];
      if (p.status !== "captured") return "";
      return readFileSync(join(out, p.files.find((f) => f.type === "txt")!.path), "utf8");
    };
    // What tally printed, in its own words: the real CLI ran.
    expect(transcript(0)).toContain("Added 42.00 EUR for Dinner, paid by ana, shared by ana, ben, cy.");
    expect(transcript(0)).toContain("Unknown person: sam");
    expect(transcript(1)).toContain("cy pays ana 23.00");
    expect(transcript(2)).toContain("2026-10-01,ana,42.00,Dinner");
    expect(capture.parts.every((p) => p.status === "captured" && p.files.some((f) => f.type === "cast" && f.path.startsWith(`${p.artifactId}/`)))).toBe(true);
  }, 900_000);

  it.skipIf(!ready)("records a screen product's page on each of its devices, from the preview the owner set (U2-F2)", async () => {
    // A small screen product: one static page, served by Python's standard library in the project's image.
    const src = join(scratch, "web");
    cpSync(WEB_FIXTURE, src, { recursive: true });
    const setting = { rev: 1, image: IMAGE_TABLE.find((r) => r.markers.includes("requirements.txt"))!.image, prepare: [], hosts: [] };
    const out = join(scratch, "web-capture");
    const parts: CapturePart[] = [
      { artifactId: "art-board", version: 1, kind: "screen", title: "Trip board", page: "/board.html", devices: ["desktop", "mobile"] },
      { artifactId: "art-none", version: 1, kind: "screen", title: "No page", devices: ["desktop"] },
    ];
    const capture = await runner.capture({ source: src, commit: "0".repeat(40), parts, preview: { rev: 1, preview: ["python3", "-m", "http.server", "8000", "--bind", "127.0.0.1"], port: 8000 }, environment: { plan: environmentPlan(environmentSource(undefined, setting).source!, setting), project: PROJECT }, outDir: out, signal: new AbortController().signal });
    const [board, none] = capture.parts;
    if (board.status !== "captured") throw new Error(JSON.stringify(board));
    expect(board.files.map((f) => [f.path, f.type, f.device])).toEqual([
      ["art-board/desktop.png", "png", "desktop"],
      ["art-board/mobile.png", "png", "mobile"],
    ]);
    const size = (rel: string) => {
      const b = readFileSync(join(out, rel));
      return [b.readUInt32BE(16), b.readUInt32BE(20)];
    };
    // Desktop at 1280×800; mobile at 390×844, three pixels to each point.
    expect([size("art-board/desktop.png"), size("art-board/mobile.png")]).toEqual([
      [1280, 800],
      [1170, 2532],
    ]);
    expect(none).toMatchObject({ artifactId: "art-none", status: "none", reason: "not-in-plan", detail: "The designer gave no page for this screen, so the capture cannot open it." });
  }, 900_000);
});
