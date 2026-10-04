// ORC-029 pass 4: an existing repository, read only from git at HEAD: whether it has code, and which files it tracks.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isCode, localFilterDrivers, repoAt, repoFiles, repoGlance, trackedAmong } from "./existing";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orc029-existing-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function repo(files: Record<string, string>, commit = true): string {
  const r = join(dir, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", r]);
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(r, p, ".."), { recursive: true });
    writeFileSync(join(r, p), text);
  }
  if (commit) {
    execFileSync("git", ["-C", r, "add", "-A"]);
    execFileSync("git", ["-C", r, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
  }
  return r;
}

describe("an existing repository", () => {
  it("code is anything but documents, licences, git and editor settings, and images", () => {
    for (const p of ["src/App.tsx", "index.html", "styles/site.css", "main.go", "infra/main.tf", "k8s/deploy.yaml", "Makefile", "Dockerfile", "docs/api.json"]) expect([p, isCode(p)]).toEqual([p, true]);
    for (const p of ["README.md", "docs/guide.md", "LICENSE", "licence.txt", "CHANGELOG", ".gitignore", "sub/.editorconfig", "logo.png", "notes.txt"]) expect([p, isCode(p)]).toEqual([p, false]);
  });

  it("a glance says how many files the repository tracks at HEAD, how many are code, and names the first code paths", () => {
    const r = repo({ "README.md": "# Trips\n", "src/index.html": "<h1>Trips</h1>", "src/trips.css": "h1 {}", "src/app.js": "1", "logo.png": "png" });
    expect(repoFiles(r)?.sort()).toEqual(["README.md", "logo.png", "src/app.js", "src/index.html", "src/trips.css"]);
    expect(repoGlance(r)).toEqual({ files: 5, codeFiles: 3, code: ["src/app.js", "src/index.html", "src/trips.css"] });
    expect(repoGlance(r, 2)).toEqual({ files: 5, codeFiles: 3, code: ["src/app.js", "src/index.html"] });
    // Uncommitted files are not the repository's yet.
    writeFileSync(join(r, "src", "draft.js"), "2");
    expect(repoGlance(r)?.codeFiles).toBe(3);
  });

  it("the listing follows HEAD: what a new commit adds is listed (review finding 11 keeps one listing per HEAD)", () => {
    const r = repo({ "src/index.html": "<h1>Trips</h1>" });
    expect(repoFiles(r)).toEqual(["src/index.html"]);
    writeFileSync(join(r, "src", "app.js"), "1");
    execFileSync("git", ["-C", r, "add", "-A"]);
    execFileSync("git", ["-C", r, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "more"]);
    expect(repoFiles(r)).toEqual(["src/app.js", "src/index.html"]);
  });

  it("the provenance lookup names which of the given files the repository tracks, as literal paths, and nothing else", () => {
    const r = repo({ "src/index.html": "<h1>Trips</h1>", "src/trips.css": "h1 {}", "src/*.js": "a literal star", "src/app.js": "1" });
    expect(trackedAmong(r, ["src/index.html", "src/missing.ts", "src/*.js"])).toEqual(new Set(["src/index.html", "src/*.js"]));
    // A folder is not a file it came from.
    expect(trackedAmong(r, ["src"])?.has("src")).toBe(false);
    expect(trackedAmong(join(dir, "missing"), ["src/index.html"])).toBeUndefined();
  });

  it("the provenance lookup reads the import's commit when given one (C11): a file committed later is not there", () => {
    const r = repo({ "src/index.html": "<h1>Trips</h1>" });
    const first = execFileSync("git", ["-C", r, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    writeFileSync(join(r, "src", "later.js"), "1");
    execFileSync("git", ["-C", r, "add", "-A"]);
    execFileSync("git", ["-C", r, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "later"]);
    expect(trackedAmong(r, ["src/index.html", "src/later.js"])).toEqual(new Set(["src/index.html", "src/later.js"]));
    expect(trackedAmong(r, ["src/index.html", "src/later.js"], first)).toEqual(new Set(["src/index.html"]));
    expect(trackedAmong(r, ["src/index.html"], "f".repeat(40))).toBeUndefined();
  });

  it("the import's start reads the commit, the branch and the size: source and test files apart, and their kilobytes", () => {
    const r = repo({ "README.md": "# tally\n", "tally/cli.py": "x".repeat(2048), "tally/money.py": "1", "tests/test_add.py": "x".repeat(1024), "src/app.test.ts": "1", "pkg/a_test.go": "1", "logo.png": "png" });
    const head = execFileSync("git", ["-C", r, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    expect(repoAt(r)).toEqual({ commit: head, branch: "main", size: { sourceFiles: 2, testFiles: 3, kb: 3.0 } });
    expect(repoAt(join(dir, "missing"))).toBeUndefined();
  });

  it("names the filter drivers the repository's own config defines, which a checkout would run", () => {
    const r = repo({ "a.txt": "1" });
    expect(localFilterDrivers(r)).toEqual([]);
    execFileSync("git", ["-C", r, "config", "--local", "filter.evil.smudge", "touch /tmp/pwned"]);
    execFileSync("git", ["-C", r, "config", "--local", "filter.lfs.process", "git-lfs filter-process"]);
    expect(localFilterDrivers(r)).toEqual(["evil", "lfs"]);
  });

  it("a repository with documents only has no code; one that cannot be read gives nothing", () => {
    expect(repoGlance(repo({ "README.md": "# Trips\n" }))).toEqual({ files: 1, codeFiles: 0, code: [] });
    rmSync(join(dir, "repo"), { recursive: true, force: true });
    expect(repoGlance(repo({ "src/a.js": "1" }, false))).toBeUndefined();
    expect(repoGlance(join(dir, "missing"))).toBeUndefined();
    expect(repoFiles("")).toBeUndefined();
  });
});
