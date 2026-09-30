// ORC-013 step 1 review, finding 2: file names with non-ASCII characters, a quote or a backslash reach
// the changed-path set exactly as git names them, so a reviewer that lists them completes its coverage.
// A real repository; no model runs.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { coverageOf } from "../src/domain/coverage";
import { findingKey } from "./envelope";
import { WorkspaceManager } from "./workspaces";

let dir: string;
let repo: string;
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
const commit = (msg: string) => {
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", msg);
  return git("rev-parse", "HEAD");
};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orc-paths-"));
  repo = join(dir, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "README.md"), "hello\n");
  commit("init");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the carry-forward key (review 1, finding 14)", () => {
  it("includes the severity: an error and a warning with one title and file are two findings", () => {
    expect(findingKey("review", "a.ts", "Same title", "error")).not.toBe(findingKey("review", "a.ts", "Same title", "warning"));
    expect(findingKey("review", "a.ts", "Same title", "error")).toBe(findingKey("review", "a.ts", "  same   TITLE ", "error"));
  });
});

describe("changed paths with special characters (review 1, finding 2)", () => {
  it("reviewDiff and changedPaths return docs/café.md, a name with a quote and one with a backslash as they are; coverage completes when the reviewer lists them", () => {
    const base = git("rev-parse", "HEAD");
    mkdirSync(join(repo, "docs"));
    const names = ["docs/café.md", 'docs/say "hi".md', "docs/back\\slash.md"];
    for (const n of names) writeFileSync(join(repo, n), `${n}\n`);
    const to = commit("special names");
    const ws = new WorkspaceManager(join(dir, "worktrees"));
    const diff = ws.reviewDiff({ repoPath: repo, to, baseRef: base })!;
    expect([...diff.paths].sort()).toEqual([...names].sort());
    expect(diff.total).toBe(3);
    // Never git's quoted form.
    expect(diff.paths.some((p) => p.startsWith('"'))).toBe(false);
    const changed = ws.changedPaths({ repoPath: repo, to, baseRef: base })!;
    expect([...changed.paths].sort()).toEqual([...names].sort());
    // The reviewer reports exactly these names: complete. A path with the backslash rewritten would not match.
    const scope = { from: base, to, paths: diff.paths, total: diff.total };
    expect(coverageOf(scope, names)).toMatchObject({ state: "complete", missing: [], extra: [] });
    expect(coverageOf(scope, names.map((n) => n.replace(/\\/g, "/")))).toMatchObject({ state: "incomplete", missing: ["docs/back\\slash.md"], extra: ["docs/back/slash.md"] });
  });
});
