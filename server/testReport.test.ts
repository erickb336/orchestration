// ORC-029 pass 5: the JUnit report a project's checks write, read from the run's copy as one result per test. The
// reports of vitest (a real one, written by vitest 5.0.2), jest-junit, pytest and go-junit-report (hand-written in
// their shapes); hostile files (entities, external references, huge, deep, cut off, not JUnit, links out of the copy,
// a named pipe) refused with the reason; names and messages without local paths or secrets; a report the change
// carries removed before the run.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TestReport } from "../src/domain/types";
import { MAX_CASES, REPORT_MAX_BYTES, clearReport, readTestReport, type ReportContext } from "./testReport";

const FIXTURES = join(import.meta.dirname, "fixtures", "junit");
const REL = "reports/junit.xml";
let dir: string;
let ws: string;
let ctx: ReportContext;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orc-junit-"));
  ws = join(dir, "ws");
  mkdirSync(join(ws, "reports"), { recursive: true });
  ctx = { workspace: ws, scratch: [join(dir, "ws.tmp")], env: { HOME: "/Users/someone", SERVICE_API_TOKEN: "s3cret-value-123" } };
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Put a report at the configured path in the copy and read it as the runner does. */
function read(xml: string | Buffer): TestReport {
  writeFileSync(join(ws, REL), xml);
  return readTestReport(REL, ctx);
}
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");
const reasonOf = (r: TestReport) => (r.status === "read" ? "(read)" : r.reason);

