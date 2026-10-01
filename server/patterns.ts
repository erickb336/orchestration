// ORC-016: the I/O side of pipeline patterns. Reads your pattern files from <dataDir>/patterns, parses them
// as JSONC, validates them against patterns/pattern.schema.json with ajv, hands them with the compiled-in
// built-ins to the pure resolver, and writes templates retired by migration 14 → 15 as files of yours
// (never overwriting). Loading never throws because of a pattern file: every problem is listed with its
// file, line and column, and the built-in catalog is always present.

import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findNodeAtLocation, getNodeValue, parseTree, printParseErrorCode, type Node, type ParseError } from "jsonc-parser";
import { BUILT_IN_FILES } from "../src/domain/builtInPatterns";
import * as M from "../src/domain/model";
import { CHECKS_ONLY_MESSAGE, INTERNAL_PATTERNS, PATTERN_ID_RE, builtInCatalog, resolveCatalog, type PatternFile, type RawPattern } from "../src/domain/patterns";
import { toDef } from "../src/domain/pipeline";
import type { PatternCatalog, PatternError, RetiredTemplate, StepDef } from "../src/domain/types";
import PATTERN_SCHEMA from "../patterns/pattern.schema.json";
import type { Store } from "./store";

export const MAX_PATTERN_FILES = 100;
export const MAX_PATTERN_FILE_BYTES = 64 * 1024;
export const SCHEMA_FILE = "pattern.schema.json";

/** The bundled schema as it is written next to your files, so `"$schema": "./pattern.schema.json"` works there. */
export const SCHEMA_TEXT = `${JSON.stringify(PATTERN_SCHEMA, null, 2)}\n`;

let validator: ValidateFunction | undefined;
/**
 * Compiled once; runs only in the server and the tests, never in the UI bundle. Strict mode, except
 * `strictRequired`: the schema's base-or-variant rule and its if/then name root properties from inside
 * `oneOf` and `then` subschemas, which that lint would refuse.
 */
export function patternValidator(): ValidateFunction {
  validator ??= new Ajv2020({ allErrors: true, strict: true, strictRequired: false }).compile(PATTERN_SCHEMA);
  return validator;
}

/** "~/.orchestration/patterns" for a path under the home directory. */
export function displayPath(path: string): string {
  const home = homedir();
  return home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
}

// ---------- positions ----------

/** Zero-based offset to a one-based line and column. */
export function positionOf(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let last = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      line += 1;
      last = i + 1;
    }
  }
  return { line, column: offset - last + 1 };
}

/** "/steps/2/role" → "steps[2].role" */
function renderPath(instancePath: string): string {
  const parts = instancePath.split("/").slice(1).map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  return parts.map((p, i) => (/^\d+$/.test(p) ? `[${p}]` : i === 0 ? p : `.${p}`)).join("") || "(the file)";
}

function pointerToPath(instancePath: string): (string | number)[] {
  return instancePath
    .split("/")
    .slice(1)
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"))
    .map((p) => (/^\d+$/.test(p) ? Number(p) : p));
}

export interface SchemaComplaint {
  /** JSON Pointer to the value to point at (for an unknown field, the field itself). */
  instancePath: string;
  message: string;
  /** Point at the property's key rather than its value. */
  atKey?: true;
}

/**
 * The schema's complaints in plain words, one per problem. Alternatives (`oneOf`, `anyOf`) and the
 * `if`/`then` keep their one summary line; their inner errors are folded into it.
 */
