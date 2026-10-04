// ORC-032 repair round 1 at the server: each test reproduces one finding of the first review (the reviewer's probe),
// and holds its fix. tally is sample data.

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_IMPORT_CASES } from "../../src/domain/studio/import";
import { tallyImport } from "../../src/domain/testing/import";
import { EnvironmentImport, REPORT_FILE, TALLY_FIXTURE, readImportReading, readerEnvelope, reportCases } from "./import";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orc032-repair-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Every file under `d`, relative. */
const walk = (d: string, pre = ""): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name), `${pre}${e.name}/`) : [`${pre}${e.name}`]));

describe("CR-2, SR-1: the capture writes its plan and tapes into nothing of the repository's", () => {
  it("a repository whose .orchestrator is a link out of the copy gets nothing written through it; the plan still reaches the environment", async () => {
    const repo = join(dir, "repo");
    const outside = join(dir, "outside-the-copy");
    mkdirSync(repo);
    mkdirSync(outside);
    writeFileSync(join(repo, "README.md"), "x\n");
    symlinkSync(outside, join(repo, ".orchestrator"));
    // The environment answers that Docker is not there: the capture reached it, with its plan checked.
    const reached: string[] = [];
    const lender = { withPrepared: async (o: { workspace: string }) => (reached.push(o.workspace), { ok: false as const, reason: "unavailable" as const, detail: "Docker is not running", prepare: [] }) };
    const runner = new EnvironmentImport({ lender: lender as never, recorderRoot: join(dir, "rec") });
    const out = await runner.capture({
      source: repo,
      commit: "a".repeat(40),
      parts: [{ artifactId: "sa-1", version: 1, kind: "terminal-demo", title: "tally add", tape: { path: "add/demo.tape", text: readFileSync(join(TALLY_FIXTURE, "parts", "add", "demo.tape"), "utf8") } }],
      environment: { plan: { source: { from: "setting", image: "python:3" } } } as never,
      outDir: join(dir, "data", "evidence", "p", "import-1"),
      signal: new AbortController().signal,
    });
    expect(walk(outside)).toEqual([]);
    expect(out.parts.map((p) => p.status === "none" && [p.reason, p.detail])).toEqual([["unavailable", expect.stringContaining("Docker is not running")]]);
    expect(reached).toHaveLength(1);
  });
});

/** The baseline run of a project whose tests write `cases` JUnit cases (the last `failing` of them fail), through the service's runner. */
async function baselineRun(cases: number, failing = 0): Promise<string> {
  const work = join(dir, "work");
  mkdirSync(join(work, "reports"), { recursive: true });
  const outDir = join(dir, "import");
  // The environment's stand-in: the commands "write" the report, as the project's tests would.
  const xml = Array.from({ length: cases }, (_, i) => `<testcase classname="t.py" name="test_${i + 1}">${i >= cases - failing ? '<failure message="no"/>' : ""}</testcase>`).join("");
  const lender = {
    withPrepared: async (_o: unknown, use: (p: { work: string; run: () => Promise<unknown> }) => Promise<unknown>) => ({ ok: true as const, value: await use({ work, run: async () => writeFileSync(join(work, "reports", "junit.xml"), `<testsuite name="s" tests="${cases}">${xml}</testsuite>`) }) }),
  };
  const out = await new EnvironmentImport({ lender: lender as never, env: {} }).checks({ source: work, commit: "a".repeat(40), commands: [{ id: "t", label: "Tests", argv: ["true"], timeoutMs: 1000 }], testReport: "reports/junit.xml", environment: {} as never, outDir, signal: new AbortController().signal });
  expect(out).toMatchObject({ status: "read", counts: { passed: cases - failing, failed: failing } });
  return outDir;
}
const naming = (id: string) => '```json\n{ "rules": [ { "id": "R1", "area": "x", "text": "The CLI shall work.", "tests": ["' + id + '"], "sources": [ { "from": "test", "ref": "' + id + '", "says": "works" } ] } ] }\n```';

describe("CR-4: the import keeps the full report as its file, and its rules may name up to 1,000 of its tests", () => {
  it("keeps all 450 cases of a report; the reader may name test 450", async () => {
    const outDir = await baselineRun(450);
    expect(JSON.parse(readFileSync(join(outDir, REPORT_FILE), "utf8")).cases).toHaveLength(450);
    const cases = reportCases(outDir);
    expect(cases).toHaveLength(450);
    expect(readImportReading(naming("t.py::test_450"), cases)).toEqual({ rules: [expect.objectContaining({ id: "R1" })], cases: [{ suite: "t.py", name: "test_450", status: "passed" }] });
  });

  it("past 1,000, the reader sees 1,000 of them, the failing ones first; the file keeps every case", async () => {
    const outDir = await baselineRun(1200, 3);
    expect(JSON.parse(readFileSync(join(outDir, REPORT_FILE), "utf8")).cases).toHaveLength(1200);
    const cases = reportCases(outDir);
    expect(cases).toHaveLength(MAX_IMPORT_CASES);
    expect(cases.filter((c) => c.status === "failed").map((c) => c.name)).toEqual(["test_1198", "test_1199", "test_1200"]);
  });
});

describe("CR-6: two cases with one id: a failure counts", () => {
  it("a failing and a passing case named alike read as failed, in either order; the reader is shown the id once", () => {
    const failed = { suite: "a.test.ts", name: "works", status: "failed" as const, message: "boom" };
    const passed = { suite: "a.test.ts", name: "works", status: "passed" as const };
    for (const cases of [[failed, passed], [passed, failed]]) {
      const r = readImportReading(naming("a.test.ts::works"), cases);
      expect("cases" in r && r.cases).toEqual([failed]);
    }
    const { s } = tallyImport("read");
    const run = s.studio.runs.find((r) => r.importStep === "rules")!;
    const envelope = readerEnvelope(s, run, { folder: "/x", cases: [passed, failed, passed] });
    expect(envelope.match(/^- a\.test\.ts::works$/gm)).toHaveLength(1);
  });
});
