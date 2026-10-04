// The service's own git calls tell git-lfs not to download or run anything at checkout (ORC-032, U2-F3): a repository
// the import reads may be someone else's, and a global git-lfs follows the repository's own `.lfsconfig`. The test
// stands a small filter named "lfs" in for git-lfs, in a global config, and reads what it saw at the checkout.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { WorkspaceManager } from "./workspaces";

let dir: string;
let home: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orc-lfs-"));
  home = process.env.HOME;
});

afterEach(() => {
  process.env.HOME = home;
  rmSync(dir, { recursive: true, force: true });
});

it("a checkout tells git-lfs to skip its smudge: the lfs filter sees GIT_LFS_SKIP_SMUDGE=1", () => {
  const repo = join(dir, "repo");
  const seen = join(dir, "seen");
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgSign=false", ...args], { stdio: "ignore" });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, ".gitattributes"), "*.bin filter=lfs\n");
  writeFileSync(join(repo, "a.bin"), "pointer\n");
  git("add", "-A");
  git("commit", "-q", "-m", "one");
  // The stand-in for a global git-lfs: its smudge writes down the variable it was given, and passes the file through.
  const smudge = join(dir, "smudge.sh");
  writeFileSync(smudge, `#!/bin/sh\nprintf %s "\${GIT_LFS_SKIP_SMUDGE:-unset}" > "${seen}"\ncat\n`, { mode: 0o755 });
  process.env.HOME = dir;
  writeFileSync(join(dir, ".gitconfig"), `[filter "lfs"]\n\tsmudge = ${smudge}\n\tclean = cat\n`);

  const ws = new WorkspaceManager(join(dir, "worktrees")).prepare({ repoPath: repo, attemptId: "a1", taskId: "IMPORT", stepId: "checks", access: "read", baseRef: "HEAD" });

  expect(readFileSync(join(ws.path, "a.bin"), "utf8")).toBe("pointer\n");
  expect(readFileSync(seen, "utf8")).toBe("1");
});
