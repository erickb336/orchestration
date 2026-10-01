// ORC-016 step 1, the service side: reading your pattern files (JSONC, the schema, positions), the
// built-in files and their equivalence with the format-14 templates (P4), the reload endpoint (P3), the
// removed commands (P1), migration 14 → 15 (P9), the export of retired templates (P10), and a custom
// pipeline that keeps running across the upgrade. Temporary directories only; nothing under the home.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLIENT_HEADER } from "../src/api";
import { BUILT_IN_FILES } from "../src/domain/builtInPatterns";
import { COMMANDS } from "../src/domain/commands";
import { INTERNAL_PATTERNS } from "../src/domain/internalPatterns";
import * as M from "../src/domain/model";
import { builtInCatalog } from "../src/domain/patterns";
import { toDef } from "../src/domain/pipeline";
import { ARTIFACT_KINDS, PROVIDERS, STEP_ROLES, type RetiredTemplate, type State, type StepDef } from "../src/domain/types";
import schema from "../patterns/pattern.schema.json";
import { createHttpServer } from "./http";
import { V14_TEMPLATES } from "./legacyTemplates";
import { MAX_EXPORT_NAMES, SCHEMA_FILE, SCHEMA_TEXT, exportRetiredTemplates, loadPatternCatalog, patternValidator, positionOf, retiredTemplateFile } from "./patterns";
import { FakeAdapter, defaultFakeConfig } from "./runtimes/fake";
import { Scheduler } from "./scheduler";
import { STATE_FORMAT, Store } from "./store";
import { setTestPipeline } from "./testing/pipelines";
import { ScriptedAdapter } from "./testing/scripted";
import { WorkspaceManager } from "./workspaces";

const PATTERNS_DIR = fileURLToPath(new URL("../patterns", import.meta.url));
const T0 = Date.parse("2026-09-30T12:00:00Z");
const iso = (ms = T0) => new Date(ms).toISOString();
const oneStep: StepDef[] = [{ id: "S1", purpose: "Implement", role: "coder", dependsOn: [], inputs: [], outputs: [{ name: "change", kind: "code-change" }] }];
const builtIn = (id: string) => builtInCatalog().patterns.find((p) => p.id === id)!;
const task = (s: State, id: string) => s.tasks.find((t) => t.id === id)!;