export function describeSchemaErrors(errors: ErrorObject[]): SchemaComplaint[] {
  const out: SchemaComplaint[] = [];
  const seen = new Set<string>();
  const push = (instancePath: string, message: string, atKey?: true) => {
    const key = `${instancePath}|${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ instancePath, message, ...(atKey ? { atKey } : {}) });
  };
  // A field whose value failed every alternative (`anyOf`) gets one line; the alternatives' own errors
  // (which ajv reports under the referenced definitions) are folded into it.
  const anyOfPaths = errors.filter((e) => e.keyword === "anyOf" && e.instancePath).map((e) => e.instancePath);
  for (const e of errors) {
    const path = renderPath(e.instancePath);
    const p = e.params as Record<string, unknown>;
    if (/\/(oneOf|anyOf)\/\d+\//.test(e.schemaPath)) continue;
    if (e.keyword !== "anyOf" && anyOfPaths.some((a) => e.instancePath === a || e.instancePath.startsWith(`${a}/`))) continue;
    switch (e.keyword) {
      case "oneOf":
        if (e.instancePath === "") push("", `a pattern either lists "steps" (a base pattern) or "extends" another pattern with optional "stepOverrides" (a variant), not both and not neither`);
        else push(e.instancePath, `${path}: ${e.message}`);
        break;
      case "anyOf":
        push(e.instancePath, `${path}: must be a valid value for this field, or null to remove it`);
        break;
      case "if":
        break;
      case "required": {
        const missing = String(p.missingProperty);
        if (e.schemaPath.startsWith("#/then/") && missing === "hypothesis") push(e.instancePath, `"hypothesis" is required when "experimental" is true: say what the experiment should show`);
        else if (e.schemaPath.startsWith("#/oneOf/")) break;
        else push(e.instancePath, `${path}: missing "${missing}"`);
        break;
      }
      case "additionalProperties": {
        const extra = String(p.additionalProperty);
        const where = e.instancePath ? `${path}.${extra}` : extra;
        const pointer = `${e.instancePath}/${extra.replace(/~/g, "~0").replace(/\//g, "~1")}`;
        if (extra === "only" && /\/checks$/.test(e.instancePath)) push(pointer, `${where}: not allowed; ${CHECKS_ONLY_MESSAGE}`, true);
        else if (extra === "copyOf" || extra === "iteration") push(pointer, `${where}: not allowed; the service sets it when it expands steps`, true);
        else if (extra === "id" && /stepOverrides/.test(e.instancePath)) push(pointer, `${where}: a step's id cannot be overridden`, true);
        else push(pointer, `${where}: unknown field`, true);
        break;
      }
      case "dependentRequired":
        push(e.instancePath, `"${String(p.property)}" needs "${String(p.missingProperty)}" too`);
        break;
      case "enum":
        push(e.instancePath, `${path}: must be one of ${(p.allowedValues as unknown[]).map(String).join(", ")}`);
        break;
      case "const":
        push(e.instancePath, `${path}: must be ${JSON.stringify(p.allowedValue)}`);
        break;
      case "pattern":
        if (/(^|\.)id$|^extends$/.test(path)) push(e.instancePath, `${path}: must be lowercase letters, digits and hyphens (2–40 characters, starting with a letter)`);
        else if (/^stepOverrides\./.test(path) || /\.(from|step)$|dependsOn\[\d+\]$/.test(path)) push(e.instancePath, `${path}: must be a step id (letters, digits and hyphens, starting with a letter)`);
        else if (/\.(name|output)$/.test(path)) push(e.instancePath, `${path}: must be lowercase letters, digits and hyphens, starting with a letter`);
        else push(e.instancePath, `${path}: must match ${String(p.pattern)}`);
        break;
      case "propertyNames":
        push(e.instancePath, `${path}: "${String(p.propertyName)}" is not a step id`);
        break;
      case "type":
        push(e.instancePath, `${path}: must be ${p.type === "integer" ? "a whole number" : p.type === "array" ? "a list" : p.type === "object" ? "an object" : `a ${String(p.type)}`}`);
        break;
      default:
        push(e.instancePath, `${path}: ${e.message ?? e.keyword}`);
    }
  }
  return out;
}

// ---------- loading ----------

interface LocalFile {
  name: string;
  path: string;
  size: number;
}

