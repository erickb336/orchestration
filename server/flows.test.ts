// Flows, the service side: every built-in flow file passes flows/flow.schema.json (validation lives in
// tests, never at runtime), the six flows equal the format-14 templates apart from the security review and
// Investigation's revise step (ORC-028),
// the removed commands and the removed reload endpoint are gone over HTTP, migration 14 → 15 → 16 for an
// older database (no file export any more), migration 15 → 16 for a format-15 database with every renamed
// field, and a custom pipeline that keeps running across the upgrade. Temporary directories only.

import Ajv2020 from "ajv/dist/2020.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFactoryArgs } from "../src/domain/testing/factory";
import { CLIENT_HEADER } from "../src/api";
import { BUILT_IN_FILES } from "../src/domain/builtInFlows";
import { COMMANDS } from "../src/domain/commands";
import { INTERNAL_FLOWS } from "../src/domain/internalFlows";
import * as M from "../src/domain/model";
import { builtInCatalog } from "../src/domain/flows";
import { toDef } from "../src/domain/pipeline";
import { PRINCIPLE_IDS } from "../src/domain/principles";
import { ARTIFACT_KINDS, STEP_ROLES, type State, type StepDef } from "../src/domain/types";
import schema from "../flows/flow.schema.json";
import { VERIFY_CHECKS_NOTE } from "./envelope";
import { createHttpServer } from "./http";
import { V14_TEMPLATES } from "./legacyTemplates";
import { FakeAdapter, defaultFakeConfig } from "./runtimes/fake";
import { Scheduler } from "./scheduler";
import { STATE_FORMAT, Store } from "./store";
import { setTestPipeline } from "./testing/pipelines";
import { ScriptedAdapter } from "./testing/scripted";
import { WorkspaceManager } from "./workspaces";

