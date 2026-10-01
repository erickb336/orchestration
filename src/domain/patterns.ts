// ORC-016: pipeline patterns, pure. The shape of a pattern file, the resolver (`extends` plus
// `stepOverrides`), the pattern rules, the derived flags and audience, hashing, summaries and the lookups
// the domain uses. No I/O: the server reads files and runs the JSON Schema; the built-in files are
// compiled in through src/domain/builtInPatterns.ts and proven schema-valid by tests.

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import canonicalize from "canonicalize";
import { BUILT_IN_FILES } from "./builtInPatterns";
import { INTERNAL_PATTERNS, internalPattern, isInternalPatternId, type InternalPattern } from "./internalPatterns";
import { downstreamOf, toDef, validatePipeline } from "./pipeline";
import type { ChosenBy, InputRef, OutputDef, Pattern, PatternCatalog, PatternChainEntry, PatternError, PatternFlags, PatternRef, PatternSource, ProviderId, RoleId, State, StepDef } from "./types";

// ---------- the file format ----------

/** A step as written in a pattern file. `$comment` is ignored; `copyOf`, `iteration` and `checks.only` are refused by the schema. */
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

/** Fields a variant changes on one step of its base. `null` removes an optional field. */
export type RawStepOverride = { [K in keyof Omit<RawStep, "id">]?: RawStep[K] | null };

export interface RawPattern {
  $schema?: string;
  $comment?: string;
  id: string;
  name: string;
  description: string;
  whenToUse: string;
  order?: number;
  experimental?: boolean;
  hypothesis?: string;
  /** Base patterns only. */
  steps?: RawStep[];
  /** Variants only. */
  extends?: string;
  stepOverrides?: Record<string, RawStepOverride>;
}

export interface PatternFile {
  /** Display path: "patterns/change.json", "~/.orchestration/patterns/x.jsonc". */
  file: string;
  source: PatternSource;
  /** Already schema-valid (the server ran ajv; built-ins are proven by tests). */
  raw: RawPattern;
}

export const PATTERN_ID_RE = /^[a-z][a-z0-9-]{1,39}$/;
/** `extends` hops from a variant to its base pattern. */
export const MAX_EXTENDS_DEPTH = 3;
export const MAX_PATTERN_STEPS = 30;
/** Ids the service creates when it expands a step into parallel copies or loop iterations (`baseId` strips them). */
const EXPANSION_ID_RE = /-[ci]\d+$/;
const OPTIONAL_STEP_FIELDS: readonly string[] = ["runIf", "gate", "iterate", "parallel", "waitForChildren", "independentOf", "checks"];
/** The catalog ids the service creates tasks from; a file with one of them must stay safe for that (F5). */
export const SERVICE_PATTERN_IDS = ["change", "bugfix"] as const;
export type ServicePatternId = (typeof SERVICE_PATTERN_IDS)[number];
export const CHECKS_ONLY_MESSAGE = "check commands belong to each project; patterns run every configured check";

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
export function patternHash(steps: StepDef[]): string {
  return sha256Hex(canonicalJson(steps.map(toDef)));
}

/** Any field of the file counts; whitespace and comments do not. */
export function fileHash(raw: unknown): string {
  return sha256Hex(canonicalJson(raw));
}

// ---------- flags, audience, rules ----------

function kindOf(steps: StepDef[], r: InputRef) {
  return steps.find((s) => s.id === r.step)?.outputs.find((o) => o.name === r.output)?.kind;
}

/** Roles that read, judge, plan or design: a code change from one of them has no independent review by construction. */
const NON_CODING_ROLES: readonly RoleId[] = ["code_reviewer", "ux_reviewer", "lead", "designer"];
const ROLE_WORD: Record<RoleId, string> = { lead: "lead", designer: "designer", coder: "coder", code_reviewer: "code reviewer", ux_reviewer: "UX reviewer", checks: "checks" };

/**
 * Why a pattern has no effective independent code review, one line per offending step; empty when every
 * code change is reviewed (step 1 review, finding 1). A code change counts as reviewed when a
 * `code_reviewer` step with no `runIf` downstream of it reads that change, or when the step lies in an
 * `iterate` loop whose body holds such a reviewer: the next iteration re-points the reviewer at the newest
 * change of the finished one. The structure alone is checked, not what a worker does with it.
 */