/** Your pattern files: `<id>.json` or `<id>.jsonc`, no dotfiles, no subdirectories; a symlink only to a regular file. Sorted by name. */
function listLocalFiles(dir: string): LocalFile[] {
  const out: LocalFile[] = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const name = d.name;
    if (name.startsWith(".") || !/\.jsonc?$/i.test(name) || name === SCHEMA_FILE) continue;
    const path = join(dir, name);
    let size: number;
    try {
      const st = statSync(path); // follows symlinks
      if (!st.isFile()) continue;
      size = st.size;
    } catch {
      continue;
    }
    out.push({ name, path, size });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Load the catalog: the compiled-in built-ins plus your files from `dir`. Creates the directory, keeps a
 * copy of the schema there, validates everything, and never throws because of a pattern file.
 */
export function loadPatternCatalog(dir: string, nowIso: string): PatternCatalog {
  const validate = patternValidator();
  const errors: PatternError[] = [];
  const files: PatternFile[] = [];
  const builtInIds = new Set(BUILT_IN_FILES.map((f) => f.raw.id));
  for (const b of BUILT_IN_FILES) {
    // The type guard would narrow `b.raw` away in the failing branch; the boolean keeps it.
    const ok: boolean = validate(b.raw);
    if (ok) files.push(b);
    else for (const d of describeSchemaErrors(validate.errors ?? [])) errors.push({ file: b.file, id: b.raw.id, message: d.message, effect: "skipped" });
  }
  const effectFor = (id: unknown): PatternError["effect"] => (typeof id === "string" && builtInIds.has(id) ? "built-in kept" : "skipped");
  const dirDisplay = displayPath(dir);
  const problem = (what: string, e: unknown) => errors.push({ file: dirDisplay, message: `${what}: ${e instanceof Error ? e.message : String(e)}`, effect: "skipped" });
  // Step 1 review, finding 6: an unwritable directory or a failed schema copy is a load warning, never a failure.
  let local: LocalFile[] = [];
  let dirOk = false;
  try {
    mkdirSync(dir, { recursive: true });
    local = listLocalFiles(dir);
    dirOk = true;
  } catch (e) {
    problem("your patterns directory could not be created or read, so none of your files were loaded", e);
  }
  if (dirOk) {
    try {
      ensureSchemaCopy(dir);
    } catch (e) {
      problem(`the schema copy ${SCHEMA_FILE} could not be written there`, e);
    }
  }
  // Each file's parse tree, so resolver errors (which the pure resolver reports without a position) can point at a key.
  const trees = new Map<string, { text: string; tree: Node }>();
  for (const [i, f] of local.entries()) {
    const file = displayPath(f.path);
    const idGuess = f.name.replace(/\.jsonc?$/i, "");
    if (i >= MAX_PATTERN_FILES) {
      errors.push({ file, id: idGuess, message: `more than ${MAX_PATTERN_FILES} pattern files; this one was not read`, effect: effectFor(idGuess) });
      continue;
    }
    if (f.size > MAX_PATTERN_FILE_BYTES) {
      errors.push({ file, id: idGuess, message: `the file is larger than ${MAX_PATTERN_FILE_BYTES / 1024} KiB (${f.size} bytes); not read`, effect: effectFor(idGuess) });
      continue;
    }
    let text: string;
    try {
      text = readFileSync(f.path, "utf8");
    } catch (e) {
      errors.push({ file, id: idGuess, message: `could not be read: ${e instanceof Error ? e.message : String(e)}`, effect: effectFor(idGuess) });
      continue;
    }
    // A UTF-8 byte order mark (some editors write one) is not part of the JSON.
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const parseErrors: ParseError[] = [];
    const tree: Node | undefined = parseTree(text, parseErrors, { allowTrailingComma: true, disallowComments: false });
    if (parseErrors.length) {
      const pe = parseErrors[0];
      errors.push({ file, id: idGuess, message: `JSON syntax: ${printParseErrorCode(pe.error)}`, ...positionOf(text, pe.offset), effect: effectFor(idGuess) });
      continue;
    }
    if (!tree) {
      errors.push({ file, id: idGuess, message: "the file is empty", line: 1, column: 1, effect: effectFor(idGuess) });
      continue;
    }
    const value: unknown = getNodeValue(tree);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      errors.push({ file, id: idGuess, message: "a pattern file holds one JSON object", ...positionOf(text, tree.offset), effect: effectFor(idGuess) });
      continue;
    }
    const raw = value as RawPattern;
    const ok: boolean = validate(raw);
    if (ok) {
      files.push({ file, source: "local", raw });
      trees.set(file, { text, tree });
      continue;
    }
    const id = typeof raw.id === "string" ? raw.id : idGuess;
    for (const d of describeSchemaErrors(validate.errors ?? [])) {
      const node = findNodeAtLocation(tree, pointerToPath(d.instancePath)) ?? tree;
      // A property's value node hangs off its property node, whose offset is the key's.
      const at = d.atKey && node.parent?.type === "property" ? node.parent.offset : node.offset;
      errors.push({ file, id, message: d.message, ...positionOf(text, at), effect: effectFor(id) });
    }
  }
  const r = resolveCatalog(files, errors);
  return { loadedAt: nowIso, localDir: dirDisplay, patterns: r.patterns, errors: r.errors.map((e) => locateResolverError(e, trees.get(e.file))) };
}