const FLOWS_DIR = fileURLToPath(new URL("../flows", import.meta.url));
const SCHEMA_FILE = "flow.schema.json";
const T0 = Date.parse("2026-09-30T12:00:00Z");
const iso = (ms = T0) => new Date(ms).toISOString();
const oneStep: StepDef[] = [{ id: "S1", purpose: "Implement", role: "coder", dependsOn: [], inputs: [], outputs: [{ name: "change", kind: "code-change" }] }];
const builtIn = (id: string) => builtInCatalog().find((p) => p.id === id)!;
const task = (s: State, id: string) => s.tasks.find((t) => t.id === id)!;
const validator = () => new Ajv2020({ allErrors: true, strict: true }).compile(schema);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orc-flows-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the built-in files", () => {
  it("every file in flows/ is strict JSON, passes the schema, is named by its id, and appears in the manifest exactly once", () => {
    const validate = validator();
    const files = readdirSync(FLOWS_DIR)
      .filter((f) => f.endsWith(".json") && f !== SCHEMA_FILE)
      .sort();
    expect(files).toEqual(["bugfix.json", "change.json", "design.json", "feature.json", "goal.json", "investigation.json"]);
    for (const f of files) {
      const raw: unknown = JSON.parse(readFileSync(join(FLOWS_DIR, f), "utf8"));
      expect(validate(raw), `${f}: ${JSON.stringify(validate.errors)}`).toBe(true);
      expect((raw as { id: string }).id, f).toBe(f.replace(/\.json$/, ""));
      expect((raw as { $schema: string }).$schema, f).toBe(`./${SCHEMA_FILE}`);
    }
    expect(BUILT_IN_FILES.map((f) => basename(f.file)).sort()).toEqual(files);
    expect(new Set(BUILT_IN_FILES.map((f) => f.raw.id)).size).toBe(BUILT_IN_FILES.length);
    expect(builtInCatalog()).toHaveLength(files.length);
  });

  it("the schema refuses what the engine never reads from a file: extends, stepOverrides, experimental, order, checks.only, copyOf, gate, parallel", () => {
    const validate = validator();
    const change = structuredClone(BUILT_IN_FILES.find((f) => f.raw.id === "change")!.raw) as unknown as Record<string, unknown>;
    for (const extra of [{ extends: "change" }, { stepOverrides: { S1: { gate: true } } }, { experimental: true, hypothesis: "h" }, { order: 10 }]) expect(validate({ ...change, ...extra }), JSON.stringify(extra)).toBe(false);
    const steps = structuredClone(change.steps) as Record<string, unknown>[];
    (steps[1].checks as Record<string, unknown>).only = ["lint"];
    expect(validate({ ...change, steps })).toBe(false);
    expect(validate({ ...change, steps: [{ ...oneStep[0], copyOf: "S1" }] })).toBe(false);
    // Gate steps and parallel copies are gone; a file that still sets them is refused.
    expect(validate({ ...change, steps: [{ ...oneStep[0], gate: true }] })).toBe(false);
    expect(validate({ ...change, steps: [{ ...oneStep[0], parallel: { count: 2, mode: "best-of" } }] })).toBe(false);
    expect(validate({ ...change, steps: [{ ...oneStep[0], role: "tester" }] })).toBe(false);
    const { whenToUse: _w, ...noWhen } = change;
    expect(validate(noWhen)).toBe(false);
  });

  it("the schema's enums equal the TypeScript constants, security_reviewer included", () => {
    expect(schema.$defs.role.enum).toEqual(STEP_ROLES);
    expect(schema.$defs.role.enum).toContain("security_reviewer");
    expect(schema.$defs.kind.enum).toEqual(ARTIFACT_KINDS);
    // The principle ids too.
    expect(schema.$defs.principle.enum).toEqual([...PRINCIPLE_IDS]);
  });

  it("the schema accepts a step's principles and refuses an unknown id, a repeated id and a non-list", () => {
    const validate = validator();
    const change = structuredClone(BUILT_IN_FILES.find((f) => f.raw.id === "change")!.raw) as unknown as { steps: Record<string, unknown>[] };
    const withS1 = (principles: unknown) => ({ ...change, steps: change.steps.map((st) => (st.id === "S1" ? { ...st, principles } : st)) });
    expect(validate(withS1(["laziness-protocol", "prove-it-works"]))).toBe(true);
    expect(validate(withS1([]))).toBe(true);
    expect(validate(withS1(["be-nice"]))).toBe(false);
    expect(validate(withS1(["laziness-protocol", "laziness-protocol"]))).toBe(false);
    expect(validate(withS1("laziness-protocol"))).toBe(false);
    expect(validate(withS1([...PRINCIPLE_IDS, "laziness-protocol"]))).toBe(false);
  });

  it("the six flows and the three internal pipelines equal the format-14 templates apart from the security review beside each code review and the principles", () => {
    // The verify purposes are plain descriptions now; the format-14 record keeps the sentence that moved to the lead's
    // role brief, so it is stripped here. The security review step and every reference to it are stripped too, so that
    // nothing else changed. The principles are stripped as well (principles.test.ts pins them step by step). So is
    // Feature's Capture evidence step (ORC-029 pass 5), run by the service, and the UX review's input from it.
    const described = (st: StepDef): StepDef => ({ ...st, purpose: st.purpose.replace(` ${VERIFY_CHECKS_NOTE}`, "").replace(/\.$/, "") });
    const withoutSecurity = (steps: StepDef[]): StepDef[] => {
      const sec = new Set(steps.filter((s) => s.role === "security_reviewer" || s.role === "evidence").map((s) => s.id));
      return steps
        .filter((s) => !sec.has(s.id))
        .map(({ principles: _p, ...s }) => toDef({ ...s, dependsOn: s.dependsOn.filter((d) => !sec.has(d)), inputs: s.inputs.filter((r) => !sec.has(r.step)), ...(s.runIf ? { runIf: s.runIf.filter((r) => !sec.has(r.step)) } : {}) }));
    };
    for (const id of ["change", "feature", "bugfix", "investigation", "design", "goal"]) {
      const p = builtIn(id);
      const t = V14_TEMPLATES[id];
      // One deliberate addition: Bug fix's verification now reads the code review's findings beside the security review's (item 11: "the final verification reads both").
      const expected = t.steps.map(toDef).map(described).map((st) => (id === "bugfix" && st.id === "S5" ? { ...st, inputs: st.inputs.flatMap((r) => (r.step === "C2" ? [{ step: "S3", output: "findings" }, r] : [r])) } : st));
      // Another (ORC-028): Investigation revises its report while the review finds something, as Design does, so no
      // finding is dropped; the lead's step moves to S4 and reads the revised report beside the first.
      if (id === "investigation") {
        const lead = expected.pop()!;
        // And ORC-031: its evidence step is read-only research.
        expected[0] = { ...expected[0], research: true };
        expected.push(
          toDef({ id: "S3", purpose: "Revise the report", role: "coder", dependsOn: ["S2"], inputs: [{ step: "S1", output: "report" }, { step: "S2", output: "findings" }], outputs: [{ name: "report", kind: "report" }], runIf: [{ step: "S2", output: "findings" }], iterate: { from: "S2", max: 3 } }),
          { ...lead, id: "S4", dependsOn: ["S3"], inputs: [{ step: "S1", output: "report" }, { step: "S3", output: "report" }, { step: "S2", output: "findings" }] },
        );
      }
      expect(withoutSecurity(p.steps), id).toEqual(expected);
      expect(p.name, id).toBe(t.name);
      expect(p.steps.some((s) => s.role === "security_reviewer"), id).toBe(["change", "feature", "bugfix"].includes(id));
      expect(p.steps.some((s) => s.role === "evidence"), id).toBe(id === "feature");
    }
    for (const p of INTERNAL_FLOWS) {
      const t = V14_TEMPLATES[p.id];
      expect(withoutSecurity(p.steps), p.id).toEqual(t.steps.map(toDef).map(described));
      expect(p.name, p.id).toBe(t.name);
      expect(p.steps.some((s) => s.role === "security_reviewer"), p.id).toBe(p.id !== "delivery-checks");
    }
    expect(Object.keys(V14_TEMPLATES).sort()).toEqual(["bugfix", "change", "delivery-checks", "delivery-review", "design", "feature", "goal", "investigation", "revert"]);
  });
});

