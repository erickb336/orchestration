// Removing a copy that container code wrote (copy.ts removeTree), while something swaps a folder for a link to a folder
// of this computer in the middle of the walk (review finding 4). The swap is made by the file system's own lstat, right
// after the walk saw a real folder: the moment a walk that follows links would go through the link.

import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** When the walk lstats `after`, `folder` becomes a link to `to` (the real folder moves to `folder`-real). */
const swap = vi.hoisted(() => ({ after: "", folder: "", to: "", done: false }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const lstatSync = ((p: string, ...rest: never[]) => {
    const st = (fs.lstatSync as (...a: unknown[]) => unknown)(p, ...rest);
    if (swap.after && p === swap.after && !swap.done) {
      swap.done = true;
      fs.renameSync(swap.folder, `${swap.folder}-real`);
      fs.symlinkSync(swap.to, swap.folder);
    }
    return st;
  }) as typeof fs.lstatSync;
  return { ...fs, lstatSync, default: { ...fs, lstatSync } };
});

const { removeTree } = await import("./copy");

let dir = "";
afterEach(() => {
  Object.assign(swap, { after: "", folder: "", to: "", done: false });
  if (!dir) return;
  // The test's own folders: made writable again, then removed.
  for (const p of [join(dir, "victim/sub"), join(dir, "victim")]) if (existsSync(p)) chmodSync(p, 0o700);
  rmSync(dir, { recursive: true, force: true });
  dir = "";
});

/** A copy with a folder `a` (a file x and a folder s), and a read-only folder of "this computer" with the same names. */
function setup() {
  dir = mkdtempSync(join(tmpdir(), "orc-rmtree-"));
  const stage = join(dir, "stage");
  mkdirSync(join(stage, "a/s"), { recursive: true });
  writeFileSync(join(stage, "a/x"), "copy");
  writeFileSync(join(stage, "a/s/y"), "copy");
  const victim = join(dir, "victim");
  mkdirSync(join(victim, "sub"), { recursive: true });
  writeFileSync(join(victim, "x"), "mine");
  writeFileSync(join(victim, "sub/keep"), "mine");
  chmodSync(join(victim, "sub"), 0o555);
  chmodSync(victim, 0o555);
  return { stage, victim };
}

const untouched = (victim: string) => {
  expect(readdirSync(victim).sort()).toEqual(["sub", "x"]);
  expect(readdirSync(join(victim, "sub"))).toEqual(["keep"]);
  expect(statSync(victim).mode & 0o777).toBe(0o555);
  expect(statSync(join(victim, "sub")).mode & 0o777).toBe(0o555);
};

describe("removeTree never follows a link", () => {
  it("a folder swapped for a link right after the walk saw it: nothing of the link's target is changed", () => {
    const { stage, victim } = setup();
    Object.assign(swap, { after: join(stage, "a"), folder: join(stage, "a"), to: victim });
    try {
      removeTree(stage);
    } catch {
      /* stopping is allowed; going through the link is not */
    }
    expect(swap.done).toBe(true);
    untouched(victim);
  });

  it("a parent folder swapped for a link while the walk is inside it: nothing of the link's target is deleted", () => {
    const { stage, victim } = setup();
    Object.assign(swap, { after: join(stage, "a/x"), folder: join(stage, "a"), to: victim });
    try {
      removeTree(stage);
    } catch {
      /* stopping is allowed; deleting through the link is not */
    }
    expect(swap.done).toBe(true);
    untouched(victim);
  });

  it("without a swap: links, read-only folders and files all go, and the links' targets stay", () => {
    const { stage, victim } = setup();
    mkdirSync(join(stage, "ro/deep"), { recursive: true });
    writeFileSync(join(stage, "ro/deep/f"), "x");
    chmodSync(join(stage, "ro/deep"), 0o555);
    chmodSync(join(stage, "ro"), 0o555);
    symlinkSync(victim, join(stage, "link"));
    removeTree(stage);
    expect(existsSync(stage)).toBe(false);
    untouched(victim);
  });
});
