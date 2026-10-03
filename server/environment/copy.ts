// The copies an environment run works on (docs/design/project-environment.md), on this computer's disk, in a folder
// Docker can mount. Never through a link: every walk uses lstat, and nothing is written below a link.
//
//   - the run's copy: the checked worktree without `.git`, cloned (copy-on-write where the disk allows);
//   - what the prepare phase added: the entries of the copy that were not there before it ran (a new folder counts as
//     one entry, so node_modules, .venv or vendor/bundle are found without knowing any of those names);
//   - the prepared copy: those entries, kept per prepare key, so a later commit with the same image, prepare commands,
//     hosts and prepare inputs reuses them instead of preparing again.

import { createHash } from "node:crypto";
import { chmodSync, constants, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { isPrepareInput } from "../../src/domain/environment";

const MAX_INPUT_BYTES = 8 * 1024 * 1024;

/** Copy `src` to `dst` without its top-level `.git`, links kept as links, cloned where the file system can. */
export function copyWorktree(src: string, dst: string): void {
  mkdirSync(dirname(dst), { recursive: true, mode: 0o700 });
  cpSync(src, dst, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    mode: constants.COPYFILE_FICLONE,
    filter: (from) => from !== join(src, ".git"),
  });
}

/** Every path under `root` (relative, "/"-separated), found by lstat; links are listed and never followed. */
export function listTree(root: string): Set<string> {
  const out = new Set<string>();
  const walk = (rel: string) => {
    for (const name of readdirSync(join(root, rel))) {
      const p = rel ? `${rel}/${name}` : name;
      out.add(p);
      if (lstatSync(join(root, p)).isDirectory()) walk(p);
    }
  };
  walk("");
  return out;
}

/** The entries under `root` that `before` did not have: a new folder is one entry, and the walk does not enter it. */
export function addedEntries(root: string, before: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(join(root, rel)).sort()) {
      const p = rel ? `${rel}/${name}` : name;
      if (!before.has(p)) out.push(p);
      else if (lstatSync(join(root, p)).isDirectory()) walk(p);
    }
  };
  walk("");
  return out;
}

/** The prepare inputs in a clean copy (PREPARE_INPUTS, at any depth), each with the SHA-256 of its content, sorted by path. */
export function prepareInputs(root: string, tree: ReadonlySet<string> = listTree(root)): { path: string; sha256: string }[] {
  const out: { path: string; sha256: string }[] = [];
  for (const p of [...tree].sort()) {
    if (!isPrepareInput(p)) continue;
    const st = lstatSync(join(root, p));
    if (!st.isFile()) continue;
    const text = st.size > MAX_INPUT_BYTES ? `size ${st.size}` : readFileSync(join(root, p));
    out.push({ path: p, sha256: createHash("sha256").update(text).digest("hex") });
  }
  return out;
}

/** The prepare key: one hash of what the prepare depends on (16 hex characters). */
export function prepareKey(o: { imageId: string; prepare: string[][]; hosts: string[]; inputs: { path: string; sha256: string }[] }): string {
  return createHash("sha256").update(JSON.stringify([o.imageId, o.prepare, [...o.hosts].sort(), o.inputs])).digest("hex").slice(0, 16);
}

/** Is every folder from `root` down to the parent of `rel` a real folder (or missing)? A link on the way is refused. */
function safeParents(root: string, rel: string): boolean {
  const parts = rel.split("/").slice(0, -1);
  let p = root;
  for (const seg of parts) {
    p = join(p, seg);
    if (!existsSync(p)) return true;
    if (!lstatSync(p).isDirectory()) return false;
  }
  return true;
}

/** Clone `entries` from `from` into `to`, never below a link of `to`. Returns the entries that were copied. */
export function cloneEntries(from: string, to: string, entries: string[]): string[] {
  const done: string[] = [];
  for (const e of entries) {
    if (e.split("/").some((s) => s === ".." || s === "." || s === "") || !safeParents(to, e) || !existsSync(join(from, e))) continue;
    mkdirSync(dirname(join(to, e)), { recursive: true });
    if (existsSync(join(to, e))) removeTree(join(to, e));
    cpSync(join(from, e), join(to, e), { recursive: true, dereference: false, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
    done.push(e);
  }
  return done;
}

/** Remove a folder that container code wrote, read-only folders included (Go's module cache makes them). Links are removed, not followed. */
export function removeTree(dir: string): void {
  const open = (p: string) => {
    let st;
    try {
      st = lstatSync(p);
    } catch {
      return;
    }
    if (!st.isDirectory()) return;
    try {
      chmodSync(p, 0o700);
    } catch {
      /* not ours: rmSync reports it */
    }
    for (const name of readdirSync(p)) open(join(p, name));
  };
  open(dir);
  rmSync(dir, { recursive: true, force: true });
}