describe("over HTTP", () => {
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
    const probe = createHttpServer({ store, scheduler, fakeConfig: config, startedAt: iso(), allowedHosts: [] });
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as AddressInfo).port;
    probe.close();
    const server = createHttpServer({ store, scheduler, fakeConfig: config, startedAt: iso(), allowedHosts: [`127.0.0.1:${port}`] });
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
    base = `http://127.0.0.1:${port}`;
    close = () => {
      server.closeAllConnections();
      server.close();
      store.close();
    };
  });
  afterEach(() => close());

  it("the pattern commands and the reload endpoint are gone; the flow commands are there; createTask ignores steps", async () => {
    for (const name of ["setDefaultPattern", "changePattern", "setPipeline", "saveTemplate", "deleteTemplate", "restoreBuiltInTemplates"]) {
      const r = await cmd(name, { taskId: "EX-001", expectedRev: 1, steps: oneStep, reason: "x", patternId: "change", flowId: "change" });
      expect(r.status, name).toBe(400);
      expect(r.body, name).toEqual({ kind: "invalid", error: `Unknown command ${name}` });
    }
    for (const name of ["setPipeline", "saveTemplate", "deleteTemplate", "restoreBuiltInTemplates", "setPatternCatalog", "setFlows", "recordTemplateExport", "setDefaultPattern", "changePattern"]) expect(Object.keys(COMMANDS), name).not.toContain(name);
    expect(Object.keys(COMMANDS)).toContain("setDefaultFlow");
    expect(Object.keys(COMMANDS)).toContain("changeFlow");
    for (const path of ["/api/patterns/reload", "/api/flows/reload"]) {
      const r = await post(path, {});
      expect(r.status, path).toBe(404);
    }
    const created = await cmd("createTask", { title: "Plain", area: "", outcome: "o", benefit: "", whyNow: "", approach: "a", acceptance: ["ok"], priority: 1, holdBeforeStart: true, flowId: "change", steps: oneStep });
    expect(created.status).toBe(200);
    const t = task(await state(), created.body.result.newId);
    expect(t.steps.map((x) => x.id)).toEqual(["S1", "C1", "S2", "SR1", "S3", "C2", "S4"]);
    expect(t.flow).toMatchObject({ id: "change", source: "built-in" });
    const internal = await cmd("createTask", { title: "Nope", area: "", outcome: "o", benefit: "", whyNow: "", approach: "a", acceptance: ["ok"], priority: 1, holdBeforeStart: true, flowId: "delivery-review" });
    expect(internal.status).toBe(400);
    expect(internal.body.error).toMatch(/used by the service only/);
    const chosen = await cmd("setDefaultFlow", { flowId: "goal" });
    expect(chosen.status).toBe(200);
    expect((await state()).project.defaultFlowId).toBe("goal");
    expect((await state()).flows.map((f) => f.id)).toEqual(["change", "bugfix", "feature", "design", "investigation", "goal"]);
  });
});

// ---------- migrations ----------

type Doc = Record<string, unknown> & { project: Record<string, unknown>; tasks: Record<string, unknown>[] };
const readDoc = (path: string): Doc => {
  const raw = new DatabaseSync(path);
  const doc = JSON.parse((raw.prepare("SELECT json FROM state WHERE id = 1").get() as { json: string }).json) as Doc;
  raw.close();
  return doc;
};
const writeDoc = (path: string, format: number, doc: Doc) => {
  const raw = new DatabaseSync(path);
  raw.prepare("UPDATE state SET format = ?, json = ? WHERE id = 1").run(format, JSON.stringify(doc));
  raw.close();
};
const customTemplate = {
  id: "quick-fix-1",
  name: "Quick fix",
  description: "Just fix it",
  builtIn: false,
  rev: 1,
  steps: [...oneStep, { id: "C1", purpose: "Checks", role: "checks", dependsOn: ["S1"], inputs: [{ step: "S1", output: "change" }], outputs: [{ name: "checks", kind: "check-results" }], checks: { onFail: "findings", only: ["lint", "test"] } }],
};

/** A format-14 database built from the seed: templates as format 14 held them, no flow or pattern fields anywhere. */
function format14(path: string, mutate: (doc: Doc) => void = () => {}): { before: Doc; v0: number } {
  const seeded = new Store(path);
  const v0 = seeded.read().version;
  seeded.close();
  const doc = readDoc(path);
  delete doc.flows;
  delete doc.project.defaultFlowId;
  const v14 = (id: string, rev: number) => ({ ...structuredClone(V14_TEMPLATES[id]), builtIn: true, rev });
  const editedFeature = v14("feature", 3);
  editedFeature.steps[0].purpose = "Design it my way";
  doc.project.templates = [v14("goal", 1), editedFeature, v14("change", 2), v14("bugfix", 2), v14("investigation", 1), v14("design", 1), customTemplate];
  for (const t of doc.tasks) {
    delete t.flow;
    delete t.flowSince;
    // The reasons the format-14 service wrote.
    const h = (t.pipelineHistory as { reason: string }[])[0];
    h.reason = h.reason.replace(/^Created from the (.+) flow$/, "Lead applied the $1 template");
  }
  doc.version = 14;
  mutate(doc);
  writeDoc(path, 14, doc);
  return { before: structuredClone(doc), v0 };
}

