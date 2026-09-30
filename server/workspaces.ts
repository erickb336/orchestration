// Isolated git worktrees for real runs. Every attempt gets its own worktree in the Orchestration data
// directory, never inside the managed repository's working tree:
//   - writers get a new branch orchestration/<task>/<step>/<attempt> based on their input change
//     (or the repository's HEAD);
//   - everyone else gets a detached worktree at the same base, read-only by runtime policy.
// After a writer finishes, the service (not the agent) commits the worktree; the commit becomes the
// step's code-change artifact. Only the opt-in delivery (see deliver) ever updates a user branch.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { basename, isAbsolute, join, resolve, sep } from "node:path";

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
  /** Present when the service prepared a merge or revert in the worktree before the run started. */
  seed?: PreparedSeed;
}

/**
 * Work the service prepares in a writer's worktree before the run starts, left uncommitted:
 * a merge of `ref`, or a revert of `commit`. Conflicts are expected; the coder resolves them.
 */
export type WorkspaceSeed = { kind: "merge"; ref: string } | { kind: "revert"; commit: string };

export interface PreparedSeed {
  kind: WorkspaceSeed["kind"];
  /** The full commit that was merged or reverted. */
  commit: string;
  /** Files left with conflicts (at most 20). They must not contain conflict markers when recorded. */
  conflicted: string[];
}