export function unreviewedReasons(steps: StepDef[]): string[] {
  const reasons: string[] = [];
  const reviewers = steps.filter((s) => s.role === "code_reviewer" && !s.runIf?.length && s.inputs.some((r) => kindOf(steps, r) === "code-change"));
  const bodies: Set<string>[] = [];
  steps.forEach((d, i) => {
    if (!d.iterate) return;
    const from = steps.findIndex((x) => x.id === d.iterate!.from);
    if (from >= 0 && from <= i) bodies.push(new Set(steps.slice(from, i + 1).map((b) => b.id)));
  });
  for (const x of steps) {
    if (!x.outputs.some((o) => o.kind === "code-change")) continue;
    if (NON_CODING_ROLES.includes(x.role)) {
      reasons.push(`${x.id} changes code as a ${ROLE_WORD[x.role]}; only coder steps may change code`);
      continue;
    }
    const down = downstreamOf(steps, [x.id]);
    if (reviewers.some((r) => down.has(r.id) && r.inputs.some((i) => i.step === x.id && kindOf(steps, i) === "code-change"))) continue;
    if (bodies.some((body) => body.has(x.id) && reviewers.some((r) => body.has(r.id)))) continue;
    const conditional = steps.some((r) => r.role === "code_reviewer" && r.runIf?.length && down.has(r.id));
    reasons.push(`${x.id}'s code change is not read by a code reviewer that always runs${conditional ? " (a review with runIf may be skipped)" : ""}`);
  }
  return reasons;
}

export function patternFlags(steps: StepDef[]): PatternFlags {
  return {
    breaksDown: steps.some((s) => s.outputs.some((o) => o.kind === "breakdown")),
    pausesForYou: steps.some((s) => !!s.gate),
    unreviewed: unreviewedReasons(steps).length > 0,
    bestOf: steps.some((s) => s.parallel?.mode === "best-of"),
    needsProviders: [...new Set(steps.flatMap((s) => s.parallel?.providers ?? []))],
  };
}

export function audienceOf(experimental: boolean, flags: PatternFlags): Pattern["audience"] {
  return !experimental && !flags.pausesForYou && !flags.unreviewed ? "standard" : "user-only";
}

/** The step that chooses among a best-of step's candidates: the first later step that reads the group. */
function chooserOf(steps: StepDef[], i: number): StepDef | undefined {
  return steps.slice(i + 1).find((x) => x.inputs.some((r) => r.step === steps[i].id));
}

/** The pattern rules (design §3.5 F1–F5), after the graph rules passed. The first failure is returned. */
export function patternRuleError(id: string, steps: StepDef[], experimental: boolean, flags: PatternFlags): string | undefined {
  for (const s of steps) {
    if (EXPANSION_ID_RE.test(s.id)) return `${s.id}: step ids ending in -c<n> or -i<n> are reserved for the parallel copies and loop iterations the service creates`;
    if (s.checks?.only) return `${s.id}.checks.only: ${CHECKS_ONLY_MESSAGE}`;
  }
  for (const [i, s] of steps.entries()) {
    if (s.parallel?.mode !== "best-of") continue;
    if (!experimental) return `${s.id} runs as best of ${s.parallel.count}, so the pattern must say "experimental": true with a hypothesis: competing implementations are an experiment you choose`;
    const chooser = chooserOf(steps, i);
    if (chooser?.role === "checks") return `${chooser.id} chooses among ${s.id}'s candidates, so it cannot be a Checks step: a service run never chooses`;
  }
  if ((SERVICE_PATTERN_IDS as readonly string[]).includes(id)) {
    const why = audienceOf(experimental, flags) !== "standard" ? "be a standard pattern (not experimental, no pause for you, with an independent code review)" : !steps.some((s) => s.outputs.some((o) => o.kind === "code-change")) ? "produce a code change" : flags.breaksDown ? "not break down into child tasks" : undefined;
    if (why) return `the service creates fix tasks from "${id}", so it must ${why}`;
  }
  return undefined;
}

// ---------- the resolver ----------

interface Resolved {
  raw: RawPattern;
  file: string;
  source: PatternSource;
  replacesBuiltIn: boolean;
  steps: StepDef[];
  chain: PatternChainEntry[];
  warnings: string[];
}

class ResolveFailure extends Error {}
class CycleFailure extends Error {
  constructor(readonly members: string[]) {
    super(`extends cycle: ${members.join(" → ")}`);
  }
}

/** The file name without its extension: the id the file must declare. */
export function patternIdOfFile(file: string): string {
  const name = file.split("/").pop() ?? file;
  return name.replace(/\.jsonc?$/i, "");
}

