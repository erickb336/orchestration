// ORC-021: flows, pure. The shape of a flow file, the resolver that turns the six built-in files into the
// catalog, the rules the service relies on, hashing, summaries and the lookups the domain uses. No I/O:
// the built-in files are compiled in through src/domain/builtInFlows.ts, and a broken file is a test
// failure in the repository, never a runtime state.

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import canonicalize from "canonicalize";
import { BUILT_IN_FILES } from "./builtInFlows";
import { INTERNAL_FLOWS, internalFlow, isInternalFlowId, type InternalFlow } from "./internalFlows";
import { downstreamOf, toDef, validatePipeline } from "./pipeline";
import type { ChosenBy, Flow, FlowRef, InputRef, OutputDef, ProviderId, RoleId, State, StepDef } from "./types";

// ---------- the file format ----------

/** A step as written in a flow file. `$comment` is ignored; `copyOf`, `iteration` and `checks.only` are refused by the schema. */
export interface RawStep {
  $comment?: string;
  id: string;
  purpose: string;
  role: RoleId;
  dependsOn: string[];
  inputs: InputRef[];
  outputs: OutputDef[];
  runIf?: InputRef[];
  gate?: true;
  iterate?: { from: string; max: number };
  parallel?: { count: number; mode: "copies" | "best-of"; providers?: ProviderId[] };
  waitForChildren?: true;
  independentOf?: "writer";
  checks?: { onFail: "findings" | "block" };
}

export interface RawFlow {
  $schema?: string;
  $comment?: string;
  id: string;
  name: string;
  description: string;
  whenToUse: string;
  steps: RawStep[];
}

export interface FlowFile {
  /** Display path: "flows/change.json". */
  file: string;
  /** Schema-valid: a test checks every built-in file against flows/flow.schema.json. */
  raw: RawFlow;
}

export const FLOW_ID_RE = /^[a-z][a-z0-9-]{1,39}$/;
export const MAX_FLOW_STEPS = 30;
/** Ids the service creates when it expands a step into parallel copies, loop iterations or check rounds (`baseId` strips them). */
const EXPANSION_ID_RE = /-[ci]\d+$|-r\d+-(?:fix|review|checks)$/;
/** The flows the service creates tasks from (fixes and send-back fixes); their files must stay safe for that. */
export const SERVICE_FLOW_IDS = ["change", "bugfix"] as const;
export type ServiceFlowId = (typeof SERVICE_FLOW_IDS)[number];
export const CHECKS_ONLY_MESSAGE = "check commands belong to each project; flows run every configured check";

// ---------- hashing ----------

const sha256Hex = (text: string) => bytesToHex(sha256(utf8ToBytes(text)));

/** RFC 8785 canonical JSON: key order and whitespace do not count. */
export function canonicalJson(value: unknown): string {
  try {
    return canonicalize(value) ?? "null";
  } catch {
    // A lone surrogate or a non-finite number cannot be canonicalised; the plain form still hashes.
    return JSON.stringify(value) ?? "null";
  }
}

/** What runs: the resolved steps in their normalised form. Names, descriptions and comments do not count. */
export function flowHash(steps: StepDef[]): string {
  return sha256Hex(canonicalJson(steps.map(toDef)));
}

// ---------- the review rule ----------

function kindOf(steps: StepDef[], r: InputRef) {
  return steps.find((s) => s.id === r.step)?.outputs.find((o) => o.name === r.output)?.kind;
}

/** Roles that read, judge, plan or design: a code change from one of them has no independent review by construction. */
const NON_CODING_ROLES: readonly RoleId[] = ["code_reviewer", "security_reviewer", "ux_reviewer", "lead", "designer"];
const ROLE_WORD: Record<RoleId, string> = { lead: "lead", designer: "designer", coder: "coder", code_reviewer: "code reviewer", security_reviewer: "security reviewer", ux_reviewer: "UX reviewer", checks: "checks" };

/**
 * Why a flow has no effective independent code review, one line per offending step; empty when every
 * code change is reviewed. A qualifying reviewer is a `code_reviewer` step with no `runIf` that reads a
 * code change and reports `review-findings`; the security review (ORC-021) is an additional checker, never
 * a replacement. A code change counts as reviewed when such a reviewer downstream of it reads that change,
 * or when the next iteration of an `iterate` loop reviews it: the loop runs at least twice (`max` ≥ 2),
 * the reviewer sits before the coder in the loop body, the coder's change is the newest in the body (so
 * the next iteration re-points the reviewer at it), and the coder runs only on that reviewer's findings
 * (`runIf`), so the loop ends with a clean review. The structure alone is checked, not what a worker does.
 */
