// The JUnit XML report a project's checks write (ORC-029 pass 5): the service reads it from the run's throwaway copy
// after the commands ran, and records one result per test (`TestReport` on the check run). Most runners write JUnit:
// vitest (--reporter=junit), jest-junit, pytest (--junitxml), go-junit-report.
//
// Repository code writes the file, so it is hostile input:
// - Its path stays inside the copy. A report the change itself carries is removed before the commands run
//   (`clearReport`), so only this run's report counts. The folder is resolved and must stay inside the copy (no
//   symbolic link out), the file is opened without following a link and without blocking (a named pipe), and only a
//   regular file is read.
// - At most 4 MiB.
// - No markup declaration at all: a DOCTYPE, ENTITY or any other "<!" outside a CDATA section, a comment, a processing
//   instruction or a quoted value in a tag is refused before parsing, so no entity beyond XML's own five is expanded
//   and nothing external is referred to. (The parser would expand a DOCTYPE's entities even in the middle of the
//   document.)
// - Well-formed: a cut-off report could drop a failing test while its passing ones stay, so the validator runs first.
// - At most 16 nested elements (JUnit needs 5).
// Names, suites and messages lose control characters, secrets and local paths, and are capped.
//
// The parser is fast-xml-parser 5.11.2 (MIT), pinned: mature and maintained, with a nesting limit, protection against
// prototype pollution, and a validator in the same package (XMLValidator, which upstream now also ships as
// fast-xml-validator). It never fetches anything.

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, unlinkSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { validateTestReport } from "../src/domain/checks";
import { tagsIn } from "../src/domain/studio/ruleResults";
import type { TestCaseResult, TestReport } from "../src/domain/types";
import { redact } from "./redact";

export const REPORT_MAX_BYTES = 4 * 1024 * 1024;
export const REPORT_MAX_DEPTH = 16;
/** Test cases kept in the state per run: the tagged ones first. The counts cover every case. */
export const MAX_CASES = 400;
const NAME_CAP = 300;
const SUITE_CAP = 200;
const MESSAGE_CAP = 300;

/** Where the copy and the service's own folders are, so a message names a file relative to the repository and no local path. */
export interface ReportContext {
  workspace: string;
  /** The run's temp and cache folders. */
  scratch: string[];
  /** The service's environment: secret values in it are masked. */
  env: NodeJS.ProcessEnv;
}

// ---------- the file ----------

type Located = { path: string } | { missing: string } | { refused: string };

/** The report's path in the copy. Only its folder is resolved (the file may not exist yet), and it must stay inside the copy. */
function locate(workspace: string, rel: string): Located {
  const bad = validateTestReport(rel);
  if (bad) return { refused: bad };
  let root: string;
  let folder: string;
  try {
    root = realpathSync(workspace);
  } catch {
    return { refused: "the run's copy of the repository is gone" };
  }
  try {
    folder = realpathSync(dirname(join(workspace, rel)));
  } catch {
    return { missing: `The checks wrote no report at ${rel}.` };
  }
  if (folder !== root && !folder.startsWith(root + sep)) return { refused: `the folder of ${rel} leaves the copy of the repository (a symbolic link)` };
  return { path: join(folder, basename(rel)) };
}

const codeOf = (e: unknown) => (e as NodeJS.ErrnoException)?.code ?? "error";

/**
 * Remove a report the change itself carries, before any command runs, so that only this run's report is read.
 * Returns why the path cannot be used (it leaves the copy, or the file could not be removed), else undefined.
 */
export function clearReport(workspace: string, rel: string): string | undefined {
  const at = locate(workspace, rel);
  if ("refused" in at) return at.refused;
  if ("missing" in at) return undefined;
  try {
    if (lstatSync(at.path).isDirectory()) return `${rel} is a folder, not a file`;
    unlinkSync(at.path); // a symbolic link itself goes, never what it points to
    return undefined;
  } catch (e) {
    return codeOf(e) === "ENOENT" ? undefined : `the report the change carries at ${rel} could not be removed before the run (${codeOf(e)})`;
  }
}