describe("migration 14 → 15 → 16 (a database that still has templates)", () => {
  it("drops the templates with an event each for the retired ones, writes no file, adds the default and the flows, keeps a backup, and leaves every task alone", () => {
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
    expect(STATE_FORMAT).toBe(19);
    expect(s.version).toBe(19);
    expect(upgraded.read().version).toBe(v0 + 1);
    expect((s.project as unknown as { templates?: unknown }).templates).toBeUndefined();
    expect((s.project as unknown as { defaultPatternId?: unknown }).defaultPatternId).toBeUndefined();
    expect(s.project.defaultFlowId).toBe("change");
    expect(s.flows.map((p) => p.id)).toEqual(builtInCatalog().map((p) => p.id));
    expect((s as unknown as { patterns?: unknown }).patterns).toBeUndefined();
    expect((s as unknown as { retiredTemplates?: unknown }).retiredTemplates).toBeUndefined();
    expect(s.events.filter((e) => /was retired/.test(e.message)).map((e) => e.message)).toEqual([
      'Template "Feature" was retired: pipelines now come from the built-in flows. Tasks that ran it keep their steps.',
      'Template "Quick fix" was retired: pipelines now come from the built-in flows. Tasks that ran it keep their steps.',
    ]);
    // No file is written anywhere for them.
    expect(readdirSync(dir)).toEqual(expect.arrayContaining(["old.sqlite"]));
    expect(readdirSync(dir).filter((f) => f.endsWith(".json"))).toEqual([]);
    // Steps, revisions, history and pins are exactly what they were, for every task.
    const beforeTasks = before.tasks as unknown as State["tasks"];
    expect(s.tasks.map((t) => t.id)).toEqual(beforeTasks.map((t) => t.id));
    for (const t of s.tasks) {
      const b = beforeTasks.find((x) => x.id === t.id)!;
      expect({ steps: t.steps, rev: t.pipelineRev, history: t.pipelineHistory, hold: t.hold, lifecycle: t.lifecycle }, t.id).toEqual({ steps: b.steps, rev: b.pipelineRev, history: b.pipelineHistory, hold: b.hold, lifecycle: b.lifecycle });
      expect(t.flowSince, t.id).toBe(0);
      expect(t.flow.chosenBy, t.id).toBe("migration");
      expect((t as unknown as { pattern?: unknown; patternSince?: unknown; outcome?: unknown })).not.toHaveProperty("pattern");
      expect((t as unknown as { pattern?: unknown; patternSince?: unknown; outcome?: unknown })).not.toHaveProperty("patternSince");
    }
    expect(task(s, "EX-001").steps[0].selection).toEqual({ provider: "codex", model: "codex-sample-fast" });
    expect(s.attempts).toEqual(before.attempts);
    expect(s.artifacts).toEqual(before.artifacts);
    // Legacy references: the template named by the first revision, or the internal pipeline of a service task.
    expect(task(s, "EX-003").flow).toEqual({ id: "feature", name: "Feature", source: "legacy", chosenBy: "migration" });
    expect(task(s, "EX-001").flow).toMatchObject({ source: "legacy", chosenBy: "migration" });
    expect(["change", "feature", "bugfix", "investigation", "design", "goal"]).toContain(task(s, "EX-001").flow.id);
    expect(task(s, "EX-002-RV1").flow).toEqual({ id: "delivery-review", name: "Delivery review", source: "internal", chosenBy: "migration" });
    upgraded.close();
    const check = new DatabaseSync(path);
    expect((check.prepare("SELECT format FROM state WHERE id = 1").get() as { format: number }).format).toBe(19);
    expect(check.prepare("SELECT value FROM meta WHERE key LIKE 'backup_format_14_%'").get()).toBeDefined();
    check.close();
  });

  it("a task whose first revision names no template is legacy custom; a project without templates migrates cleanly", () => {
    const path = join(dir, "old.sqlite");
    format14(path, (doc) => {
      delete doc.project.templates;
      (doc.tasks[0].pipelineHistory as { reason: string }[])[0].reason = "Imported";
    });
    const upgraded = new Store(path);
    const s = upgraded.read().state;
    expect(s.tasks[0].flow).toEqual({ id: "custom", name: "Custom pipeline", source: "legacy", chosenBy: "migration" });
    expect(s.version).toBe(19);
    upgraded.close();
  });
});

/** A step as formats 15 to 17 could hold it: with the gate and parallel settings that migration 17 → 18 drops. */
type LegacyStepDef = StepDef & { gate?: true; parallel?: { count: number; mode: "copies" | "best-of"; providers?: string[] }; copyOf?: string };
/** Steps without the fields migration 17 → 18 drops: what an older fixture's steps look like after the upgrade. */
const modern = (steps: unknown[]) => steps.map((s) => Object.fromEntries(Object.entries(s as Record<string, unknown>).filter(([k]) => !["gate", "parallel", "copyOf"].includes(k))));

/** The steps of the five removed catalog entries, as the pattern files resolved them (from the frozen format-14 templates). */
const REMOVED: Record<string, { name: string; steps: LegacyStepDef[]; experimental?: true }> = {
  "change-cross-review": { name: "Change, reviewed by the other provider", steps: V14_TEMPLATES.change.steps.map((s) => (s.id === "S2" ? { ...s, independentOf: "writer" as const } : s)) },
  "feature-design-gate": { name: "Feature, pause after design", steps: V14_TEMPLATES.feature.steps.map((s) => (s.id === "S1" ? { ...s, gate: true } : s)) },
  "goal-plan-gate": { name: "Goal, review the plan first", steps: V14_TEMPLATES.goal.steps.map((s) => (s.id === "S1" ? { ...s, gate: true } : s)) },
  "change-best-of-two": {
    name: "Change, best of two implementations",
    experimental: true,
    steps: [
      { ...V14_TEMPLATES.change.steps[0], parallel: { count: 2, mode: "best-of", providers: ["claude", "codex"] } },
      { id: "S2", purpose: "Compare the two implementations and choose the better one", role: "code_reviewer", dependsOn: ["S1"], inputs: [{ step: "S1", output: "change" }, { step: "S1", output: "handoff" }], outputs: [{ name: "comparison", kind: "report" }] },
      ...V14_TEMPLATES.change.steps.slice(1).map((s) => ({ ...s, id: s.id === "S2" ? "S3" : s.id === "S3" ? "S4" : s.id === "S4" ? "S5" : s.id })),
    ],
  },
  "change-lean": { name: "Change without the lead's verification", experimental: true, steps: V14_TEMPLATES.change.steps.slice(0, -1) },
};