/** Largest diff returned to the changes viewer. */
export const MAX_CHANGE_DIFF_BYTES = 512 * 1024;

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

  private safeFlags(): string[] {
    const noHooks = join(this.root, ".no-hooks");
    mkdirSync(noHooks, { recursive: true });
    return ["-c", `core.hooksPath=${noHooks}`, "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "commit.gpgSign=false"];
  }

  /**
   * Run git for the service. Hooks and fsmonitor are disabled for every call: worktree contents are
   * agent-controlled, and the service must never execute code an agent wrote or configured.
   */
  private run(args: string[]): string {
    try {
      return execFileSync(this.gitBin, [...this.safeFlags(), ...args], { encoding: "utf8", env: gitEnv(), stdio: ["ignore", "pipe", "pipe"] }).trim();
    } catch (e) {
      // Report git's own reason (stderr), not the command line with local paths.
      const stderr = (e as { stderr?: Buffer | string }).stderr;
      const reason = (stderr ? String(stderr) : e instanceof Error ? e.message : String(e)).trim().split("\n").filter(Boolean).slice(-2).join(" ");
      throw new Error(reason || "git failed");
    }
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

  /**
   * Create the worktree. `baseRef` is a commit to start from (an input change), else HEAD. A writer's
   * worktree may be seeded with a prepared merge or revert (see WorkspaceSeed).
   */
  prepare(opts: { repoPath: string; projectId?: string; attemptId: string; taskId: string; stepId: string; access: "write" | "read"; baseRef?: string; seed?: WorkspaceSeed }): PreparedWorkspace {
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
    const ws: PreparedWorkspace = { path, base, branch, gitDir, gitFile };
    if (opts.seed && opts.access === "write") {
      try {
        ws.seed = this.applySeed(repo, ws, opts.seed);
      } catch (e) {
        // Never hand a half-prepared worktree to a run; its branch holds no work yet.
        this.remove(opts.repoPath, path);
        throw e;
      }
    }
    return ws;
  }

  /** Prepare a merge or a revert in a fresh writer worktree, as Orchestration, without committing. */
  private applySeed(repo: string, ws: PreparedWorkspace, seed: WorkspaceSeed): PreparedSeed {
    const target = seed.kind === "merge" ? seed.ref : seed.commit;
    let commit: string;
    try {
      commit = this.git(repo, ["rev-parse", "--verify", "--end-of-options", `${target}^{commit}`]);
    } catch {
      throw new Error(`commit ${target.slice(0, 12)} is no longer in the repository`);
    }
    const ident = ["-c", "user.name=Orchestration", "-c", "user.email=orchestration@localhost"];
    let args: string[];
    if (seed.kind === "merge") args = [...ident, "merge", "--no-ff", "--no-commit", commit];
    else {
      // Reverting something the base does not contain would produce an unrelated change.
      try {
        this.git(repo, ["merge-base", "--is-ancestor", commit, ws.base]);
      } catch {
        throw new Error(`cannot prepare the revert: the starting point (${ws.base.slice(0, 12)}) does not contain ${commit.slice(0, 12)}`);
      }
      // A merge commit is reverted against its first parent (the branch it was merged into).
      const parents = this.git(repo, ["rev-list", "--parents", "-n", "1", commit]).split(" ").length - 1;
      args = [...ident, "revert", "--no-commit", ...(parents > 1 ? ["-m", "1"] : []), commit];
    }
    let failure: string | undefined;
    try {
      this.wt(ws, args);
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
    }
    const conflicted = this.wt(ws, ["diff", "--name-only", "--diff-filter=U"]).split("\n").filter(Boolean);
    // A non-zero exit that leaves conflicts is expected; anything else means nothing was prepared.
    if (failure && conflicted.length === 0) throw new Error(`could not prepare the ${seed.kind}: ${failure}`);
    return { kind: seed.kind, commit, conflicted: conflicted.slice(0, 20) };
  }

  /** Commit everything a writer changed. Hooks are skipped: they are not part of the agent's work. */
  commit(ws: PreparedWorkspace & { message: string }): CommitResult {
    const { base } = ws;
    this.wt(ws, ["add", "-A"]);
    if (ws.seed?.conflicted.length) {
      // Marker guard: a prepared merge or revert is recorded only once its conflicts are resolved.
      let marked: string[] = [];
      try {
        marked = this.wt(ws, ["grep", "--cached", "-l", "-E", "^(<<<<<<<|>>>>>>>) ", "--", ...ws.seed.conflicted]).split("\n").filter(Boolean);
      } catch (e) {
        if (e instanceof Error && e.message.includes("git metadata")) throw e;
        /* non-zero exit: no markers left */
      }
      if (marked.length) throw new Error(`unresolved conflict markers in ${marked.join(", ")}`);
    }
    let changed = true;
    try {
      this.wt(ws, ["diff", "--cached", "--quiet"]);
      changed = false;
    } catch (e) {
      if (e instanceof Error && e.message.includes("git metadata")) throw e;
      /* non-zero exit: there are staged changes */
    }
    // A prepared merge is concluded (two parents) even when it changed no file.
    if (changed || (ws.seed?.kind === "merge" && existsSync(join(ws.gitDir, "MERGE_HEAD")))) {
      this.wt(ws, ["-c", "user.name=Orchestration", "-c", "user.email=orchestration@localhost", "commit", "--no-verify", "-q", "-m", ws.message]);
      changed = true;
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

  integrationBranch(projectId: string): string {
    return `orchestration/${projectId.replace(/[^A-Za-z0-9._-]/g, "_")}/integration`;
  }

  /**
   * Merge a finished task's commit into the project's integration branch, serially, in a service-only
   * worktree. The integration branch starts from the repository's HEAD the first time; the user's own
   * branches are never touched. A conflict aborts the merge and reports the conflicted files.
   */
  integrate(opts: { repoPath: string; projectId: string; sha: string; message: string; baseBranch?: string }): { status: "integrated"; ref: string; sha: string } | { status: "conflict"; message: string } {
    const check = this.check(opts.repoPath);
    if (!check.ok) throw new Error(check.reason);
    const repo = resolve(opts.repoPath.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
    const branch = this.integrationBranch(opts.projectId);
    const path = this.pathFor(opts.repoPath, "integration", opts.projectId);
    if (!existsSync(path)) {
      mkdirSync(join(path, ".."), { recursive: true });
      this.git(repo, ["worktree", "prune"]); // forget a registration whose directory was removed
      let exists = true;
      try {
        this.git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`]);
      } catch {
        exists = false;
      }
      // With delivery on, the integration branch starts from the delivery branch, never from
      // whatever happens to be checked out (which could carry unrelated, unfinished work).
      const start = opts.baseBranch ? this.git(repo, ["rev-parse", "--verify", "--end-of-options", `refs/heads/${opts.baseBranch}^{commit}`]) : check.head!;
      try {
        if (exists) this.git(repo, ["worktree", "add", path, branch]);
        else this.git(repo, ["worktree", "add", "-b", branch, path, start]);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/already (checked out|used by worktree)/.test(msg)) throw new Error(`${branch} is checked out somewhere else; switch that checkout to another branch`);
        throw new Error("could not prepare the integration workspace");
      }
    }
    const ws = { path, gitDir: this.git(path, ["rev-parse", "--absolute-git-dir"]), gitFile: readFileSync(join(path, ".git"), "utf8") };
    const ident = ["-c", "user.name=Orchestration", "-c", "user.email=orchestration@localhost"];
    // Start from a clean state: an interrupted earlier merge must not fail the next task.
    try {
      this.wt(ws, ["merge", "--abort"]);
    } catch {
      /* no merge in progress */
    }
    this.wt(ws, ["reset", "--hard", "-q", "HEAD"]);
    this.wt(ws, ["clean", "-fdq"]);
    let full: string;
    try {
      full = this.git(repo, ["rev-parse", "--verify", "--end-of-options", `${opts.sha}^{commit}`]);
    } catch {
      throw new Error(`commit ${opts.sha.slice(0, 12)} is no longer in the repository`);
    }
    try {
      this.wt(ws, [...ident, "merge", "--no-ff", "--no-edit", "-m", opts.message, full]);
    } catch {
      let files: string[] = [];
      try {
        files = this.wt(ws, ["diff", "--name-only", "--diff-filter=U"]).split("\n").filter(Boolean).slice(0, 20);
      } catch {
        /* no conflict listing available */
      }
      try {
        this.wt(ws, ["merge", "--abort"]);
      } catch {
        this.wt(ws, ["reset", "--hard", "HEAD"]);
      }
      return { status: "conflict", message: files.length ? `conflicts in ${files.join(", ")}` : `merging ${opts.sha.slice(0, 12)} failed` };
    }
    const head = this.wt(ws, ["rev-parse", "HEAD"]);
    return { status: "integrated", ref: `${head.slice(0, 12)} on ${branch}`, sha: head };
  }

  /**
   * What one commit changed relative to its first parent, for the changes viewer: a stat and a patch,
   * cut at MAX_CHANGE_DIFF_BYTES. Read-only. Undefined when the commit (or its parent) is not in the
   * repository.
   */
  changeDiff(opts: { repoPath: string; commit: string }): { diff: string; truncated: boolean } | undefined {
    if (!/^[0-9a-f]{40,64}$/.test(opts.commit)) return undefined;
    if (!this.check(opts.repoPath).ok) return undefined;
    const repo = resolve(opts.repoPath.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
    try {
      this.git(repo, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${opts.commit}^{commit}`]);
      this.git(repo, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${opts.commit}^1^{commit}`]);
    } catch {
      return undefined;
    }
    const args = [...this.safeFlags(), "-C", repo, "diff", "--no-color", "--no-ext-diff", "--no-textconv", "-M", "--stat", "--patch", `${opts.commit}^1`, opts.commit];
    // Output past the cap is dropped by the buffer limit (ENOBUFS); what arrived is returned as truncated.
    const r = spawnSync(this.gitBin, args, { env: gitEnv(), stdio: ["ignore", "pipe", "pipe"], maxBuffer: MAX_CHANGE_DIFF_BYTES + 4096 });
    const over = (r.error as NodeJS.ErrnoException | undefined)?.code === "ENOBUFS";
    if (!over && (r.error || r.status !== 0)) throw new Error("the changes could not be read");
    const out = r.stdout ?? Buffer.alloc(0);
    if (!over && out.length <= MAX_CHANGE_DIFF_BYTES) return { diff: out.toString("utf8"), truncated: false };
    // Cut at a line boundary inside the cap.
    const cut = out.subarray(0, MAX_CHANGE_DIFF_BYTES);
    const nl = cut.lastIndexOf(10);
    return { diff: cut.subarray(0, nl > 0 ? nl + 1 : cut.length).toString("utf8"), truncated: true };
  }

  /**
   * Deliver the integration branch to one of the user's branches. Delivery only ever ADDS commits
   * made by Orchestration on top of the branch as it is now, by fast-forward:
   *   - the user's branch is first merged into the integration branch (service-only worktree);
   *   - every commit it would add must be authored by Orchestration, so nothing from another branch
   *     or from history the user removed can reach it;
   *   - if the branch no longer contains what was delivered before (reset or rewritten), automatic
   *     delivery stops and asks the user;
   *   - a checkout that has the branch open is fast-forwarded in place only when it is clean, has no
   *     rebase/merge/bisect in progress, and no file the delivery adds already exists there (ignored
   *     files included); otherwise the branch ref is moved with a compare-and-swap.
   */
  deliver(opts: { repoPath: string; projectId: string; branch: string; lastDelivered?: string }): {
    status: "delivered" | "skipped" | "conflict" | "blocked";
    message: string;
    sha?: string;
  } {
    const check = this.check(opts.repoPath);
    if (!check.ok) return { status: "skipped", message: check.reason! };
    const repo = resolve(opts.repoPath.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
    const integration = this.integrationBranch(opts.projectId);
    const path = this.pathFor(opts.repoPath, "integration", opts.projectId);
    if (!existsSync(path)) return { status: "skipped", message: "Nothing has been integrated yet." };
    const target = opts.branch;
    let targetSha: string;
    try {
      targetSha = this.git(repo, ["rev-parse", "--verify", "--end-of-options", `refs/heads/${target}^{commit}`]);
    } catch {
      return { status: "skipped", message: `Branch ${target} does not exist in the repository.` };
    }
    const isAncestor = (a: string, b: string) => {
      try {
        this.git(repo, ["merge-base", "--is-ancestor", a, b]);
        return true;
      } catch {
        return false;
      }
    };
    if (opts.lastDelivered && !isAncestor(opts.lastDelivered, targetSha)) {
      return {
        status: "blocked",
        message: `${target} no longer contains work delivered earlier (it was reset or rewritten). Automatic delivery is paused so nothing you removed comes back; decide what ${integration} should contain, then turn delivery on again.`,
      };
    }

    // Where is the target checked out, and is a rebase of it in progress anywhere?
    const checkouts: string[] = [];
    for (const block of this.git(repo, ["worktree", "list", "--porcelain"]).split("\n\n")) {
      const wtPath = /^worktree (.+)$/m.exec(block)?.[1];
      if (!wtPath) continue;
      if (block.split("\n").includes(`branch refs/heads/${target}`)) checkouts.push(wtPath);
      for (const f of ["rebase-merge/head-name", "rebase-apply/head-name"]) {
        try {
          const p = this.git(wtPath, ["rev-parse", "--git-path", f]);
          const abs = isAbsolute(p) ? p : join(wtPath, p);
          if (existsSync(abs) && readFileSync(abs, "utf8").trim() === `refs/heads/${target}`) {
            return { status: "skipped", message: `A rebase of ${target} is in progress in ${wtPath}; delivery waits until it finishes.` };
          }
        } catch {
          /* not a readable worktree */
        }
      }
    }
    const inProgress = (wtPath: string) =>
      ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-merge", "rebase-apply"].some((f) => {
        try {
          const p = this.git(wtPath, ["rev-parse", "--git-path", f]);
          return existsSync(isAbsolute(p) ? p : join(wtPath, p));
        } catch {
          return false;
        }
      });

    // 1. Bring the user's latest work into the integration branch (service-only worktree).
    const ws = { path, gitDir: this.git(path, ["rev-parse", "--absolute-git-dir"]), gitFile: readFileSync(join(path, ".git"), "utf8") };
    const ident = ["-c", "user.name=Orchestration", "-c", "user.email=orchestration@localhost"];
    if (!isAncestor(targetSha, this.wt(ws, ["rev-parse", "HEAD"]))) {
      try {
        this.wt(ws, [...ident, "merge", "--no-ff", "--no-edit", "-m", `Merge ${target} into ${integration}`, targetSha]);
      } catch {
        let files: string[] = [];
        try {
          files = this.wt(ws, ["diff", "--name-only", "--diff-filter=U"]).split("\n").filter(Boolean).slice(0, 20);
        } catch {
          /* ignore */
        }
        try {
          this.wt(ws, ["merge", "--abort"]);
        } catch {
          this.wt(ws, ["reset", "--hard", "-q", "HEAD"]);
        }
        return { status: "conflict", message: `${target} has changes that conflict with integrated work${files.length ? ` (${files.join(", ")})` : ""}; nothing was delivered.` };
      }
    }
    const newSha = this.wt(ws, ["rev-parse", "HEAD"]);
    if (newSha === targetSha) return { status: "delivered", message: `${target} already contains all integrated work.`, sha: newSha };

    // 2. Only Orchestration's own commits may be added to the user's branch.
    const foreign = this.git(repo, ["log", "--format=%an", `${targetSha}..${newSha}`])
      .split("\n")
      .filter((a) => a && a !== "Orchestration");
    if (foreign.length) {
      return {
        status: "blocked",
        message: `${integration} contains ${foreign.length} commit(s) not made by Orchestration (for example from another branch it started from); delivering would add them to ${target}. Automatic delivery is paused.`,
      };
    }

    // 3. Fast-forward: in the checkout that has the branch open, or by compare-and-swap.
    const added = this.git(repo, ["diff", "--name-only", "--diff-filter=A", targetSha, newSha]).split("\n").filter(Boolean);
    for (const wtPath of checkouts) {
      if (inProgress(wtPath)) return { status: "skipped", message: `A merge, rebase, or bisect is in progress in ${wtPath}; delivery waits.` };
      if (this.git(wtPath, ["status", "--porcelain", "--untracked-files=no"])) {
        return { status: "skipped", message: `${target} is checked out in ${wtPath} with uncommitted changes; delivery waits until it is clean.` };
      }
      const clash = added.find((f) => existsSync(join(wtPath, f)));
      if (clash) return { status: "skipped", message: `Delivery would overwrite ${clash} in ${wtPath}, which exists there but is not tracked; move it, then delivery continues.` };
      try {
        this.git(wtPath, ["merge", "--ff-only", newSha]);
      } catch (e) {
        return { status: "skipped", message: `Could not fast-forward ${target}: ${e instanceof Error ? e.message : String(e)}` };
      }
      return { status: "delivered", message: `${target} fast-forwarded to ${newSha.slice(0, 12)}.`, sha: newSha };
    }
    try {
      this.git(repo, ["update-ref", "-m", "orchestration: deliver", `refs/heads/${target}`, newSha, targetSha]);
    } catch (e) {
      return { status: "skipped", message: `${target} changed during delivery; it will be retried (${e instanceof Error ? e.message : String(e)}).` };
    }
    return { status: "delivered", message: `${target} fast-forwarded to ${newSha.slice(0, 12)}.`, sha: newSha };
  }

  /** Remove one run's worktree (and private temp dir). Its branch, if any, is kept. */
  remove(repoPath: string, path: string) {
    const repo = resolve(repoPath.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
    if (!resolve(path).startsWith(this.root + sep)) return;
    try {
      this.git(repo, ["worktree", "remove", "--force", path]);
    } catch {
      rmSync(path, { recursive: true, force: true });
    }
    rmSync(`${path}.tmp`, { recursive: true, force: true });
  }

  /** Remove worktrees (and private temp dirs) of runs that are no longer active. Branches are kept. */
  prune(opts: { repoPath: string; projectId: string; keep: Set<string> }): number {
    const check = this.check(opts.repoPath);
    if (!check.ok) return 0;
    const repo = resolve(opts.repoPath.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
    const dir = join(this.pathFor(opts.repoPath, "x", opts.projectId), "..");
    if (!existsSync(dir)) return 0;
    let removed = 0;
    for (const name of readdirSync(dir)) {
      const id = name.replace(/\.tmp$/, "");
      if (id === "integration" || opts.keep.has(id)) continue;
      const path = join(dir, name);
      if (name.endsWith(".tmp")) {
        rmSync(path, { recursive: true, force: true });
        continue;
      }
      // Never destroy work that exists only in a worktree (for example a run stopped at its time limit).
      let dirty = true;
      try {
        dirty = this.git(path, ["status", "--porcelain"]) !== "";
      } catch {
        dirty = false;
      }
      if (dirty) continue;
      try {
        this.git(repo, ["worktree", "remove", "--force", path]);
      } catch {
        rmSync(path, { recursive: true, force: true });
      }
      removed++;
    }
    try {
      this.git(repo, ["worktree", "prune"]);
    } catch {
      /* best effort */
    }
    return removed;
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