describe("the four runners' reports: one result per test", () => {
  it("vitest (a real report): name with its describe block, the file as the suite, the failure's message, a skipped test", () => {
    expect(read(fixture("vitest.xml"))).toEqual({
      status: "read",
      path: REL,
      cases: [
        { name: "join flow > [bi-12 R1] shows the trip and a Join button when a friend opens the link", suite: "tests/join.test.ts", status: "passed" },
        { name: "join flow > [bi-12 R2] adds the friend to Who's in when they join", suite: "tests/join.test.ts", status: "passed" },
        {
          name: "join flow > [bi-12 R4] shows 'Ask the organizer for a new link' when the link has expired",
          suite: "tests/join.test.ts",
          status: "failed",
          message: "expected 'an empty page' to be 'Ask the organizer for a new link' // Object.is equality",
        },
        { name: "join flow > [bi-12 R5] never shows other trips to a friend who joins by link", suite: "tests/join.test.ts", status: "skipped" },
        { name: "join flow > [bi-12 E1] given a full trip, when a friend opens the link, then the page says the trip is full", suite: "tests/join.test.ts", status: "passed" },
        { name: "join flow > formats a date with no tag", suite: "tests/join.test.ts", status: "passed" },
      ],
      counts: { passed: 4, failed: 1, skipped: 1, error: 0 },
      truncated: false,
    });
  });

  it("jest-junit: a failure with no message attribute gives the first lines of its text, up to the stack", () => {
    const r = read(fixture("jest-junit.xml"));
    expect(r.status === "read" && r.cases.map((c) => [c.name, c.status, c.message])).toEqual([
      ["join flow [bi-12 R1] shows the trip and a Join button", "passed", undefined],
      ["join flow [bi-12 R2] joining adds the friend to Who's in", "passed", undefined],
      ["join flow [bi-12 R2] joining keeps the friend after a reload", "passed", undefined],
      ["join flow [bi-12 R4] an expired link asks for a new one", "failed", 'Error: expect(received).toBe(expected) // Object.is equality Expected: "Ask the organizer for a new link" Received: "an empty page"'],
      ["join flow [bi-12 R5] never shows other trips", "skipped", undefined],
    ]);
  });

  it("pytest: the tag in a parametrize id, a message with line breaks written as references, a skip's reason, a setup error", () => {
    const r = read(fixture("pytest.xml"));
    expect(r).toMatchObject({ status: "read", counts: { passed: 2, failed: 1, skipped: 1, error: 1 } });
    expect(r.status === "read" && r.cases).toEqual([
      { name: "test_open_link[bi-12 R1]", suite: "tests.test_join", status: "passed" },
      { name: "test_expired_link[bi-12 R4]", suite: "tests.test_join", status: "failed", message: "AssertionError: assert 'an empty page' == 'Ask the organizer for a new link' - Ask the organizer for a new link + an empty page" },
      { name: "test_other_trips[bi-12 R5]", suite: "tests.test_join", status: "skipped", message: "not built yet" },
      { name: "test_full_trip[bi-12 E1]", suite: "tests.test_join", status: "error", message: "failed on setup with \"KeyError: 'trip'\"" },
      { name: "test_format", suite: "tests.test_dates", status: "passed" },
    ]);
  });

  it("go-junit-report: the subtest's name with '_' for spaces, and the CDATA text instead of the one-word 'Failed'", () => {
    const r = read(fixture("go-junit-report.xml"));
    expect(r.status === "read" && r.cases).toEqual([
      { name: "TestJoin/[bi-12_R1]_shows_the_trip", suite: "example.com/trips/join", status: "passed" },
      { name: "TestJoin/[bi-12_R4]_expired_link", suite: "example.com/trips/join", status: "failed", message: 'join_test.go:21: got "an empty page", want "Ask the organizer for a new link"' },
      { name: "TestJoin", suite: "example.com/trips/join", status: "failed", message: "Failed" },
    ]);
  });

  it("Node's built-in reporter (a real report, written by Node 22.23): top-level tests sit in <testsuites> itself; a failing todo test is a failure", () => {
    // Node's test runner does not fail the run for a todo test, and writes both <skipped type="todo"> and <failure>.
    const r = read(fixture("node-test.xml"));
    expect(r.status === "read" && r.cases.map((c) => [c.name, c.status])).toEqual([
      ["[bi-3 R1] each person pays an equal share", "passed"],
      ["[bi-3 R3] the first person pays the cents left over", "failed"],
      ["[bi-3 E1] a skipped example", "skipped"],
      ["is refused", "passed"],
    ]);
    expect(r.status === "read" && r.counts).toEqual({ passed: 2, failed: 1, skipped: 1, error: 0 });
  });

  it("a <testsuite> root, nested suites (the inner suite's name when a case has no class name) and an empty report", () => {
    const nested = read('<testsuite name="outer"><testsuite name="inner"><testcase name="a"/></testsuite><testcase name="b" classname="k"/></testsuite>');
    expect(nested.status === "read" && nested.cases).toEqual([
      { name: "b", suite: "k", status: "passed" },
      { name: "a", suite: "inner", status: "passed" },
    ]);
    expect(read('<?xml version="1.0"?><testsuites/>')).toEqual({ status: "read", path: REL, cases: [], counts: { passed: 0, failed: 0, skipped: 0, error: 0 }, truncated: false });
  });
});

describe("what reaches the state: no local paths, no secrets, capped, at most 400 cases with the tagged ones kept", () => {
  it("the copy's path becomes relative, home folders '~', the run's own folders '<tmp>'; tokens and secret values from the service's environment are masked", () => {
    const msg = `Error at ${ws}/src/join.ts:3 in /Users/other/x and ${join(dir, "ws.tmp")}/cache.json with ghp_fakefakefakefakefake1234 and s3cret-value-123`;
    const r = read(`<testsuite><testcase name="t" classname="${ws}/tests/a.test.ts"><failure message="${msg}"/></testcase></testsuite>`);
    expect(r.status === "read" && r.cases[0]).toEqual({ name: "t", suite: "tests/a.test.ts", status: "failed", message: "Error at src/join.ts:3 in ~/x and <tmp>/cache.json with *** and ***" });
  });

  it("names are capped at 300 characters and messages at 300, on one line without control characters", () => {
    const long = "x".repeat(500);
    const r = read(`<testsuite><testcase name="${long}"><failure message="line one&#10;line two\u0007 ${long}"/></testcase></testsuite>`);
    expect(r.status === "read" && r.cases[0].name).toBe(`${"x".repeat(299)}…`);
    expect(r.status === "read" && r.cases[0].message).toBe(`line one line two ${"x".repeat(281)}…`);
  });

  it("over 400 cases: every tagged case is kept, then the failing ones, then the rest in the report's order; the counts cover all", () => {
    const untagged = Array.from({ length: 450 }, (_, i) => `<testcase name="plain ${i}"/>`).join("");
    const tagged = '<testcase name="[bi-3 R1] kept"/><testcase name="[bi-3 R2] kept too"><failure message="no"/></testcase>';
    const failing = '<testcase name="plain but failing"><error message="boom"/></testcase>';
    const r = read(`<testsuite>${untagged}${failing}${tagged}</testsuite>`);
    if (r.status !== "read") throw new Error(reasonOf(r));
    expect(r.cases).toHaveLength(MAX_CASES);
    expect(r.cases.slice(-4).map((c) => c.name)).toEqual(["plain 396", "plain but failing", "[bi-3 R1] kept", "[bi-3 R2] kept too"]);
    expect(r.counts).toEqual({ passed: 451, failed: 1, skipped: 0, error: 1 });
    expect(r.truncated).toBe(true);
  });
});

