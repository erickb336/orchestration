// Housekeeping (server/housekeeping.ts) in a temporary home folder: never the real ~/.codex, ~/.claude or ~/.Trash.
// What it finds is only Orchestrator's, the owner's own threads and folders stay, a held thread is reported and tried
// again, no link is followed, two sweeps never overlap, and the setting turns the owner's-app part off. The Claude
// CLI's folder names are checked against the Claude Agent SDK itself, which finds a session only under that name.

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SweepReport } from "../src/api";
import { Housekeeping, MIN_AGE_MS, claudeProjectName, dockerTime, orphanContainer, sweepMessage, transcriptCwd, type DockerOps, type HousekeepingOptions } from "./housekeeping";
import type { ArchiveOutcome } from "./runtimes/codex";
import { STAGE_SWEEP_AGE_MS } from "./studio/container";

const NOW = Date.parse("2026-10-03T12:00:00Z");
const OLD = NOW - 2 * MIN_AGE_MS;
let home: string;
let data: string;
let repo: string;

beforeEach(() => {
  // The real path: the Claude CLI names a session by its real working folder (/private/var/…, not /var/…).
  home = realpathSync(mkdtempSync(join(tmpdir(), "orc-hk-home-")));
  data = join(home, ".orchestration");
  repo = join(home, "workspace", "Orchestration");
  for (const d of [join(data, "worktrees"), join(data, "studio"), join(repo, "evidence"), join(home, ".Trash")]) mkdirSync(d, { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const setTime = (p: string, ms: number) => utimesSync(p, ms / 1000, ms / 1000);
const uuid = (n: number) => `01a0ffa8-0000-7000-8000-${String(n).padStart(12, "0")}`;

/** A Codex session file whose first line is the session_meta Codex writes (originator = the client's name). */
function codexThread(n: number, originator: string, mtime = OLD): string {
  const day = join(home, ".codex", "sessions", "2026", "10", "02");
  mkdirSync(day, { recursive: true });
  const id = uuid(n);
  const file = join(day, `rollout-2026-10-02T19-46-51-${id}.jsonl`);
  const meta = { timestamp: "2026-10-02T19:46:51.661Z", type: "session_meta", payload: { session_id: id, id, cwd: "/somewhere", originator, cli_version: "0.159.2", base_instructions: "x".repeat(20_000) } };
  writeFileSync(file, `${JSON.stringify(meta)}\n{"type":"response_item"}\n`);
  setTime(file, mtime);
  return id;
}

/** A Claude session folder for a working folder: a transcript that ran there (or only `memory/`, as a run with no saved session left). */
function claudeFolder(cwd: string, o: { transcriptCwd?: string; memoryOnly?: boolean; mtime?: number } = {}): string {
  const name = claudeProjectName(cwd);
  const dir = join(home, ".claude", "projects", name);
  mkdirSync(dir, { recursive: true });
  if (o.memoryOnly) mkdirSync(join(dir, "memory"));
  else {
    const lines = [{ type: "queue-operation", operation: "enqueue" }, { type: "user", cwd: o.transcriptCwd ?? cwd, sessionId: "s1" }];
    writeFileSync(join(dir, "6f1c2b8e-0000-4000-8000-000000000001.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  }
  for (const e of readdirSync(dir)) setTime(join(dir, e), o.mtime ?? OLD);
  setTime(dir, o.mtime ?? OLD);
  return name;
}

const trashed = () => readdirSync(join(home, ".Trash")).sort();
const projects = () => readdirSync(join(home, ".claude", "projects")).sort();
const sessions = () => readdirSync(join(home, ".codex", "sessions", "2026", "10", "02")).sort();

/** Archives as Codex would: the session file moves to archived_sessions. `held` ids answer "active writer". */
function fakeArchive(held: Set<string> = new Set(), calls: string[][] = []) {
  return async (ids: string[]) => {
    calls.push(ids);
    const out = new Map<string, ArchiveOutcome>();
    for (const id of ids) out.set(id, held.has(id) ? "held" : "archived");
    return out;
  };
}

function keeper(o: Partial<HousekeepingOptions> = {}) {
  const events: string[] = [];
  const hk = new Housekeeping({
    home,
    env: {},
    ownedFolders: [join(data, "worktrees"), join(data, "studio"), join(repo, "evidence")],
    ownerApps: () => true,
    ownerAppsAllowed: true,
    archive: fakeArchive(),
    platform: "darwin",
    now: () => NOW,
    record: (m) => events.push(m),
    ...o,
  });
  return { hk, events };
}

describe("the Claude CLI's folder names", () => {
  it("encodes a working folder as the CLI does, on names seen on the owner's computer", () => {
    expect(claudeProjectName("/Users/erickb336/workspace/Orchestration")).toBe("-Users-erickb336-workspace-Orchestration");
    expect(claudeProjectName("/Users/erickb336/workspace/Orchestration/.claude/worktrees/charming-hertz-b98519")).toBe("-Users-erickb336-workspace-Orchestration--claude-worktrees-charming-hertz-b98519");
    expect(claudeProjectName("/private/tmp/claude-501/-Users-erickb336-workspace-Orchestration/27ba951d-3efc-4000-b54e-66e81d19db2f/scratchpad")).toBe(
      "-private-tmp-claude-501--Users-erickb336-workspace-Orchestration-27ba951d-3efc-4000-b54e-66e81d19db2f-scratchpad",
    );
    expect(claudeProjectName("/Users/erickb336/.orchestration/worktrees/orchestration/p-1/run-1035")).toBe("-Users-erickb336--orchestration-worktrees-orchestration-p-1-run-1035");
  });

  it("is the name under which the Claude Agent SDK finds a session", async () => {
    // For a name of 200 characters or fewer the SDK looks only in the folder of that exact name (a longer one it also
    // finds by its first 200 characters and the transcript's cwd, so it cannot prove the name).
    const config = join(home, "claude-config");
    const before = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = config;
    try {
      const { listSessions } = await import("@anthropic-ai/claude-agent-sdk");
      const session = (folder: string, sid: string, cwd: string) => {
        mkdirSync(join(config, "projects", folder), { recursive: true });
        const line = { type: "user", message: { role: "user", content: "hello" }, uuid: `u-${sid}`, parentUuid: null, timestamp: new Date().toISOString(), sessionId: sid, cwd };
        writeFileSync(join(config, "projects", folder, `${sid}.jsonl`), JSON.stringify(line) + "\n");
      };
      const dir = join(data, "worktrees", "orchestration", "p-1.x", "run_12");
      session(claudeProjectName(dir), "6f1c2b8e-0000-4000-8000-000000000001", dir);
      expect((await listSessions({ dir, includeWorktrees: false })).map((s) => s.sessionId)).toEqual(["6f1c2b8e-0000-4000-8000-000000000001"]);
      // A near miss: "." and "_" kept. The SDK finds nothing under it.
      const near = join(data, "worktrees", "orchestration", "p-1.x", "run_13");
      session(near.replace(/[^a-zA-Z0-9._]/g, "-"), "6f1c2b8e-0000-4000-8000-000000000002", near);
      expect(await listSessions({ dir: near, includeWorktrees: false })).toEqual([]);
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = before;
    }
  });

  it("finds a long working folder's session by the start of its name, as the CLI cuts it", async () => {
    const cwd = join(data, "worktrees", "a-long-folder-name-".repeat(12), "run-1");
    const cut = `${claudeProjectName(cwd).slice(0, 200)}-i03ip8`; // the CLI: 200 characters, "-" and a hash
    const dir = join(home, ".claude", "projects", cut);
    mkdirSync(join(dir, "memory"), { recursive: true });
    setTime(join(dir, "memory"), OLD);
    setTime(dir, OLD);
    expect((await keeper().hk.find()).claudeFolders.map((f) => f.name)).toEqual([cut]);
  });

  it("reads a transcript's first cwd from its complete lines only", () => {
    expect(transcriptCwd('{"type":"queue-operation"}\n{"type":"user","cwd":"/a/b"}\n{"cwd":"/c"}\n')).toBe("/a/b");
    expect(transcriptCwd('{"type":"user","cwd":"/a/b"')).toBeUndefined();
    expect(transcriptCwd("")).toBeUndefined();
  });
});

describe("a sweep", () => {
  it("cleans only what Orchestrator's runs left, and leaves the owner's own threads and folders", async () => {
    const mine = codexThread(1, "orchestration");
    codexThread(2, "codex_work_desktop");
    codexThread(3, "codex_exec");
    const recent = codexThread(4, "orchestration", NOW - 60_000);
    const worktree = claudeFolder(join(data, "worktrees", "orchestration", "p-1", "run-1035"), { memoryOnly: true });
    const studio = claudeFolder(join(data, "studio", "p-1", "staging", "studio-1029"));
    const evidence = claudeFolder(join(repo, "evidence", "work-2026-10-02T10-00-00-000Z", "data", "worktrees", "x", "run-1"));
    const ownRepo = claudeFolder(repo);
    const ownWorktree = claudeFolder(join(repo, ".claude", "worktrees", "charming-hertz-b98519"));
    // Same name as a folder under evidence/, but its transcript ran in the owner's "evidence-notes" folder.
    const lookalike = claudeFolder(join(repo, "evidence", "notes"), { transcriptCwd: join(repo, "evidence-notes") });
    const calls: string[][] = [];
    const { hk, events } = keeper({ archive: fakeArchive(new Set(), calls) });

    const dry = await hk.find();
    expect(dry.codexThreads.map((t) => t.id)).toEqual([mine]);
    expect(dry.claudeFolders.map((f) => f.name).sort()).toEqual([evidence, studio, worktree].sort());
    expect(dry.recent).toBe(1);
    expect(trashed()).toEqual([]); // the dry run changed nothing
    expect(calls).toEqual([]);

    const r = await hk.sweep("owner");
    expect(calls).toEqual([[mine]]);
    expect(r).toMatchObject({ trigger: "owner", ownerApps: true, archived: 1, trashed: 3, held: 0, recent: 1, notes: [] });
    expect(trashed()).toEqual([evidence, studio, worktree].sort());
    expect(projects()).toEqual([lookalike, ownRepo, ownWorktree].sort());
    expect(sessions()).toHaveLength(4); // the fake archive moves nothing; the owner's threads were never asked about
    expect(events).toEqual(["Archived 1 Codex thread and moved 3 Claude session folders to the Trash that Orchestrator's runs left"]);
    expect(hk.status()).toMatchObject({ running: false, everyHours: 6, ownerApps: true, last: { archived: 1, trashed: 3 } });
    expect(recent).toBeTruthy();
  });

  it("skips a thread another app holds open, says so, and archives it at the next sweep", async () => {
    const held = codexThread(1, "orchestration");
    const other = codexThread(2, "orchestration");
    const holding = new Set([held]);
    const { hk, events } = keeper({ archive: fakeArchive(holding) });
    const first = await hk.sweep("start");
    expect(first).toMatchObject({ archived: 1, held: 1 });
    expect(events).toEqual(["Archived 1 Codex thread that Orchestrator's runs left; 1 thread is held open by another app"]);
    holding.clear();
    const second = await hk.sweep("timer");
    expect(second).toMatchObject({ archived: 2, held: 0 }); // the fake leaves files in place, so both are found again
    expect(other).toBeTruthy();
  });

  it("never follows a link", async () => {
    // The owner's real folders, reached only through links.
    const elsewhere = join(home, "elsewhere");
    const target = join(elsewhere, "sessions");
    mkdirSync(join(target, "2026"), { recursive: true });
    writeFileSync(join(target, "2026", `rollout-${uuid(9)}.jsonl`), JSON.stringify({ type: "session_meta", payload: { id: uuid(9), originator: "orchestration" } }) + "\n");
    setTime(join(target, "2026", `rollout-${uuid(9)}.jsonl`), OLD);
    // A link inside sessions/ to a folder, and a linked session file.
    codexThread(1, "codex_work_desktop");
    symlinkSync(join(target, "2026"), join(home, ".codex", "sessions", "linked-dir"));
    symlinkSync(join(target, "2026", `rollout-${uuid(9)}.jsonl`), join(home, ".codex", "sessions", "2026", "10", "02", `rollout-${uuid(9)}.jsonl`));
    // A Claude session folder's name that is a link to the owner's folder.
    const ownFolder = join(elsewhere, "keep-me");
    mkdirSync(ownFolder);
    writeFileSync(join(ownFolder, "notes.md"), "mine");
    mkdirSync(join(home, ".claude", "projects"), { recursive: true });
    const linkName = claudeProjectName(join(data, "worktrees", "x", "run-1"));
    symlinkSync(ownFolder, join(home, ".claude", "projects", linkName));

    const { hk } = keeper();
    expect(await hk.find()).toMatchObject({ codexThreads: [], claudeFolders: [] });
    await hk.sweep("owner");
    expect(lstatSync(join(home, ".claude", "projects", linkName)).isSymbolicLink()).toBe(true);
    expect(existsSync(join(ownFolder, "notes.md"))).toBe(true);
    expect(trashed()).toEqual([]);

    // A root that is a link is not read at all.
    rmSync(join(home, ".codex"), { recursive: true });
    mkdirSync(join(home, ".codex"));
    symlinkSync(target, join(home, ".codex", "sessions"));
    rmSync(join(home, ".claude", "projects"), { recursive: true });
    mkdirSync(join(elsewhere, "projects", claudeProjectName(join(data, "worktrees", "y"))), { recursive: true });
    symlinkSync(join(elsewhere, "projects"), join(home, ".claude", "projects"));
    expect(await hk.find()).toMatchObject({ codexThreads: [], claudeFolders: [] });
  });

  it("never runs two at once: a second request gets the running sweep", async () => {
    codexThread(1, "orchestration");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const archive = async (ids: string[]) => {
      calls++;
      await gate;
      return new Map<string, ArchiveOutcome>(ids.map((id) => [id, "archived"]));
    };
    let changes = 0;
    const { hk } = keeper({ archive, changed: () => changes++ });
    const a = hk.sweep("start");
    const b = hk.sweep("owner");
    expect(b).toBe(a);
    expect(hk.status().running).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(1);
    release();
    expect((await a).trigger).toBe("start");
    expect(hk.status().running).toBe(false);
    expect(changes).toBe(2); // started, ended
    await hk.sweep("owner");
    expect(calls).toBe(2);
  });

  it("leaves the owner's apps alone when the setting is off, or in the simulated runtime; its own containers are still removed", async () => {
    codexThread(1, "orchestration");
    claudeFolder(join(data, "worktrees", "x", "run-1"), { memoryOnly: true });
    const removed: string[] = [];
    const docker: DockerOps = { list: async () => [{ name: "orc-rec-999999-0123456789ab", createdMs: NOW }], remove: async (n) => void removed.push(n) };
    const calls: string[][] = [];
    for (const o of [{ ownerApps: () => false }, { ownerAppsAllowed: false }]) {
      removed.length = 0;
      const { hk, events } = keeper({ ...o, archive: fakeArchive(new Set(), calls), docker, alive: () => false });
      const r = await hk.sweep("timer");
      expect(r).toMatchObject({ ownerApps: false, archived: 0, trashed: 0, containers: 1 });
      expect(removed).toEqual(["orc-rec-999999-0123456789ab"]);
      expect(events).toEqual(["Removed 1 recorder container that Orchestrator's runs left"]);
    }
    expect(calls).toEqual([]);
    expect(trashed()).toEqual([]);
    expect(sessions()).toHaveLength(1);
  });

  it("gives a folder a free name in the Trash, and on other systems only reports it", async () => {
    const name = claudeFolder(join(data, "worktrees", "x", "run-1"), { memoryOnly: true });
    mkdirSync(join(home, ".Trash", name));
    writeFileSync(join(home, ".Trash", name, "older.txt"), "an older copy");
    const { hk } = keeper();
    expect(await hk.sweep("owner")).toMatchObject({ trashed: 1 });
    expect(trashed()).toEqual([name, `${name} 2`]);
    expect(existsSync(join(home, ".Trash", name, "older.txt"))).toBe(true);

    const again = claudeFolder(join(data, "worktrees", "x", "run-2"), { memoryOnly: true });
    const linux = keeper({ platform: "linux" }).hk;
    const r = await linux.sweep("owner");
    expect(r.trashed).toBe(0);
    expect(r.notes).toEqual([`Claude session folder ${again} left in place: moving it to the Trash works on macOS only`]);
    expect(projects()).toEqual([again]);
  });

  it("reports what it could not clean, and records no event when nothing changed", async () => {
    codexThread(1, "orchestration");
    const { hk, events } = keeper({ archive: async (ids) => new Map(ids.map((id) => [id, { error: "no rollout found" }])), docker: { list: async () => ({ unavailable: "Docker did not answer, so the recorder's containers were not checked" }), remove: async () => undefined } });
    const r = await hk.sweep("owner");
    expect(r.notes).toEqual(["Docker did not answer, so the recorder's containers were not checked", `Codex thread ${uuid(1)} was not archived: no rollout found`]);
    expect(events).toEqual([]);
  });
});

describe("the recorder's containers", () => {
  const o = { pid: 100, alive: (pid: number) => pid === 100 || pid === 200, now: NOW };
  it("are left when their service still runs a job; removed when it has gone or no job runs that long", () => {
    expect(orphanContainer("orc-rec-100-0123456789ab", NOW - 10 * STAGE_SWEEP_AGE_MS, o)).toBe(false); // this service's own
    expect(orphanContainer("orc-ev-200-0123456789ab", NOW - 60_000, o)).toBe(false); // another live service's, young
    expect(orphanContainer("orc-ev-200-0123456789ab", NOW - STAGE_SWEEP_AGE_MS, o)).toBe(true); // older than any job
    expect(orphanContainer("orc-probe-300-0123456789ab", NOW, o)).toBe(true); // its service has gone
    expect(orphanContainer("orc-rec-300-0123456789ab", Number.NaN, o)).toBe(true);
    expect(orphanContainer("orc-ev-200-0123456789ab", Number.NaN, o)).toBe(false); // no time: only a gone service decides
  });
  it("are only the recorder's names", () => {
    for (const name of ["orc-hkprobe-1", "orc-rec-300-0123456789", "orc-rec-300-0123456789abc", "my-orc-rec-300-0123456789ab", "postgres", "orc-build-300-0123456789ab"]) expect(orphanContainer(name, 0, o)).toBe(false);
  });
  it("reads Docker's creation time", () => {
    expect(dockerTime("2026-10-02 19:48:03 -0700 PDT")).toBe(Date.parse("2026-10-03T02:48:03Z"));
    expect(dockerTime("about an hour ago")).toBeNaN();
  });
});

describe("the Activity event", () => {
  const base: SweepReport = { at: "", trigger: "timer", ownerApps: true, archived: 0, trashed: 0, containers: 0, stages: 0, held: 0, recent: 0, notes: [] };
  it("says what changed, in the owner's words", () => {
    expect(sweepMessage({ ...base, archived: 2, trashed: 1, held: 1 })).toBe("Archived 2 Codex threads and moved 1 Claude session folder to the Trash that Orchestrator's runs left; 1 thread is held open by another app");
    expect(sweepMessage({ ...base, archived: 1, containers: 2, stages: 1, held: 2 })).toBe(
      "Archived 1 Codex thread, removed 2 recorder containers and removed 1 recorder stage folder that Orchestrator's runs left; 2 threads are held open by other apps",
    );
  });
  it("is not recorded for a sweep that changed nothing", () => {
    expect(sweepMessage({ ...base, held: 3, recent: 2, notes: ["x"] })).toBeUndefined();
  });
});
