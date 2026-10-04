// An existing repository (ORC-029 pass 4, a first slice of ORC-032): whether the project's repository already has
// code, and which files it holds, read from git at HEAD (what a read-only checkout starts from). The lead's envelope
// says whether there is code, so its first round in Vision can be "as it is today"; the designer's envelope lists the
// code it may reproduce; and the import checks that an "as is" artifact's provenance names files the repository has.
// Read only: `git ls-tree`, never a write, and nothing when the repository cannot be read.
//
// Review finding 11: these run in the scheduler, never inside the store's transaction. The whole listing is read once
// per HEAD and kept (a lead run in Vision reads it every time); the provenance check lists only the files it names, so
// a large repository can never fail an import after its designer run was paid for.

import { execFileSync } from "node:child_process";
import { gitEnv, gitSafeFlags, isPartialClone } from "../workspaces";

/** Files that describe a repository rather than make up its product: documents, licences, git and editor settings, images. */
const NOT_CODE = /(^|\/)(readme|license|licence|copying|notice|changelog|contributing|authors|code_of_conduct)(\.[^/]*)?$|(^|\/)\.(gitignore|gitattributes|gitmodules|editorconfig)$|\.(md|markdown|txt|rst|adoc|png|jpe?g|gif|webp|ico|svg|pdf)$/i;

/** Whether a tracked file is code: anything but documents, licences, git and editor settings, and images. */
export const isCode = (path: string) => !NOT_CODE.test(path);

/** The service's git flags; /dev/null holds no hooks. */
const FLAGS = gitSafeFlags("/dev/null");

/** Git with the service's environment and flags (SR-3): no hook, no fsmonitor, and no lazy fetch of a missing object. */
const git = (repoPath: string, args: string[], maxBuffer = 1024 * 1024) =>
  execFileSync("git", [...FLAGS, "-C", repoPath, ...args], { encoding: "utf8", env: gitEnv(), stdio: ["ignore", "pipe", "ignore"], timeout: 10_000, maxBuffer });

/** Whether the repository is a partial clone, which the import refuses (SR-3). */
export const partialClone = (repoPath: string) => isPartialClone(repoPath, FLAGS);

/** The commit at HEAD, or undefined when the repository cannot be read (no repository, no commit). */
function head(repoPath: string): string | undefined {
  if (!repoPath.trim()) return undefined;
  try {
    return git(repoPath, ["rev-parse", "--verify", "HEAD"]).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The last listing read, per repository: a listing changes only with HEAD. */
const listings = new Map<string, { head: string; files: string[] }>();

/** Every file tracked at HEAD, or undefined when the repository cannot be read. Read once per HEAD. */
export function repoFiles(repoPath: string): string[] | undefined {
  const at = head(repoPath);
  if (!at) return undefined;
  const kept = listings.get(repoPath);
  if (kept?.head === at) return kept.files;
  try {
    const files = git(repoPath, ["ls-tree", "-r", "-z", "--name-only", at], 64 * 1024 * 1024).split("\0").filter(Boolean);
    if (listings.size >= 8) listings.clear();
    listings.set(repoPath, { head: at, files });
    return files;
  } catch {
    return undefined;
  }
}

/**
 * Which of these paths the repository tracks at `commit` (an import's, C11), else at HEAD; undefined when it cannot be
 * read. Lists only these paths (literal pathspecs), so its size does not grow with the repository.
 */
export function trackedAmong(repoPath: string, paths: readonly string[], commit?: string): Set<string> | undefined {
  const at = commit ?? head(repoPath);
  if (!at) return undefined;
  if (!paths.length) return new Set();
  try {
    return new Set(git(repoPath, ["--literal-pathspecs", "ls-tree", "-r", "-z", "--name-only", "--end-of-options", at, "--", ...paths]).split("\0").filter(Boolean));
  } catch {
    return undefined;
  }
}

/** What the lead and the designer are told of the repository: how many files it tracks, how many are code, and the first code paths. */
export interface RepoGlance {
  files: number;
  codeFiles: number;
  /** Up to `max` code paths, in git's order. */
  code: string[];
}

/** A glance at the repository, or undefined when it cannot be read. */
export function repoGlance(repoPath: string, max = 40): RepoGlance | undefined {
  const files = repoFiles(repoPath);
  if (!files) return undefined;
  const code = files.filter(isCode);
  return { files: files.length, codeFiles: code.length, code: code.slice(0, max) };
}

// ---------- the import's start (ORC-032) ----------

/** A test file, in any language: under a tests or spec folder, or named as a test (test_x.py, x_test.go, x.test.ts). */
const TEST_FILE = /(^|\/)(tests?|__tests__|specs?)\/|(^|\/)(test_[^/]*|[^/]*_test\.[^/.]+|[^/]*\.(test|spec)\.[^/.]+)$/i;

/** What the import's Start screen reads: the commit at HEAD, its branch, and the code's size (C7: files, not tests). */
export interface RepoAt {
  commit: string;
  /** The branch HEAD is on; absent when HEAD is detached. */
  branch?: string;
  size: { sourceFiles: number; testFiles: number; kb: number };
}

/**
 * The repository at HEAD, from git's own records (rev-parse, symbolic-ref, ls-tree): never `git status`, which can run
 * the repository's fsmonitor and filters. Undefined when it cannot be read.
 */
export function repoAt(repoPath: string): RepoAt | undefined {
  const commit = head(repoPath);
  if (!commit) return undefined;
  let branch: string | undefined;
  try {
    branch = git(repoPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]).trim() || undefined;
  } catch {
    /* detached */
  }
  try {
    let sourceFiles = 0;
    let testFiles = 0;
    let bytes = 0;
    // "<mode> <type> <object> <size>\t<path>", one per file.
    for (const row of git(repoPath, ["ls-tree", "-r", "-l", "-z", "--end-of-options", commit], 64 * 1024 * 1024).split("\0")) {
      const tab = row.indexOf("\t");
      if (tab < 0) continue;
      const path = row.slice(tab + 1);
      const [, type, , size] = row.slice(0, tab).trim().split(/\s+/);
      // ls-tree gives "-" for the size of a blob that is not in the object store: fail closed (SR-3).
      if (type === "blob" && !/^\d+$/.test(size ?? "")) return undefined;
      if (!isCode(path)) continue;
      if (TEST_FILE.test(path)) testFiles++;
      else sourceFiles++;
      if (type === "blob") bytes += Number(size);
    }
    return { commit, ...(branch ? { branch } : {}), size: { sourceFiles, testFiles, kb: Math.round((bytes / 1024) * 10) / 10 } };
  } catch {
    return undefined;
  }
}
