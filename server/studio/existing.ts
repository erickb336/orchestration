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

/** Files that describe a repository rather than make up its product: documents, licences, git and editor settings, images. */
const NOT_CODE = /(^|\/)(readme|license|licence|copying|notice|changelog|contributing|authors|code_of_conduct)(\.[^/]*)?$|(^|\/)\.(gitignore|gitattributes|gitmodules|editorconfig)$|\.(md|markdown|txt|rst|adoc|png|jpe?g|gif|webp|ico|svg|pdf)$/i;

/** Whether a tracked file is code: anything but documents, licences, git and editor settings, and images. */
export const isCode = (path: string) => !NOT_CODE.test(path);

const git = (repoPath: string, args: string[], maxBuffer = 1024 * 1024) =>
  execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000, maxBuffer });

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
 * Which of these paths the repository tracks at HEAD, or undefined when it cannot be read. Lists only these paths
 * (literal pathspecs), so its size does not grow with the repository.
 */
export function trackedAmong(repoPath: string, paths: readonly string[]): Set<string> | undefined {
  const at = head(repoPath);
  if (!at) return undefined;
  if (!paths.length) return new Set();
  try {
    return new Set(git(repoPath, ["--literal-pathspecs", "ls-tree", "-r", "-z", "--name-only", at, "--", ...paths]).split("\0").filter(Boolean));
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
