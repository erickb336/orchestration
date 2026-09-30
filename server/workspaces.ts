// Isolated git worktrees for real runs. Every attempt gets its own worktree in the Orchestration data
// directory, never inside the managed repository's working tree:
//   - writers get a new branch orchestration/<task>/<step>/<attempt> based on their input change
//     (or the repository's HEAD);
//   - everyone else gets a detached worktree at the same base, read-only by runtime policy.
// After a writer finishes, the service (not the agent) commits the worktree; the commit becomes the
// step's code-change artifact. Only the opt-in delivery (see deliver) ever updates a user branch.

import { execFile, execFileSync, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { PR_BRANCH_REF, matchGlob, prBaseRef, prBranch } from "../src/domain/delivery";
import type { PrDelivery } from "../src/domain/types";
import { redact } from "./redact";

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
  /** Every file left with conflicts. None may contain a new conflict marker when the work is recorded. */
  conflicted: string[];
}

/** A task's final commit prepared as a pull-request head, or why it cannot be one. */
export type PrHeadResult = { status: "ready"; sha: string; baseSha: string; branch: string; changed: PrDelivery["changed"] } | { status: "conflict"; message: string };

const ORCHESTRATION_AUTHOR = "Orchestration\0orchestration@localhost";
/** A line git writes at the start or end of a conflict. */
const MARKER = /^(<<<<<<<|>>>>>>>) /;
/** Flags the app never passes to `git push`. */
const FORBIDDEN_PUSH = new Set(["--force", "-f", "--force-with-lease", "--force-if-includes", "--mirror", "--all", "--tags", "--delete", "-d", "--prune"]);
const NETWORK_TIMEOUT_MS = 120_000;
const NETWORK_MAX_BUFFER = 5 * 1024 * 1024;

/** Refuse, before anything is spawned, a push that could force, delete, or leave the app's own branch namespace. */
export function assertSafePush(args: string[]) {
  const i = args.indexOf("push");
  if (i < 0) throw new Error("not a push");
  const rest = args.slice(i + 1);
  for (const a of rest) if (FORBIDDEN_PUSH.has(a) || a.startsWith("--force") || a.startsWith("--delete") || a.startsWith("--mirror") || a === "--follow-tags" || a.startsWith("--recurse-submodules")) throw new Error(`refusing to run git push with ${a}`);
  // Nothing after the options may be read as one: the remote's name never starts with "-".
  const eoo = rest.indexOf("--end-of-options");
  const ALLOWED = new Set(["--porcelain", "--no-verify", "--no-follow-tags", "--no-recurse-submodules", "--quiet", "-q", "--end-of-options"]);
  for (const a of eoo >= 0 ? rest.slice(0, eoo) : rest) if (a.startsWith("-") && !ALLOWED.has(a)) throw new Error(`refusing to run git push with ${a}`);
  const positional = eoo >= 0 ? rest.slice(eoo + 1) : rest.filter((a) => !a.startsWith("-"));
  if (eoo >= 0 && positional.length !== 2) throw new Error("refusing to run git push with anything but a remote and one refspec");
  if (positional.some((a) => !a.includes(":") && !/^[A-Za-z0-9._][A-Za-z0-9._-]{0,99}$/.test(a))) throw new Error("refusing to run git push to a remote with that name");
  const refspecs = rest.filter((a) => a.includes(":"));
  if (refspecs.length !== 1) throw new Error("refusing to run git push without exactly one refspec");
  const [src, dst] = refspecs[0].split(":");
  if (src.startsWith("+") || !/^[0-9a-f]{40,64}$/.test(src)) throw new Error("refusing to push anything but one commit, without force");
  if (!PR_BRANCH_REF.test(dst)) throw new Error(`refusing to push to ${dst}: not one of the app's pull-request branches`);
}

/** Largest diff handed to a reviewer in its assignment. */
export const MAX_REVIEW_DIFF_BYTES = 60 * 1024;

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
export function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_")) env[k] = v;
  return { ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1" };
}

/**
 * Environment for a child that talks to the network (git fetch, ls-remote, push; gh). Debug variables
 * that could print credentials are removed and every prompt is disabled. A token variable the user
 * set passes through unread; the app never sets one.
 */
