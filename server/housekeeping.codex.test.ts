// Housekeeping's Codex part against the real, pinned Codex CLI (node_modules/.bin/codex) in a temporary CODEX_HOME:
// no sign-in, no model, no network, and never the owner's ~/.codex. A thread a run left is archived (Codex moves its
// session file to archived_sessions and keeps it there); a thread that a live app-server holds open is reported as
// held, stays, and is archived at the next sweep once it is free. The owner's own thread is never asked about.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Housekeeping, MIN_AGE_MS } from "./housekeeping";
import { CODEX_CLIENT_NAME, CodexAdapter, defaultCodexPath } from "./runtimes/codex";
import { JsonRpcConnection } from "./runtimes/codexRpc";

const codex = defaultCodexPath();
let home: string;
let codexHome: string;
let holder: ChildProcess | undefined;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "orc-hk-codex-")));
  codexHome = join(home, ".codex");
});
afterEach(() => {
  holder?.kill("SIGKILL");
  holder = undefined;
  rmSync(home, { recursive: true, force: true });
});

const env = () => ({ PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome });
const DAY = () => join(codexHome, "sessions", "2026", "10", "02");

/** A session file as Codex writes one: its first line is the session_meta with the client's name as originator. */
function thread(id: string, originator: string) {
  mkdirSync(DAY(), { recursive: true });
  const meta = { timestamp: "2026-10-03T02:46:51.661Z", type: "session_meta", payload: { session_id: id, id, timestamp: "2026-10-03T02:46:51.619Z", cwd: home, originator, cli_version: "0.159.2", source: "vscode", model_provider: "openai" } };
  writeFileSync(sessionFile(id), JSON.stringify(meta) + "\n");
  age(id);
}
const sessionFile = (id: string) => join(DAY(), `rollout-2026-10-02T19-46-51-${id}.jsonl`);
/** Older than housekeeping's hour: a file written more recently may belong to a live run, and is left. */
function age(id: string) {
  const old = (Date.now() - 2 * MIN_AGE_MS) / 1000;
  utimesSync(sessionFile(id), old, old);
}

/** Another app holding a thread open: an app-server that resumed it. */
async function hold(threadId: string) {
  holder = spawn(codex, ["app-server"], { env: env(), stdio: ["pipe", "pipe", "ignore"] });
  const rpc = new JsonRpcConnection(holder.stdout!, holder.stdin!);
  await rpc.request("initialize", { clientInfo: { name: "another-app", title: "Another app", version: "1" }, capabilities: null }, 20_000);
  rpc.notify("initialized");
  await rpc.request("thread/resume", { threadId }, 20_000);
}

const files = (dir: string) => (existsSync(dir) ? readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".jsonl")).sort() : []);

it.skipIf(!existsSync(codex))(
  "archives a thread a run left, reports one another app holds open, and archives that one when it is free",
  async () => {
    const left = "01a0ffa8-0000-7000-8000-00000000000a";
    const held = "01a0ffa8-0000-7000-8000-00000000000b";
    const owners = "01a0ffa8-0000-7000-8000-00000000000c";
    thread(left, CODEX_CLIENT_NAME);
    thread(held, CODEX_CLIENT_NAME);
    thread(owners, "codex_work_desktop");
    await hold(held);
    // Resuming writes to the file: a thread opened now is left as recent. One held open for over an hour is asked about.
    const r0 = await new Housekeeping({ home, env: { CODEX_HOME: codexHome }, ownedFolders: [], ownerApps: () => true, ownerAppsAllowed: true }).find();
    expect(r0).toMatchObject({ codexThreads: [{ id: left }], recent: 1 });
    age(held);

    const adapter = new CodexAdapter({ codexPath: codex, env: env(), probeTimeoutMs: 20_000 });
    const asked: string[][] = [];
    const hk = new Housekeeping({
      home,
      env: { CODEX_HOME: codexHome },
      ownedFolders: [],
      ownerApps: () => true,
      ownerAppsAllowed: true,
      archive: (ids) => {
        asked.push(ids);
        return adapter.archiveThreads(ids);
      },
    });

    const first = await hk.sweep("owner");
    expect(first).toMatchObject({ archived: 1, held: 1, notes: [] });
    expect(asked).toEqual([[left, held]]);
    expect(files(join(codexHome, "archived_sessions"))).toEqual([`rollout-2026-10-02T19-46-51-${left}.jsonl`]);
    expect(files(join(codexHome, "sessions"))).toEqual([`2026/10/02/rollout-2026-10-02T19-46-51-${held}.jsonl`, `2026/10/02/rollout-2026-10-02T19-46-51-${owners}.jsonl`]);

    holder!.kill("SIGKILL");
    await new Promise((r) => holder!.once("exit", r));
    const second = await hk.sweep("timer");
    expect(second).toMatchObject({ archived: 1, held: 0, notes: [] });
    expect(asked).toEqual([[left, held], [held]]);
    expect(files(join(codexHome, "sessions"))).toEqual([`2026/10/02/rollout-2026-10-02T19-46-51-${owners}.jsonl`]);
  },
  60_000,
);
