// ORC-032 at the service, unit by unit: the rules reader's answer and the parts designer's hand-in checked at the
// boundary, provenance at the import's commit, the simulated runner, the service's runner without an environment, and
// the bundled tally fixture the demo and the tests rely on.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as I from "../../src/domain/studio/import";
import { TALLY_COMMIT, tallyCases, tallyImport, tallyReading } from "../../src/domain/testing/import";
import type { TestCaseResult } from "../../src/domain/types";
import type { StagedArtifact } from "./artifacts";
import { EnvironmentImport, NO_ENVIRONMENT, SimulatedImport, TALLY_FIXTURE, askForImportRuns, partsRefusal, readImportReading, reportCases, tallyRepo } from "./import";
import { handedIn, importDesignerRun } from "./runs";
import { importDemo } from "./media";
import { validateCast, validateTape } from "./terminal";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orc032-import-unit-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const answer = (rules: unknown) => `Here are the rules.\n\n\`\`\`json\n${JSON.stringify({ rules })}\n\`\`\`\n`;
const CASES: TestCaseResult[] = tallyCases();

describe("the rules reader's answer, checked at the boundary", () => {
  it("gives the rules and exactly the report's cases they name", () => {
    const r = readImportReading(answer(tallyReading().rules), CASES);
    expect("rules" in r && r.rules.map((x) => x.id)).toEqual(["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9", "R10", "R11", "R12", "R13", "R14", "R15", "R16", "R17"]);
    expect("cases" in r && r.cases).toHaveLength(22);
    // The statuses are the report's, never the reader's.
    const failing = readImportReading(answer(tallyReading().rules), tallyCases(["test_add.py::test_rejects_text"]));
    expect("cases" in failing && failing.cases.find((c) => c.name === "test_rejects_text")?.status).toBe("failed");
  });

  it("refuses an answer with no JSON block, a bad schema, or a rule that fits no pattern, with the reason", () => {
    expect(readImportReading("I read it all.", CASES)).toEqual({ refused: 'its answer has no JSON block with the rules: { "rules": [...] }' });
    expect(readImportReading(answer("all of them"), CASES)).toEqual({ refused: 'The reading is { "rules": [...], "cases": [...] }' });
    const [r1] = tallyReading().rules;
    expect(readImportReading(answer([{ ...r1, text: "Money is kept carefully." }]), CASES)).toEqual({ refused: 'rule R1 fits no pattern: "Money is kept carefully."' });
    expect(readImportReading(answer([{ ...r1, sources: [] }]), CASES)).toEqual({ refused: 'rule R1: "sources" is a list of 1 to 5 { "from", "ref", "says" }' });
  });

  it("refuses a test the baseline report does not have, naming the rule", () => {
    const [r1] = tallyReading().rules;
    expect(readImportReading(answer([{ ...r1, tests: ["test_add.py::test_records_expense", "test_add.py::test_invented"] }]), CASES)).toEqual({ refused: 'rule R1 names "test_add.py::test_invented": not in the baseline report' });
    // With no baseline run, any test it names is unknown.
    expect(readImportReading(answer([r1]), [])).toEqual({ refused: 'rule R1 names "test_add.py::test_records_expense"; rule R1 names "test_add.py::test_records_date": not in the baseline report' });
  });
});