function rawStepsToDefs(steps: RawStep[]): StepDef[] {
  // toDef copies the known fields only, so a step's $comment is dropped here.
  return steps.map((s) => toDef(s as StepDef));
}

function applyOverrides(base: StepDef[], overrides: Record<string, RawStepOverride>, fail: (m: string) => never): StepDef[] {
  const steps = structuredClone(base);
  for (const [sid, ov] of Object.entries(overrides)) {
    const st = steps.find((x) => x.id === sid);
    if (!st) fail(`stepOverrides.${sid}: the base pattern has no step ${sid}`);
    if (!ov || typeof ov !== "object") fail(`stepOverrides.${sid}: must be an object of step fields`);
    const target = st as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(ov)) {
      if (k === "$comment") continue;
      if (k === "id") fail(`stepOverrides.${sid}.id: a step's id cannot be overridden`);
      if (v === null) {
        if (!OPTIONAL_STEP_FIELDS.includes(k)) fail(`stepOverrides.${sid}.${k}: null removes an optional field only; ${k} is required`);
        delete target[k];
      } else target[k] = structuredClone(v);
    }
  }
  return steps.map(toDef);
}

function toPattern(r: Resolved): Pattern {
  const experimental = r.raw.experimental === true;
  const flags = patternFlags(r.steps);
  const warnings = [...r.warnings];
  if (flags.unreviewed) warnings.push(`No independent code review: ${unreviewedReasons(r.steps).join("; ")}.`);
  return {
    id: r.raw.id,
    name: r.raw.name,
    description: r.raw.description,
    whenToUse: r.raw.whenToUse,
    order: typeof r.raw.order === "number" ? r.raw.order : 100,
    ...(experimental ? { experimental: true as const, hypothesis: r.raw.hypothesis ?? "" } : {}),
    source: r.source,
    ...(r.replacesBuiltIn ? { replacesBuiltIn: true as const } : {}),
    file: r.file,
    chain: r.chain,
    hash: patternHash(r.steps),
    steps: r.steps,
    flags,
    audience: audienceOf(experimental, flags),
    warnings,
  };
}

/**
 * Resolve a catalog from pattern files: built-ins first, then yours. A file of yours with a built-in's
 * id replaces it; when that file fails at any stage, the built-in stays in effect ("built-in kept"), and a
 * variant that extends the failed id extends the built-in. Every failure is listed; nothing throws.
 */
