// The import reads an untrusted repository without a checkout (ORC-032, SR-2): `snapshot` writes a commit's files from
// git's object store. A hostile repository sets a filter through include.path (which `git config --local` never
// showed), and a global git-lfs stand-in follows `.gitattributes`: a checkout runs both on this computer, a snapshot
// runs neither.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hostilePartialClone } from "./testing/partialClone";
import { SNAPSHOT_CAPS, WorkspaceManager } from "./workspaces";

let dir: string;
let repo: string;
// This computer's git config (a CI runner's git-lfs, for one) stays out: the test sets every config git reads.
const CONFIG_ENV = ["HOME", "XDG_CONFIG_HOME", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL"] as const;
let saved: Record<string, string | undefined>;
const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgSign=false", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" }).trim();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orc032-snapshot-"));
  repo = join(dir, "repo");
  saved = Object.fromEntries(CONFIG_ENV.map((k) => [k, process.env[k]]));
  delete process.env.GIT_CONFIG_GLOBAL;
  process.env.HOME = dir;
  process.env.XDG_CONFIG_HOME = dir;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
});
afterEach(() => {
  for (const k of CONFIG_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A repository from someone else: every file goes through its filter "evil", whose smudge, set in a config file that
 * .git/config includes, writes a marker on this computer. Its .bin files go through "lfs", a global git-lfs stand-in.
 */
function hostileRepository(): { marker: string; lfsSeen: string; commit: string } {
  const marker = join(dir, "the-smudge-ran");
  const lfsSeen = join(dir, "lfs-smudge-ran");
  writeFileSync(join(repo, ".gitattributes"), "*.py filter=evil\n*.bin filter=lfs\n");
  mkdirSync(join(repo, "tally"));
  writeFileSync(join(repo, "tally", "cli.py"), "print('tally')\n");
  writeFileSync(join(repo, "run.sh"), "#!/bin/sh\necho run\n", { mode: 0o755 });
  writeFileSync(join(repo, "big.bin"), "version https://git-lfs.github.com/spec/v1\noid sha256:00\nsize 1\n");
  symlinkSync("tally/cli.py", join(repo, "entry.py"));
  git("add", "-A");
  git("commit", "-q", "-m", "tally");
  const evil = join(dir, "evil.sh");
  writeFileSync(evil, `#!/bin/sh\ntouch "${marker}"\ncat\n`, { mode: 0o755 });
  writeFileSync(join(repo, ".git", "hostile.cfg"), `[filter "evil"]\n\tsmudge = ${evil}\n\tclean = cat\n`);
  git("config", "--local", "include.path", "hostile.cfg");
  const smudge = join(dir, "lfs-smudge.sh");
  writeFileSync(smudge, `#!/bin/sh\ntouch "${lfsSeen}"\ncat\n`, { mode: 0o755 });
  writeFileSync(join(dir, ".gitconfig"), `[filter "lfs"]\n\tsmudge = ${smudge}\n\tclean = cat\n`);
  return { marker, lfsSeen, commit: git("rev-parse", "HEAD") };
}

describe("a snapshot of a commit (SR-2, INT-F3)", () => {
  it("writes the commit's files as it holds them, and runs no filter, smudge or git-lfs of any config; a checkout runs them", () => {
    const { marker, lfsSeen, commit } = hostileRepository();
    // What the import's start used to check finds no filter: the include hides it (exit 1, no match).
    expect(spawnSync("git", ["-C", repo, "config", "--local", "--name-only", "--get-regexp", "^filter\\."]).status).toBe(1);
    const ws = new WorkspaceManager(join(dir, "worktrees"));
    const snap = ws.snapshot({ repoPath: repo, projectId: "p", attemptId: "import-1-checks", commit });
    expect(snap.base).toBe(commit);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(lfsSeen)).toBe(false);
    expect(readFileSync(join(snap.path, "tally", "cli.py"), "utf8")).toBe("print('tally')\n");
    expect(readFileSync(join(snap.path, "big.bin"), "utf8")).toBe("version https://git-lfs.github.com/spec/v1\noid sha256:00\nsize 1\n");
    expect(statSync(join(snap.path, "run.sh")).mode & 0o111).not.toBe(0);
    expect(statSync(join(snap.path, "tally", "cli.py")).mode & 0o111).toBe(0);
    expect(lstatSync(join(snap.path, "entry.py")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(snap.path, "entry.py"))).toBe("tally/cli.py");
    expect(existsSync(join(snap.path, ".git"))).toBe(false);
    ws.remove(repo, snap.path);
    expect(existsSync(snap.path)).toBe(false);
    // The control: a checkout of the same commit runs the repository's filter, and git-lfs's smudge.
    ws.prepare({ repoPath: repo, projectId: "p", attemptId: "a-checkout", taskId: "T", stepId: "s", access: "read", baseRef: commit });
    expect(existsSync(marker)).toBe(true);
    expect(existsSync(lfsSeen)).toBe(true);
  });

  it("is pinned to the commit it is given: a commit the repository does not have is refused", () => {
    writeFileSync(join(repo, "a.txt"), "a\n");
    git("add", "-A");
    git("commit", "-q", "-m", "one");
    const ws = new WorkspaceManager(join(dir, "worktrees"));
    expect(() => ws.snapshot({ repoPath: repo, projectId: "p", attemptId: "x", commit: "f".repeat(40) })).toThrow();
    expect(existsSync(ws.pathFor(repo, "x", "p"))).toBe(false);
  });

  it("refuses a commit that names one path twice, in another case, or a file under a link", () => {
    const outside = join(dir, "outside");
    mkdirSync(outside);
    const blob = (text: string) => execFileSync("git", ["-C", repo, "hash-object", "-w", "--stdin"], { input: text, encoding: "utf8" }).trim();
    const tree = (rows: string[]) => execFileSync("git", ["-C", repo, "mktree", "--missing"], { input: rows.join("\n") + "\n", encoding: "utf8" }).trim();
    // "a" is a link out of the folder; "A" is a folder with a file: on a file system that ignores case, the same name.
    const inner = tree([`100644 blob ${blob("x\n")}\tx`]);
    const root = tree([`040000 tree ${inner}\tA`, `120000 blob ${blob(outside)}\ta`]);
    const commit = execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit-tree", root, "-m", "hostile"], { encoding: "utf8" }).trim();
    git("update-ref", "refs/heads/main", commit);
    const ws = new WorkspaceManager(join(dir, "worktrees"));
    expect(() => ws.snapshot({ repoPath: repo, projectId: "p", attemptId: "y", commit })).toThrow(/names "a" twice, or a file and a folder alike/);
    expect(existsSync(join(outside, "x"))).toBe(false);
    expect(existsSync(ws.pathFor(repo, "y", "p"))).toBe(false);
  });

  it("counts submodules and links in its caps, refuses a path too deep, and reads the files a batch at a time (SR-4)", () => {
    const blob = (text: string) => execFileSync("git", ["-C", repo, "hash-object", "-w", "--stdin"], { input: text, encoding: "utf8" }).trim();
    const tree = (rows: string[]) => execFileSync("git", ["-C", repo, "mktree", "--missing"], { input: rows.join("\n") + "\n", encoding: "utf8" }).trim();
    const commitOf = (root: string) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit-tree", root, "-m", "c"], { encoding: "utf8" }).trim();
    git("commit", "-q", "--allow-empty", "-m", "first");
    const ws = new WorkspaceManager(join(dir, "worktrees"));
    const caps = { ...SNAPSHOT_CAPS };
    try {
      // One file and three submodules: four paths.
      const gitlinks = commitOf(tree([`100644 blob ${blob("a\n")}\ta.txt`, ...["s1", "s2", "s3"].map((s) => `160000 commit ${"1".repeat(40)}\t${s}`)]));
      SNAPSHOT_CAPS.files = 3;
      expect(() => ws.snapshot({ repoPath: repo, projectId: "p", attemptId: "g", commit: gitlinks })).toThrow(/more than 3 files/);
      SNAPSHOT_CAPS.files = 4;
      expect(existsSync(join(ws.snapshot({ repoPath: repo, projectId: "p", attemptId: "g2", commit: gitlinks }).path, "s3"))).toBe(true);
      // A file with 64 folders above it is written; with 65, the commit is refused (L1).
      let deep = tree([`100644 blob ${blob("x\n")}\tx`]);
      for (let i = 0; i < 64; i++) deep = tree([`040000 tree ${deep}\td`]);
      expect(existsSync(join(ws.snapshot({ repoPath: repo, projectId: "p", attemptId: "d64", commit: commitOf(deep) }).path, ...Array(64).fill("d"), "x"))).toBe(true);
      deep = tree([`040000 tree ${deep}\td`]);
      expect(() => ws.snapshot({ repoPath: repo, projectId: "p", attemptId: "d", commit: commitOf(deep) })).toThrow("the commit has a file with more than 64 folders above it");
      expect(existsSync(ws.pathFor(repo, "d", "p"))).toBe(false);
      // Batches of at most 4 bytes (or one larger file): every file still has its own bytes.
      SNAPSHOT_CAPS.batch = 4;
      const many = commitOf(tree([`100644 blob ${blob("one\n")}\t1.txt`, `100644 blob ${blob("two\n")}\t2.txt`, `100644 blob ${blob("a longer file\n")}\t3.txt`, `120000 blob ${blob("1.txt")}\tl`]));
      const snap = ws.snapshot({ repoPath: repo, projectId: "p", attemptId: "b", commit: many });
      expect(["1.txt", "2.txt", "3.txt", "l"].map((f) => readFileSync(join(snap.path, f), "utf8"))).toEqual(["one\n", "two\n", "a longer file\n", "one\n"]);
      expect(readlinkSync(join(snap.path, "l"))).toBe("1.txt");
    } finally {
      Object.assign(SNAPSHOT_CAPS, caps);
    }
  });

  it("refuses a partial clone, and runs none of its remote's commands; a missing file fails closed (SR-3)", () => {
    const { repo: partial, marker, commit } = hostilePartialClone(dir);
    const ws = new WorkspaceManager(join(dir, "worktrees"));
    expect(() => ws.snapshot({ repoPath: partial, projectId: "p", attemptId: "z", commit })).toThrow(/partial clone/);
    expect(existsSync(marker)).toBe(false);
    // Without the promisor config, the missing file is still never fetched: the snapshot stops.
    execFileSync("git", ["-C", partial, "config", "--unset", "extensions.partialClone"]);
    execFileSync("git", ["-C", partial, "config", "--unset", "remote.origin.promisor"]);
    // git 2.17 to 2.26 marked a partial clone with core.partialClone only (S3-1): it is refused too.
    execFileSync("git", ["-C", partial, "config", "core.partialClone", "origin"]);
    expect(() => ws.snapshot({ repoPath: partial, projectId: "p", attemptId: "z1", commit })).toThrow(/partial clone/);
    expect(existsSync(marker)).toBe(false);
    execFileSync("git", ["-C", partial, "config", "--unset", "core.partialClone"]);
    expect(() => ws.snapshot({ repoPath: partial, projectId: "p", attemptId: "z2", commit })).toThrow(/could not read the files/);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(ws.pathFor(partial, "z2", "p"))).toBe(false);
  });

  it("reads no file of a partial clone, even with a git that ignores GIT_NO_LAZY_FETCH (git older than 2.45; SR-5)", () => {
    const { repo: partial, marker, commit } = hostilePartialClone(dir);
    // A git that drops GIT_NO_LAZY_FETCH, as git before 2.45 ignores it.
    const oldGit = join(dir, "old-git");
    writeFileSync(oldGit, '#!/bin/sh\nunset GIT_NO_LAZY_FETCH\nexec git "$@"\n', { mode: 0o755 });
    const ws = new WorkspaceManager(join(dir, "worktrees"), oldGit);
    // The devcontainer, the conventions and the screens' reads all go through readFileAt.
    // Its missing blob is not fetched: the remote's command never runs.
    expect(ws.readFileAt({ repoPath: partial, ref: commit, path: "src/app.js" })).toBeUndefined();
    expect(existsSync(marker)).toBe(false);
    // And no file of it is read, though its README is there.
    expect(ws.readFileAt({ repoPath: partial, ref: commit, path: "README.md" })).toBeUndefined();
    // A full clone is read as before.
    writeFileSync(join(repo, "a.txt"), "a\n");
    git("add", "-A");
    git("commit", "-q", "-m", "a");
    expect(ws.readFileAt({ repoPath: repo, ref: "HEAD", path: "a.txt" })?.text).toBe("a\n");
  });
});