/** A format-15 database built from the seed, with every pipeline-pattern field as that format wrote it. */
function format15(path: string): { before: Doc; v0: number } {
  const seeded = new Store(path);
  const v0 = seeded.read().version;
  seeded.close();
  const doc = readDoc(path);
  const flows = doc.flows as { id: string; name: string; hash: string; steps: StepDef[] }[];
  const chain = (id: string) => [{ id, source: "built-in", file: `patterns/${id}.json`, fileHash: "1".repeat(64) }];
  // The catalog as format 15 held it, plus the five removed entries.
  const removed = Object.entries(REMOVED).map(([id, r]) => ({ id, name: r.name, description: "d", whenToUse: "w", order: 90, ...(r.experimental ? { experimental: true, hypothesis: "h" } : {}), source: "built-in", file: `patterns/${id}.json`, chain: chain(id), hash: "2".repeat(64), steps: r.steps, flags: { breaksDown: false, pausesForYou: false, unreviewed: false, bestOf: false, needsProviders: [] }, audience: "standard", warnings: [] }));
  doc.patterns = { loadedAt: iso(), localDir: "~/.orchestration/patterns", patterns: [...flows.map((f) => ({ ...f, order: 10, file: `patterns/${f.id}.json`, chain: chain(f.id), flags: { breaksDown: f.id === "goal", pausesForYou: false, unreviewed: false, bestOf: false, needsProviders: [] }, audience: "standard", warnings: [] })), ...removed], errors: [{ file: "~/.orchestration/patterns/broken.json", message: "JSON syntax", line: 1, column: 1, effect: "skipped" }] };
  delete doc.flows;
  doc.retiredTemplates = [{ id: "quick-fix-1", name: "Quick fix", description: "", steps: oneStep, kind: "custom", retiredAt: iso(), exportedTo: "~/.orchestration/patterns/quick-fix.json", exportedId: "quick-fix" }];
  doc.project.defaultPatternId = "change-best-of-two";
  delete doc.project.defaultFlowId;
  for (const t of doc.tasks) {
    const ref = t.flow as Record<string, unknown>;
    t.pattern = { ...ref, chain: chain(String(ref.id)) };
    delete t.flow;
    t.patternSince = t.flowSince;
    delete t.flowSince;
    for (const h of t.pipelineHistory as Record<string, unknown>[]) {
      if (h.flow) h.pattern = { ...(h.flow as Record<string, unknown>), chain: chain(String((h.flow as { id: string }).id)) };
      delete h.flow;
    }
    if (t.lifecycle === "done" || t.lifecycle === "cancelled") t.outcome = { v: 1, result: t.lifecycle, settledAt: iso(), pattern: t.pattern, patternChanges: 0, runsBeforePattern: 0, createdAt: t.createdAt, agentMs: 0, runs: [], usage: [], repair: { rounds: 0, iterations: 0, finalCheckRounds: 0 }, findings: { raised: {}, byAction: {}, summaryOnly: 0, openAtEnd: 0 }, decisions: {}, checks: { runs: 0, failedRuns: 0, finalPassed: null, acceptedFailing: false }, coverage: {}, human: {} };
  }
  // One task per removed entry, created from it on format 15, with a pin and an expansion revision on the best-of one.
  const template = structuredClone(doc.tasks[0]);
  let n = 90;
  for (const [id, r] of Object.entries(REMOVED)) {
    const t = structuredClone(template);
    n += 1;
    t.id = `RM-${n}`;
    t.lifecycle = "proposed";
    t.hold = false;
    delete t.integration;
    delete t.outcome;
    const steps = r.steps.map((s) => ({ ...toDef(s), selection: s.id === "S1" ? { provider: "codex", model: "codex-sample-fast" } : null, revision: 1, state: "pending" }));
    t.steps = steps;
    const ref = { id, name: r.name, source: "built-in", hash: "2".repeat(64), chain: chain(id), ...(r.experimental ? { experimental: true } : {}), chosenBy: "user" };
    t.pattern = ref;
    t.patternSince = 1;
    t.pipelineRev = 1;
    t.pipelineHistory = [{ rev: 1, at: iso(), author: "user", reason: `Created from the ${r.name} pattern`, steps: r.steps.map(toDef), pattern: ref }];
    doc.tasks.push(t);
  }
  doc.version = 15;
  writeDoc(path, 15, doc);
  return { before: structuredClone(doc), v0 };
}