export function networkEnv(remoteUrl?: string): NodeJS.ProcessEnv {
  const env = gitEnv();
  for (const k of Object.keys(env)) if (k === "GH_DEBUG" || k === "GH_REPO" || k === "GH_HOST" || k === "DEBUG") delete env[k];
  Object.assign(env, { GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_SPINNER_DISABLED: "1", NO_COLOR: "1", GIT_TERMINAL_PROMPT: "0" });
  if (remoteUrl && (/^(ssh:\/\/|[^/@\s]+@[^:/\s]+:)/.test(remoteUrl))) env.GIT_SSH_COMMAND = "ssh -oBatchMode=yes";
  return env;
}

/** A push was refused because it would publish commits Orchestration did not author. */
export class ForeignCommitsError extends Error {
  authors: string[];
  constructor(authors: string[]) {
    super(`contains ${authors.length} commit(s) not made by Orchestrator (authors: ${[...new Set(authors)].slice(0, 5).join(", ")}); nothing was pushed`);
    this.name = "ForeignCommitsError";
    this.authors = authors;
  }
}

export class WorkspaceManager {
  readonly root: string;
  private readonly gitBin: string;
  private readonly children = new Set<ChildProcess>();

  /** How long the changes viewer's diff may run. */
  changeDiffTimeoutMs = 10_000;

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

