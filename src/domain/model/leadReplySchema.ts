// The lead's reply as one JSON Schema (ORC-029 pass 4, after the real trial of 2026-10-02): the contract each runtime
// constrains the lead's final answer to (Claude: the Agent SDK's `outputFormat`; Codex: the app-server's
// `outputSchema`), and the shape the service checks again on arrival (parseLeadOutput, server/envelope.ts).
//
// One schema for both providers, in the subset that both strict modes accept:
// - every object names all its properties in `required` and sets `additionalProperties: false` (OpenAI strict mode);
// - a field the lead may leave out is nullable (`anyOf` with null), never optional;
// - no numeric, length or item-count limits (Claude's structured outputs do not support them).
// So the schema fixes the shape: the fields, their types and the fixed choices. The domain's validators keep the
// meaning: limits, authority and unknown ids (leadOutput.ts, shaping.ts, steering.ts, findings.ts, studio/lead.ts).
// A field the domain reads must be here too, or no constrained lead can send it.
//
// A null field means "left out". `withNulls` fills each missing nullable field with null (the simulated lead, and a
// reply from a runtime that applied no schema); `withoutNulls` removes the null fields before the domain reads the
// reply, so the domain's input stays "absent means not given". `schemaMismatch` is the check, with ajv.

import Ajv, { type ValidateFunction } from "ajv";
import { LEAD_OPTIONS } from "../findings";
import { DESIGNER_KINDS, ROUND_FOCUSES } from "../studio/types";
import { COVERAGE_STATES, DEVICES, SHAPING_AREAS } from "../types";

/** The JSON Schema keywords the lead's schema uses: the subset both providers' strict modes accept. */
export type JsonSchema = {
  type?: "object" | "array" | "string" | "integer" | "number" | "boolean" | "null";
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: false;
  items?: JsonSchema;
  enum?: readonly string[];
  anyOf?: JsonSchema[];
};

const text: JsonSchema = { type: "string" };
const whole: JsonSchema = { type: "integer" };
const flag: JsonSchema = { type: "boolean" };
const oneOf = (values: readonly string[]): JsonSchema => ({ type: "string", enum: [...values] });
const list = (items: JsonSchema): JsonSchema => ({ type: "array", items });
/** A field the lead may leave out: the value, or null. */
const orNull = (s: JsonSchema): JsonSchema => ({ anyOf: [s, { type: "null" }] });
/** An object with exactly these fields, all required (a field that may be left out is `orNull`). */
const record = (properties: Record<string, JsonSchema>): JsonSchema => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });

const proposal = record({
  title: text,
  area: orNull(text),
  whyNow: orNull(text),
  outcome: text,
  benefit: orNull(text),
  scopeIncluded: orNull(list(text)),
  scopeExcluded: orNull(list(text)),
  options: list(
    record({
      id: text,
      name: text,
      approach: text,
      benefit: orNull(text),
      effort: orNull(text),
      risks: orNull(text),
      reversibility: orNull(text),
    }),
  ),
  recommendedOptionId: text,
  rationale: text,
  uncertainty: orNull(text),
  acceptance: list(text),
  flowId: orNull(text),
  priority: orNull(whole),
  // ORC-029 pass 5: the approved blueprint items it builds, and the task the PE sent back that it revises.
  blueprintRefs: orNull(list(text)),
  revises: orNull(text),
});

// Each task entry gives exactly one of priority, defer and drop; the steering module checks that.
const steer = record({
  focus: orNull(text),
  reason: orNull(text),
  tasks: orNull(list(record({ id: text, priority: orNull(whole), defer: orNull(flag), drop: orNull(flag), why: orNull(text) }))),
  notes: orNull(list(record({ task: text, step: text, text, ifFinished: orNull(oneOf(["report", "rerun"])) }))),
});

const vision = record({ text, focus: orNull(text), reason: orNull(text) });

const coverage = record(Object.fromEntries(SHAPING_AREAS.map((area) => [area, orNull(oneOf(COVERAGE_STATES))])));

const options = orNull(list(text));
const questions = list(record({ question: text, why: orNull(text), area: orNull(oneOf(SHAPING_AREAS)), options }));