describe("migration 15 → 16 (patterns become flows)", () => {
  it("renames every persisted field, drops outcomes and retired templates, keeps every pipeline, and turns a default that named a removed entry into change", () => {
    const path = join(dir, "v15.sqlite");
    const { before, v0 } = format15(path);
    expect(before.tasks.filter((t) => Object.keys(REMOVED).includes((t.pattern as { id: string }).id))).toHaveLength(5);
    const upgraded = new Store(path);
    const s = upgraded.read().state;
    expect(s.version).toBe(19);
    expect(upgraded.read().version).toBe(v0 + 1);
    // The project.
    expect(s.project.defaultFlowId).toBe("change");
    expect((s.project as unknown as { defaultPatternId?: unknown }).defaultPatternId).toBeUndefined();
    // The catalog: the six flows, nothing else; the removed entries and the errors list are gone.
    expect(s.flows.map((p) => p.id)).toEqual(["change", "bugfix", "feature", "design", "investigation", "goal"]);
    expect((s as unknown as { patterns?: unknown }).patterns).toBeUndefined();
    expect((s as unknown as { retiredTemplates?: unknown }).retiredTemplates).toBeUndefined();
    // Every task: fields renamed, references reduced to id, name, source, hash, chosenBy; steps and history untouched.
    const beforeTasks = before.tasks;
    expect(s.tasks.map((t) => t.id)).toEqual(beforeTasks.map((t) => t.id));
    for (const t of s.tasks) {
      const b = beforeTasks.find((x) => x.id === t.id)!;
      const raw = t as unknown as Record<string, unknown>;
      expect(raw, t.id).not.toHaveProperty("pattern");
      expect(raw, t.id).not.toHaveProperty("patternSince");
      expect(raw, t.id).not.toHaveProperty("outcome");
      const { chain: _c, experimental: _e, ...expected } = b.pattern as Record<string, unknown>;
      expect(t.flow, t.id).toEqual(expected);
      expect(Object.keys(t.flow).sort(), t.id).toEqual(["chosenBy", "hash", "id", "name", "source"]);
      expect(t.flowSince, t.id).toBe(b.patternSince);
      expect(t.steps, t.id).toEqual(modern(b.steps as unknown[])); // migration 17 → 18 drops gate and parallel on the way
      expect(t.pipelineRev, t.id).toBe(b.pipelineRev);
      const history = b.pipelineHistory as Record<string, unknown>[];
      expect(t.pipelineHistory.length, t.id).toBe(history.length);
      for (const [i, h] of t.pipelineHistory.entries()) {
        const bh = history[i];
        expect(h.steps, `${t.id} r${h.rev}`).toEqual(modern(bh.steps as unknown[]));
        expect(h as unknown as Record<string, unknown>, `${t.id} r${h.rev}`).not.toHaveProperty("pattern");
        if (bh.pattern) {
          const { chain: _c2, experimental: _e2, ...applied } = bh.pattern as Record<string, unknown>;
          expect(h.flow, `${t.id} r${h.rev}`).toEqual(applied);
        } else expect(h.flow, `${t.id} r${h.rev}`).toBeUndefined();
      }
    }
    // Tasks that ran a removed entry keep their copied steps and their recorded id and name; nothing about their pipeline changes.
    for (const [id, r] of Object.entries(REMOVED)) {
      const t = s.tasks.find((x) => x.flow.id === id)!;
      expect(t, id).toBeDefined();
      expect(t.flow, id).toEqual({ id, name: r.name, source: "built-in", hash: "2".repeat(64), chosenBy: "user" });
      expect(t.steps.map(toDef), id).toEqual(r.steps.map(toDef));
      expect(t.steps[0].selection, id).toEqual({ provider: "codex", model: "codex-sample-fast" });
      expect(s.flows.some((f) => f.id === id), id).toBe(false);
    }
    // The upgraded state takes the flow commands; a task on a removed entry can be moved to one of the six.
    const rm = s.tasks.find((x) => x.flow.id === "change-lean")!;
    upgraded.command("changeFlow", { taskId: rm.id, expectedRev: 1, flowId: "change" }, "c1", iso());
    expect(task(upgraded.read().state, rm.id).flow).toMatchObject({ id: "change", chosenBy: "user" });
    expect(task(upgraded.read().state, rm.id).steps.map((x) => x.id)).toEqual(["S1", "C1", "S2", "SR1", "S3", "C2", "S4"]);
    upgraded.close();
    const check = new DatabaseSync(path);
    expect((check.prepare("SELECT format FROM state WHERE id = 1").get() as { format: number }).format).toBe(19);
    expect(check.prepare("SELECT value FROM meta WHERE key LIKE 'backup_format_15_%'").get()).toBeDefined();
    check.close();
  });

  it("a default that named one of the six stays; a task from before flows keeps its legacy reference", () => {
    const path = join(dir, "v15.sqlite");
    format15(path);
    const doc = readDoc(path);
    doc.project.defaultPatternId = "goal";
    doc.tasks[0].pattern = { id: "feature", name: "Feature", source: "legacy", chosenBy: "migration" };
    doc.tasks[0].patternSince = 0;
    writeDoc(path, 15, doc);
    const upgraded = new Store(path);
    const s = upgraded.read().state;
    expect(s.project.defaultFlowId).toBe("goal");
    expect(s.tasks[0].flow).toEqual({ id: "feature", name: "Feature", source: "legacy", chosenBy: "migration" });
    expect(s.tasks[0].flowSince).toBe(0);
    upgraded.close();
  });

  it("a default that named a personal file becomes change; a task that ran one keeps its steps and its local reference", () => {
    const path = join(dir, "v15-local.sqlite");
    format15(path);
    const doc = readDoc(path);
    doc.project.defaultPatternId = "my-change";
    const ref = { id: "my-change", name: "My change", source: "local", hash: "3".repeat(64), chain: ["my-change", "change"], chosenBy: "user" };
    doc.tasks[0].pattern = ref;
    (doc.tasks[0].pipelineHistory as Record<string, unknown>[])[0].pattern = ref;
    const steps = structuredClone(doc.tasks[0].steps);
    writeDoc(path, 15, doc);
    const upgraded = new Store(path);
    const s = upgraded.read().state;
    expect(s.project.defaultFlowId).toBe("change");
    expect(s.tasks[0].flow).toEqual({ id: "my-change", name: "My change", source: "local", hash: "3".repeat(64), chosenBy: "user" });
    expect(s.tasks[0].pipelineHistory[0].flow).toEqual(s.tasks[0].flow);
    expect(s.tasks[0].steps).toEqual(steps);
    upgraded.close();
  });
});

