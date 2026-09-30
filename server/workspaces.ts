// Isolated git worktrees for real runs. Every attempt gets its own worktree in the Orchestration data
// directory, never inside the managed repository's working tree:
//   - writers get a new branch orchestration/<task>/<step>/<attempt> based on their input change
//     (or the repository's HEAD);
//   - everyone else gets a detached worktree at the same base, read-only by runtime policy.
// After a writer finishes, the service (not the agent) commits the worktree; the commit becomes the
// step's code-change artifact. Nothing is merged into the user's branches.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";

export interface RepoCheck {
  ok: boolean;
  /** Present when ok. */
  head?: string;
  branch?: string;
  /** Actionable explanation when not ok. */
  reason?: string;
}

export interface PreparedWorkspace {
  path: string;
  base: string;
  branch?: string;
  /** The worktree's git directory, recorded at creation; all later git calls use it explicitly. */
  gitDir: string;
  /** Exact contents of the worktree's `.git` file at creation (it must not change). */
  gitFile: string;
}

export interface CommitResult {
  sha: string;
  branch?: string;
  changed: boolean;
  /** e.g. "3 files changed, 42 insertions(+), 6 deletions(-)" */
  diffstat: string;
  /** Files changed relative to the base (at most 20). */
  files: string[];
}

/**
 * Environment for the service's own git calls: no inherited GIT_* variables (GIT_DIR, GIT_WORK_TREE,
 * GIT_CONFIG_* …) that could redirect them, and no prompts.
 */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_")) env[k] = v;
  return { ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1" };
}

export class WorkspaceManager {
  readonly root: string;
  private readonly gitBin: string;

  constructor(root: string, gitBin = "git") {
    this.root = resolve(root);
    this.gitBin = gitBin;
  }