describe("the parts designer's hand-in", () => {
  const reading = () => tallyImport("read").s;
  const part = (title: string, rules: { id: string; text: string; tests?: string[] }[], kind: StagedArtifact["kind"] = "algorithm"): StagedArtifact => ({
    kind,
    title,
    devices: [],
    variants: [{ id: "a", label: "As it is today", entry: "p/p.md" }],
    files: [],
    provenance: ["tally/cli.py"],
    rules: [{ variant: "a", path: "p/rules.json", rules: rules.map((r) => ({ ...r, pattern: "always" })), examples: [] }],
  });
  const all = () => tallyReading().rules.map(({ id, text, tests }) => ({ id, text, ...(tests.length ? { tests } : {}) }));

  it("is taken when every rule is placed once, unchanged", () => {
    const rules = all();
    expect(partsRefusal(reading(), { importStep: "parts" }, [part("One", rules.slice(0, 9)), part("Two", rules.slice(9))])).toBeUndefined();
  });

  it("is refused when a rule is left out, placed twice, changed, names other tests, or unknown", () => {
    const s = reading();
    const rules = all();
    expect(partsRefusal(s, { importStep: "parts" }, [part("One", rules.slice(1))])).toBe("R1 is not placed: place every rule once, in the part it belongs to");
    expect(partsRefusal(s, { importStep: "parts" }, [part("One", rules), part("Two", rules.slice(0, 1))])).toBe('rule R1 is placed twice: in "One" and in "Two"');
    expect(partsRefusal(s, { importStep: "parts" }, [part("One", [{ ...rules[0], text: "The CLI shall record expenses." }, ...rules.slice(1)])])).toBe(`rule R1 in "One" is changed: place it as the reader wrote it, "${rules[0].text}"`);
    expect(partsRefusal(s, { importStep: "parts" }, [part("One", [{ ...rules[0], tests: ["test_add.py::test_records_date"] }, ...rules.slice(1)])])).toBe('rule R1 in "One" names other tests than the reader did (test_add.py::test_records_expense, test_add.py::test_records_date)');
    expect(partsRefusal(s, { importStep: "parts" }, [part("One", [...rules, { id: "R99", text: "The CLI shall exist." }])])).toBe('"One" places rule R99, which the reader did not find');
    expect(partsRefusal(s, { importStep: "parts" }, [{ ...part("Words", []), kind: "dictionary", rules: [] }, part("One", rules)])).toBe("the parts run hands in parts; the words run hands in the dictionary");
  });

  it("the words run hands in one dictionary, and nothing else", () => {
    const s = reading();
    const words: StagedArtifact = { kind: "dictionary", title: "Words", devices: [], variants: [{ id: "a", label: "As it is today", entry: "dictionary.json" }], files: [], provenance: ["README.md"] };
    expect(partsRefusal(s, { importStep: "words" }, [words])).toBeUndefined();
    expect(partsRefusal(s, { importStep: "words" }, [words, part("One", [])])).toBe("the import's words run hands in one dictionary, and nothing else");
  });

  it("names repository files that exist at the import's commit, and is refused for one added after it", () => {
    const repo = tallyRepo(join(dir, "tally"));
    const commit = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    // A file added in a later commit: at HEAD, not at the import's commit.
    writeFileSync(join(repo, "tally", "later.py"), "LATER = 1\n");
    execFileSync("git", ["-C", repo, "add", "-A"]);
    execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "later"]);
    // An import at tally's first commit, its words run under way.
    let s = tallyImport("checked").s;
    s = { ...s, project: { ...s.project, repoPath: repo }, studio: { ...s.studio, import: { ...s.studio.import!, commit } } };
    const asked = askForImportRuns(s, "2026-10-03T09:00:30.000Z");
    const run = asked.studio.runs.find((r) => r.importStep === "words")!;
    const running = { ...asked, studio: { ...asked.studio, runs: asked.studio.runs.map((r) => (r.id === run.id ? { ...r, status: "running" as const } : r)) } };
    const words = (provenance: string[]): StagedArtifact => ({ kind: "dictionary", title: "Words", devices: [], variants: [{ id: "a", label: "As it is today", entry: "dictionary.json" }], files: [{ path: "dictionary.json", sha256: "0".repeat(64), bytes: 2, data: Buffer.from("[]") }], provenance, dictionary: [{ term: "ledger", meaning: "The file of expenses.", avoid: [] }] });
    const ok = importDesignerRun(running, run.id, handedIn(running, run.id, [words(["README.md", "tally/cli.py"])]), join(dir, "studio"), "2026-10-03T09:00:40.000Z");
    expect(I.importParts(ok.state)[0].provenance).toEqual({ asIs: true, files: ["README.md", "tally/cli.py"], commit });
    expect(() => importDesignerRun(running, run.id, handedIn(running, run.id, [words(["tally/later.py"])]), join(dir, "studio"), "2026-10-03T09:00:40.000Z")).toThrow(
      `the provenance of "Words" names "tally/later.py", which the repository does not have at the import's commit ${commit.slice(0, 7)}.`,
    );
  });
});