/** A format-17 database built from the seed, plus tasks holding every field migration 17 → 18 removes. */
function format17(path: string): { before: Doc; v0: number } {
  const seeded = new Store(path);
  const v0 = seeded.read().version;
  seeded.close();
  const doc = readDoc(path);
  const step = (id: string, purpose: string, role: string, dependsOn: string[], inputs: { step: string; output: string }[], outputs: { name: string; kind: string }[], extra: Record<string, unknown> = {}) => ({
    id,
    purpose,
    role,
    dependsOn,
    inputs,
    outputs,
    ...extra,
    selection: null,
    revision: 1,
    state: "pending",
  });
  const change = { name: "change", kind: "code-change" };
  const findings = { name: "findings", kind: "review-findings" };
  const custom = { id: "custom", name: "Custom pipeline", source: "custom", chosenBy: "user" };
  const legacy = (s: Record<string, unknown>) => Object.fromEntries(Object.entries(s).filter(([k]) => ["gate", "parallel", "copyOf"].includes(k)));
  const task = (id: string, lifecycle: string, steps: Record<string, unknown>[], extra: Record<string, unknown> = {}): Record<string, unknown> => {
    const { integration: _i, ...base } = structuredClone(doc.tasks[0]);
    return {
      ...base,
      id,
      lifecycle,
      hold: false,
      holdBeforeStart: false,
      steps,
      pipelineRev: 2,
      pipelineHistory: [
        { rev: 1, at: iso(), author: "user", reason: "Created", steps: steps.map((s) => toDef(s as unknown as StepDef)), flow: custom },
        // A revision as the expansion wrote it: the step definitions carry the settings and the copies.
        { rev: 2, at: iso(), author: "lead", reason: "Expanded", steps: steps.map((s) => ({ ...toDef(s as unknown as StepDef), ...legacy(s) })) },
      ],
      flow: custom,
      flowSince: 1,
      ...extra,
    };
  };
  // An open task whose best-of candidates both finished, with the comparison's choice recorded and confirmed by a person.
  const bestOf = task(
    "BO-1",
    "active",
    [
      { ...step("S1", "Implement", "coder", [], [], [change], { parallel: { count: 2, mode: "best-of", providers: ["claude", "codex"] }, copyOf: "S1" }), state: "done" },
      { ...step("S1-c2", "Implement (copy 2 of 2)", "coder", [], [], [change], { copyOf: "S1" }), state: "done" },
      step("S2", "Compare", "code_reviewer", ["S1", "S1-c2"], [{ step: "S1", output: "change" }, { step: "S1-c2", output: "change" }], [findings]),
    ],
    { bestOf: { S1: "S1-c2" }, bestOfByUser: { S1: iso() } },
  );
  // A finished task whose review ran as two copies, with a gate after the review.
  const copies = task(
    "CP-1",
    "done",
    [
      { ...step("S1", "Implement", "coder", [], [], [change]), state: "done" },
      { ...step("S2", "Review", "code_reviewer", ["S1"], [{ step: "S1", output: "change" }], [findings], { parallel: { count: 2, mode: "copies" }, copyOf: "S2", gate: true }), state: "done" },
      { ...step("S2-c2", "Review (copy 2 of 2)", "code_reviewer", ["S1"], [{ step: "S1", output: "change" }], [findings], { copyOf: "S2" }), state: "done" },
    ],
    { integration: { status: "integrated" } },
  );
  // A proposal whose settings never expanded: a parallel step and a gate, as the removed "best of two" entry had them.
  const unexpanded = task("UX-1", "proposed", [step("S1", "Implement", "coder", [], [], [change], { parallel: { count: 2, mode: "best-of" } }), step("S2", "Compare", "code_reviewer", ["S1"], [{ step: "S1", output: "change" }], [findings], { gate: true })]);
  doc.tasks.push(bestOf, copies, unexpanded);
  doc.version = 17;
  writeDoc(path, 17, doc);
  return { before: structuredClone(doc), v0 };
}