/**
 * The key a resolver error is about: `extends` for base problems, the named step (and field) under
 * `stepOverrides` for override problems, otherwise `id` (identity, graph and rule errors concern the whole
 * pattern). Errors that already carry a position, and errors on built-ins, are returned as they are.
 */
function locateResolverError(e: PatternError, src: { text: string; tree: Node } | undefined): PatternError {
  if (!src || e.line !== undefined) return e;
  const override = /^stepOverrides\.([A-Za-z][A-Za-z0-9-]*)(?:\.([A-Za-z$][A-Za-z0-9]*))?/.exec(e.message);
  const path: (string | number)[] = e.message.startsWith("extends ") || /^a pattern either lists "steps" or "extends"/.test(e.message) ? ["extends"] : override ? ["stepOverrides", override[1], ...(override[2] && override[2] !== "id" ? [override[2]] : [])] : ["id"];
  let node: Node | undefined = findNodeAtLocation(src.tree, path);
  while (!node && path.length > 1) {
    path.pop();
    node = findNodeAtLocation(src.tree, path);
  }
  const at = node?.parent?.type === "property" ? node.parent.offset : (node ?? src.tree).offset;
  return { ...e, ...positionOf(src.text, at) };
}

function existingText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Write the schema copy when it is missing or differs. That file is the app's: it is rewritten and it is not a pattern. */
export function ensureSchemaCopy(dir: string): boolean {
  const path = join(dir, SCHEMA_FILE);
  let current: string | undefined;
  try {
    current = readFileSync(path, "utf8");
  } catch {
    current = undefined;
  }
  if (current === SCHEMA_TEXT) return false;
  writeFileSync(path, SCHEMA_TEXT);
  return true;
}

// ---------- exporting retired templates (design §9.3) ----------

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");

/** A valid pattern id from free text, or undefined when nothing usable is left. */
export function slugId(text: string): string | undefined {
  let s = slug(text);
  if (!/^[a-z]/.test(s)) s = s.replace(/^[^a-z]+/, "");
  if (s.length < 2) return undefined;
  return PATTERN_ID_RE.test(s) ? s : undefined;
}

/** `<base>-yours`, `<base>-yours-2`, … within 40 characters, avoiding `taken`. */
function freeId(base: string, taken: Set<string>, forceSuffix: boolean): string {
  const fit = (stem: string, suffix: string) => `${stem.slice(0, 40 - suffix.length).replace(/-+$/g, "")}${suffix}`;
  if (!forceSuffix && !taken.has(base)) return base;
  let candidate = fit(base, "-yours");
  for (let n = 2; taken.has(candidate); n++) candidate = fit(base, `-yours-${n}`);
  return candidate;
}

export interface ExportedPatternFile {
  id: string;
  json: string;
  stripped: string[];
}