describe("the runners", () => {
  it("the simulated runner reads tally's bundled report and gives each terminal demo its bundled cast, labelled simulated", async () => {
    const out = join(dir, "import");
    const signal = new AbortController().signal;
    expect(await new SimulatedImport().checks({ commit: TALLY_COMMIT, commands: [], outDir: out, signal })).toEqual({ status: "read", counts: { passed: 22, failed: 0, skipped: 0, error: 0 }, reportFile: "checks/report.json", simulated: true });
    expect(reportCases(out)).toHaveLength(22);
    const capture = await new SimulatedImport().capture({
      commit: TALLY_COMMIT,
      parts: [
        { artifactId: "art-1", version: 1, kind: "terminal-demo", title: "tally add", tape: { path: "add/demo.tape", text: "" } },
        { artifactId: "art-2", version: 1, kind: "screen", title: "A page" },
      ],
      outDir: out,
      signal,
    });
    expect(capture.simulated).toBe(true);
    expect(capture.parts[0]).toMatchObject({ artifactId: "art-1", status: "captured", files: [{ path: "art-1/demo.cast", type: "cast" }, { path: "art-1/demo.txt", type: "txt" }] });
    expect(readFileSync(join(out, "art-1", "demo.txt"), "utf8")).toContain("> tally add 42 Dinner --by ana\nAdded 42.00 EUR for Dinner");
    expect(capture.parts[1]).toMatchObject({ status: "none", reason: "unavailable" });
    expect(readdirSync(join(out, "art-1")).sort()).toEqual(["demo.cast", "demo.txt"]);
  });

  it("the service's runner runs nothing without an environment, and says why", async () => {
    const never = { withPrepared: () => Promise.reject(new Error("must not run")) };
    const runner = new EnvironmentImport({ lender: never });
    const signal = new AbortController().signal;
    expect(await runner.checks({ source: dir, commit: TALLY_COMMIT, commands: [], outDir: dir, signal })).toEqual({ status: "not-run", reason: NO_ENVIRONMENT });
    const capture = await runner.capture({ source: dir, commit: TALLY_COMMIT, parts: [{ artifactId: "art-1", version: 1, kind: "terminal-demo", title: "tally add" }], outDir: dir, signal, noEnvironment: "No image is set." });
    expect(capture).toEqual({ parts: [{ artifactId: "art-1", version: 1, status: "none", reason: "not-set-up", detail: "No image is set." }] });
  });

  it("the service's runner keeps the report it read, and says why when the tests did not write one", async () => {
    const environment = { plan: { source: { from: "setting" as const, image: "x" }, prepare: [], prepareFrom: "none" as const, hosts: [] }, project: "p" };
    const lender = (write: boolean) => ({
      withPrepared: async <T,>(_req: unknown, use: (p: never) => Promise<T>) => {
        const work = mkdtempSync(join(dir, "work-"));
        const p = { work, run: async () => {
          if (write) {
            mkdirSync(join(work, "reports"), { recursive: true });
            copyFileSync(join(TALLY_FIXTURE, "junit.xml"), join(work, "reports", "junit.xml"));
          }
          return { stdout: "", stderr: "", code: 0 };
        } } as never;
        return { ok: true as const, value: await use(p), record: {} as never, prepare: [] };
      },
    });
    const job = { source: dir, commit: TALLY_COMMIT, commands: [{ id: "test", label: "tests", argv: ["python3", "tests/run.py"], timeoutMs: 60_000 }], testReport: "reports/junit.xml", environment, outDir: join(dir, "out"), signal: new AbortController().signal };
    expect(await new EnvironmentImport({ lender: lender(true) }).checks(job)).toEqual({ status: "read", counts: { passed: 22, failed: 0, skipped: 0, error: 0 }, reportFile: "checks/report.json" });
    expect(await new EnvironmentImport({ lender: lender(false) }).checks(job)).toEqual({ status: "not-run", reason: "The checks wrote no report at reports/junit.xml." });
    expect(await new EnvironmentImport({ lender: lender(false) }).checks({ ...job, testReport: undefined })).toMatchObject({ status: "not-run", reason: "No JUnit report path is set, so the import cannot read the tests' results. Set it in Settings › Checks." });
  });
});

