// ORC-027: the records of real-model runs in docs/real-runs are committed for anyone to read, so none may hold a
// local path or anything shaped like a credential. The scenario (scripts/real-run-test.mjs) writes them that way;
// this catches a hand edit, or a change to the scenario that would let one through. The scenario runs the same check
// (scripts/recordLeaks.mjs) before it writes a record, adding the user name, computer name and git email it knows.

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { leaksIn, scrubHomePaths } from "../scripts/recordLeaks.mjs";
import { PRICES } from "../src/domain/spend";

const DIR = resolve(import.meta.dirname, "..", "docs", "real-runs");

/** The shared patterns, plus this computer's home directory (in CI that is the runner's, so a stray path is caught there too). */
const leaks = (text: string) => leaksIn(text, [{ what: "this computer's home directory", value: homedir() }]);

const records = readdirSync(DIR).filter((f) => f.endsWith(".json"));

describe("real-run records (docs/real-runs)", () => {
  it("there is at least one", () => {
    expect(records.length).toBeGreaterThan(0);
  });

  it.each(records)("%s is a real-run record with no local path or credential", (name) => {
    const text = readFileSync(join(DIR, name), "utf8");
    expect(leaks(text)).toEqual([]);
    const r = JSON.parse(text) as { mode: string; startedAt: string; ok: boolean; checks: Record<string, { ok: boolean }>; serviceLog?: unknown };
    expect(r.mode).toBe("real");
    expect(name).toBe(`${r.startedAt.replace(/[:.]/g, "-")}.json`);
    expect(typeof r.ok).toBe("boolean");
    expect(Object.keys(r.checks).length).toBeGreaterThan(0);
    // The service log can hold anything a process printed; it stays in the local evidence file only.
    expect(r.serviceLog).toBeUndefined();
  });

  it("the leak check finds each kind (strings built here, so none sits in the repository)", () => {
    const key = (prefix: string) => prefix + "A1b2C3d4E5f6G7h8J9k0";
    expect(leaks(`{"repo": "/Users/someone/work/repo"}`)).toEqual(["a home-directory path"]);
    expect(leaks(`{"repo": "/home/someone/repo"}`)).toEqual(["a home-directory path"]);
    expect(leaks(`{"reason": "cut short: /Users/someo…"}`)).toEqual(["a home-directory path"]);
    expect(leaks(`{"repo": "C:\\\\Users\\\\someone\\\\repo"}`)).toEqual(["a Windows home-directory path"]);
    expect(leaks(`{"x": "${key("sk-" + "ant-" + "oat01-")}"}`)).toEqual(["an Anthropic or OpenAI key or token"]);
    expect(leaks(`{"x": "${key("sk-" + "proj-")}"}`)).toEqual(["an Anthropic or OpenAI key or token"]);
    expect(leaks(`{"x": "${key("gh" + "p_")}"}`)).toEqual(["a GitHub token"]);
    expect(leaks(`{"x": "Authorization: Bearer ${key("")}"}`)).toEqual(["a bearer token"]);
    expect(leaks(`{"x": "${"ey" + "J" + key("") + "." + key("") + "." + key("")}"}`)).toEqual(["a JSON Web Token"]);
    expect(leaks(`{"x": "${"AK" + "IA" + "ABCDEFGHIJKLMNOP"}"}`)).toEqual(["an AWS access key"]);
    expect(leaks(`{"x": "${homedir()}"}`)).toContain("this computer's home directory");
    // Names known where the record is made match as whole words only.
    expect(leaksIn(`{"x": "made by janedoe on janes-mac"}`, [{ what: "your user name", value: "janedoe" }, { what: "this computer's name", value: "janes-mac" }])).toEqual(["your user name", "this computer's name"]);
    expect(leaksIn(`{"x": "janedoe2 and xjanedoe"}`, [{ what: "your user name", value: "janedoe" }])).toEqual([]);
    // Clean text, URL-like paths and the placeholders pass.
    expect(leaks(`{"repo": "<work>/repo", "workspace": "~/x", "api": "/api/users/7"}`)).toEqual([]);
  });

  it("the fallback scrub turns a home path that an exact replacement missed into ~", () => {
    expect(scrubHomePaths(`{"reason": "cannot read /Users/someo…", "w": "/home/runner/x"}`)).toBe(`{"reason": "cannot read ~", "w": "~/x"}`);
  });
});

describe("the pinned prices (src/domain/prices.json) and the real runs", () => {
  it("every price names the provider's pricing page and the date it was read; a model has one price", () => {
    const pages = { claude: "https://platform.claude.com/docs/en/about-claude/pricing", codex: "https://developers.openai.com/api/docs/pricing" };
    for (const p of PRICES) {
      expect(p.source, p.model).toBe(pages[p.provider]);
      expect(p.checked, p.model).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(new Date(`${p.checked}T00:00:00Z`).toISOString().slice(0, 10), p.model).toBe(p.checked);
      expect(p.inputPerMTok > 0 && p.outputPerMTok > 0, p.model).toBe(true);
    }
    const keys = PRICES.map((p) => `${p.provider} ${p.model}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("every model a real run reported has a price, so its tokens are priced, not unknown", () => {
    const ran = new Set<string>();
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) return v.forEach(walk);
      if (!v || typeof v !== "object") return;
      const o = v as Record<string, unknown>;
      if ((o.provider === "claude" || o.provider === "codex") && typeof o.actualModel === "string") ran.add(`${o.provider} ${o.actualModel}`);
      Object.values(o).forEach(walk);
    };
    for (const name of records) walk(JSON.parse(readFileSync(join(DIR, name), "utf8")));
    expect(ran.size).toBeGreaterThan(0);
    const priced = new Set(PRICES.map((p) => `${p.provider} ${p.model}`));
    expect([...ran].filter((m) => !priced.has(m))).toEqual([]);
  });
});