let dir: string;
let patterns: string;
const write = (name: string, text: string) => writeFileSync(join(patterns, name), text);
const load = () => loadPatternCatalog(patterns, iso());
const pretty = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
/** Line and column of the first occurrence of `needle` in `text` (one-based). */
const where = (text: string, needle: string) => positionOf(text, text.indexOf(needle));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orc-patterns-"));
  patterns = join(dir, "patterns");
  mkdirSync(patterns, { recursive: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("reading your files", () => {
  it("a .jsonc file with comments and trailing commas loads as a variant of a built-in", () => {
    write(
      "bugfix-pause-after-repro.jsonc",
      `{
  "$schema": "./pattern.schema.json",   // the app keeps a copy of the schema next to your files
  "id": "bugfix-pause-after-repro",      // must match the file name
  "name": "Bug fix, pause after the reproduction",
  "description": "Bug fix that stops after the reproduction so you can read it before the fix starts.",
  "whenToUse": "Bugs where a wrong reproduction would waste the fix.",
  "extends": "bugfix",                   // start from the built-in Bug fix
  "stepOverrides": {
    "S1": { "gate": true },              // pause after S1, Reproduce and diagnose
  },                                     // trailing commas are fine in your files
}
`,
    );
    const c = load();
    expect(c.errors).toEqual([]);
    expect(c.localDir).toBe(patterns);
    expect(c.loadedAt).toBe(iso());
    const p = c.patterns.find((x) => x.id === "bugfix-pause-after-repro")!;
    expect(p).toMatchObject({ source: "local", file: join(patterns, "bugfix-pause-after-repro.jsonc"), audience: "user-only", flags: expect.objectContaining({ pausesForYou: true }) });
    expect(p.replacesBuiltIn).toBeUndefined();
    expect(p.chain.map((x) => [x.id, x.source])).toEqual([
      ["bugfix-pause-after-repro", "local"],
      ["bugfix", "built-in"],
    ]);
    expect(p.steps.map((s) => ({ ...s, gate: undefined }))).toEqual(builtIn("bugfix").steps.map((s) => ({ ...s, gate: undefined })));
    expect(p.steps[0].gate).toBe(true);
    expect(c.patterns).toHaveLength(builtInCatalog().patterns.length + 1);
  });

  it("a syntax error reports its line and column, and the rest of the catalog loads", () => {
    write("bad.json", '{\n  "id": "bad",\n  "name": "x" "oops"\n}');
    const c = load();
    expect(c.errors).toEqual([{ file: join(patterns, "bad.json"), id: "bad", message: "JSON syntax: CommaExpected", line: 3, column: 15, effect: "skipped" }]);
    expect(c.patterns).toHaveLength(builtInCatalog().patterns.length);
    write("empty.json", "   \n");
    expect(load().errors.find((e) => /empty/.test(e.file))).toMatchObject({ message: "JSON syntax: ValueExpected", effect: "skipped" });
    write("list.json", "[1, 2]");
    expect(load().errors.find((e) => /list/.test(e.file))).toMatchObject({ message: "a pattern file holds one JSON object", line: 1, column: 1 });
  });

  it("a schema error names the field and the position of its value; a broken file over a built-in keeps the built-in", () => {
    const raw = structuredClone(BUILT_IN_FILES.find((f) => f.raw.id === "change")!.raw) as unknown as { steps: { role: string }[] };
    raw.steps[2].role = "tester";
    const text = pretty(raw);
    write("change.json", text);
    const c = load();
    expect(c.errors).toEqual([{ file: join(patterns, "change.json"), id: "change", message: "steps[2].role: must be one of lead, designer, coder, code_reviewer, ux_reviewer, checks", ...where(text, '"tester"'), effect: "built-in kept" }]);
    const change = c.patterns.find((p) => p.id === "change")!;
    expect(change.source).toBe("built-in");
    expect(change.hash).toBe(builtIn("change").hash);
    expect(c.patterns.filter((p) => p.id === "change")).toHaveLength(1);
  });

  it("an unknown key, checks.only, a missing hypothesis, and a steps-plus-extends mix are refused in plain words", () => {
    const base = { id: "mine", name: "Mine", description: "d", whenToUse: "w" };
    write("mine.json", pretty({ ...base, steps: oneStep, foo: 1 }));
    expect(load().errors.map((e) => e.message)).toEqual(["foo: unknown field"]);
    const withOnly = pretty({ ...base, steps: [...oneStep, { id: "C1", purpose: "Checks", role: "checks", dependsOn: ["S1"], inputs: [{ step: "S1", output: "change" }], outputs: [{ name: "checks", kind: "check-results" }], checks: { onFail: "findings", only: ["lint"] } }] });
    write("mine.json", withOnly);
    expect(load().errors).toEqual([expect.objectContaining({ id: "mine", message: "steps[1].checks.only: not allowed; check commands belong to each project; patterns run every configured check", ...where(withOnly, '"only"') })]);
    write("mine.json", pretty({ ...base, steps: oneStep, experimental: true }));
    expect(load().errors.map((e) => e.message)).toEqual(['"hypothesis" is required when "experimental" is true: say what the experiment should show']);
    write("mine.json", pretty({ ...base, steps: oneStep, extends: "change" }));
    expect(load().errors.map((e) => e.message)).toEqual([expect.stringMatching(/either lists "steps" \(a base pattern\) or "extends" another pattern/)]);
    write("mine.json", pretty({ ...base, extends: "change", stepOverrides: { S1: { gate: false } } }));
    expect(load().errors.map((e) => e.message)).toEqual(["stepOverrides.S1.gate: must be a valid value for this field, or null to remove it"]);
    write("mine.json", pretty({ ...base, stepOverrides: { S1: { gate: true } } }));
    expect(load().errors.map((e) => e.message)).toEqual(expect.arrayContaining(['"stepOverrides" needs "extends" too']));
    write("mine.json", pretty({ ...base, steps: oneStep.map((s) => ({ ...s, copyOf: "S1" })) }));
    expect(load().errors.map((e) => e.message)).toEqual(["steps[0].copyOf: not allowed; the service sets it when it expands steps"]);
  });

  it("the file name must be the id; dotfiles, subdirectories, other extensions and the schema copy are not patterns", () => {
    write("other.json", pretty({ id: "mine", name: "Mine", description: "d", whenToUse: "w", steps: oneStep }));
    mkdirSync(join(patterns, "sub"));
    writeFileSync(join(patterns, "sub", "nested.json"), pretty({ id: "nested", name: "N", description: "d", whenToUse: "w", steps: oneStep }));
    writeFileSync(join(patterns, ".hidden.json"), "not json");
    writeFileSync(join(patterns, "notes.txt"), "not json");
    const c = load();
    expect(c.errors).toEqual([expect.objectContaining({ file: join(patterns, "other.json"), message: expect.stringMatching(/named "other" but declares the id "mine"/), effect: "skipped" })]);
    expect(c.patterns.some((p) => p.id === "nested" || p.id === "mine")).toBe(false);
  });

  it("a UTF-8 byte order mark is not part of the file; resolver errors point at the extends, stepOverrides or id key (step 1 review, finding 6)", () => {
    write("bom.json", `﻿${pretty({ id: "bom", name: "BOM", description: "d", whenToUse: "w", extends: "change", stepOverrides: { S2: { independentOf: "writer" } } })}`);
    const unknownBase = pretty({ id: "orphan", name: "Orphan", description: "d", whenToUse: "w", extends: "nope", stepOverrides: { S1: { gate: true } } });
    write("orphan.json", unknownBase);
    const badOverride = pretty({ id: "override", name: "Override", description: "d", whenToUse: "w", extends: "change", stepOverrides: { S9: { gate: true } } });
    write("override.json", badOverride);
    const badGraph = pretty({ id: "graph", name: "Graph", description: "d", whenToUse: "w", steps: [{ ...oneStep[0], dependsOn: ["S9"] }] });
    write("graph.json", badGraph);
    const c = load();
    expect(c.patterns.find((p) => p.id === "bom")).toMatchObject({ source: "local", steps: builtIn("change-cross-review").steps });
    const errorFor = (id: string) => c.errors.find((e) => e.id === id)!;
    expect(errorFor("orphan")).toMatchObject({ message: expect.stringMatching(/extends "nope", which is not a pattern/), ...where(unknownBase, '"extends"') });
    expect(errorFor("override")).toMatchObject({ message: expect.stringMatching(/stepOverrides\.S9: the base pattern has no step S9/), ...where(badOverride, '"S9"') });
    expect(errorFor("graph")).toMatchObject({ message: expect.stringMatching(/S1 depends on S9/), ...where(badGraph, '"id"') });
    expect(c.errors).toHaveLength(3);
  });

  it("an unwritable patterns directory or a failed schema copy is a load warning, never a failure (step 1 review, finding 6)", () => {
    rmSync(patterns, { recursive: true, force: true });
    writeFileSync(patterns, "not a directory\n"); // a file where the directory should be
    const c = load();
    expect(c.patterns.map((p) => p.id)).toEqual(builtInCatalog().patterns.map((p) => p.id));
    expect(c.errors).toEqual([expect.objectContaining({ file: patterns, message: expect.stringMatching(/your patterns directory could not be created or read, so none of your files were loaded/), effect: "skipped" })]);
    expect(c.errors[0].line).toBeUndefined();
    // The schema copy cannot be written where a file of yours takes its name as a directory; your files still load.
    rmSync(patterns, { force: true });
    mkdirSync(join(patterns, SCHEMA_FILE), { recursive: true });
    write("mine.json", pretty({ id: "mine", name: "Mine", description: "d", whenToUse: "w", extends: "change", stepOverrides: { S2: { independentOf: "writer" } } }));
    const d = load();
    expect(d.patterns.find((p) => p.id === "mine")).toBeDefined();
    expect(d.errors).toEqual([expect.objectContaining({ file: patterns, message: expect.stringMatching(/the schema copy pattern\.schema\.json could not be written there/) })]);
  });

  it("more than 100 files, or a file over 64 KiB, is refused and listed", () => {
    mkdirSync(patterns, { recursive: true });
    for (let i = 1; i <= 101; i++) write(`v${String(i).padStart(3, "0")}.json`, pretty({ id: `v${String(i).padStart(3, "0")}`, name: `V${i}`, description: "d", whenToUse: "w", extends: "change", stepOverrides: { S1: { purpose: `Implement v${i}` } } }));
    const c = load();
    expect(c.patterns.filter((p) => p.source === "local")).toHaveLength(100);
    expect(c.errors).toEqual([expect.objectContaining({ file: join(patterns, "v101.json"), id: "v101", message: expect.stringMatching(/more than 100 pattern files; this one was not read/) })]);
    rmSync(patterns, { recursive: true, force: true });
    mkdirSync(patterns);
    write("huge.json", pretty({ id: "huge", name: "Huge", description: "d", whenToUse: "w", $comment: "x".repeat(65 * 1024), steps: oneStep }));
    expect(load().errors).toEqual([expect.objectContaining({ id: "huge", message: expect.stringMatching(/larger than 64 KiB/), effect: "skipped" })]);
  });
});

describe("the built-in files", () => {
  it("the schema copy is written next to your files and refreshed when it differs; it is never read as a pattern", () => {
    load();
    expect(readFileSync(join(patterns, SCHEMA_FILE), "utf8")).toBe(SCHEMA_TEXT);
    write(SCHEMA_FILE, "{ broken");
    const c = load();
    expect(readFileSync(join(patterns, SCHEMA_FILE), "utf8")).toBe(SCHEMA_TEXT);
    expect(c.errors).toEqual([]);
  });

  it("every file in patterns/ is strict JSON, passes the schema, and appears in the manifest exactly once", () => {
    const validate = patternValidator();
    const files = readdirSync(PATTERNS_DIR)
      .filter((f) => f.endsWith(".json") && f !== SCHEMA_FILE)
      .sort();
    expect(files.length).toBeGreaterThanOrEqual(11);
    for (const f of files) {
      const raw: unknown = JSON.parse(readFileSync(join(PATTERNS_DIR, f), "utf8"));
      expect(validate(raw), `${f}: ${JSON.stringify(validate.errors)}`).toBe(true);
      expect((raw as { id: string }).id, f).toBe(f.replace(/\.json$/, ""));
    }
    expect(BUILT_IN_FILES.map((f) => basename(f.file)).sort()).toEqual(files);
    expect(new Set(BUILT_IN_FILES.map((f) => f.raw.id)).size).toBe(BUILT_IN_FILES.length);
    expect(builtInCatalog().errors).toEqual([]);
    expect(builtInCatalog().patterns).toHaveLength(files.length);
  });

  it("the schema's enums equal the TypeScript constants", () => {
    expect(schema.$defs.role.enum).toEqual(STEP_ROLES);
    expect(schema.$defs.kind.enum).toEqual(ARTIFACT_KINDS);
    expect(schema.$defs.provider.enum).toEqual(PROVIDERS);
  });

  it("P4: the six standard base patterns and the three internal pipelines equal the format-14 templates", () => {
    for (const id of ["change", "feature", "bugfix", "investigation", "design", "goal"]) {
      const p = builtIn(id);
      const t = V14_TEMPLATES[id];
      expect(p.steps, id).toEqual(t.steps.map(toDef));
      expect(p.name, id).toBe(t.name);
      expect(p.description, id).toBe(t.description);
    }
    for (const p of INTERNAL_PATTERNS) {
      const t = V14_TEMPLATES[p.id];
      expect(p.steps, p.id).toEqual(t.steps.map(toDef));
      expect(p.name, p.id).toBe(t.name);
      expect(p.description, p.id).toBe(t.description);
    }
    expect(Object.keys(V14_TEMPLATES).sort()).toEqual(["bugfix", "change", "delivery-checks", "delivery-review", "design", "feature", "goal", "investigation", "revert"]);
  });
});

describe("over HTTP: reload and the removed commands", () => {
  let base = "";
  let store: Store;
  let close: () => void = () => {};
  let key = 0;
  const k = () => `k-${++key}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const j = (r: Response) => r.json() as Promise<any>;
  const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", [CLIENT_HEADER]: "1" }, body: JSON.stringify(body) });
  const state = async (): Promise<State> => (await j(await fetch(base + "/api/state"))).state;
  const cmd = async (name: string, args: unknown) => {
    const r = await post("/api/commands", { name, args, idempotencyKey: k() });
    return { status: r.status, body: await j(r) };
  };

  beforeEach(async () => {
    store = new Store(join(dir, "db.sqlite"));
    const config = defaultFakeConfig();
    const adapters = { claude: new FakeAdapter("claude", config), codex: new FakeAdapter("codex", config) };
    const scheduler = new Scheduler(store, adapters);
    const probe = createHttpServer({ store, scheduler, fakeConfig: config, startedAt: iso(), allowedHosts: [], patternsDir: patterns });
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as AddressInfo).port;
    probe.close();
    const server = createHttpServer({ store, scheduler, fakeConfig: config, startedAt: iso(), allowedHosts: [`127.0.0.1:${port}`], patternsDir: patterns });
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
    base = `http://127.0.0.1:${port}`;
    close = () => {
      server.closeAllConnections();
      server.close();
      store.close();
    };
  });
  afterEach(() => close());

  it("a new variant of yours appears on reload without a restart; a later edit never changes a task created before (P3)", async () => {
    const first = await post("/api/patterns/reload", {});
    expect(first.status).toBe(200);
    expect(await j(first)).toEqual({ loadedAt: expect.any(String), patterns: builtInCatalog().patterns.length, errors: 0 });
    mkdirSync(patterns, { recursive: true });
    const variant = (purpose: string) => pretty({ id: "bugfix-gate", name: "Bug fix, pause after repro", description: "d", whenToUse: "w", extends: "bugfix", stepOverrides: { S1: { gate: true }, S2: { purpose } } });
    write("bugfix-gate.json", variant("Fix"));
    expect(await j(await post("/api/patterns/reload", {}))).toMatchObject({ patterns: builtInCatalog().patterns.length + 1, errors: 0 });
    let s = await state();
    const loaded = s.patterns.patterns.find((p) => p.id === "bugfix-gate")!;
    expect(loaded).toMatchObject({ source: "local", audience: "user-only" });
    expect(s.events.filter((e) => e.message.startsWith("Patterns loaded"))).toHaveLength(1);
    const created = await cmd("createTask", { title: "Gated fix", area: "", outcome: "o", benefit: "", whyNow: "", approach: "a", acceptance: ["ok"], priority: 1, holdBeforeStart: true, patternId: "bugfix-gate" });
    expect(created.status).toBe(200);
    const id = created.body.result.newId as string;
    s = await state();
    const before = JSON.stringify({ steps: task(s, id).steps, history: task(s, id).pipelineHistory, pattern: task(s, id).pattern });
    expect(task(s, id).pattern).toMatchObject({ id: "bugfix-gate", source: "local", hash: loaded.hash, chosenBy: "user" });
    expect(task(s, id).steps[0].gate).toBe(true);
    // The file changes: the catalog follows, the task does not.
    write("bugfix-gate.json", variant("Fix it carefully"));
    expect(await j(await post("/api/patterns/reload", {}))).toMatchObject({ patterns: builtInCatalog().patterns.length + 1, errors: 0 });
    s = await state();
    const edited = s.patterns.patterns.find((p) => p.id === "bugfix-gate")!;
    expect(edited.hash).not.toBe(loaded.hash);
    expect(edited.steps.find((x) => x.id === "S2")!.purpose).toBe("Fix it carefully");
    expect(JSON.stringify({ steps: task(s, id).steps, history: task(s, id).pipelineHistory, pattern: task(s, id).pattern })).toBe(before);
    expect(s.events.filter((e) => e.message.startsWith("Patterns loaded"))).toHaveLength(2);
    // Repeating it changes nothing.
    await post("/api/patterns/reload", {});
    expect((await state()).events.filter((e) => e.message.startsWith("Patterns loaded"))).toHaveLength(2);
    // A broken file is listed with its position; the service keeps running.
    write("broken.json", "{\n  oops\n}");
    expect(await j(await post("/api/patterns/reload", {}))).toMatchObject({ errors: 1 });
    expect((await state()).patterns.errors).toEqual([expect.objectContaining({ id: "broken", line: 2, column: 3, effect: "skipped" })]);
    // Step 1 review, finding 6: a directory that cannot be read is a listed warning, never a 500.
    rmSync(patterns, { recursive: true, force: true });
    writeFileSync(patterns, "in the way\n");
    const blocked = await post("/api/patterns/reload", {});
    expect(blocked.status).toBe(200);
    expect(await j(blocked)).toMatchObject({ patterns: builtInCatalog().patterns.length, errors: 1 });
    expect((await state()).patterns.errors[0].message).toMatch(/your patterns directory could not be created or read/);
  });

  it("P1: the removed commands are unknown over HTTP, the registry has no catalog writers, and createTask ignores steps", async () => {
    for (const name of ["setPipeline", "saveTemplate", "deleteTemplate", "restoreBuiltInTemplates"]) {
      const r = await cmd(name, { taskId: "EX-001", expectedRev: 1, steps: oneStep, reason: "x", template: { id: "t", name: "T", description: "", steps: oneStep }, templateId: "t" });
      expect(r.status, name).toBe(400);
      expect(r.body, name).toEqual({ kind: "invalid", error: `Unknown command ${name}` });
    }
    for (const name of ["setPipeline", "saveTemplate", "deleteTemplate", "restoreBuiltInTemplates", "setPatternCatalog", "recordTemplateExport"]) expect(Object.keys(COMMANDS), name).not.toContain(name);
    expect(Object.keys(COMMANDS)).toContain("setDefaultPattern");
    const created = await cmd("createTask", { title: "Plain", area: "", outcome: "o", benefit: "", whyNow: "", approach: "a", acceptance: ["ok"], priority: 1, holdBeforeStart: true, patternId: "change", steps: oneStep });
    expect(created.status).toBe(200);
    const t = task(await state(), created.body.result.newId);
    expect(t.steps.map((x) => x.id)).toEqual(["S1", "C1", "S2", "S3", "C2", "S4"]);
    expect(t.pattern).toMatchObject({ id: "change", source: "built-in" });
    const internal = await cmd("createTask", { title: "Nope", area: "", outcome: "o", benefit: "", whyNow: "", approach: "a", acceptance: ["ok"], priority: 1, holdBeforeStart: true, patternId: "delivery-review" });
    expect(internal.status).toBe(400);
    expect(internal.body.error).toMatch(/used by the service only/);
  });
});

