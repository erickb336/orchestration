// Keeping the Mac awake while agents run (ORC-030 C4): one `caffeinate -i -w <pid>` while a run is active, none
// otherwise, and nothing on other systems. The spawner is injected: no test starts a real caffeinate.

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { KeepAwake, type HeldProcess, type Spawner } from "./keepAwake";

class FakeChild extends EventEmitter implements HeldProcess {
  signals: (NodeJS.Signals | undefined)[] = [];
  kill(signal?: NodeJS.Signals) {
    this.signals.push(signal);
    // A real child reports its exit after the signal, asynchronously; the holder must not mind.
    queueMicrotask(() => this.emit("exit", null, signal ?? "SIGTERM"));
    return true;
  }
}

function harness(platform: NodeJS.Platform = "darwin") {
  const started: { command: string; args: string[]; child: FakeChild }[] = [];
  const spawn: Spawner = (command, args) => {
    const child = new FakeChild();
    started.push({ command, args, child });
    return child;
  };
  const logs: string[] = [];
  const keep = new KeepAwake({ platform, pid: 4242, spawn, log: (m) => logs.push(m) });
  const live = () => started.filter((s) => s.child.signals.length === 0);
  return { keep, started, live, logs };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("KeepAwake", () => {
  it("starts one caffeinate -i bound to the service's pid when a run becomes active, and ends it when none is", async () => {
    const { keep, started, live } = harness();
    expect(keep.status()).toEqual({ holding: false });
    keep.set(true);
    expect(started).toHaveLength(1);
    expect(started[0].command).toBe("/usr/bin/caffeinate");
    expect(started[0].args).toEqual(["-i", "-w", "4242"]);
    expect(keep.status()).toEqual({ holding: true });
    // Every cycle says "active" again: still one process.
    keep.set(true);
    keep.set(true);
    expect(started).toHaveLength(1);
    keep.set(false);
    expect(started[0].child.signals).toEqual(["SIGTERM"]);
    expect(live()).toHaveLength(0);
    expect(keep.holding).toBe(false);
    await tick(); // its exit arrives after the holder let go
    keep.set(false);
    expect(started[0].child.signals).toEqual(["SIGTERM"]); // signalled once
    // The next stretch of work starts a new one.
    keep.set(true);
    expect(started).toHaveLength(2);
    expect(live()).toHaveLength(1);
  });

  it("ends the process when the service stops", () => {
    const { keep, started, live } = harness();
    keep.set(true);
    keep.stop();
    expect(started[0].child.signals).toEqual(["SIGTERM"]);
    expect(live()).toHaveLength(0);
    keep.stop(); // nothing held: nothing to end
    expect(started).toHaveLength(1);
  });

  it("does nothing on systems other than macOS, and says nothing about sleep there", () => {
    for (const platform of ["linux", "win32"] as NodeJS.Platform[]) {
      const { keep, started } = harness(platform);
      keep.set(true);
      keep.set(false);
      keep.stop();
      expect(started).toHaveLength(0);
      expect(keep.supported).toBe(false);
      expect(keep.status()).toBeUndefined();
    }
  });

  it("a caffeinate that cannot start is reported and not tried again until the runs end", async () => {
    const { keep, started, logs } = harness();
    keep.set(true);
    started[0].child.emit("error", Object.assign(new Error("spawn /usr/bin/caffeinate ENOENT"), { code: "ENOENT" }));
    await tick();
    expect(keep.status()).toEqual({ holding: false, failed: "caffeinate could not start (spawn /usr/bin/caffeinate ENOENT)" });
    expect(logs.join("\n")).toContain("ENOENT");
    keep.set(true);
    keep.set(true);
    expect(started).toHaveLength(1); // no retry every cycle
    keep.set(false);
    expect(keep.status()).toEqual({ holding: false });
    keep.set(true);
    expect(started).toHaveLength(2); // the next stretch of work tries again
  });

  it("a holding process someone else ended is started again; one that failed with an exit code is not", () => {
    const { keep, started } = harness();
    keep.set(true);
    started[0].child.emit("exit", null, "SIGKILL"); // for example `killall caffeinate`
    expect(keep.holding).toBe(false);
    keep.set(true);
    expect(started).toHaveLength(2);
    started[1].child.emit("exit", 1, null);
    expect(keep.status()?.failed).toContain("exited with code 1");
    keep.set(true);
    expect(started).toHaveLength(2);
  });

  it("a spawner that throws is a failure, not a crash", () => {
    const keep = new KeepAwake({
      platform: "darwin",
      pid: 1,
      spawn: () => {
        throw new Error("EAGAIN");
      },
    });
    expect(() => keep.set(true)).not.toThrow();
    expect(keep.status()).toEqual({ holding: false, failed: "caffeinate could not start (EAGAIN)" });
  });
});
