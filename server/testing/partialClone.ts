// A hostile partial clone (ORC-032, SR-3), for the tests: its config names a promisor remote whose upload-pack is a
// shell command that writes a marker, and one blob of its commit is missing. When git reads that blob, it fetches it
// lazily from the remote, and so runs the command on this computer, unless the service stops it.

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function hostilePartialClone(dir: string): { repo: string; marker: string; commit: string } {
  const repo = join(dir, "partial");
  const marker = join(dir, "the-upload-pack-ran");
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgSign=false", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "app.js"), "console.log('app');\n");
  writeFileSync(join(repo, "README.md"), "# app\n");
  git("add", "-A");
  git("commit", "-q", "-m", "app");
  git("config", "core.repositoryformatversion", "1");
  git("config", "extensions.partialClone", "origin");
  git("config", "remote.origin.url", `file://${repo}`);
  git("config", "remote.origin.promisor", "true");
  git("config", "remote.origin.uploadpack", `touch "${marker}"; false`);
  const oid = git("rev-parse", "HEAD:src/app.js");
  rmSync(join(repo, ".git", "objects", oid.slice(0, 2), oid.slice(2)));
  return { repo, marker, commit: git("rev-parse", "HEAD") };
}
