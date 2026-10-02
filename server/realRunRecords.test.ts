// ORC-027: the records of real-model runs in docs/real-runs are committed for anyone to read, so none may hold a
// local path or anything shaped like a credential. The scenario (scripts/real-run-test.mjs) writes them that way;
// this catches a hand edit, or a change to the scenario that would let one through.

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = resolve(import.meta.dirname, "..", "docs", "real-runs");

const LEAKS: { what: string; re: RegExp }[] = [
  { what: "a home-directory path", re: /\/(Users|home)\/[^/"\s]+/ },
  { what: "an Anthropic or OpenAI key or token", re: /\bsk-(ant-)?[A-Za-z0-9_-]{16,}/ },
  { what: "a GitHub token", re: /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/ },
  { what: "a bearer token", re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/i },
];

/** What in this text must not be committed, by kind. */
export function leaksIn(text: string): string[] {
  const found = LEAKS.filter((l) => l.re.test(text)).map((l) => l.what);
  if (text.includes(homedir())) found.push("this computer's home directory");
  return [...new Set(found)];
}

const records = readdirSync(DIR).filter((f) => f.endsWith(".json"));

describe("real-run records (docs/real-runs)", () => {
  it("there is at least one", () => {
    expect(records.length).toBeGreaterThan(0);
  });

  it.each(records)("%s is a real-run record with no local path or credential", (name) => {
    const text = readFileSync(join(DIR, name), "utf8");
    expect(leaksIn(text)).toEqual([]);
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
    expect(leaksIn(`{"repo": "/Users/someone/work/repo"}`)).toEqual(["a home-directory path"]);
    expect(leaksIn(`{"x": "${key("sk-" + "ant-" + "oat01-")}"}`)).toEqual(["an Anthropic or OpenAI key or token"]);
    expect(leaksIn(`{"x": "${key("sk-" + "proj-")}"}`)).toEqual(["an Anthropic or OpenAI key or token"]);
    expect(leaksIn(`{"x": "${key("gh" + "p_")}"}`)).toEqual(["a GitHub token"]);
    expect(leaksIn(`{"x": "Authorization: Bearer ${key("")}"}`)).toEqual(["a bearer token"]);
    expect(leaksIn(`{"x": "${homedir()}"}`)).toContain("this computer's home directory");
    expect(leaksIn(`{"repo": "<work>/repo", "workspace": "~/x"}`)).toEqual([]);
  });
});