describe("hostile reports are refused with a clear reason", () => {
  it("entities (a billion laughs), an external reference, and a DOCTYPE in the middle of the document: refused before parsing", () => {
    const laughs = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]><testsuite><testcase name="&lol2;"/></testsuite>`;
    expect(read(laughs)).toEqual({ status: "refused", path: REL, reason: "reports/junit.xml declares <!DOCTYPE (a DTD, entities or another declaration); the service reads none" });
    expect(reasonOf(read('<?xml version="1.0"?>\n<!-- a comment --><!DOCTYPE testsuite SYSTEM "file:///etc/passwd"><testsuite><testcase name="&xxe;"/></testsuite>'))).toContain("declares <!DOCTYPE");
    // fast-xml-parser would expand this one; the scan refuses it.
    expect(reasonOf(read('<testsuite><!DOCTYPE x [<!ENTITY e "pwned">]><testcase name="&e;"/></testsuite>'))).toContain("declares <!DOCTYPE");
    expect(reasonOf(read('<testsuite><!ENTITY e "x"><testcase name="a"/></testsuite>'))).toContain("declares <!ENTITY");
  });

  it("a comment opener inside a processing instruction or an attribute does not hide a DOCTYPE after it", () => {
    // The review's input (finding 9): the scan read "<!--" in the instruction and skipped to the last "-->".
    const pi = '<?x <!-- ?><!DOCTYPE t [<!ENTITY e "X">]><testsuite><testcase name="&e;"/></testsuite><!-- -->';
    expect(read(pi)).toEqual({ status: "refused", path: REL, reason: "reports/junit.xml declares <!DOCTYPE (a DTD, entities or another declaration); the service reads none" });
    expect(reasonOf(read('<testsuite a="<!--"><!DOCTYPE t [<!ENTITY e "X">]><testcase name="&e;"/></testsuite><!-- -->'))).toContain("declares <!DOCTYPE");
    expect(reasonOf(read('<?x <![CDATA[ ?><!DOCTYPE t [<!ENTITY e "X">]><testsuite><testcase name="&e;"/></testsuite>]]>'))).toContain("declares <!DOCTYPE");
    // An instruction inside a comment is text, and a well-formed report with instructions is read.
    const ok = read('<?xml version="1.0"?><!-- <?x <!DOCTYPE no> --><?style a="<!--"?><testsuite><testcase name="a"/></testsuite>');
    expect(ok.status === "read" && ok.cases.map((c) => c.name)).toEqual(["a"]);
  });

  it("a DOCTYPE inside a CDATA section or a comment is text, not a declaration", () => {
    const r = read('<testsuite><!-- <!DOCTYPE no> --><testcase name="html"><failure><![CDATA[expected <!DOCTYPE html> at the start]]></failure></testcase></testsuite>');
    expect(r.status === "read" && r.cases).toEqual([{ name: "html", suite: "", status: "failed", message: "expected <!DOCTYPE html> at the start" }]);
  });

  it("a file over 4 MiB is refused unread", () => {
    const big = Buffer.alloc(REPORT_MAX_BYTES + 1, 0x20);
    big.write("<testsuite>", 0);
    expect(read(big)).toEqual({ status: "refused", path: REL, reason: "reports/junit.xml is 4.0 MiB; the service reads at most 4 MiB" });
  });

  it("nesting deeper than 16 elements, a cut-off report and a file that is not JUnit are refused", () => {
    expect(reasonOf(read(`${"<testsuite>".repeat(40)}<testcase name="a"/>${"</testsuite>".repeat(40)}`))).toBe("reports/junit.xml nests more than 16 elements");
    // A cut-off report could have lost a failing test: nothing of it counts.
    expect(reasonOf(read('<testsuite><testcase name="[bi-1 R1] a"/><testcase name="[bi-1 R1] b"><failure message="x"/>'))).toMatch(/^reports\/junit\.xml is not well-formed XML \(line 1: /);
    expect(reasonOf(read("<html><body>no tests</body></html>"))).toBe("reports/junit.xml has no <testsuites> or <testsuite>: it is not a JUnit report");
  });

  it("a link to a file outside the copy, a folder that links out of it, and a named pipe are refused, and nothing outside is read", () => {
    const secret = join(dir, "secret.txt");
    writeFileSync(secret, '<testsuite><testcase name="SECRET"/></testsuite>');
    symlinkSync(secret, join(ws, REL));
    expect(readTestReport(REL, ctx)).toEqual({ status: "refused", path: REL, reason: "reports/junit.xml is a symbolic link" });
    rmSync(join(ws, "reports"), { recursive: true });
    const outside = join(dir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "junit.xml"), '<testsuite><testcase name="SECRET"/></testsuite>');
    symlinkSync(outside, join(ws, "reports"));
    expect(readTestReport(REL, ctx)).toEqual({ status: "refused", path: REL, reason: "the folder of reports/junit.xml leaves the copy of the repository (a symbolic link)" });
    rmSync(join(ws, "reports"));
    mkdirSync(join(ws, "reports"));
    expect(spawnSync("mkfifo", [join(ws, REL)]).status).toBe(0);
    const t0 = Date.now();
    expect(readTestReport(REL, ctx)).toEqual({ status: "refused", path: REL, reason: "reports/junit.xml is not a regular file" });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("no report, or no folder for it: missing; a path that leaves the copy is refused whatever the settings said", () => {
    expect(readTestReport(REL, ctx)).toEqual({ status: "missing", path: REL, reason: "The checks wrote no report at reports/junit.xml." });
    expect(readTestReport("out/deeper/junit.xml", ctx)).toEqual({ status: "missing", path: "out/deeper/junit.xml", reason: "The checks wrote no report at out/deeper/junit.xml." });
    expect(readTestReport("../junit.xml", ctx)).toMatchObject({ status: "refused", reason: expect.stringContaining('is not a path inside the repository') });
  });
});

describe("a report the change itself carries never counts", () => {
  it("is removed before the commands run; a link goes without its target; a folder that links out is refused and nothing outside is touched", () => {
    writeFileSync(join(ws, REL), '<testsuite><testcase name="[bi-1 R1] always green"/></testsuite>');
    expect(clearReport(ws, REL)).toBeUndefined();
    expect(existsSync(join(ws, REL))).toBe(false);
    expect(clearReport(ws, REL)).toBeUndefined(); // nothing there: nothing to do
    const target = join(dir, "keep.xml");
    writeFileSync(target, "keep");
    symlinkSync(target, join(ws, REL));
    expect(clearReport(ws, REL)).toBeUndefined();
    expect(existsSync(join(ws, REL))).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("keep");
    rmSync(join(ws, "reports"), { recursive: true });
    const outside = join(dir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "junit.xml"), "not yours");
    symlinkSync(outside, join(ws, "reports"));
    expect(clearReport(ws, REL)).toBe("the folder of reports/junit.xml leaves the copy of the repository (a symbolic link)");
    expect(readFileSync(join(outside, "junit.xml"), "utf8")).toBe("not yours");
  });
});