describe("an imported part's terminal demo, shown from the capture (U3-F1)", () => {
  const part = { id: "art-1", version: 1, variants: [{ id: "a", label: "As it is today", entry: "add/demo.tape" }] };
  const capture = (p: object) => ({ at: "2026-10-03T09:01:00.000Z", parts: [{ artifactId: "art-1", version: 1, ...p }] }) as never;
  const now = () => "2026-10-03T09:02:00.000Z";

  it("copies the capture's transcript into the version's recording folder, and reads recorded, or recorded with errors", () => {
    const captured = join(dir, "capture");
    mkdirSync(join(captured, "art-1"), { recursive: true });
    writeFileSync(join(captured, "art-1", "demo.txt"), "> tally add 42 Dinner --by ana\nAdded 42.00 EUR\n");
    const files = [{ path: "art-1/demo.cast", type: "cast", bytes: 1, sha256: "0".repeat(64) }, { path: "art-1/demo.txt", type: "txt", bytes: 1, sha256: "0".repeat(64) }];
    expect(importDemo(join(dir, "studio"), part, capture({ status: "captured", files }), captured, now)).toEqual({ demo: { status: "done", at: now(), variants: [{ variant: "a", status: "recorded", tape: "add/demo.tape", txt: "recording/a/demo.txt" }] } });
    expect(readFileSync(join(dir, "studio", "artifacts", "art-1", "v1", "recording", "a", "demo.txt"), "utf8")).toContain("Added 42.00 EUR");
    expect(importDemo(join(dir, "studio"), part, capture({ status: "captured", files, warnings: ["The recording shows a failure: Traceback"] }), captured, now).demo.variants).toEqual([{ variant: "a", status: "recorded-with-errors", tape: "add/demo.tape", txt: "recording/a/demo.txt", reason: "The recording shows a failure: Traceback" }]);
  });

  it("says why when the capture did not record it, or recorded another version", () => {
    const none = importDemo(join(dir, "studio"), part, capture({ status: "none", reason: "unavailable", detail: "Docker is not running" }), dir, now);
    expect(none.demo.variants).toEqual([{ variant: "a", status: "not-recorded", reason: "the import's capture did not record it: Docker is not running" }]);
    const later = importDemo(join(dir, "studio"), { ...part, version: 2 }, capture({ status: "none", reason: "unavailable", detail: "x" }), dir, now);
    expect(later.demo.variants).toEqual([{ variant: "a", status: "not-recorded", reason: "the import's capture recorded version 1; this version came after it" }]);
  });
});

describe("the bundled tally fixture", () => {
  it("is a repository with one commit that is the same on every computer, and its tapes and casts pass the studio's checks", () => {
    const a = tallyRepo(join(dir, "a"));
    const b = tallyRepo(join(dir, "b"));
    const head = (r: string) => execFileSync("git", ["-C", r, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    expect(head(a)).toBe(head(b));
    expect(execFileSync("git", ["-C", a, "rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim()).toBe("1");
    for (const key of ["add", "split", "report"]) {
      expect(validateTape(readFileSync(join(TALLY_FIXTURE, "parts", key, "demo.tape"), "utf8"), { name: `${key}/demo.tape` })).toMatchObject({ ok: true, shell: "bash" });
      expect(validateCast(readFileSync(join(TALLY_FIXTURE, "casts", `${key}.cast`), "utf8"), 2)).toMatchObject({ ok: true });
    }
    // The canned reading names only tests the canned report has.
    const reading = JSON.parse(readFileSync(join(TALLY_FIXTURE, "reading.json"), "utf8")) as { rules: { tests: string[] }[] };
    expect("rules" in readImportReading(answer(reading.rules), CASES)).toBe(true);
  });
});