// ---------- migration 14 → 15 and the export of retired templates ----------

type Doc = Record<string, unknown> & { project: Record<string, unknown>; tasks: Record<string, unknown>[] };
const customTemplate = {
  id: "quick-fix-1",
  name: "Quick fix",
  description: "Just fix it",
  builtIn: false,
  rev: 1,
  steps: [...oneStep, { id: "C1", purpose: "Checks", role: "checks", dependsOn: ["S1"], inputs: [{ step: "S1", output: "change" }], outputs: [{ name: "checks", kind: "check-results" }], checks: { onFail: "findings", only: ["lint", "test"] } }],
};
const bestOfTemplate = {
  id: "two-shots-9",
  name: "Two shots",
  description: "",
  builtIn: false,
  rev: 1,
  steps: [
    { ...oneStep[0], parallel: { count: 2, mode: "best-of", providers: ["claude", "codex"] } },
    { id: "S2", purpose: "Choose", role: "code_reviewer", dependsOn: ["S1"], inputs: [{ step: "S1", output: "change" }], outputs: [{ name: "findings", kind: "review-findings" }] },
  ],
};

/** A format-14 database built from the seed: templates as format 14 held them, no pattern fields anywhere. */
function format14(path: string, mutate: (doc: Doc) => void = () => {}): { before: Doc; v0: number } {
  const seeded = new Store(path);
  const v0 = seeded.read().version;
  seeded.close();
  const raw = new DatabaseSync(path);
  const doc = JSON.parse((raw.prepare("SELECT json FROM state WHERE id = 1").get() as { json: string }).json) as Doc;
  delete doc.patterns;
  delete doc.retiredTemplates;
  delete doc.project.defaultPatternId;
  const v14 = (id: string, rev: number) => ({ ...structuredClone(V14_TEMPLATES[id]), builtIn: true, rev });
  const editedFeature = v14("feature", 3);
  editedFeature.steps[0].purpose = "Design it my way";
  doc.project.templates = [v14("goal", 1), editedFeature, v14("change", 2), v14("bugfix", 2), v14("investigation", 1), v14("design", 1), customTemplate, bestOfTemplate];
  for (const t of doc.tasks) {
    delete t.pattern;
    delete t.patternSince;
    // The reasons the format-14 service wrote.
    const h = (t.pipelineHistory as { reason: string }[])[0];
    h.reason = h.reason.replace(/^Created from the (.+) pattern$/, "Lead applied the $1 template");
  }
  doc.version = 14;
  mutate(doc);
  raw.prepare("UPDATE state SET format = 14, json = ? WHERE id = 1").run(JSON.stringify(doc));
  raw.close();
  return { before: structuredClone(doc), v0 };
}

