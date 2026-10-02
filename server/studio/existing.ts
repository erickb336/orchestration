// An existing repository (ORC-029 pass 4, a first slice of ORC-032): whether the project's repository already has
// code, and which files it holds, read from git at HEAD (what a read-only checkout starts from). The lead's envelope
// says whether there is code, so its first round in Vision can be "as it is today"; the designer's envelope lists the
// code it may reproduce; and the import checks that an "as is" artifact's provenance names files the repository has.
// Read only: `git ls-tree`, never a write, and nothing when the repository cannot be read.

import { execFileSync } from "node:child_process";

/** Files that describe a repository rather than make up its product: documents, licences, git and editor settings, images. */
const NOT_CODE = /(^|\/)(readme|license|licence|copying|notice|changelog|contributing|authors|code_of_conduct)(\.[^/]*)?$|(^|\/)\.(gitignore|gitattributes|gitmodules|editorconfig)$|\.(md|markdown|txt|rst|adoc|png|jpe?g|gif|webp|ico|svg|pdf)$/i;

/** Whether a tracked file is code: anything but documents, licences, git and editor settings, and images. */
export const isCode = (path: string) => !NOT_CODE.test(path);

/** Every file tracked at HEAD, or undefined when the repository cannot be read (no repository, no commit). */
export function repoFiles(repoPath: string): string[] | undefined {
  if (!repoPath.trim()) return undefined;
  try {
    const out = execFileSync("git", ["-C", repoPath, "ls-tree", "-r", "-z", "--name-only", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000, maxBuffer: 64 * 1024 * 1024 });
    return out.split("\0").filter(Boolean);
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
