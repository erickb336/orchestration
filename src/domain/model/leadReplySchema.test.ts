import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { LEAD_REPLY_SCHEMA, schemaMismatch, withNulls, withoutNulls, type JsonSchema } from "./leadReplySchema";

const check = new Ajv({ allErrors: true, strict: true }).compile(LEAD_REPLY_SCHEMA);
const accepts = (v: unknown) => check(withNulls(LEAD_REPLY_SCHEMA, v)) || check.errors;

/** Every object schema in the tree, with its path. */
function objects(s: JsonSchema, at = "#"): { at: string; s: JsonSchema }[] {
  const here = s.type === "object" ? [{ at, s }] : [];
  const props = Object.entries(s.properties ?? {}).flatMap(([k, p]) => objects(p, `${at}/${k}`));
  const items = s.items ? objects(s.items, `${at}[]`) : [];
  const branches = (s.anyOf ?? []).flatMap((b) => objects(b, at));
  return [...here, ...props, ...items, ...branches];
}

describe("the lead's reply schema", () => {
  it("is in the subset both strict modes accept: every object closed, every field required, no limits", () => {
    const all = objects(LEAD_REPLY_SCHEMA);
    expect(all.length).toBeGreaterThan(10);
    for (const { at, s } of all) {
      expect(s.additionalProperties, at).toBe(false);
      expect([...(s.required ?? [])].sort(), at).toEqual(Object.keys(s.properties ?? {}).sort());
    }
    const text = JSON.stringify(LEAD_REPLY_SCHEMA);
    for (const k of ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "pattern", "$ref", "oneOf", "allOf"]) expect(text).not.toContain(`"${k}"`);
  });

  it("accepts a sparse reply once the missing nullable fields are null, and refuses one without its reply", () => {
    expect(accepts({ reply: "ok", proposals: [] })).toBe(true);
    expect(accepts({ proposals: [] })).toEqual([expect.objectContaining({ keyword: "required", params: { missingProperty: "reply" } })]);
  });

  it("refuses fields it does not name and values outside the fixed choices", () => {
    expect(accepts({ reply: "ok", proposals: [], studio: { approve: true } })).toEqual(expect.arrayContaining([expect.objectContaining({ instancePath: "/studio", keyword: "additionalProperties" })]));
    expect(accepts({ reply: "ok", proposals: [], coverage: { intent: "done" } })).toEqual(expect.arrayContaining([expect.objectContaining({ instancePath: "/coverage/intent", keyword: "enum" })]));
  });

  it("says where a value does not match, short: the value branch only, at most three places", () => {
    const at = (v: unknown) => schemaMismatch(LEAD_REPLY_SCHEMA, withNulls(LEAD_REPLY_SCHEMA, v));
    expect(at({ reply: "ok", proposals: [] })).toBeUndefined();
    // A nullable field's null branch ("must be null") and the anyOf around it are left out.
    expect(at({ reply: "ok", proposals: [], steer: "x", vision: { text: 1 } })).toBe("/steer must be object; /vision/text must be string");
    expect(at({ reply: "ok", proposals: [], coverage: { intent: "done" } })).toBe("/coverage/intent must be equal to one of the allowed values: clear, partial, open");
    expect(at({ reply: 1, proposals: {}, steer: 1, vision: 1, studio: 1 })).toBe("/reply must be string; /proposals must be array; /steer must be object; and 2 more");
  });

  it("withoutNulls removes null fields at every depth and keeps the rest", () => {
    const parsed = JSON.parse('{"a":null,"b":{"c":null,"d":[{"e":null,"f":1},null]},"__proto__":{"x":1}}');
    const out = withoutNulls(parsed) as Record<string, unknown>;
    expect(out).toEqual({ b: { d: [{ f: 1 }, null] }, ["__proto__"]: { x: 1 } });
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });
});