describe("migration 17 → 18 (parallel copies, best-of choices and gate steps are gone)", () => {
  const legacyKeys = (o: unknown) => Object.keys(o as Record<string, unknown>).filter((k) => ["gate", "parallel", "copyOf", "bestOf", "bestOfByUser"].includes(k));

  it("drops the fields from every task, step and pipeline revision, records what changed, holds the open best-of task, and leaves the rest alone", () => {
    const path = join(dir, "v17.sqlite");
    const { before, v0 } = format17(path);
    const upgraded = new Store(path);
    const s = upgraded.read().state;
    expect(STATE_FORMAT).toBe(19);
    expect(s.version).toBe(19);
    expect(upgraded.read().version).toBe(v0 + 1);
    // Nothing of the removed features is left anywhere.
    for (const t of s.tasks) {
      expect(legacyKeys(t), t.id).toEqual([]);
      for (const st of t.steps) expect(legacyKeys(st), `${t.id} ${st.id}`).toEqual([]);
      for (const h of t.pipelineHistory) for (const st of h.steps) expect(legacyKeys(st), `${t.id} r${h.rev} ${st.id}`).toEqual([]);
    }
    // The copies stay as ordinary steps with their ids and purposes; nothing else about a step changes.
    const bo = task(s, "BO-1");
    expect(bo.steps.map((x) => [x.id, x.purpose, x.state])).toEqual([
      ["S1", "Implement", "done"],
      ["S1-c2", "Implement (copy 2 of 2)", "done"],
      ["S2", "Compare", "pending"],
    ]);
    expect(bo.pipelineHistory.map((h) => h.rev)).toEqual([1, 2]);
    // The open best-of task is held, with the reason, and the event says what was dropped.
    expect(bo.hold).toBe(true);
    expect(bo.holdReason).toBe("Parallel copies were removed in this version: S1-c2 is now an ordinary step and every finished copy's output goes forward. Check the pipeline, then resume.");
    const ev = (id: string) => s.events.filter((e) => e.taskId === id && /were removed from Orchestrator/.test(e.message)).map((e) => e.message);
    expect(ev("BO-1")).toEqual(["Parallel copies, best-of choices and gate steps were removed from Orchestrator when the state format was upgraded: S1-c2 is now an ordinary step (every finished copy's output goes forward); the recorded choice (S1-c2 for S1) is dropped."]);
    // The finished task with copies and a gate: an event, no hold, still done and integrated.
    const cp = task(s, "CP-1");
    expect(cp).toMatchObject({ lifecycle: "done", hold: false, integration: { status: "integrated" } });
    expect(cp.holdReason).toBeUndefined();
    expect(ev("CP-1")).toEqual(["Parallel copies, best-of choices and gate steps were removed from Orchestrator when the state format was upgraded: S2-c2 is now an ordinary step (every finished copy's output goes forward); S2 is no longer a pause for you."]);
    // Settings that never expanded: an event, no hold.
    const ux = task(s, "UX-1");
    expect(ux).toMatchObject({ lifecycle: "proposed", hold: false });
    expect(ev("UX-1")).toEqual(["Parallel copies, best-of choices and gate steps were removed from Orchestrator when the state format was upgraded: S1 no longer expands into parallel agents; S2 is no longer a pause for you."]);
    // Every other task is exactly what it was, and no other event was added.
    for (const b of before.tasks.filter((t) => !["BO-1", "CP-1", "UX-1"].includes(t.id as string))) expect(task(s, b.id as string), b.id as string).toEqual(b);
    expect(s.events.length).toBe((before.events as unknown[]).length + 3);
    expect(s.attempts).toEqual(before.attempts);
    expect(s.artifacts).toEqual(before.artifacts);
    // The upgraded state takes commands: the held task resumes and its pending step is an ordinary step.
    upgraded.command("resumeTask", { taskId: "BO-1" }, "c1", iso());
    expect(task(upgraded.read().state, "BO-1").hold).toBe(false);
    expect(task(upgraded.read().state, "BO-1").holdReason).toBeUndefined();
    upgraded.close();
    const check = new DatabaseSync(path);
    expect((check.prepare("SELECT format FROM state WHERE id = 1").get() as { format: number }).format).toBe(19);
    expect(check.prepare("SELECT value FROM meta WHERE key LIKE 'backup_format_17_%'").get()).toBeDefined();
    check.close();
  });

  it("a task already held keeps its own hold and reason", () => {
    const path = join(dir, "v17-held.sqlite");
    format17(path);
    const doc = readDoc(path);
    const bo = doc.tasks.find((t) => t.id === "BO-1")!;
    bo.hold = true;
    bo.holdReason = "Review S1 (Implement) before the pipeline continues";
    writeDoc(path, 17, doc);
    const upgraded = new Store(path);
    expect(task(upgraded.read().state, "BO-1")).toMatchObject({ hold: true, holdReason: "Review S1 (Implement) before the pipeline continues" });
    upgraded.close();
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
    cmd1("startFactory", startFactoryArgs(store1.read().state));
    cmd1("setRoleDefault", { role: "coder", selection: { provider: "codex", model: "codex-sample-large" } });
    const id = (cmd1("createTask", { title: "Custom", area: "", outcome: "o", benefit: "", whyNow: "", approach: "a", acceptance: ["ok"], priority: 1, holdBeforeStart: false, flowId: "change" }).result as { newId: string }).newId;
    setTestPipeline(store1, id, oneStep, iso(now), "one step");
    now += 1000;
    scheduler1.tick(now);
    const run = M.activeAttempts(store1.read().state, id)[0];
    expect(run).toBeDefined();
    expect(codex.has(run.id)).toBe(true);
    const stepsBefore = structuredClone(task(store1.read().state, id).steps);
    // The service goes away mid-run (no stop: nothing is killed); the database is rewritten as format 14.
    store1.close();
    const doc = readDoc(path);
    delete doc.flows;
    delete doc.project.defaultFlowId;
    doc.project.templates = [{ ...structuredClone(V14_TEMPLATES.change), builtIn: true, rev: 2 }];
    for (const t of doc.tasks) {
      delete t.flow;
      delete t.flowSince;
    }
    doc.version = 14;
    writeDoc(path, 14, doc);
    const store2 = new Store(path);
    const scheduler2 = new Scheduler(store2, { claude, codex }, { workspaces, leaseMs: 60_000, ackTimeoutMs: 10_000 });
    await scheduler2.refreshHealth();
    try {
      const upgraded = task(store2.read().state, id);
      expect(store2.read().state.version).toBe(19);
      expect(upgraded.steps).toEqual(stepsBefore);
      expect(upgraded.flow).toEqual({ id: "custom", name: "Custom pipeline", source: "legacy", chosenBy: "migration" });
      expect(upgraded.flowSince).toBe(0);
      expect(M.activeAttempts(store2.read().state, id).map((a) => a.id)).toEqual([run.id]);
      // The attempt is still active and its completion integrates (pure): flowSince 0 never discards a legacy task's result.
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
      expect(done.flow).toEqual({ id: "custom", name: "Custom pipeline", source: "legacy", chosenBy: "migration" });
      expect(done.flowSince).toBe(0);
      expect(store2.read().state.attempts.find((a) => a.id === retried.id)!.outcome).toBe("completed");
    } finally {
      await scheduler2.stop();
      store2.close();
    }
  });
});
