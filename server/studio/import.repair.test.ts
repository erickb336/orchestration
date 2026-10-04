// ORC-032 repair round 1 at the server: each test reproduces one finding of the first review (the reviewer's probe),
// and holds its fix. tally is sample data.

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EnvironmentImport, TALLY_FIXTURE } from "./import";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orc032-repair-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Every file under `d`, relative. */
const walk = (d: string, pre = ""): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name), `${pre}${e.name}/`) : [`${pre}${e.name}`]));

describe("CR-2, SR-1: the capture writes its plan and tapes into nothing of the repository's", () => {
  it("a repository whose .orchestrator is a link out of the copy gets nothing written through it; the plan still reaches the environment", async () => {
    const repo = join(dir, "repo");
    const outside = join(dir, "outside-the-copy");
    mkdirSync(repo);
    mkdirSync(outside);
    writeFileSync(join(repo, "README.md"), "x\n");
    symlinkSync(outside, join(repo, ".orchestrator"));
    // The environment answers that Docker is not there: the capture reached it, with its plan checked.
    const reached: string[] = [];
    const lender = { withPrepared: async (o: { workspace: string }) => (reached.push(o.workspace), { ok: false as const, reason: "unavailable" as const, detail: "Docker is not running", prepare: [] }) };
    const runner = new EnvironmentImport({ lender: lender as never, recorderRoot: join(dir, "rec") });
    const out = await runner.capture({
      source: repo,
      commit: "a".repeat(40),
      parts: [{ artifactId: "sa-1", version: 1, kind: "terminal-demo", title: "tally add", tape: { path: "add/demo.tape", text: readFileSync(join(TALLY_FIXTURE, "parts", "add", "demo.tape"), "utf8") } }],
      environment: { plan: { source: { from: "setting", image: "python:3" } } } as never,
      outDir: join(dir, "data", "evidence", "p", "import-1"),
      signal: new AbortController().signal,
    });
    expect(walk(outside)).toEqual([]);
    expect(out.parts.map((p) => p.status === "none" && [p.reason, p.detail])).toEqual([["unavailable", expect.stringContaining("Docker is not running")]]);
    expect(reached).toHaveLength(1);
  });
});