/** The pattern file a retired template becomes (pure): steps normalised, `checks.only` stripped and listed, best-of made an experiment. */
export function retiredTemplateFile(t: RetiredTemplate, id: string, name: string): ExportedPatternFile {
  const stripped: string[] = [];
  const steps = t.steps.map((s) => {
    const d = toDef(s);
    delete d.copyOf;
    delete d.iteration;
    if (d.checks?.only?.length) {
      stripped.push(`${d.id}.checks.only (${d.checks.only.join(", ")})`);
      d.checks = { onFail: d.checks.onFail };
    }
    return d as StepDef & Record<string, unknown>;
  });
  const bestOf = steps.some((s) => s.parallel?.mode === "best-of");
  // An edited copy of a pipeline the service owns is an experiment, so it never reaches the lead (step 1 review, finding 2).
  const experiment = t.internal ? "Exported from your edited internal template; review before use" : bestOf ? "Edit this file to say what the best-of experiment should show." : undefined;
  const file: Record<string, unknown> = {
    $schema: `./${SCHEMA_FILE}`,
    $comment: `Saved from your template "${t.name}" when pipelines became patterns (ORC-016).`,
    id,
    name,
    description: t.description.trim().slice(0, 300) || "Saved from your template.",
    whenToUse: "Your template from before patterns. Edit this file to say when to use it.",
    ...(experiment ? { experimental: true, hypothesis: experiment } : {}),
    steps,
  };
  return { id, json: `${JSON.stringify(file, null, 2)}\n`, stripped };
}

export type ExportResult = { exportedTo: string; exportedId: string; stripped: string[] } | { exportError: string };

/**
 * Write each retired template that has not been exported or marked failed yet as a pattern file of yours
 * in `dir`, once, never overwriting (`wx`). The outcome is recorded on the state so a second start exports
 * nothing again (P10). The loader then lists the new file like any other.
 */
export function exportRetiredTemplates(store: Store, dir: string): { written: string[]; failed: string[]; problem?: string } {
  const written: string[] = [];
  const failed: string[] = [];
  const pending = store.read().state.retiredTemplates.filter((t) => !t.exportedTo && !t.exportError);
  if (!pending.length) return { written, failed };
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    // Step 1 review, finding 6: never fatal. Nothing is recorded, so the export is tried again at the next start.
    return { written, failed, problem: `Could not create ${displayPath(dir)}: ${e instanceof Error ? e.message : String(e)}; ${pending.length} template${pending.length === 1 ? "" : "s"} from before patterns not saved yet` };
  }
  const taken = new Set<string>([...builtInCatalog().patterns.map((p) => p.id), ...INTERNAL_PATTERNS.map((p) => p.id), ...store.read().state.retiredTemplates.map((t) => t.exportedId).filter((x): x is string => !!x)]);
  for (const t of pending) {
    const now = new Date().toISOString();
    let result: ExportResult;
    try {
      const edited = t.kind === "edited-built-in";
      const base = edited ? t.id : (slugId(t.name) ?? slugId(t.id) ?? "template");
      const id = freeId(base, taken, edited);
      taken.add(id);
      const name = (edited ? `${t.name} (yours)` : t.name).trim().slice(0, 60) || id;
      const out = retiredTemplateFile(t, id, name);
      const path = join(dir, `${id}.json`);
      try {
        writeFileSync(path, out.json, { flag: "wx" });
        result = { exportedTo: displayPath(path), exportedId: id, stripped: out.stripped };
        written.push(path);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        // Step 1 review, finding 4: a file with exactly this content was written already (an earlier start that
        // did not get to record it), so it counts as exported; anything else is the user's and is kept.
        if (code === "EEXIST" && existingText(path) === out.json) {
          result = { exportedTo: displayPath(path), exportedId: id, stripped: out.stripped };
          written.push(path);
        } else {
          result = { exportError: code === "EEXIST" ? `A file named ${displayPath(path)} already exists; yours was kept.` : `Could not write ${displayPath(path)}: ${e instanceof Error ? e.message : String(e)}` };
          failed.push(path);
        }
      }
    } catch (e) {
      result = { exportError: `Could not build the pattern file: ${e instanceof Error ? e.message : String(e)}` };
      failed.push(t.id);
    }
    store.update((s) => M.recordTemplateExport(s, t.id, result, now), now);
  }
  return { written, failed };
}