describe("migration 14 → 15", () => {
  it("retires custom and edited templates, drops unedited built-ins, adds the default and the catalog, keeps a backup, and leaves every task alone (P9)", () => {
    const path = join(dir, "old.sqlite");
    const { before, v0 } = format14(path, (doc) => {
      const t = doc.tasks.find((x) => x.id === "EX-003")!;
      (t.pipelineHistory as { reason: string }[])[0].reason = "Created from the Feature template";
      const rv = structuredClone(doc.tasks.find((x) => x.id === "EX-002")!);
      rv.id = "EX-002-RV1";
      rv.reviewTarget = { taskId: "EX-002", n: 1, headSha: "a".repeat(40), baseSha: "b".repeat(40) };
      doc.tasks.push(rv);
      const pinned = doc.tasks.find((x) => x.id === "EX-001")!;
      (pinned.steps as { selection: unknown }[])[0].selection = { provider: "codex", model: "codex-sample-fast" };
    });
    const upgraded = new Store(path);
    const s = upgraded.read().state;
    expect(STATE_FORMAT).toBe(15);
    expect(s.version).toBe(15);
    expect(upgraded.read().version).toBe(v0 + 1);
    expect((s.project as unknown as { templates?: unknown }).templates).toBeUndefined();
    expect(s.project.defaultPatternId).toBe("change");
    expect(s.patterns.patterns.map((p) => p.id)).toEqual(builtInCatalog().patterns.map((p) => p.id));
    expect(s.retiredTemplates.map((t) => [t.id, t.kind])).toEqual([
      ["feature", "edited-built-in"],
      ["quick-fix-1", "custom"],
      ["two-shots-9", "custom"],
    ]);
    expect(s.retiredTemplates[0].steps[0].purpose).toBe("Design it my way");
    expect(s.retiredTemplates.every((t) => t.retiredAt && !t.exportedTo && !t.exportError)).toBe(true);
    expect(s.events.filter((e) => /was retired: pipelines now come from patterns/.test(e.message)).map((e) => e.message)).toEqual([
      'Template "Feature" was retired: pipelines now come from patterns. It is saved as a pattern file of yours when the service starts.',
      'Template "Quick fix" was retired: pipelines now come from patterns. It is saved as a pattern file of yours when the service starts.',
      'Template "Two shots" was retired: pipelines now come from patterns. It is saved as a pattern file of yours when the service starts.',
    ]);
    // P9: steps, revisions, history and pins are exactly what they were, for every task.
    const beforeTasks = before.tasks as unknown as State["tasks"];
    expect(s.tasks.map((t) => t.id)).toEqual(beforeTasks.map((t) => t.id));
    for (const t of s.tasks) {
      const b = beforeTasks.find((x) => x.id === t.id)!;
      expect({ steps: t.steps, rev: t.pipelineRev, history: t.pipelineHistory, hold: t.hold, lifecycle: t.lifecycle }, t.id).toEqual({ steps: b.steps, rev: b.pipelineRev, history: b.pipelineHistory, hold: b.hold, lifecycle: b.lifecycle });
      expect(t.patternSince, t.id).toBe(0);
      expect(t.pattern.chosenBy, t.id).toBe("migration");
    }
    expect(task(s, "EX-001").steps[0].selection).toEqual({ provider: "codex", model: "codex-sample-fast" });
    expect(s.attempts).toEqual(before.attempts);
    expect(s.artifacts).toEqual(before.artifacts);
    // Legacy references: the template named by the first revision, or the internal pipeline of a service task.
    expect(task(s, "EX-003").pattern).toEqual({ id: "feature", name: "Feature", source: "legacy", chosenBy: "migration" });
    expect(task(s, "EX-001").pattern).toMatchObject({ source: "legacy", chosenBy: "migration" });
    expect(["change", "feature", "bugfix", "investigation", "design", "goal"]).toContain(task(s, "EX-001").pattern.id);
    // No hash on a migrated service task: its format-14 internal template may have been edited, and delivery rewrote its purposes (step 1 review, finding 5).
    expect(task(s, "EX-002-RV1").pattern).toEqual({ id: "delivery-review", name: "Delivery review", source: "internal", chosenBy: "migration" });
    upgraded.close();
    const check = new DatabaseSync(path);
    expect((check.prepare("SELECT format FROM state WHERE id = 1").get() as { format: number }).format).toBe(15);
    expect(check.prepare("SELECT value FROM meta WHERE key LIKE 'backup_format_14_%'").get()).toBeDefined();
    check.close();
  });

  it("an unedited internal template is dropped silently; an edited one is retired as internal and exported as an experiment the lead never gets (step 1 review, finding 2)", () => {
    const path = join(dir, "old.sqlite");
    format14(path, (doc) => {
      const v14 = (id: string) => ({ ...structuredClone(V14_TEMPLATES[id]), builtIn: true, rev: 1 });
      const editedReview = v14("delivery-review");
      (editedReview.steps as { purpose: string }[])[0].purpose = "Review it my way";
      doc.project.templates = [v14("revert"), v14("delivery-checks"), editedReview];
    });
    const store = new Store(path);
    try {
      const s = store.read().state;
      expect(s.retiredTemplates.map((t) => [t.id, t.kind, t.internal])).toEqual([["delivery-review", "edited-built-in", true]]);
      expect(s.events.filter((e) => /was retired/.test(e.message)).map((e) => e.message)).toEqual([
        'Template "Delivery review" was retired: pipelines now come from patterns. It is saved as a pattern file of yours when the service starts, marked experimental: the service keeps its own copy of this pipeline.',
      ]);
      const r = exportRetiredTemplates(store, patterns);
      expect(r.written.map((p) => basename(p))).toEqual(["delivery-review-yours.json"]);
      const file = JSON.parse(readFileSync(join(patterns, "delivery-review-yours.json"), "utf8"));
      expect(file).toMatchObject({ id: "delivery-review-yours", name: "Delivery review (yours)", experimental: true, hypothesis: "Exported from your edited internal template; review before use" });
      expect(file.steps[0].purpose).toBe("Review it my way");
      const c = loadPatternCatalog(patterns, iso());
      const loaded = c.patterns.find((p) => p.id === "delivery-review-yours")!;
      expect(loaded).toMatchObject({ source: "local", experimental: true, audience: "user-only" });
      expect(c.errors).toEqual([]);
      // The service's own revert, review and checks pipelines still come from code.
      expect(c.patterns.some((p) => INTERNAL_PATTERNS.some((i) => i.id === p.id))).toBe(false);
    } finally {
      store.close();
    }
  });

  it("a task whose first revision names no template is legacy custom; a project without templates migrates cleanly", () => {
    const path = join(dir, "old.sqlite");
    format14(path, (doc) => {
      delete doc.project.templates;
      (doc.tasks[0].pipelineHistory as { reason: string }[])[0].reason = "Imported";
    });
    const upgraded = new Store(path);
    const s = upgraded.read().state;
    expect(s.retiredTemplates).toEqual([]);
    expect(s.tasks[0].pattern).toEqual({ id: "custom", name: "Custom pipeline", source: "legacy", chosenBy: "migration" });
    upgraded.close();
  });
});

