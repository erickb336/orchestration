// The Docker stand-in (fake-docker.mjs) for tests: its "container" outlives the docker command, as a real container
// does, but never the test process that started that command (backlog B-33: three ran for 50 minutes after their test
// process was killed).

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const FAKE = new URL("./fake-docker.mjs", import.meta.url).pathname;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A stand-in test process: it starts one docker command (attached or detached) and then only waits. */
function testProcess(state: string, detach: boolean) {
  const args = ["run", ...(detach ? ["--detach"] : []), "--name", "c1", "--mount", `type=bind,source=${join(state, "work")},target=/work`, "--entrypoint", "fake-beat", "image"];
  const script = `require("node:child_process").spawn(process.execPath, process.argv.slice(1), { stdio: "ignore", env: process.env }); setInterval(() => {}, 1000);`;
  return spawn(process.execPath, ["-e", script, FAKE, ...args], { env: { ...process.env, DOCKER_CONFIG: state }, stdio: "ignore" });
}

describe("the Docker stand-in's containers", { timeout: 20_000 }, () => {
  for (const detach of [false, true]) {
    it(`end when the test process that started them is killed (${detach ? "run --detach" : "an attached run"})`, async () => {
      const state = mkdtempSync(join(tmpdir(), "fake-docker-"));
      const file = join(state, "c1.json");
      const parent = testProcess(state, detach);
      let pid = 0;
      try {
        for (let i = 0; i < 250 && !pid; i++, await sleep(20)) if (existsSync(file)) pid = (JSON.parse(readFileSync(file, "utf8")) as { pid?: number }).pid ?? 0;
        expect(pid).toBeGreaterThan(0);
        // The container outlives its docker command (the attached one waits for it), as a real one does.
        expect(alive(pid)).toBe(true);
        parent.kill("SIGKILL");
        for (let i = 0; i < 100 && alive(pid); i++) await sleep(20);
        expect(alive(pid)).toBe(false);
      } finally {
        parent.kill("SIGKILL");
        // Before the fix, stop the container the stand-in's own way, so this test leaves nothing running.
        if (pid && alive(pid)) writeFileSync(join(state, "c1.stop"), JSON.stringify({ at: 0, remove: true }));
        for (let i = 0; i < 100 && pid && alive(pid); i++) await sleep(20);
        rmSync(state, { recursive: true, force: true });
      }
    });
  }
});
