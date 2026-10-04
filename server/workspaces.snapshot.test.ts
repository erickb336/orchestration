// The import reads an untrusted repository without a checkout (ORC-032, SR-2): `snapshot` writes a commit's files from
// git's object store. A hostile repository sets a filter through include.path (which `git config --local` never
// showed), and a global git-lfs stand-in follows `.gitattributes`: a checkout runs both on this computer, a snapshot
// runs neither.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceManager } from "./workspaces";

let dir: string;
let repo: string;
let home: string | undefined;
const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgSign=false", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" }).trim();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orc032-snapshot-"));
  repo = join(dir, "repo");
  home = process.env.HOME;
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
});
afterEach(() => {
  process.env.HOME = home;
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
  process.env.HOME = dir;
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
});