  /** Like run(), for calls whose exit status is an answer: nothing is thrown for a non-zero exit. */
  private status(args: string[]): { status: number | null; stdout: string } {
    const r = spawnSync(this.gitBin, [...this.safeFlags(), ...args], { encoding: "utf8", env: gitEnv(), stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
    return { status: r.error ? null : r.status, stdout: r.stdout ?? "" };
  }

  /**
   * Git over the network (fetch, ls-remote, push): asynchronous, no shell, timed out, and killed by
   * abortNetwork(). The same safety flags and environment as run(). Errors carry git's own reason,
   * redacted.
   */
  private runAsync(args: string[], remoteUrl?: string): Promise<string> {
    return new Promise((resolveRun, reject) => {
      const child = execFile(
        this.gitBin,
        [...this.safeFlags(), ...args],
        { encoding: "utf8", env: networkEnv(remoteUrl), timeout: NETWORK_TIMEOUT_MS, maxBuffer: NETWORK_MAX_BUFFER, killSignal: "SIGTERM" },
        (err, stdout, stderr) => {
          this.children.delete(child);
          if (!err) return resolveRun(String(stdout).trim());
          const timedOut = (err as { killed?: boolean }).killed;
          const reason = redact(String(stderr || err.message)).trim().split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 300);
          reject(new Error(timedOut ? `git timed out or was stopped${reason ? `: ${reason}` : ""}` : reason || "git failed"));
        },
      );
      this.children.add(child);
    });
  }

  /** Stop every network operation in flight (the scheduler lost its lease or is shutting down). */
  abortNetwork() {
    for (const c of this.children) {
      c.kill("SIGTERM");
      const t = setTimeout(() => c.kill("SIGKILL"), 5000);
      t.unref();
      c.once("exit", () => clearTimeout(t));
    }
  }

  private repoDir(repoPath: string): string {
    return resolve(repoPath.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
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
    return { kind: seed.kind, commit, conflicted };
  }

  /** Commit everything a writer changed. Hooks are skipped: they are not part of the agent's work. */
  commit(ws: PreparedWorkspace & { message: string }): CommitResult {
    const { base } = ws;
    this.wt(ws, ["add", "-A"]);
    if (ws.seed?.conflicted.length) {
      // Marker guard: a prepared merge or revert is recorded only once its conflicts are resolved.
      const marked = ws.seed.conflicted.filter((f) => this.hasNewMarkers(ws, ws.seed!, f));
      if (marked.length) throw new Error(`unresolved conflict markers in ${marked.slice(0, 20).join(", ")}${marked.length > 20 ? ` and ${marked.length - 20} more` : ""}`);
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

  /** Conflict-marker lines of one file at a revision (":" is the index). Empty when the file is not there. */
  private markerLines(ws: PreparedWorkspace, rev: string, file: string): string[] {
    this.assertUntouched(ws);
    const at = ["--git-dir", ws.gitDir, "--work-tree", ws.path];
    // Is the file there at all? Only a successful listing that names nothing means "absent"; any
    // failure stops the recording instead of passing as clean.
    const listed = rev === "" ? this.status([...at, "ls-files", "--stage", "--", file]) : this.status([...at, "ls-tree", rev, "--", file]);
    if (listed.status !== 0) throw new Error(`could not check ${file} for conflict markers`);
    if (!listed.stdout.trim()) return [];
    const r = this.status([...at, "show", `${rev}:${file}`]);
    if (r.status !== 0) throw new Error(`could not check ${file} for conflict markers`);
    return r.stdout.split("\n").filter((l) => MARKER.test(l));
  }

  /**
   * Does a seeded file still hold a conflict marker the service's merge or revert wrote? Marker-like
   * lines the file already had (documentation that shows a conflict, for example) do not count: only
   * lines that were not in the base or in the merged or reverted commit.
   */
  private hasNewMarkers(ws: PreparedWorkspace, seed: PreparedSeed, file: string): boolean {
    const staged = this.markerLines(ws, "", file);
    if (staged.length === 0) return false;
    const known = new Map<string, number>();
    const parent = seed.kind === "revert" && this.status(["--git-dir", ws.gitDir, "rev-parse", "--verify", "--quiet", `${seed.commit}^`]).status === 0 ? [`${seed.commit}^`] : [];
    for (const rev of [ws.base, seed.commit, ...parent]) {
      // As many of each marker-like line as the fullest of these versions has, not their sum.
      const here = new Map<string, number>();
      for (const l of this.markerLines(ws, rev, file)) here.set(l, (here.get(l) ?? 0) + 1);
      for (const [l, n] of here) known.set(l, Math.max(known.get(l) ?? 0, n));
    }
    const count = new Map<string, number>();
    for (const l of staged) count.set(l, (count.get(l) ?? 0) + 1);
    return [...count].some(([l, n]) => n > (known.get(l) ?? 0));
  }

  integrationBranch(projectId: string): string {
    return `orchestration/${projectId.replace(/[^A-Za-z0-9._-]/g, "_")}/integration`;
  }

  /**
   * Merge a finished task's commit into the project's integration branch, serially, in a service-only
   * worktree. The integration branch starts from the repository's HEAD the first time; the user's own
   * branches are never touched. A conflict aborts the merge and reports the conflicted files.
   */
  integrate(opts: { repoPath: string; projectId: string; sha: string; message: string; baseBranch?: string; requireOwn?: boolean }):
    | { status: "integrated"; ref: string; sha: string }
    | { status: "conflict"; message: string }
    | { status: "not-needed" } {
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
    // Nothing of this task's own to merge: the run changed nothing, so its "change" is a commit the
    // integration branch already has, or only commits somebody else made. Reporting the branch tip as
    // this task's landed commit would point its review, and a revert, at other work.
    const before = this.wt(ws, ["rev-parse", "HEAD"]);
    if (this.status(["-C", repo, "merge-base", "--is-ancestor", full, before]).status === 0) return { status: "not-needed" };
    if (opts.requireOwn && !this.git(repo, ["log", "--format=%an%x00%ae", "--end-of-options", `${before}..${full}`]).split("\n").includes(ORCHESTRATION_AUTHOR)) return { status: "not-needed" };
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
    // The recorded commit is provably this task's: a new merge whose second parent is its final change.
    const parents = this.git(repo, ["rev-list", "--parents", "-n", "1", head]).split(" ");
    if (parents.length !== 3 || parents[1] !== before || parents[2] !== full) throw new Error("the integration merge did not produce this task's own merge commit");
    return { status: "integrated", ref: `${head.slice(0, 12)} on ${branch}`, sha: head };
  }

  /**
   * What one commit changed relative to its first parent, for the changes viewer: a stat and a patch,
   * cut at MAX_CHANGE_DIFF_BYTES. Read-only. Undefined when the commit (or its parent) is not in the
   * repository.
   */
  changeDiff(opts: { repoPath: string; commit: string; from?: string }): { diff: string; truncated: boolean } | undefined {
    if (!/^[0-9a-f]{40,64}$/.test(opts.commit)) return undefined;
    if (opts.from !== undefined && !/^[0-9a-f]{40,64}$/.test(opts.from)) return undefined;
    if (!this.check(opts.repoPath).ok) return undefined;
    const repo = resolve(opts.repoPath.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
    try {
      this.git(repo, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${opts.commit}^{commit}`]);
      this.git(repo, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${opts.from ?? `${opts.commit}^1`}^{commit}`]);
    } catch {
      return undefined;
    }
    const args = [...this.safeFlags(), "-C", repo, "diff", "--no-color", "--no-ext-diff", "--no-textconv", "-M", "--stat", "--patch", opts.from ?? `${opts.commit}^1`, opts.commit];
    // Output past the cap is dropped by the buffer limit (ENOBUFS), and a diff that takes too long is
    // stopped; what arrived by then is returned as truncated.
    const r = spawnSync(this.gitBin, args, { env: gitEnv(), stdio: ["ignore", "pipe", "pipe"], maxBuffer: MAX_CHANGE_DIFF_BYTES + 4096, timeout: this.changeDiffTimeoutMs });
    const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
    const over = code === "ENOBUFS" || (code === "ETIMEDOUT" && (r.stdout?.length ?? 0) > 0);
    if (!over && (r.error || r.status !== 0)) throw new Error(code === "ETIMEDOUT" ? "reading the changes took too long" : "the changes could not be read");
    const out = r.stdout ?? Buffer.alloc(0);
    if (!over && out.length <= MAX_CHANGE_DIFF_BYTES) return { diff: out.toString("utf8"), truncated: false };
    if (out.length === 0) return { diff: "", truncated: true };
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
        message: `${integration} contains ${foreign.length} commit(s) not made by Orchestrator (for example from another branch it started from); delivering would add them to ${target}. Automatic delivery is paused.`,
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

  // ---------- pull-request delivery (ORC-008) ----------

  /** The private ref that holds the fetched tip of the delivery base. */
  baseRef(projectId: string): string {
    return prBaseRef(projectId);
  }

  /** Where `git push` to this remote would go. */
  remoteUrl(repoPath: string, remote: string): string {
    return this.git(this.repoDir(repoPath), ["remote", "get-url", "--push", "--end-of-options", remote]);
  }

  /**
   * Fetch the base branch into the app's private ref. This is the only `+` refspec the app uses, and
   * its destination is local: the user's branches, remote-tracking refs and FETCH_HEAD are not written.
   */
  async fetchBase(o: { repoPath: string; projectId: string; remote: string; base: string }): Promise<{ sha: string }> {
    const repo = this.repoDir(o.repoPath);
    const ref = this.baseRef(o.projectId);
    const url = this.remoteUrl(o.repoPath, o.remote);
    await this.runAsync(["-C", repo, "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", "--end-of-options", o.remote, `+refs/heads/${o.base}:${ref}`], url);
    return { sha: this.git(repo, ["rev-parse", "--verify", `${ref}^{commit}`]) };
  }

  /** The commit a branch points to on the remote, if it exists there. */
  async lsRemote(o: { repoPath: string; remote: string; branch: string }): Promise<string | undefined> {
    const repo = this.repoDir(o.repoPath);
    const out = await this.runAsync(["-C", repo, "ls-remote", "--refs", "--end-of-options", o.remote, `refs/heads/${o.branch}`], this.remoteUrl(o.repoPath, o.remote));
    const sha = out.split(/\s+/)[0];
    return /^[0-9a-f]{40,64}$/.test(sha) ? sha : undefined;
  }

  /** Commits in `sha` that the fetched base does not have and that Orchestration did not author. */
  foreignAuthors(o: { repoPath: string; projectId: string; sha: string }): string[] {
    const repo = this.repoDir(o.repoPath);
    const base = this.git(repo, ["rev-parse", "--verify", `${this.baseRef(o.projectId)}^{commit}`]);
    return this.git(repo, ["log", "--format=%an%x00%ae", "--end-of-options", `${base}..${o.sha}`])
      .split("\n")
      .filter((l) => l && l !== ORCHESTRATION_AUTHOR)
      .map((l) => l.split("\0")[0] || "unknown");
  }

  /**
   * Push one commit to one of the app's pull-request branches. Never forced: a remote branch that holds
   * anything other than an ancestor of `sha` is reported as "diverged" and left alone. Before every
   * push, every commit that would be published must have been authored by Orchestration.
   */
  async pushHead(o: { repoPath: string; projectId: string; remote: string; branch: string; sha: string }): Promise<"pushed" | "already" | "diverged"> {
    const repo = this.repoDir(o.repoPath);
    const dst = `refs/heads/${o.branch}`;
    if (!PR_BRANCH_REF.test(dst)) throw new Error(`refusing to push to ${dst}: not one of the app's pull-request branches`);
    if (!/^[0-9a-f]{40,64}$/.test(o.sha)) throw new Error("refusing to push anything but a full commit id");
    const foreign = this.foreignAuthors(o);
    if (foreign.length) throw new ForeignCommitsError(foreign);
    const remote = await this.lsRemote(o);
    if (remote === o.sha) return "already";
    if (remote && this.status(["-C", repo, "merge-base", "--is-ancestor", remote, o.sha]).status !== 0) return "diverged";
    // Exactly one ref is published, whatever the user's git configuration says: no tags that happen to
    // be reachable (push.followTags), no submodules (push.recurseSubmodules), no signing prompt.
    const args = [
      "-c",
      "push.followTags=false",
      "-c",
      "push.recurseSubmodules=no",
      "-c",
      "push.gpgSign=false",
      "-C",
      repo,
      "push",
      "--porcelain",
      "--no-verify",
      "--no-follow-tags",
      "--no-recurse-submodules",
      "--end-of-options",
      o.remote,
      `${o.sha}:${dst}`,
    ];
    assertSafePush(args);
    await this.runAsync(args, this.remoteUrl(o.repoPath, o.remote));
    return "pushed";
  }

  /**
   * Prepare a finished task's final commit as a pull-request head. Local and synchronous; nothing is
   * pushed. The head is the task's commit itself: it is only checked, measured and pinned.
   */
  preparePrHead(o: { repoPath: string; projectId: string; taskId: string; n: number; baseRef: string; sha: string; protectedPaths: string[]; skipConflictCheck?: boolean }): PrHeadResult {
    const check = this.check(o.repoPath);
    if (!check.ok) throw new Error(check.reason);
    const repo = this.repoDir(o.repoPath);
    const branch = prBranch(o.projectId, o.taskId, o.n);
    if (!PR_BRANCH_REF.test(`refs/heads/${branch}`)) throw new Error(`${branch} is not a valid pull-request branch name`);
    let sha: string;
    try {
      sha = this.git(repo, ["rev-parse", "--verify", "--end-of-options", `${o.sha}^{commit}`]);
    } catch {
      throw new Error(`commit ${o.sha.slice(0, 12)} is no longer in the repository`);
    }
    const base = this.git(repo, ["rev-parse", "--verify", "--end-of-options", `${o.baseRef}^{commit}`]);
    // Authorship guard: only Orchestration's own commits are ever published.
    const foreign = this.git(repo, ["log", "--format=%an%x00%ae", "--end-of-options", `${base}..${sha}`])
      .split("\n")
      .filter((l) => l && l !== ORCHESTRATION_AUTHOR);
    if (foreign.length) {
      const authors = [...new Set(foreign.map((l) => l.split("\0")[0] || "unknown"))].slice(0, 5).join(", ");
      return { status: "conflict", message: `contains ${foreign.length} commit(s) not made by Orchestrator (authors: ${authors}); nothing was pushed` };
    }
    // Conflict pre-check against the base, without touching any worktree.
    // A fix for an open pull request skips this: a conflict with the base is then the pull request's own state.
    const mt = o.skipConflictCheck ? { status: 0, stdout: "" } : this.status(["-C", repo, "merge-tree", "--write-tree", "--name-only", "--no-messages", base, sha]);
    if (mt.status === 1) {
      const files = mt.stdout.split("\n").slice(1).filter(Boolean).slice(0, 20);
      return { status: "conflict", message: `conflicts with the base in ${files.join(", ") || "one or more files"}` };
    }
    if (mt.status !== 0) throw new Error("could not check the change against the base");
    const mergeBase = this.git(repo, ["merge-base", base, sha]);
    const rows = this.git(repo, ["diff", "--no-ext-diff", "--no-textconv", "--numstat", "-M", "-z", mergeBase, sha]).split("\0");
    const paths: string[] = [];
    let additions = 0;
    let deletions = 0;
    for (let i = 0; i < rows.length; i++) {
      const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(rows[i]);
      if (!m) continue;
      additions += m[1] === "-" ? 0 : Number(m[1]);
      deletions += m[2] === "-" ? 0 : Number(m[2]);
      if (m[3]) paths.push(m[3]);
      else {
        // A rename: the old and the new path follow as separate fields. Both count as touched.
        paths.push(rows[i + 1], rows[i + 2]);
        i += 2;
      }
    }
    const touched = [...new Set(paths.filter(Boolean))];
    const changed: PrDelivery["changed"] = {
      files: touched.length,
      additions,
      deletions,
      paths: touched.slice(0, 50),
      protectedHits: touched.filter((f) => o.protectedPaths.some((g) => matchGlob(g, f))).slice(0, 50),
      workflowHits: touched.filter((f) => f.startsWith(".github/workflows/")).slice(0, 50),
    };
    // Pin the head so the object survives garbage collection.
    this.git(repo, ["update-ref", `refs/orchestration/${branch.slice("orchestration/".length)}`, sha]);
    return { status: "ready", sha, baseSha: mergeBase, branch, changed };
  }

  /** Does `sha` contain `ancestor`? Local and read-only. */
  isAncestor(o: { repoPath: string; ancestor: string; sha: string }): boolean {
    if (!/^[0-9a-f]{7,64}$/.test(o.ancestor) || !/^[0-9a-f]{7,64}$/.test(o.sha)) return false;
    return this.status(["-C", this.repoDir(o.repoPath), "merge-base", "--is-ancestor", o.ancestor, o.sha]).status === 0;
  }

  /**
   * Bring a pull-request head up to date with the base: a two-parent merge commit made by
   * Orchestration, the old head first, so pushing it is a plain fast-forward. Local and synchronous;
   * no worktree is touched and nothing is pushed. A base that does not merge cleanly is reported with
   * its files and changes nothing. Repeating it for the same head and base returns the same commit.
   */
  baseUpdate(o: { repoPath: string; projectId: string; taskId: string; n: number; base: string; headSha: string; baseSha: string }): { status: "updated"; sha: string } | { status: "conflict"; files: string[] } {
    const check = this.check(o.repoPath);
    if (!check.ok) throw new Error(check.reason);
    const repo = this.repoDir(o.repoPath);
    const hex = /^[0-9a-f]{40,64}$/;
    if (!hex.test(o.headSha) || !hex.test(o.baseSha)) throw new Error("a base update needs two full commit ids");
    const branch = prBranch(o.projectId, o.taskId, o.n);
    if (!PR_BRANCH_REF.test(`refs/heads/${branch}`)) throw new Error(`${branch} is not a valid pull-request branch name`);
    const pin = `refs/orchestration/${branch.slice("orchestration/".length)}`;
    for (const c of [o.headSha, o.baseSha]) {
      if (this.status(["-C", repo, "rev-parse", "--verify", "--quiet", "--end-of-options", `${c}^{commit}`]).status !== 0) throw new Error(`commit ${c.slice(0, 12)} is no longer in the repository`);
    }
    if (this.status(["-C", repo, "merge-base", "--is-ancestor", o.baseSha, o.headSha]).status === 0) return { status: "updated", sha: o.headSha };
    const mt = this.status(["-C", repo, "merge-tree", "--write-tree", "--name-only", "--no-messages", o.headSha, o.baseSha]);
    if (mt.status === 1) return { status: "conflict", files: mt.stdout.split("\n").slice(1).filter(Boolean).slice(0, 20) };
    const tree = mt.stdout.split("\n")[0].trim();
    if (mt.status !== 0 || !hex.test(tree)) throw new Error("could not merge the base into the pull request head");
    // An earlier, interrupted attempt may already have made this exact merge: use it, do not make another.
    // "This exact merge" includes its content: the pinned commit is adopted only when its tree is the
    // tree git computes for the merge now. Parents and author alone do not say what it contains.
    const pinned = this.status(["-C", repo, "rev-parse", "--verify", "--quiet", `${pin}^{commit}`]);
    if (pinned.status === 0) {
      const sha = pinned.stdout.trim();
      const parents = this.git(repo, ["rev-list", "--parents", "-n", "1", sha]).split(" ").slice(1);
      const author = this.git(repo, ["log", "-1", "--format=%an%x00%ae", sha]);
      const pinnedTree = this.status(["-C", repo, "rev-parse", "--verify", "--quiet", `${sha}^{tree}`]);
      if (parents.length === 2 && parents[0] === o.headSha && parents[1] === o.baseSha && author === ORCHESTRATION_AUTHOR && pinnedTree.status === 0 && pinnedTree.stdout.trim() === tree) return { status: "updated", sha };
    }
    const sha = this.run(["-C", repo, "-c", "user.name=Orchestration", "-c", "user.email=orchestration@localhost", "commit-tree", tree, "-p", o.headSha, "-p", o.baseSha, "-m", `Merge ${o.base} into ${branch}`]);
    if (!hex.test(sha)) throw new Error("could not record the merge of the base");
    this.git(repo, ["update-ref", pin, sha]);
    return { status: "updated", sha };
  }

  /**
   * The changed lines a reviewer is handed: a stat and a patch from the base the change contains to
   * the change, cut at MAX_REVIEW_DIFF_BYTES with the list of all changed files. `from` is a commit on
   * the base branch (the fork point is worked out from it); without it, `baseRef` (default HEAD) is
   * used. Read-only. Undefined when a commit is missing.
   */
  reviewDiff(o: { repoPath: string; to: string; from?: string; baseRef?: string }): { from: string; to: string; text: string; truncated: boolean } | undefined {
    if (!this.check(o.repoPath).ok) return undefined;
    const repo = this.repoDir(o.repoPath);
    const rev = (r: string) => {
      const x = this.status(["-C", repo, "rev-parse", "--verify", "--quiet", "--end-of-options", `${r}^{commit}`]);
      return x.status === 0 ? x.stdout.trim() : undefined;
    };
    const to = rev(o.to);
    const against = rev(o.from ?? o.baseRef ?? "HEAD");
    if (!to || !against) return undefined;
    const mb = this.status(["-C", repo, "merge-base", against, to]);
    const from = mb.status === 0 && mb.stdout.trim() ? mb.stdout.trim() : against;
    const base = [...this.safeFlags(), "-C", repo, "diff", "--no-color", "--no-ext-diff", "--no-textconv", "-M"];
    const names = spawnSync(this.gitBin, [...base, "--name-only", from, to], { encoding: "utf8", env: gitEnv(), stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024, timeout: this.changeDiffTimeoutMs });
    if (names.error || names.status !== 0) return undefined;
    const files = names.stdout.split("\n").filter(Boolean);
    const r = spawnSync(this.gitBin, [...base, "--stat", "--patch", from, to], { env: gitEnv(), stdio: ["ignore", "pipe", "pipe"], maxBuffer: MAX_REVIEW_DIFF_BYTES + 4096, timeout: this.changeDiffTimeoutMs });
    const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
    const over = code === "ENOBUFS" || code === "ETIMEDOUT";
    if (!over && (r.error || r.status !== 0)) return undefined;
    const out = r.stdout ?? Buffer.alloc(0);
    if (!over && out.length <= MAX_REVIEW_DIFF_BYTES) return { from, to, text: out.toString("utf8"), truncated: false };
    const cut = out.subarray(0, MAX_REVIEW_DIFF_BYTES);
    const nl = cut.lastIndexOf(10);
    const shown = cut.subarray(0, nl > 0 ? nl + 1 : cut.length).toString("utf8");
    // Every file whose patch started is counted as shown, except the last, which was cut.
    const started = (shown.match(/^diff --git /gm) ?? []).length;
    const missing = Math.max(1, files.length - Math.max(0, started - 1));
    const list = files.slice(0, 200).map((f) => `- ${f}`).join("\n");
    return { from, to, truncated: true, text: `${shown}\n[truncated; ${missing} of ${files.length} files not shown in full. Read them in the workspace. All changed files:]\n${list}${files.length > 200 ? `\n- and ${files.length - 200} more` : ""}\n` };
  }

  /**
   * Orchestration's own commits on a local branch that the fetched base does not have (local delivery
   * put them there). Read-only; the app never pushes them. Undefined when the branch or the fetched
   * base is not there.
   */
  unpushedOrchestration(o: { repoPath: string; projectId: string; branch: string }): number | undefined {
    if (!/^[A-Za-z0-9._][A-Za-z0-9._/-]{0,99}$/.test(o.branch)) return undefined;
    const repo = this.repoDir(o.repoPath);
    const base = this.status(["-C", repo, "rev-parse", "--verify", "--quiet", `${this.baseRef(o.projectId)}^{commit}`]);
    const local = this.status(["-C", repo, "rev-parse", "--verify", "--quiet", `refs/heads/${o.branch}^{commit}`]);
    if (base.status !== 0 || local.status !== 0) return undefined;
    const log = this.status(["-C", repo, "log", "--format=%an%x00%ae", "--end-of-options", `${base.stdout.trim()}..${local.stdout.trim()}`]);
    if (log.status !== 0) return undefined;
    return log.stdout.split("\n").filter((l) => l === ORCHESTRATION_AUTHOR).length;
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
