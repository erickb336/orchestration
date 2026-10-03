// The copies an environment run works on (docs/design/project-environment.md), on this computer's disk, in a folder
// Docker can mount. Never through a link: every walk uses lstat, and nothing is written below a link.
//
//   - the run's copy: the checked worktree without `.git`, cloned (copy-on-write where the disk allows);
//   - what the prepare phase added: the entries of the copy that were not there before it ran (a new folder counts as
//     one entry, so node_modules, .venv or vendor/bundle are found without knowing any of those names);
//   - the prepared copy: those entries, kept per prepare key, so a later commit with the same image, prepare commands,
//     hosts and prepare inputs reuses them instead of preparing again.

import { createHash } from "node:crypto";
import { closeSync, constants, cpSync, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmdirSync, unlinkSync, type Stats } from "node:fs";
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

const sameEntry = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;

/** `p` is still the folder that was opened (`own`): a link or anything else put in its place stops the walk. */
function still(p: string, own: Stats): void {
  const now = lstatSync(p);
  if (!now.isDirectory() || !sameEntry(now, own)) throw new Error(`${p} was replaced while it was being removed; the clean-up stopped there`);
}

/**
 * Remove a folder that container code wrote, read-only folders included (Go's module cache makes them), without ever
 * following a link. Each folder is opened with O_NOFOLLOW and made writable through its own descriptor; before each
 * removal below it, the walk checks that the folder is still the one it opened. A link is removed, never followed. A
 * folder replaced during the walk stops the walk with an error, and what remains stays. Node has no unlinkat, so the
 * service also waits until no container mounts the folder before it removes it (prepared.ts): nothing should change
 * the folder during the walk.
 */
export function removeTree(dir: string): void {
  let st: Stats;
  try {
    st = lstatSync(dir);
  } catch {
    return;
  }
  removeEntry(dir, st);
}

function removeEntry(p: string, st: Stats, parent?: { path: string; own: Stats }): void {
  if (!st.isDirectory()) {
    if (parent) still(parent.path, parent.own);
    try {
      return void unlinkSync(p);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
  }
  let fd: number;
  try {
    fd = openSync(p, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // Replaced by a link or a file since its lstat: that entry itself goes, never what it points to.
    if (code === "ELOOP" || code === "ENOTDIR" || code === "EMLINK") return removeEntry(p, lstatSync(p), parent);
    if (code === "ENOENT") return;
    throw e;
  }
  try {
    const own = fstatSync(fd);
    if (!sameEntry(own, st)) throw new Error(`${p} was replaced while it was being removed; the clean-up stopped there`);
    fchmodSync(fd, 0o700);
    const names = readdirSync(p);
    for (const name of names) {
      still(p, own);
      const child = join(p, name);
      let cst: Stats;
      try {
        cst = lstatSync(child);
      } catch {
        continue;
      }
      removeEntry(child, cst, { path: p, own });
    }
    still(p, own);
    if (parent) still(parent.path, parent.own);
    rmdirSync(p);
  } finally {
    closeSync(fd);
  }
}