export function unreviewedReasons(steps: StepDef[]): string[] {
  const reasons: string[] = [];
  const reviewers = steps.filter((s) => s.role === "code_reviewer" && !s.runIf?.length && s.inputs.some((r) => kindOf(steps, r) === "code-change") && s.outputs.some((o) => o.kind === "review-findings"));
  const loops: { body: StepDef[]; max: number }[] = [];
  steps.forEach((d, i) => {
    if (!d.iterate) return;
    const from = steps.findIndex((x) => x.id === d.iterate!.from);
    if (from >= 0 && from <= i) loops.push({ body: steps.slice(from, i + 1), max: d.iterate.max });
  });
  const reviewedByNextIteration = (x: StepDef) =>
    loops.some(({ body, max }) => {
      if (max < 2) return false;
      const xi = body.findIndex((b) => b.id === x.id);
      if (xi < 0) return false;
      const newest = [...body].reverse().find((b) => b.outputs.some((o) => o.kind === "code-change"));
      if (newest?.id !== x.id) return false;
      return reviewers.some((r) => {
        const ri = body.findIndex((b) => b.id === r.id);
        return ri >= 0 && ri < xi && !!x.runIf?.some((ref) => ref.step === r.id && kindOf(steps, ref) === "review-findings");
      });
    });
  for (const x of steps) {
    if (!x.outputs.some((o) => o.kind === "code-change")) continue;
    if (NON_CODING_ROLES.includes(x.role)) {
      reasons.push(`${x.id} changes code as a ${ROLE_WORD[x.role]}; only coder steps may change code`);
      continue;
    }
    const down = downstreamOf(steps, [x.id]);
    if (reviewers.some((r) => down.has(r.id) && r.inputs.some((i) => i.step === x.id && kindOf(steps, i) === "code-change"))) continue;
    if (reviewedByNextIteration(x)) continue;
    const conditional = steps.some((r) => r.role === "code_reviewer" && r.runIf?.length && down.has(r.id));
    reasons.push(`${x.id}'s code change is not read by a code reviewer that always runs${conditional ? " (a review with runIf may be skipped)" : ""}`);
  }
  return reasons;
}

export const breaksDown = (steps: StepDef[]) => steps.some((s) => s.outputs.some((o) => o.kind === "breakdown"));
export const changesCode = (steps: StepDef[]) => steps.some((s) => s.outputs.some((o) => o.kind === "code-change"));

/** The step that chooses among a best-of step's candidates: the first later step that reads the group. */
function chooserOf(steps: StepDef[], i: number): StepDef | undefined {
  return steps.slice(i + 1).find((x) => x.inputs.some((r) => r.step === steps[i].id));
}

/** The flow rules, after the graph rules passed. The first failure is returned. */
export function flowRuleError(id: string, steps: StepDef[]): string | undefined {
  for (const s of steps) {
    if (EXPANSION_ID_RE.test(s.id)) return `${s.id}: step ids ending in -c<n>, -i<n> or -r<k>-fix, -r<k>-review, -r<k>-checks are reserved for the parallel copies, loop iterations and check rounds the service creates`;
    if (s.checks?.only) return `${s.id}.checks.only: ${CHECKS_ONLY_MESSAGE}`;
  }
  for (const [i, s] of steps.entries()) {
    if (s.parallel?.mode !== "best-of") continue;
    const chooser = chooserOf(steps, i);
    if (chooser?.role === "checks") return `${chooser.id} chooses among ${s.id}'s candidates, so it cannot be a Checks step: a service run never chooses`;
  }
  if ((SERVICE_FLOW_IDS as readonly string[]).includes(id)) {
    const why = !changesCode(steps) ? "produce a code change" : unreviewedReasons(steps).length ? `have an independent code review of every code change (${unreviewedReasons(steps).join("; ")})` : breaksDown(steps) ? "not break down into child tasks" : steps.some((s) => s.gate) ? "not pause for a person" : undefined;
    if (why) return `the service creates fix tasks from "${id}", so it must ${why}`;
  }
  return undefined;
}

// ---------- the resolver ----------

export function flowIdOfFile(file: string): string {
  const name = file.split("/").pop() ?? file;
  return name.replace(/\.json$/i, "");
}

/**
 * Resolve the catalog from flow files, in file order. A file that fails any rule throws, naming the file:
 * the built-ins are proven by tests, so nothing is ever skipped or kept in a degraded state at runtime.
 */
export function resolveFlows(files: FlowFile[]): Flow[] {
  const out: Flow[] = [];
  for (const f of files) {
    const raw = f.raw;
    const fail = (m: string): never => {
      throw new Error(`${f.file}: ${m}`);
    };
    if (typeof raw.id !== "string" || !FLOW_ID_RE.test(raw.id)) fail("id must be lowercase letters, digits and hyphens (2–40 characters, starting with a letter)");
    if (flowIdOfFile(f.file) !== raw.id) fail(`the file is named "${flowIdOfFile(f.file)}" but declares the id "${raw.id}"; a flow's file is <id>.json`);
    if (isInternalFlowId(raw.id)) fail(`"${raw.id}" is a pipeline the service owns (${internalFlow(raw.id).name}); it stays in code and no file may take that id`);
    if (out.some((x) => x.id === raw.id)) fail(`the id "${raw.id}" appears twice`);
    if (!Array.isArray(raw.steps) || raw.steps.length === 0 || raw.steps.length > MAX_FLOW_STEPS) fail(`a flow needs 1–${MAX_FLOW_STEPS} steps`);
    if (typeof raw.whenToUse !== "string" || !raw.whenToUse.trim()) fail("whenToUse is required");
    // toDef copies the known fields only, so a step's $comment is dropped here.
    const steps = raw.steps.map((s) => toDef(s as StepDef));
    const graphErrors = validatePipeline(steps).filter((i) => i.severity === "error");
    if (graphErrors.length) fail(graphErrors.map((e) => e.message).join(" "));
    const ruleError = flowRuleError(raw.id, steps);
    if (ruleError) fail(ruleError);
    out.push({ id: raw.id, name: raw.name, description: raw.description, whenToUse: raw.whenToUse, source: "built-in", hash: flowHash(steps), steps, breaksDown: breaksDown(steps) });
  }
  return out;
}