export function resolveCatalog(files: PatternFile[], preErrors: PatternError[] = []): { patterns: Pattern[]; errors: PatternError[] } {
  const errors: PatternError[] = [...preErrors];
  const builtIns = new Map<string, PatternFile>();
  const locals = new Map<string, PatternFile>();
  const duplicates = new Map<string, PatternFile[]>();
  const builtInIds = new Set(files.filter((f) => f.source === "built-in" && typeof f.raw?.id === "string").map((f) => f.raw.id));
  for (const f of files) {
    const id = typeof f.raw?.id === "string" ? f.raw.id : patternIdOfFile(f.file);
    if (f.source === "built-in") {
      if (builtIns.has(id)) errors.push({ file: f.file, id, message: `the built-in id "${id}" appears twice in the manifest`, effect: "skipped" });
      else builtIns.set(id, f);
    } else if (patternIdOfFile(f.file) !== id) {
      // Step 1 review, finding 3: a misnamed file fails on its own, before ids are grouped, so it cannot knock out the correctly named file.
      errors.push({ file: f.file, id, message: `the file is named "${patternIdOfFile(f.file)}" but declares the id "${id}"; a pattern's file is <id>.json or <id>.jsonc`, effect: builtInIds.has(id) ? "built-in kept" : "skipped" });
    } else if (locals.has(id) || duplicates.has(id)) {
      const list = duplicates.get(id) ?? [locals.get(id)!];
      list.push(f);
      duplicates.set(id, list);
      locals.delete(id);
    } else locals.set(id, f);
  }
  for (const [id, list] of duplicates) {
    for (const f of list) errors.push({ file: f.file, id, message: `two of your files declare the id "${id}" (${list.map((x) => x.file).join(", ")}); neither is loaded`, effect: builtIns.has(id) ? "built-in kept" : "skipped" });
  }

  const memo = new Map<string, Resolved | null>();
  const memoBuiltIn = new Map<string, Resolved | null>();
  const visiting: string[] = [];
  const cycleMembers = new Set<string>();

  const tryFile = (f: PatternFile): Resolved | undefined => {
    const raw = f.raw;
    const id = raw.id;
    const fail: (m: string) => never = (m) => {
      throw new ResolveFailure(m);
    };
    try {
      // C: identity
      if (typeof id !== "string" || !PATTERN_ID_RE.test(id)) fail(`id must be lowercase letters, digits and hyphens (2–40 characters, starting with a letter)`);
      if (patternIdOfFile(f.file) !== id) fail(`the file is named "${patternIdOfFile(f.file)}" but declares the id "${id}"; a pattern's file is <id>.json or <id>.jsonc`);
      if (isInternalPatternId(id)) fail(`"${id}" is a pipeline the service owns (${internalPattern(id).name}); it stays in code and no file may take that id`);
      // D: resolve
      let steps: StepDef[];
      let chain: PatternChainEntry[];
      const own: PatternChainEntry = { id, source: f.source, file: f.file, fileHash: fileHash(raw) };
      if (typeof raw.extends === "string") {
        if (raw.steps) fail(`a pattern either lists "steps" or "extends" another pattern, not both`);
        let base: Resolved | null;
        try {
          // Step 1 review, finding 6: a file of yours that extends its own id is a variant of the built-in it
          // replaces, so it resolves against that built-in; without one there is nothing to extend.
          if (raw.extends === id && f.source === "local") {
            if (!builtIns.has(id)) fail(`extends "${id}", its own id, but there is no built-in "${id}" to extend`);
            base = resolveBuiltIn(id);
          } else base = resolve(raw.extends);
        } catch (e) {
          if (e instanceof CycleFailure) fail(`extends "${raw.extends}", which leads back to "${id}" (a cycle: ${e.members.join(" → ")})`);
          throw e;
        }
        if (!base) fail(cycleMembers.has(raw.extends) ? `extends "${raw.extends}", which is part of an extends cycle` : raw.extends === id ? `extends "${id}", its own id, but the built-in "${id}" did not load` : `extends "${raw.extends}", which is not a pattern in the catalog`);
        if (base.chain.length > MAX_EXTENDS_DEPTH) fail(`extends "${raw.extends}", which would make the extends chain deeper than ${MAX_EXTENDS_DEPTH}`);
        steps = applyOverrides(base.steps, raw.stepOverrides ?? {}, fail);
        chain = [own, ...base.chain];
      } else {
        if (!Array.isArray(raw.steps) || raw.steps.length === 0) fail(`a base pattern needs 1–${MAX_PATTERN_STEPS} steps`);
        if (raw.steps.length > MAX_PATTERN_STEPS) fail(`at most ${MAX_PATTERN_STEPS} steps per pattern`);
        if (raw.stepOverrides) fail(`"stepOverrides" belongs to a variant that "extends" another pattern`);
        steps = rawStepsToDefs(raw.steps);
        chain = [own];
      }
      // E: graph
      const issues = validatePipeline(steps);
      const graphErrors = issues.filter((i) => i.severity === "error");
      if (graphErrors.length) fail(graphErrors.map((e) => e.message).join(" "));
      // F: pattern rules
      const ruleError = patternRuleError(id, steps, raw.experimental === true, patternFlags(steps));
      if (ruleError) fail(ruleError);
      return { raw, file: f.file, source: f.source, replacesBuiltIn: f.source === "local" && builtIns.has(id), steps, chain, warnings: issues.filter((i) => i.severity === "warning").map((w) => w.message) };
    } catch (e) {
      if (!(e instanceof ResolveFailure)) throw e;
      errors.push({ file: f.file, id: typeof id === "string" ? id : undefined, message: e.message, effect: f.source === "local" && builtIns.has(id) ? "built-in kept" : "skipped" });
      return undefined;
    }
  };

  /** The built-in with this id on its own, whatever file of yours replaces it. Its own `extends` resolve as usual. */
  function resolveBuiltIn(id: string): Resolved | null {
    if (memoBuiltIn.has(id)) return memoBuiltIn.get(id)!;
    const b = builtIns.get(id);
    const out = b ? (tryFile(b) ?? null) : null;
    memoBuiltIn.set(id, out);
    return out;
  }

  function resolve(id: string): Resolved | null {
    if (memo.has(id)) return memo.get(id)!;
    const at = visiting.indexOf(id);
    if (at >= 0) {
      const members = [...visiting.slice(at), id];
      for (const m of members) cycleMembers.add(m);
      throw new CycleFailure(members);
    }
    visiting.push(id);
    try {
      let out: Resolved | undefined;
      const local = locals.get(id);
      if (local) out = tryFile(local);
      if (!out) out = resolveBuiltIn(id) ?? undefined;
      memo.set(id, out ?? null);
      return out ?? null;
    } finally {
      visiting.pop();
    }
  }

  for (const id of [...builtIns.keys(), ...locals.keys()]) {
    if (!memo.has(id)) {
      try {
        resolve(id);
      } catch (e) {
        // A cycle surfaces through the member that first re-enters; every member records its own error.
        if (!(e instanceof CycleFailure)) throw e;
      }
    }
  }
  const patterns = [...memo.values()]
    .filter((r): r is Resolved => !!r)
    .map(toPattern)
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { patterns, errors };
}