  /**
   * Run git for the service. Hooks and fsmonitor are disabled for every call: worktree contents are
   * agent-controlled, and the service must never execute code an agent wrote or configured.
   */
  private run(args: string[]): string {
    const noHooks = join(this.root, ".no-hooks");
    mkdirSync(noHooks, { recursive: true });
    const safe = ["-c", `core.hooksPath=${noHooks}`, "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "commit.gpgSign=false"];
    return execFileSync(this.gitBin, [...safe, ...args], { encoding: "utf8", env: gitEnv(), stdio: ["ignore", "pipe", "pipe"] }).trim();
  }

  private git(cwd: string, args: string[]): string {
    return this.run(["-C", cwd, ...args]);
  }

  /** Git against a prepared worktree, using its recorded git directory, never one discovered from the tree. */
  private wt(ws: { path: string; gitDir: string; gitFile: string }, args: string[]): string {
    this.assertUntouched(ws);
    return this.run(["--git-dir", ws.gitDir, "--work-tree", ws.path, ...args]);
  }

  /** The worktree's `.git` file must be exactly what `git worktree add` wrote. */
  private assertUntouched(ws: { path: string; gitFile: string }) {
    const f = join(ws.path, ".git");
    let ok = false;
    try {
      ok = lstatSync(f).isFile() && readFileSync(f, "utf8") === ws.gitFile;
    } catch {
      ok = false;
    }
    if (!ok) throw new Error("The run modified the workspace's git metadata (.git); its changes were not recorded.");
  }

  /** Is this a usable repository with at least one commit? */
  check(repoPath: string): RepoCheck {
    // Never fall back to the current directory: an empty or relative path would silently point
    // workers at whatever directory the service was started from.
    if (!repoPath.trim()) return { ok: false, reason: "No repository is configured. Set one in Settings → Project." };
    const expanded = repoPath.trim().replace(/^~(?=\/|$)/, process.env.HOME ?? "~");
    if (!isAbsolute(expanded)) return { ok: false, reason: `Use an absolute repository path (got "${repoPath}").` };
    const repo = resolve(expanded);
    if (!existsSync(repo)) return { ok: false, reason: `Repository path ${repo} does not exist.` };
    try {
      this.git(repo, ["rev-parse", "--is-inside-work-tree"]);
    } catch {
      return { ok: false, reason: `${repo} is not a git repository. Run \`git init\` and make a first commit.` };
    }
    try {
      const head = this.git(repo, ["rev-parse", "--verify", "HEAD"]);
      let branch = "(detached)";
      try {
        branch = this.git(repo, ["symbolic-ref", "--short", "HEAD"]);
      } catch {
        /* detached HEAD */
      }
      return { ok: true, head, branch };
    } catch {
      return { ok: false, reason: `${repo} has no commits yet. Make a first commit so workers have a base.` };
    }
  }

  /** Where an attempt's worktree lives (recorded in the run snapshot before it exists). */
  pathFor(repoPath: string, attemptId: string, projectId = "default"): string {
    const repo = resolve(repoPath.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
    const slug = `${basename(repo).replace(/[^A-Za-z0-9._-]/g, "_")}-${createHash("sha256").update(repo).digest("hex").slice(0, 8)}`;
    return join(this.root, slug, projectId.replace(/[^A-Za-z0-9._-]/g, "_"), attemptId);
  }

  branchFor(taskId: string, stepId: string, attemptId: string, projectId = "default"): string {
    return `orchestration/${projectId.replace(/[^A-Za-z0-9._-]/g, "_")}/${taskId}/${stepId}/${attemptId}`;
  }

  /** Create the worktree. `baseRef` is a commit to start from (an input change), else HEAD. */
  prepare(opts: { repoPath: string; projectId?: string; attemptId: string; taskId: string; stepId: string; access: "write" | "read"; baseRef?: string }): PreparedWorkspace {
    const check = this.check(opts.repoPath);
    if (!check.ok) throw new Error(check.reason);
    const repo = resolve(opts.repoPath.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
    const path = this.pathFor(opts.repoPath, opts.attemptId, opts.projectId);
    if (existsSync(path)) throw new Error(`Workspace ${path} already exists; refusing to reuse another run's files.`);
    mkdirSync(join(path, ".."), { recursive: true });
    const base = opts.baseRef ? this.git(repo, ["rev-parse", "--verify", `${opts.baseRef}^{commit}`]) : check.head!;
    let branch: string | undefined;
    if (opts.access === "write") {
      branch = this.branchFor(opts.taskId, opts.stepId, opts.attemptId, opts.projectId);
      this.git(repo, ["worktree", "add", "-b", branch, path, base]);
    } else {
      this.git(repo, ["worktree", "add", "--detach", path, base]);
    }
    const gitDir = this.git(path, ["rev-parse", "--absolute-git-dir"]);
    const gitFile = readFileSync(join(path, ".git"), "utf8");
    return { path, base, branch, gitDir, gitFile };
  }

  /** Commit everything a writer changed. Hooks are skipped: they are not part of the agent's work. */
  commit(ws: PreparedWorkspace & { message: string }): CommitResult {
    const { base } = ws;
    this.wt(ws, ["add", "-A"]);
    let changed = true;
    try {
      this.wt(ws, ["diff", "--cached", "--quiet"]);
      changed = false;
    } catch (e) {
      if (e instanceof Error && e.message.includes("git metadata")) throw e;
      /* non-zero exit: there are staged changes */
    }
    if (changed) {
      this.wt(ws, ["-c", "user.name=Orchestration", "-c", "user.email=orchestration@localhost", "commit", "--no-verify", "-q", "-m", ws.message]);
    }
    const sha = this.wt(ws, ["rev-parse", "HEAD"]);
    let branch: string | undefined;
    try {
      branch = this.wt(ws, ["symbolic-ref", "--short", "HEAD"]);
    } catch {
      branch = undefined;
    }
    const stat = changed ? this.wt(ws, ["diff", "--shortstat", base, sha]) : "";
    const files = changed ? this.wt(ws, ["diff", "--name-only", base, sha]).split("\n").filter(Boolean).slice(0, 20) : [];
    return { sha, branch, changed, diffstat: stat || "no changes", files };
  }

  /** Files a read-only run left modified (should be none). */
  dirtyFiles(ws: PreparedWorkspace): string[] {
    try {
      return this.wt(ws, ["status", "--porcelain"]).split("\n").filter(Boolean).slice(0, 20);
    } catch (e) {
      return [e instanceof Error && e.message.includes("git metadata") ? ".git (modified)" : "(status unavailable)"];
    }
  }
}