const decisions = list(
  record({
    id: text,
    decision: oneOf(LEAD_OPTIONS),
    why: text,
    title: orNull(text),
    // [low, high] in dollars; the PE's cost check reads the pair.
    cost: orNull(record({ buildUsd: orNull(list({ type: "number" })), maintenanceUsdPerMonth: orNull(list({ type: "number" })), basis: text })),
  }),
);

const studio = record({
  closeRound: orNull(record({ summary: orNull(text) })),
  openRound: orNull(record({ focus: oneOf(ROUND_FOCUSES), summary: orNull(text) })),
  designerRuns: orNull(
    list(
      record({
        brief: text,
        // Left out only with "revises": the next version keeps its kind.
        kinds: orNull(list(oneOf(DESIGNER_KINDS))),
        variants: whole,
        devices: orNull(list(oneOf(DEVICES))),
        revises: orNull(text),
      }),
    ),
  ),
  questions: orNull(list(record({ question: text, why: orNull(text), options }))),
});

/** The lead's final answer: what every lead run returns, whatever it was started for. */
export const LEAD_REPLY_SCHEMA: JsonSchema = record({
  reply: text,
  proposals: list(proposal),
  steer: orNull(steer),
  vision: orNull(vision),
  coverage: orNull(coverage),
  questions: orNull(questions),
  decisions: orNull(decisions),
  studio: orNull(studio),
});

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const allowsNull = (s: JsonSchema) => s.type === "null" || !!s.anyOf?.some((b) => b.type === "null");

/** The part of a schema that describes a value of this kind (an object or a list), if any. */
function branchFor(s: JsonSchema, v: unknown): JsonSchema | undefined {
  const kind = Array.isArray(v) ? "array" : isPlainObject(v) ? "object" : undefined;
  if (!kind) return undefined;
  if (s.type === kind) return s;
  return s.anyOf?.find((b) => b.type === kind);
}

/**
 * The value with each missing nullable field set to null, as a model constrained to the schema sends it. Changes
 * nothing else: a missing required field stays missing, and fields the schema does not name stay, for the check to
 * report.
 */
export function withNulls(schema: JsonSchema, value: unknown): unknown {
  const s = branchFor(schema, value);
  if (!s) return value;
  if (Array.isArray(value)) return s.items ? value.map((x) => withNulls(s.items!, x)) : value;
  const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const [k, field] of Object.entries(s.properties ?? {})) {
    if (Object.hasOwn(out, k)) out[k] = withNulls(field, out[k]);
    else if (allowsNull(field)) out[k] = null;
  }
  return out;
}

const ajv = new Ajv({ allErrors: true, strict: true });
const compiled = new WeakMap<JsonSchema, ValidateFunction>();
const MAX_MISMATCHES = 3;

/**
 * Why the value does not match the schema, short: the first places and what is wrong there, or undefined when it
 * matches. It names fields and the schema's rules, never the values.
 */
export function schemaMismatch(schema: JsonSchema, value: unknown): string | undefined {
  let validate = compiled.get(schema);
  if (!validate) compiled.set(schema, (validate = ajv.compile(schema)));
  if (validate(value)) return undefined;
  const found = new Map<string, string>();
  for (const e of validate.errors ?? []) {
    // A nullable field's null branch and the anyOf around it only repeat what its value branch says.
    if (e.keyword === "anyOf" || (e.keyword === "type" && e.params.type === "null")) continue;
    const at = e.instancePath || "the reply";
    if (found.has(at)) continue;
    const named = e.keyword === "additionalProperties" ? ` ("${String(e.params.additionalProperty).slice(0, 40)}")` : e.keyword === "enum" ? `: ${(e.params.allowedValues as string[]).join(", ")}` : "";
    found.set(at, `${at} ${e.message}${named}`);
  }
  const all = [...found.values()];
  return all.slice(0, MAX_MISMATCHES).join("; ") + (all.length > MAX_MISMATCHES ? `; and ${all.length - MAX_MISMATCHES} more` : "");
}

/** The value with every null field removed, at every depth: a null field means the lead left it out. */
export function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (!isPlainObject(value)) return value;
  // fromEntries defines each key as a plain field, also a "__proto__" key from JSON.parse.
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, v]) => v !== null)
      .map(([k, v]) => [k, withoutNulls(v)]),
  );
}
