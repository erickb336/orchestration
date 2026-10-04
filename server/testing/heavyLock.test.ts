// The heavy tests' lock across test runs on one computer (ORC-030 B-34): a second run waits for the first, a lock whose
// holder is gone is taken over, and a wait that runs too long fails with its reason.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { takeHeavyLock } from "./heavyLock";

const root = mkdtempSync(join(tmpdir(), "orc-heavylock-"));
const lock = () => join(root, `lock-${Math.random().toString(36).slice(2)}`);
const quiet = { log: () => {}, pollMs: 50 };
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
});

describe("the heavy tests' lock", () => {
  it("is taken when free, holds this process's id, and goes at release", async () => {
    const dir = lock();
    const release = await takeHeavyLock(dir, quiet);
    expect(readFileSync(join(dir, "pid"), "utf8")).toBe(String(process.pid));
    release();
    expect(existsSync(dir)).toBe(false);
  });

  it("makes a second run wait while the holder lives, then takes it when the holder is gone", async () => {
    const dir = lock();
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    mkdirSync(dir);
    writeFileSync(join(dir, "pid"), String(holder.pid));
    let taken = false;
    const waiting = takeHeavyLock(dir, quiet).then((release) => ((taken = true), release));
    await new Promise((r) => setTimeout(r, 300));
    expect(taken).toBe(false);
    holder.kill();
    const release = await waiting;
    expect(readFileSync(join(dir, "pid"), "utf8")).toBe(String(process.pid));
    release();
  });

  it("takes over at once a lock whose holder is gone", async () => {
    const dir = lock();
    const gone = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await new Promise((r) => gone.on("exit", r));
    mkdirSync(dir);
    writeFileSync(join(dir, "pid"), String(gone.pid));
    const release = await takeHeavyLock(dir, { ...quiet, waitMs: 1_000 });
    release();
  });

  it("fails with its reason when the wait runs past its limit", async () => {
    const dir = lock();
    mkdirSync(dir);
    writeFileSync(join(dir, "pid"), String(process.ppid));
    await expect(takeHeavyLock(dir, { ...quiet, waitMs: 200 })).rejects.toThrow(/waited 0 min for another test run \(pid \d+\)/);
  });

  it("a release never removes another holder's lock", async () => {
    const dir = lock();
    const release = await takeHeavyLock(dir, quiet);
    writeFileSync(join(dir, "pid"), String(process.ppid));
    release();
    expect(existsSync(dir)).toBe(true);
  });
});