/** Read and parse the report after the commands ran. Never throws. */
export function readTestReport(rel: string, ctx: ReportContext): TestReport {
  const refused = (reason: string): TestReport => ({ status: "refused", path: rel, reason });
  const at = locate(ctx.workspace, rel);
  if ("refused" in at) return refused(at.refused);
  if ("missing" in at) return { status: "missing", path: rel, reason: at.missing };
  let data: Buffer;
  try {
    const st = lstatSync(at.path);
    if (st.isSymbolicLink()) return refused(`${rel} is a symbolic link`);
    if (!st.isFile()) return refused(`${rel} is not a regular file`);
  } catch (e) {
    if (codeOf(e) === "ENOENT") return { status: "missing", path: rel, reason: `The checks wrote no report at ${rel}.` };
    return refused(`${rel} could not be read (${codeOf(e)})`);
  }
  let fd: number | undefined;
  try {
    // No link is followed, and a named pipe put there meanwhile cannot block the service.
    fd = openSync(at.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const st = fstatSync(fd);
    if (!st.isFile()) return refused(`${rel} is not a regular file`);
    if (st.size > REPORT_MAX_BYTES) return refused(`${rel} is ${(st.size / 1024 / 1024).toFixed(1)} MiB; the service reads at most ${REPORT_MAX_BYTES / 1024 / 1024} MiB`);
    data = Buffer.alloc(st.size);
    let got = 0;
    while (got < st.size) {
      const n = readSync(fd, data, got, st.size - got, got);
      if (n === 0) break;
      got += n;
    }
    data = data.subarray(0, got);
  } catch (e) {
    return codeOf(e) === "ELOOP" ? refused(`${rel} is a symbolic link`) : refused(`${rel} could not be read (${codeOf(e)})`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const parsed = parseJUnit(data.toString("utf8"), cleaner(ctx));
  if (!parsed.ok) return refused(`${rel} ${parsed.reason}`);
  return { status: "read", path: rel, ...keep(parsed.cases) };
}

// ---------- the XML ----------

/**
 * The first markup declaration ("<!DOCTYPE", "<!ENTITY", …) the parser would read, or undefined. A linear scan, before
 * any parsing, that reads the markup as fast-xml-parser 5 does: a comment, a CDATA section, a processing instruction
 * and a tag are each skipped whole, and the "?>" or ">" that ends an instruction or a tag does not count inside a
 * quoted value. So "<!--" inside an instruction or an attribute hides nothing after it.
 */
export function declarationIn(xml: string): string | undefined {
  let i = xml.indexOf("<");
  while (i >= 0) {
    let end: number;
    if (xml.startsWith("<!--", i)) end = after(xml.indexOf("-->", i + 4), 3);
    else if (xml.startsWith("<![CDATA[", i)) end = after(xml.indexOf("]]>", i + 9), 3);
    else if (xml.startsWith("<!", i)) return (/^<![A-Za-z]*/.exec(xml.slice(i, i + 12)) ?? ["<!"])[0];
    else if (xml.startsWith("</", i)) end = after(xml.indexOf(">", i), 1);
    else if (xml.startsWith("<?", i)) end = quotedEnd(xml, i + 1, "?>");
    else end = quotedEnd(xml, i + 1, ">");
    // Not closed: not well-formed, so the validator refuses it.
    if (end < 0) return undefined;
    i = xml.indexOf("<", end);
  }
  return undefined;
}

const after = (at: number, len: number) => (at < 0 ? -1 : at + len);

/** The index after `close`, from `from`, outside a quoted value (as the parser reads a tag or an instruction); else -1. */
function quotedEnd(xml: string, from: number, close: string): number {
  let quote = "";
  for (let j = from; j < xml.length; j++) {
    const c = xml[j];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (xml.startsWith(close, j)) return j + close.length;
  }
  return -1;
}

const LISTS = new Set(["testsuites", "testsuite", "testcase", "failure", "error", "skipped"]);
const parser = new XMLParser({
  ignoreAttributes: false,
  // Attributes as "@_name", apart from child elements of the same name.
  attributeNamePrefix: "@_",
  parseTagValue: false,
  parseAttributeValue: false,
  // XML's own five entities only: a document with a DTD never reaches the parser.
  processEntities: true,
  htmlEntities: false,
  trimValues: true,
  ignoreDeclaration: true,
  ignorePiTags: true,
  maxNestedTags: REPORT_MAX_DEPTH,
  isArray: (name) => LISTS.has(name),
});

type Node = Record<string, unknown>;
const asNode = (v: unknown): Node => (v && typeof v === "object" && !Array.isArray(v) ? (v as Node) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const attr = (n: Node, name: string): string | undefined => (typeof n[`@_${name}`] === "string" ? (n[`@_${name}`] as string) : undefined);
const textOf = (v: unknown): string => (typeof v === "string" ? v : typeof asNode(v)["#text"] === "string" ? (asNode(v)["#text"] as string) : "");

/** Cleans a name, a suite or a message for the state: `cap` characters, one line. */
export type Clean = (text: string, cap: number) => string;

/**
 * A message from <failure>, <error> or <skipped>: its message attribute, else the first lines of its text before a
 * stack frame. A one-word attribute ("Failed", as go-junit-report writes) gives way to the text when there is some.
 */
function messageOf(el: unknown, clean: Clean): string | undefined {
  const fromAttr = clean(attr(asNode(el), "message") ?? "", MESSAGE_CAP);
  if (fromAttr.includes(" ")) return fromAttr;
  const lines: string[] = [];
  for (const l of textOf(el).split(/\r?\n/)) {
    if (/^\s*(at\s|❯)/.test(l) && lines.length) break;
    if (l.trim()) lines.push(l.trim());
    if (lines.length === 3) break;
  }
  return clean(lines.join(" "), MESSAGE_CAP) || fromAttr || undefined;
}

function caseOf(tc: unknown, suite: string, clean: Clean): TestCaseResult {
  const n = asNode(tc);
  const failure = list(n.failure)[0];
  const error = list(n.error)[0];
  const skipped = list(n.skipped)[0];
  const status: TestCaseResult["status"] = n.failure !== undefined ? "failed" : n.error !== undefined ? "error" : n.skipped !== undefined ? "skipped" : "passed";
  const message = status === "passed" ? undefined : messageOf(status === "failed" ? failure : status === "error" ? error : skipped, clean);
  return { name: clean(attr(n, "name") ?? "", NAME_CAP), suite: clean(attr(n, "classname") ?? suite, SUITE_CAP), status, ...(message ? { message } : {}) };
}

function walk(suites: unknown[], parent: string, clean: Clean, out: TestCaseResult[]) {
  for (const s of suites) {
    const n = asNode(s);
    const name = attr(n, "name") ?? parent;
    for (const tc of list(n.testcase)) out.push(caseOf(tc, name, clean));
    walk(list(n.testsuite), name, clean, out);
  }
}

/** Parse a JUnit XML text into its test cases, or say why it is refused. Pure apart from the parser. */
export function parseJUnit(xml: string, clean: Clean): { ok: true; cases: TestCaseResult[] } | { ok: false; reason: string } {
  const decl = declarationIn(xml);
  if (decl) return { ok: false, reason: `declares ${decl} (a DTD, entities or another declaration); the service reads none` };
  const valid = XMLValidator.validate(xml);
  if (valid !== true) return { ok: false, reason: `is not well-formed XML (line ${valid.err.line}: ${clean(valid.err.msg, 120)})` };
  let doc: Node;
  try {
    doc = asNode(parser.parse(xml));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: /nested/i.test(msg) ? `nests more than ${REPORT_MAX_DEPTH} elements` : `could not be parsed (${clean(msg, 120)})` };
  }
  if (doc.testsuites === undefined && doc.testsuite === undefined) return { ok: false, reason: "has no <testsuites> or <testsuite>: it is not a JUnit report" };
  // <testsuites> is walked as a suite too: Node's built-in reporter writes top-level tests directly in it.
  const roots = [...list(doc.testsuites), ...list(doc.testsuite)];
  const out: TestCaseResult[] = [];
  walk(roots, "", clean, out);
  return { ok: true, cases: out };
}

/**
 * The cases kept in the state: every case when they fit; else the failing tagged ones (a rule's failure is never the
 * one left out), then the other tagged ones (the rules' evidence), then the failing ones, then the rest, kept in the
 * report's order. The tags of the cases left out are listed (rule results never read a tag that lost a test as a pass),
 * or "unlisted" past 400 tags.
 */
function keep(all: TestCaseResult[]): Pick<Extract<TestReport, { status: "read" }>, "cases" | "counts" | "truncated" | "droppedTags"> {
  const counts: Record<TestCaseResult["status"], number> = { passed: 0, failed: 0, skipped: 0, error: 0 };
  for (const c of all) counts[c.status]++;
  if (all.length <= MAX_CASES) return { cases: all, counts, truncated: false };
  const tags = (c: TestCaseResult) => [...tagsIn(c.name), ...tagsIn(c.suite)];
  const failing = (c: TestCaseResult) => c.status === "failed" || c.status === "error";
  const rank = (c: TestCaseResult) => (tags(c).length ? 0 : 2) + (failing(c) ? 0 : 1);
  const order = all.map((c, i) => ({ c, i, r: rank(c) })).sort((a, b) => a.r - b.r || a.i - b.i);
  const dropped = new Set(order.slice(MAX_CASES).flatMap((x) => tags(x.c)));
  const cases = order
    .slice(0, MAX_CASES)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.c);
  if (!dropped.size) return { cases, counts, truncated: true };
  return { cases, counts, truncated: true, droppedTags: dropped.size > MAX_CASES ? "unlisted" : [...dropped] };
}

// ---------- cleaning ----------

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const CONTROL = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;
const CHAR_REF = /&#(x[0-9A-Fa-f]{1,6}|[0-9]{1,7});/g;

/** Numeric character references the parser leaves in attribute values. An invalid one becomes nothing. */
function decodeCharRefs(t: string): string {
  return t.replace(CHAR_REF, (_, ref: string) => {
    const cp = ref[0] === "x" ? parseInt(ref.slice(1), 16) : parseInt(ref, 10);
    return cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff) ? String.fromCodePoint(cp) : "";
  });
}

/** Local paths out: the copy's path becomes relative, the run's own folders "<tmp>", home folders "~". */
export function scrubPaths(t: string, ctx: Pick<ReportContext, "workspace" | "scratch" | "env">): string {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const swaps: [string, string][] = [];
  for (const w of new Set([ctx.workspace, real(ctx.workspace)])) swaps.push([`${w}/`, ""], [w, "."]);
  for (const d of ctx.scratch) for (const p of new Set([d, real(d)])) swaps.push([p, "<tmp>"]);
  if (ctx.env.HOME && ctx.env.HOME.length > 1) swaps.push([ctx.env.HOME, "~"]);
  let out = t;
  for (const [from, to] of swaps.sort((a, b) => b[0].length - a[0].length)) if (from) out = out.split(from).join(to);
  return out
    .replace(/(?:\/private)?\/var\/folders\/[^\s:'"()]+/g, "<tmp>")
    .replace(/\/(?:Users|home)\/[^/\s:'"()]+/g, "~")
    .replace(/\b[A-Za-z]:\\Users\\[^\\\s:'"()]+/g, "~");
}

/** The cleaner for one report: character references decoded, colours and control characters out, local paths and secrets out, one line, capped. */
export function cleaner(ctx: ReportContext): Clean {
  return (text, cap) => {
    const one = decodeCharRefs(text).replace(ANSI, "").replace(CONTROL, " ").replace(/\s+/g, " ").trim();
    const safe = redact(scrubPaths(one, ctx), ctx.env);
    return safe.length > cap ? `${safe.slice(0, cap - 1)}…` : safe;
  };
}