// ---------- the built-in catalog ----------

let builtIn: Flow[] | undefined;

/** The six built-in flows (memoised, returned as a copy): the server writes them to the state at start; seeds, the migration and tests use them. */
export function builtInCatalog(): Flow[] {
  builtIn ??= resolveFlows(BUILT_IN_FILES);
  return structuredClone(builtIn);
}

// ---------- summaries and references ----------

/** Short markers for a step in one-line pipeline summaries. */
export function stepMarkers(st: StepDef): string {
  const m: string[] = [];
  if (st.runIf?.length) m.push("if findings");
  if (st.parallel) m.push(`parallel ×${st.parallel.count}${st.parallel.mode === "best-of" ? " best of" : ""}`);
  if (st.iterate) m.push("repeats");
  if (st.waitForChildren) m.push("waits for child tasks");
  if (st.outputs.some((o) => o.kind === "breakdown")) m.push("breakdown");
  if (st.gate) m.push("pauses for you");
  if (st.independentOf) m.push("reviewed by the other provider");
  if (st.role === "checks") m.push("run by the service");
  return m.length ? ` (${m.join(", ")})` : "";
}

/** "S1 Implement → C1 Run the project's checks (run by the service) → …", shared by the UI and the lead envelope. */
export function flowSummary(steps: StepDef[]): string {
  return steps.map((st) => `${st.id} ${st.purpose}${stepMarkers(st)}`).join(" → ");
}

const isCatalogFlow = (p: Flow | InternalFlow): p is Flow => "source" in p;

/** The provenance recorded on a task and on the pipeline revision that applied the flow. */
export function flowRef(p: Flow | InternalFlow, chosenBy: ChosenBy): FlowRef {
  if (isCatalogFlow(p)) return { id: p.id, name: p.name, source: p.source, hash: p.hash, chosenBy };
  return { id: p.id, name: p.name, source: "internal", hash: flowHash(p.steps), chosenBy };
}

/** A task built by the internal `setPipeline` (tests), or a copy of such a pipeline. */
export function customRef(chosenBy: ChosenBy): FlowRef {
  return { id: "custom", name: "Custom pipeline", source: "custom", chosenBy };
}

// ---------- lookups ----------

export function findFlow(s: State, id: string): Flow | undefined {
  return s.flows?.find((p) => p.id === id);
}

function builtInFlow(id: string): Flow {
  const p = builtInCatalog().find((x) => x.id === id);
  if (!p) throw new Error(`No built-in flow ${id}`);
  return p;
}

/** The catalog's "change" or "bugfix", which the service creates fix tasks from; the built-in when the state's catalog lacks it. */
export function serviceFlow(s: State, id: ServiceFlowId): Flow {
  return findFlow(s, id) ?? builtInFlow(id);
}

/** The project default when that flow exists, else Change. */
export function effectiveDefault(s: State): Flow {
  return findFlow(s, s.project.defaultFlowId) ?? serviceFlow(s, "change");
}

/** The default for breakdown items: the project default unless it breaks down, else Change. */
export function childDefault(s: State): Flow {
  const d = effectiveDefault(s);
  return d.breaksDown ? serviceFlow(s, "change") : d;
}

/** Who may use a flow: the lead and the project default may use any; a breakdown item any flow that does not break down again. */
export function eligible(p: Flow, who: "lead" | "child" | "default"): boolean {
  return who !== "child" || !p.breaksDown;
}

export function eligibleIds(s: State, who: "lead" | "child" | "default"): string[] {
  return s.flows.filter((p) => eligible(p, who)).map((p) => p.id);
}

/** The steps of a built-in or internal flow, cloned, for tests and seeds. */
export function flowSteps(id: string): StepDef[] {
  const p = builtInCatalog().find((x) => x.id === id);
  if (p) return structuredClone(p.steps);
  if (isInternalFlowId(id)) return internalFlow(id).steps;
  throw new Error(`Unknown flow ${id}`);
}

/** A built-in or internal flow by id, for seeds. */
export function builtInOrInternal(id: string): Flow | InternalFlow {
  const p = builtInCatalog().find((x) => x.id === id);
  if (p) return p;
  if (isInternalFlowId(id)) return internalFlow(id);
  throw new Error(`Unknown flow ${id}`);
}

export { INTERNAL_FLOWS, internalFlow, isInternalFlowId };
