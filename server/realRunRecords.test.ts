// ORC-027: the records of real-model runs in docs/real-runs are committed for anyone to read, so none may hold a
// local path or anything shaped like a credential. The scenario (scripts/real-run-test.mjs) writes them that way;
// this catches a hand edit, or a change to the scenario that would let one through. The scenario runs the same check
// (scripts/recordLeaks.mjs) before it writes a record, adding the user name, computer name and git email it knows.

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { leaksIn, scrubHomePaths } from "../scripts/recordLeaks.mjs";

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