describe("exporting retired templates at start (P10)", () => {
  it("writes each once as a file of yours, strips checks.only, labels best-of an experiment, never overwrites, and exports nothing a second time", () => {
    const path = join(dir, "old.sqlite");
    format14(path);
    mkdirSync(patterns, { recursive: true });
    write("quick-fix.json", "keep me\n");
    const store = new Store(path);
    try {
      const first = exportRetiredTemplates(store, patterns);
      // Steps 2–3 review, finding 8: a file of yours under the first name is kept, and the export takes the next free name.
      expect(first.written.map((p) => basename(p)).sort()).toEqual(["feature-yours.json", "quick-fix-yours.json", "two-shots.json"]);
      expect(first.failed).toEqual([]);
      expect(readFileSync(join(patterns, "quick-fix.json"), "utf8")).toBe("keep me\n");
      const s = store.read().state;
      const byId = (id: string) => s.retiredTemplates.find((t) => t.id === id)!;
      expect(byId("feature")).toMatchObject({ exportedTo: join(patterns, "feature-yours.json"), exportedId: "feature-yours" });
      expect(byId("feature").stripped).toBeUndefined();
      expect(byId("quick-fix-1")).toMatchObject({ exportedTo: join(patterns, "quick-fix-yours.json"), exportedId: "quick-fix-yours" });
      expect(byId("quick-fix-1").exportError).toBeUndefined();
      expect(JSON.parse(readFileSync(join(patterns, "quick-fix-yours.json"), "utf8"))).toMatchObject({ id: "quick-fix-yours", name: "Quick fix" });
      expect(byId("two-shots-9")).toMatchObject({ exportedTo: join(patterns, "two-shots.json"), exportedId: "two-shots" });
      const feature = JSON.parse(readFileSync(join(patterns, "feature-yours.json"), "utf8"));
      expect(feature).toMatchObject({ $schema: "./pattern.schema.json", id: "feature-yours", name: "Feature (yours)", description: V14_TEMPLATES.feature.description, whenToUse: expect.stringMatching(/Your template from before patterns/) });
      expect(feature.$comment).toBe('Saved from your template "Feature" when pipelines became patterns (ORC-016).');
      expect(feature.steps[0].purpose).toBe("Design it my way");
      expect(feature.experimental).toBeUndefined();
      const twoShots = JSON.parse(readFileSync(join(patterns, "two-shots.json"), "utf8"));
      expect(twoShots).toMatchObject({ id: "two-shots", name: "Two shots", description: "Saved from your template.", experimental: true, hypothesis: expect.any(String) });
      expect(patternValidator()(feature)).toBe(true);
      expect(patternValidator()(twoShots)).toBe(true);
      expect(s.events.filter((e) => /from before patterns saved as/.test(e.message))).toHaveLength(3);
      // The loader lists the new files like any other; the unrelated file of yours is still listed as broken.
      const c = loadPatternCatalog(patterns, iso());
      expect(c.patterns.find((p) => p.id === "feature-yours")).toMatchObject({ source: "local", audience: "standard" });
      expect(c.patterns.find((p) => p.id === "quick-fix-yours")).toMatchObject({ source: "local" });
      expect(c.patterns.find((p) => p.id === "two-shots")).toMatchObject({ source: "local", experimental: true });
      expect(c.errors.map((e) => basename(e.file))).toEqual(["quick-fix.json"]);
      // A second start exports nothing again.
      const second = exportRetiredTemplates(store, patterns);
      expect(second).toEqual({ written: [], failed: [] });
      expect(store.read().state.events.filter((e) => /from before patterns/.test(e.message))).toHaveLength(3);
    } finally {
      store.close();
    }
  });

  it("a file that already holds exactly what would be written counts as exported; any other file of that name is kept (step 1 review, finding 4)", () => {
    const path = join(dir, "old.sqlite");
    format14(path);
    const store = new Store(path);
    try {
      // An earlier start wrote feature-yours.json but did not get to record it.
      const feature = store.read().state.retiredTemplates.find((t) => t.id === "feature")!;
      write("feature-yours.json", retiredTemplateFile(feature, "feature-yours", "Feature (yours)").json);
      write("two-shots.json", pretty({ id: "two-shots", name: "Mine already", description: "d", whenToUse: "w", steps: oneStep }));
      const r = exportRetiredTemplates(store, patterns);
      expect(r.written.map((p) => basename(p)).sort()).toEqual(["feature-yours.json", "quick-fix.json", "two-shots-yours.json"]);
      expect(r.failed).toEqual([]);
      const s = store.read().state;
      expect(s.retiredTemplates.find((t) => t.id === "feature")).toMatchObject({ exportedTo: join(patterns, "feature-yours.json"), exportedId: "feature-yours" });
      expect(s.retiredTemplates.find((t) => t.id === "two-shots-9")).toMatchObject({ exportedTo: join(patterns, "two-shots-yours.json"), exportedId: "two-shots-yours" });
      expect(JSON.parse(readFileSync(join(patterns, "two-shots.json"), "utf8")).name).toBe("Mine already");
      expect(JSON.parse(readFileSync(join(patterns, "two-shots-yours.json"), "utf8"))).toMatchObject({ id: "two-shots-yours", name: "Two shots" });
      expect(exportRetiredTemplates(store, patterns)).toEqual({ written: [], failed: [] });
    } finally {
      store.close();
    }
  });

  it("steps 2–3 review, finding 8: an unrelated <id>-yours.json never blocks an edited built-in's export; the next free name is used, up to a bound, and nothing is overwritten", () => {
    const path = join(dir, "old.sqlite");
    format14(path);
    const store = new Store(path);
    try {
      write("feature-yours.json", pretty({ id: "feature-yours", name: "Not the export", description: "d", whenToUse: "w", steps: oneStep }));
      // Every name the custom template could take is occupied by files of yours.
      write("quick-fix.json", "mine 0\n");
      for (let n = 1; n < MAX_EXPORT_NAMES; n++) write(n === 1 ? "quick-fix-yours.json" : `quick-fix-yours-${n}.json`, `mine ${n}\n`);
      const r = exportRetiredTemplates(store, patterns);
      expect(r.written.map((p) => basename(p)).sort()).toEqual(["feature-yours-2.json", "two-shots.json"]);
      expect(r.failed.map((p) => basename(p))).toEqual(["quick-fix.json"]);
      const s = store.read().state;
      expect(s.retiredTemplates.find((t) => t.id === "feature")).toMatchObject({ exportedTo: join(patterns, "feature-yours-2.json"), exportedId: "feature-yours-2" });
      expect(JSON.parse(readFileSync(join(patterns, "feature-yours.json"), "utf8")).name).toBe("Not the export");
      expect(JSON.parse(readFileSync(join(patterns, "feature-yours-2.json"), "utf8"))).toMatchObject({ id: "feature-yours-2", name: "Feature (yours)" });
      const quick = s.retiredTemplates.find((t) => t.id === "quick-fix-1")!;
      expect(quick.exportedTo).toBeUndefined();
      expect(quick.exportError).toBe(`${MAX_EXPORT_NAMES} files named ${join(patterns, "quick-fix.json")} to ${join(patterns, `quick-fix-yours-${MAX_EXPORT_NAMES - 1}.json`)} already exist; yours were kept and nothing was written.`);
      for (let n = 0; n < MAX_EXPORT_NAMES; n++) expect(readFileSync(join(patterns, n === 0 ? "quick-fix.json" : n === 1 ? "quick-fix-yours.json" : `quick-fix-yours-${n}.json`), "utf8")).toBe(`mine ${n}\n`);
      expect(existsSync(join(patterns, `quick-fix-yours-${MAX_EXPORT_NAMES}.json`))).toBe(false);
      // Recorded once: a second start tries nothing again.
      expect(exportRetiredTemplates(store, patterns)).toEqual({ written: [], failed: [] });
    } finally {
      store.close();
    }
  });

  it("an unwritable patterns directory records nothing, so the export is tried again at the next start (step 1 review, finding 6)", () => {
    const path = join(dir, "old.sqlite");
    format14(path);
    rmSync(patterns, { recursive: true, force: true });
    writeFileSync(patterns, "in the way\n");
    const store = new Store(path);
    try {
      const r = exportRetiredTemplates(store, patterns);
      expect(r).toMatchObject({ written: [], failed: [], problem: expect.stringMatching(/Could not create .*3 templates from before patterns not saved yet/) });
      expect(store.read().state.retiredTemplates.every((t) => !t.exportedTo && !t.exportError)).toBe(true);
      rmSync(patterns, { force: true });
      expect(exportRetiredTemplates(store, patterns).written).toHaveLength(3);
    } finally {
      store.close();
    }
  });

  it("checks.only is stripped and listed; ids are slugs that avoid built-in, internal and already-used ids", () => {
    const path = join(dir, "old.sqlite");
    format14(path, (doc) => {
      doc.project.templates = [
        customTemplate,
        { ...customTemplate, id: "another", name: "Quick fix" }, // the same name twice
        { ...customTemplate, id: "r1", name: "Revert", steps: oneStep }, // an internal id's name
        { ...customTemplate, id: "c1", name: "Change", steps: oneStep }, // a built-in id's name
        { ...customTemplate, id: "n1", name: "???", steps: oneStep }, // nothing usable in the name: the old id
      ];
    });
    const store = new Store(path);
    try {
      const r = exportRetiredTemplates(store, patterns);
      expect(r.failed).toEqual([]);
      expect(r.written.map((p) => basename(p))).toEqual(["quick-fix.json", "quick-fix-yours.json", "revert-yours.json", "change-yours.json", "n1.json"]);
      const retired: RetiredTemplate[] = store.read().state.retiredTemplates;
      expect(retired[0].stripped).toEqual(["C1.checks.only (lint, test)"]);
      const written = JSON.parse(readFileSync(join(patterns, "quick-fix.json"), "utf8"));
      expect(written.steps[1].checks).toEqual({ onFail: "findings" });
      expect(store.read().state.events.find((e) => /Quick fix" from before patterns saved as/.test(e.message))!.message).toMatch(/left out: C1\.checks\.only \(lint, test\)/);
      expect(loadPatternCatalog(patterns, iso()).errors).toEqual([]);
    } finally {
      store.close();
    }
  });
});

describe("a running custom pipeline across the upgrade", () => {
  it("the upgraded state still integrates the run's completion, and after the restart the task runs on to done with its original steps", async () => {
    const repo = join(dir, "repo");
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    writeFileSync(join(repo, "README.md"), "hello\n");
    execFileSync("git", ["-C", repo, "add", "-A"]);
    execFileSync("git", ["-C", repo, "-c", "user.name=u", "-c", "user.email=u@u", "commit", "-q", "-m", "init"]);
    const path = join(dir, "db.sqlite");
    let now = T0;
    const store1 = new Store(path);
    const claude = new ScriptedAdapter("claude");
    const codex = new ScriptedAdapter("codex");
    const workspaces = new WorkspaceManager(join(dir, "worktrees"));
    // A short lease, so the second scheduler can take over once the first instance is gone.
    const scheduler1 = new Scheduler(store1, { claude, codex }, { workspaces, leaseMs: 1000, ackTimeoutMs: 10_000 });
    await scheduler1.refreshHealth();
    let key = 0;
    const cmd1 = (name: string, args: object) => store1.command(name, args, `k${++key}`, iso(now));
    cmd1("initProject", { name: "Up", repoPath: repo, vision: "v", focus: "f" });
    cmd1("setRoleDefault", { role: "coder", selection: { provider: "codex", model: "codex-sample-large" } });
    const id = (cmd1("createTask", { title: "Custom", area: "", outcome: "o", benefit: "", whyNow: "", approach: "a", acceptance: ["ok"], priority: 1, holdBeforeStart: false, patternId: "change" }).result as { newId: string }).newId;
    setTestPipeline(store1, id, oneStep, iso(now), "one step");
    now += 1000;
    scheduler1.tick(now);
    const run = M.activeAttempts(store1.read().state, id)[0];
    expect(run).toBeDefined();
    expect(codex.has(run.id)).toBe(true);
    const stepsBefore = structuredClone(task(store1.read().state, id).steps);
    // The service goes away mid-run (no stop: nothing is killed); the database is rewritten as format 14.
    store1.close();
    const raw = new DatabaseSync(path);
    const doc = JSON.parse((raw.prepare("SELECT json FROM state WHERE id = 1").get() as { json: string }).json) as Doc;
    delete doc.patterns;
    delete doc.retiredTemplates;
    delete doc.project.defaultPatternId;
    doc.project.templates = [{ ...structuredClone(V14_TEMPLATES.change), builtIn: true, rev: 2 }];
    for (const t of doc.tasks) {
      delete t.pattern;
      delete t.patternSince;
    }
    doc.version = 14;
    raw.prepare("UPDATE state SET format = 14, json = ? WHERE id = 1").run(JSON.stringify(doc));
    raw.close();
    const store2 = new Store(path);
    const scheduler2 = new Scheduler(store2, { claude, codex }, { workspaces, leaseMs: 60_000, ackTimeoutMs: 10_000 });
    await scheduler2.refreshHealth();
    try {
      const upgraded = task(store2.read().state, id);
      expect(store2.read().state.version).toBe(15);
      expect(upgraded.steps).toEqual(stepsBefore);
      expect(upgraded.pattern).toEqual({ id: "custom", name: "Custom pipeline", source: "legacy", chosenBy: "migration" });
      expect(upgraded.patternSince).toBe(0);
      expect(M.activeAttempts(store2.read().state, id).map((a) => a.id)).toEqual([run.id]);
      // The attempt is still active and its completion integrates (pure): nothing in completion reads templates,
      // and patternSince 0 never discards a legacy task's result.
      const completed = M.reportCompletion(store2.read().state, run.id, [], iso(now + 1000), [{ name: "change", summary: "done", ref: `${"a".repeat(40)} on orchestration/x` }]);
      expect(completed.attempts.find((a) => a.id === run.id)!.outcome).toBe("completed");
      expect(task(completed, id).steps[0].state).toBe("done");
      expect(task(completed, id).lifecycle).toBe("done");
      // The service itself: a new instance takes the lease, and (as at any restart) knows no live process, so the
      // run is marked lost; the step is retried and finishes on the same steps.
      now += 5000; // past the first instance's lease
      scheduler2.tick(now);
      expect(store2.read().state.attempts.find((a) => a.id === run.id)!.outcome).toBe("lost");
      expect(task(store2.read().state, id).steps.map(toDef)).toEqual(stepsBefore.map(toDef));
      // The lost step is requeued and dispatched again on the same definition.
      now += 1000;
      scheduler2.tick(now);
      const retried = M.activeAttempts(store2.read().state, id)[0];
      expect(retried).toBeDefined();
      expect(retried.id).not.toBe(run.id);
      expect(codex.has(retried.id)).toBe(true);
      codex.finish(retried.id, { write: ["a.txt", "a\n"] });
      now += 1000;
      scheduler2.tick(now);
      now += 1000;
      scheduler2.tick(now);
      const done = task(store2.read().state, id);
      expect(done.lifecycle).toBe("done");
      expect(done.steps.map((x) => ({ id: x.id, state: x.state }))).toEqual([{ id: "S1", state: "done" }]);
      expect(done.steps.map(toDef)).toEqual(stepsBefore.map(toDef));
      expect(done.pipelineRev).toBe(2);
      expect(done.pattern).toEqual({ id: "custom", name: "Custom pipeline", source: "legacy", chosenBy: "migration" });
      expect(done.patternSince).toBe(0);
      expect(store2.read().state.attempts.find((a) => a.id === retried.id)!.outcome).toBe("completed");
    } finally {
      await scheduler2.stop();
      store2.close();
    }
  });
});