// ---------- the built-in catalog ----------

let builtIn: PatternCatalog | undefined;

/** The catalog made from the built-in files alone (memoised, returned as a copy): seeds, the migration and tests use it. */
export function builtInCatalog(): PatternCatalog {
  if (!builtIn) {
    const r = resolveCatalog(BUILT_IN_FILES);
    builtIn = { loadedAt: "", localDir: "", patterns: r.patterns, errors: r.errors };
  }
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
export function patternSummary(steps: StepDef[]): string {
  return steps.map((st) => `${st.id} ${st.purpose}${stepMarkers(st)}`).join(" → ");
}

const isCatalogPattern = (p: Pattern | InternalPattern): p is Pattern => "source" in p;

/** The provenance recorded on a task and on the pipeline revision that applied the pattern. */
export function patternRef(p: Pattern | InternalPattern, chosenBy: ChosenBy): PatternRef {
  if (isCatalogPattern(p)) return { id: p.id, name: p.name, source: p.source, hash: p.hash, chain: structuredClone(p.chain), ...(p.experimental ? { experimental: true as const } : {}), chosenBy };
  return { id: p.id, name: p.name, source: "internal", hash: patternHash(p.steps), chosenBy };
}

/** A task built by the internal `setPipeline` (tests), or a copy of such a pipeline. */
export function customRef(chosenBy: ChosenBy): PatternRef {
  return { id: "custom", name: "Custom pipeline", source: "custom", chosenBy };
}

// ---------- lookups ----------

export function findPattern(s: State, id: string): Pattern | undefined {
  return s.patterns?.patterns.find((p) => p.id === id);
}

function builtInPattern(id: string): Pattern {
  const p = builtInCatalog().patterns.find((x) => x.id === id);
  if (!p) throw new Error(`No built-in pattern ${id}`);
  return p;
}

/** The catalog's "change" or "bugfix", which the service creates fix tasks from; the built-in when the state's catalog lacks it. */
export function servicePattern(s: State, id: ServicePatternId): Pattern {
  return findPattern(s, id) ?? builtInPattern(id);
}

/** The project default when that pattern exists and is standard, else "change". */
export function effectiveDefault(s: State): Pattern {
  const p = findPattern(s, s.project.defaultPatternId);
  return p && p.audience === "standard" ? p : servicePattern(s, "change");
}

/** The default for breakdown items: the project default unless it breaks down, else "change". */
export function childDefault(s: State): Pattern {
  const d = effectiveDefault(s);
  return d.flags.breaksDown ? servicePattern(s, "change") : d;
}

/** Who may use a pattern: the lead's proposals and the project default need a standard pattern; a child task also one that does not break down. */
export function eligible(p: Pattern, who: "lead" | "child" | "default"): boolean {
  return p.audience === "standard" && (who !== "child" || !p.flags.breaksDown);
}

export function eligibleIds(s: State, who: "lead" | "child" | "default"): string[] {
  return s.patterns.patterns.filter((p) => eligible(p, who)).map((p) => p.id);
}

/** The steps of a built-in or internal pattern, cloned. Replaces `templateSteps` in tests and seeds. */
export function patternSteps(id: string): StepDef[] {
  const p = builtInCatalog().patterns.find((x) => x.id === id);
  if (p) return structuredClone(p.steps);
  if (isInternalPatternId(id)) return internalPattern(id).steps;
  throw new Error(`Unknown pattern ${id}`);
}

/** A built-in or internal pattern by id, for seeds. */
export function builtInOrInternal(id: string): Pattern | InternalPattern {
  const p = builtInCatalog().patterns.find((x) => x.id === id);
  if (p) return p;
  if (isInternalPatternId(id)) return internalPattern(id);
  throw new Error(`Unknown pattern ${id}`);
}

export { INTERNAL_PATTERNS, internalPattern, isInternalPatternId };
