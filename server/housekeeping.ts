// Housekeeping: what Orchestrator's runs leave on this computer, found and cleaned up (the owner, 2026-10-03: "can you
// cleanup orphaned codex chat sessions and can we build some management of orphaned sessions into the factory?").
// Runs start Codex threads with `ephemeral: true` and Claude sessions with `persistSession: false`, so a run leaves
// nothing. Leftovers still come from a provider version that ignores the flag, a crash, or a script.
//
// What it finds, each only when it can prove that Orchestrator made it:
//   Codex threads    a session file under <CODEX_HOME>/sessions whose first line (session_meta) names Orchestrator's
//                    client (CODEX_CLIENT_NAME) as its originator. Codex writes that name from the client's
//                    `initialize`, and no other client of Codex uses it.
//   Claude sessions  a folder under <Claude's config folder>/projects whose name is the Claude CLI's name for a working
//                    folder Orchestrator owns (its worktrees, its studio folders, this repository's evidence/), and
//                    whose transcripts, if it has any, say that they ran in one. The name alone is lossy (every
//                    character other than a letter or a digit becomes "-"), so a transcript's own `cwd` decides.
//   Containers       a Docker container the recorder named (orc-rec-, orc-probe-, orc-ev-, then the pid of the
//                    service that started it) whose service has gone, or that is older than any job runs.
//   The project      a container or network with the environment's label (orchestrator.environment), whose service
//   environment's    has gone (its name carries the pid) or that is older than any step (LEFTOVER_AGE_MS); then the
//   leftovers        scratch folders under the environment's root (scratchFolders) older than that, but only once
//                    Docker lists no container of the environment that could still mount them.
//   Stage folders    the recorder's, by sweepStages (studio/container.ts).
// Not found: a provider process that outlived the service that started it. The service records its children only in
// memory (processes.ts) and kills them when it exits; nothing on disk proves which process an earlier service started.
//
// What it does: it archives the threads through Codex's app-server (Codex keeps them, and the owner can unarchive
// them), moves the folders to the macOS Trash (on other systems it only reports them), and removes the containers
// (the service's own throwaway ones). An item changed in the last hour is left for the next sweep, because a live run
// may still write it. Nothing of the owner's is deleted, and no link is followed.

import { constants } from "node:fs";
import { lstat, open, readdir, realpath, rename } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { HousekeepingInfo, SweepReport } from "../src/api";
import { removeTree } from "./environment/copy";
import { LABEL } from "./environment/docker";
import { LEFTOVER_AGE_MS, scratchFolders } from "./environment/prepared";
import { CODEX_CLIENT_NAME, type ArchiveOutcome } from "./runtimes/codex";
import { STAGE_SWEEP_AGE_MS, dockerEnv, findDocker, runDocker, sweepStages } from "./studio/container";

/**
 * Six hours between two sweeps. Leftovers are rare (a crash, a provider that ignores the flag, a script), a crash
 * also means a restart, which sweeps, and a cluttered sidebar is not urgent within hours. A sweep reads two folders
 * and asks Docker for one list; it starts Codex's app-server only when there is a thread to archive.
 */
export const SWEEP_EVERY_MS = 6 * 60 * 60_000;
/** An item changed more recently than this may belong to a live run: the next sweep looks at it again. */
export const MIN_AGE_MS = 60 * 60_000;

/**
 * The folder name the Claude CLI gives a working folder under <config>/projects (Claude Agent SDK 0.3.285, core.mjs):
 * every character other than an ASCII letter or digit becomes "-". The CLI cuts a name longer than 200 characters to
 * 200 and adds "-" and a hash of the path. Housekeeping compares only the start of a name with an owned folder's name
 * shorter than 200 characters, so it needs no hash.
 */
export function claudeProjectName(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, "-");
}

/** The recorder's container names (studio/container.ts, containerName): what it records, the service's pid, 12 hex digits. */
const RECORDER_CONTAINER = /^orc-(?:rec|probe|ev)-(\d+)-[0-9a-f]{12}$/;
/** The environment's names (environment/docker.ts, envName): its kind, the service's pid, 10 hex digits. */
const ENV_NAME = /^orc-env-[a-z]+-(\d+)-[0-9a-f]{10}$/;

/**
 * Whether a container is one the recorder left: named by the recorder, not this service's (its own end on their own
 * time limits), and either its service has gone or it is older than any job (STAGE_SWEEP_AGE_MS). A pid that is in use
 * may be another service on this computer, or a new process with an old number: then only the age decides.
 */
export function orphanContainer(name: string, createdMs: number, o: { pid: number; alive: (pid: number) => boolean; now: number }): boolean {
  const m = RECORDER_CONTAINER.exec(name);
  if (!m) return false;
  const pid = Number(m[1]);
  if (pid === o.pid) return false;
  return !o.alive(pid) || o.now - createdMs >= STAGE_SWEEP_AGE_MS;
}

/**
 * Whether a container or network is one Orchestrator left: the recorder's by its name (orphanContainer); the project
 * environment's by its label, which only the service sets, and then by its name's pid or its age. Never this service's
 * own; a live service's only once it is older than any step (a pid in use may also be a new process with an old number).
 */
export function leftover(t: DockerThing, o: { pid: number; alive: (pid: number) => boolean; now: number }): boolean {
  if (t.environment === undefined) return t.kind === "container" && orphanContainer(t.name, t.createdMs, o);
  const m = ENV_NAME.exec(t.name);
  const pid = m ? Number(m[1]) : undefined;
  if (pid === o.pid) return false;
  return (pid !== undefined && !o.alive(pid)) || o.now - t.createdMs >= LEFTOVER_AGE_MS;
}

/** Whether a process with this pid exists (EPERM: it exists, under another user). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A container or a network, as housekeeping sees it. */
export interface DockerThing {
  kind: "container" | "network";
  name: string;
  /** When Docker made it; NaN when Docker's time could not be read. */
  createdMs: number;
  /** The value of the environment's label (orchestrator.environment), when it has one. */
  environment?: string;
}

/** The Docker commands housekeeping needs. */
export interface DockerOps {
  /**
   * Every container whose name starts with "orc-" or that has the environment's label, then every network with that
   * label, each with the time it was made; or why Docker could not answer.
   */
  list(): Promise<DockerThing[] | { unavailable: string }>;
  /** Removes a container or a network; the reason when it could not. */
  remove(t: DockerThing): Promise<string | undefined>;
}

/** The docker command on this computer, or undefined when there is none (then there are no containers either). */
export function systemDocker(env: NodeJS.ProcessEnv): DockerOps | undefined {
  const docker = findDocker(env);
  if (!docker) return undefined;
  const denv = dockerEnv(env);
  const format = `{{.Names}}\t{{.CreatedAt}}\t{{.Label "${LABEL}"}}`;
  const parse = (kind: DockerThing["kind"], stdout: string): DockerThing[] =>
    stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name, created = "", label = ""] = line.split("\t");
        return { kind, name, createdMs: dockerTime(created), ...(label ? { environment: label } : {}) };
      });
  return {
    async list() {
      const unavailable = { unavailable: "Docker did not answer, so its containers and networks were not checked" };
      // Every container: only their names and labels are read, and only Orchestrator's (by name or label) are kept.
      const c = await runDocker(docker, ["ps", "--all", "--no-trunc", "--format", format], { env: denv, timeoutMs: 20_000 });
      if (c.code !== 0) return unavailable;
      const n = await runDocker(docker, ["network", "ls", "--no-trunc", "--filter", `label=${LABEL}`, "--format", format.replace("{{.Names}}", "{{.Name}}")], { env: denv, timeoutMs: 20_000 });
      if (n.code !== 0) return unavailable;
      return [...parse("container", c.stdout).filter((t) => t.name.startsWith("orc-") || t.environment !== undefined), ...parse("network", n.stdout).filter((t) => t.environment !== undefined)];
    },
    async remove(t) {
      const r = await runDocker(docker, t.kind === "container" ? ["rm", "--force", t.name] : ["network", "rm", t.name], { env: denv, timeoutMs: 30_000 });
      return r.code === 0 ? undefined : r.stderr.trim().split("\n").at(-1) || `docker exited with ${r.code}`;
    },
  };
}

/** Docker's CreatedAt ("2026-10-02 19:48:03 -0700 PDT"; a network's has fractions of a second) as milliseconds; NaN when it is not that shape. */
export function dockerTime(s: string): number {
  const m = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)(\.\d{1,3})?\d* ([+-]\d\d)(\d\d)\b/.exec(s.trim());
  return m ? Date.parse(`${m[1]}T${m[2]}${m[3] ?? ""}${m[4]}:${m[5]}`) : NaN;
}

/** What a sweep found: the dry run's answer. */
export interface Found {
  codexThreads: { id: string; file: string }[];
  claudeFolders: { name: string; path: string }[];
  /** Containers first, then networks: a network goes only once no container uses it. */
  docker: DockerThing[];
  /** The environment's scratch folders old enough to go, and whether no container of the environment remains to mount them. */
  folders: { paths: string[]; blocked?: string };
  recent: number;
  notes: string[];
}

export interface HousekeepingOptions {
  /** The owner's home folder: .codex, .claude and .Trash are under it (tests give a temporary one). */
  home: string;
  /** CODEX_HOME and CLAUDE_CONFIG_DIR, read as Codex and the Claude CLI read them. */
  env: NodeJS.ProcessEnv;
  /** The working folders Orchestrator owns. A Claude session folder is Orchestrator's only when it names one of them. */
  ownedFolders: string[];
  /** Whether this sweep cleans the owner's own apps (Codex threads, Claude session folders): the owner's setting. */
  ownerApps: () => boolean;
  /** False in the simulated runtime: it never touches the owner's apps, whatever the setting says. */
  ownerAppsAllowed: boolean;
  /** Archives threads through Codex's app-server. Without it, threads are found and left. */
  archive?: (ids: string[]) => Promise<Map<string, ArchiveOutcome>>;
  docker?: DockerOps;
  /** Where the recorder stages its folders; without it, stage folders are not swept. */
  recorderRoot?: string;
  /** The project environment's root (environment/prepared.ts); without it, its scratch folders are not swept. */
  environmentRoot?: string;
  platform?: NodeJS.Platform;
  now?: () => number;
  pid?: number;
  alive?: (pid: number) => boolean;
  /** Records the Activity event of a sweep that changed something. */
  record?: (message: string) => void;
  /** Called when the status changes (a sweep starts or ends), so the app shows it. */
  changed?: () => void;
  log?: (msg: string) => void;
}

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A session file's first line is about 20 KB (it holds the base instructions); a transcript's first `cwd` comes early. */
const HEAD_BYTES = 1024 * 1024;
const MAX_DEPTH = 6;

export class Housekeeping {
  private running?: Promise<SweepReport>;
  private last?: SweepReport;
  private readonly now: () => number;

  constructor(private readonly o: HousekeepingOptions) {
    this.now = o.now ?? Date.now;
  }

  status(): HousekeepingInfo {
    return { running: !!this.running, everyHours: SWEEP_EVERY_MS / 3_600_000, ownerApps: this.o.ownerAppsAllowed, ...(this.last ? { last: this.last } : {}) };
  }

  /** One sweep. A sweep asked for while one runs gets that one's report: two never run at once. Never rejects. */
  sweep(trigger: SweepReport["trigger"]): Promise<SweepReport> {
    if (this.running) return this.running;
    const run = this.run(trigger)
      .catch((e: unknown) => {
        const r: SweepReport = { at: new Date(this.now()).toISOString(), trigger, ownerApps: false, archived: 0, trashed: 0, containers: 0, networks: 0, stages: 0, held: 0, recent: 0, notes: [`The sweep stopped: ${e instanceof Error ? e.message : String(e)}`] };
        this.last = r;
        this.o.log?.(`Housekeeping: ${r.notes[0]}`);
        return r;
      })
      .finally(() => {
        this.running = undefined;
        this.o.changed?.();
      });
    this.running = run;
    this.o.changed?.();
    return run;
  }

  /** What a sweep would clean now, without changing anything (the dry run). */
  async find(): Promise<Found> {
    const found: Found = { codexThreads: [], claudeFolders: [], docker: [], folders: { paths: [] }, recent: 0, notes: [] };
    if (this.ownerApps()) {
      await this.findCodexThreads(found);
      await this.findClaudeFolders(found);
    }
    await this.findDocker(found);
    return found;
  }

  private ownerApps() {
    return this.o.ownerAppsAllowed && this.o.ownerApps();
  }

  private async run(trigger: SweepReport["trigger"]): Promise<SweepReport> {
    const ownerApps = this.ownerApps();
    const found = await this.find();
    const r: SweepReport = { at: "", trigger, ownerApps, archived: 0, trashed: 0, containers: 0, networks: 0, stages: 0, held: 0, recent: found.recent, notes: found.notes };
    if (found.codexThreads.length) {
      if (!this.o.archive) r.notes.push(`${count(found.codexThreads.length, "Codex thread")} left: this service has no Codex app-server to archive them`);
      else {
        const outcomes = await this.o.archive(found.codexThreads.map((t) => t.id));
        for (const t of found.codexThreads) {
          const out = outcomes.get(t.id) ?? { error: "Codex did not answer" };
          if (out === "archived") r.archived++;
          else if (out === "held") r.held++;
          else r.notes.push(`Codex thread ${t.id} was not archived: ${out.error}`);
        }
      }
    }
    for (const f of found.claudeFolders) {
      if ((this.o.platform ?? process.platform) !== "darwin") {
        r.notes.push(`Claude session folder ${f.name} left in place: moving it to the Trash works on macOS only`);
        continue;
      }
      try {
        if (await this.moveToTrash(f.path, f.name)) r.trashed++;
      } catch (e) {
        r.notes.push(`Claude session folder ${f.name} was not moved to the Trash: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    for (const t of found.docker) {
      const err = await this.o.docker!.remove(t);
      if (err) r.notes.push(`${t.kind === "container" ? "Container" : "Network"} ${t.name} was not removed: ${err}`);
      else if (t.kind === "container") r.containers++;
      else r.networks++;
    }
    if (this.o.recorderRoot) {
      const swept = sweepStages(this.o.recorderRoot);
      r.stages = swept.removed.length;
      for (const name of swept.failed) r.notes.push(`Stage folder ${name} in ${this.o.recorderRoot} was not removed`);
    }
    await this.removeFolders(found.folders, r);
    r.at = new Date(this.now()).toISOString();
    this.last = r;
    const message = sweepMessage(r);
    if (message) {
      this.o.log?.(`Housekeeping: ${message}`);
      try {
        this.o.record?.(message);
      } catch (e) {
        r.notes.push(`The Activity event was not recorded: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    for (const n of r.notes) this.o.log?.(`Housekeeping: ${n}`);
    return r;
  }

  // ---------- Codex ----------

  private async findCodexThreads(found: Found) {
    const root = join(this.o.env.CODEX_HOME ? resolve(this.o.env.CODEX_HOME) : join(this.o.home, ".codex"), "sessions");
    for (const file of await sessionFiles(root, 0)) {
      const head = await readHead(file);
      if (!head) continue;
      const nl = head.text.indexOf("\n");
      let meta: { type?: unknown; payload?: { originator?: unknown; id?: unknown } };
      try {
        meta = JSON.parse(nl >= 0 ? head.text.slice(0, nl) : head.text);
      } catch {
        continue;
      }
      if (meta?.type !== "session_meta" || meta.payload?.originator !== CODEX_CLIENT_NAME) continue;
      const id = meta.payload.id;
      if (typeof id !== "string" || !THREAD_ID.test(id)) continue;
      if (this.now() - head.mtimeMs < MIN_AGE_MS) found.recent++;
      else found.codexThreads.push({ id, file });
    }
  }

  // ---------- Claude ----------

  private async findClaudeFolders(found: Found) {
    const config = this.o.env.CLAUDE_CONFIG_DIR ? resolve(this.o.env.CLAUDE_CONFIG_DIR) : join(this.o.home, ".claude");
    const root = join(config, "projects");
    const owned = await ownedPaths(this.o.ownedFolders);
    const prefixes = owned.map(claudeProjectName).filter((p) => p.length < 200);
    for (const e of await listDir(root)) {
      if (!e.isDirectory()) continue; // a link is never followed
      if (!prefixes.some((p) => e.name === p || e.name.startsWith(`${p}-`))) continue;
      const path = join(root, e.name);
      const look = await lookInto(path, owned);
      if (!look || look.foreign) continue;
      if (this.now() - look.newestMs < MIN_AGE_MS) found.recent++;
      else found.claudeFolders.push({ name: e.name, path });
    }
  }

  /** Moves a folder into the Trash under a name not in use there ("name", then "name 2", …). False when it was gone already. */
  private async moveToTrash(path: string, name: string): Promise<boolean> {
    const trash = join(this.o.home, ".Trash");
    const st = await lstat(trash).catch(() => undefined);
    if (!st?.isDirectory()) throw new Error(`there is no Trash folder at ${trash}`);
    for (let i = 1; i < 100; i++) {
      const target = join(trash, i === 1 ? name : `${name} ${i}`);
      if (await lstat(target).then(() => true, () => false)) continue;
      try {
        await rename(path, target);
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw e;
      }
    }
    throw new Error("the Trash has no free name for it");
  }

  // ---------- Docker, and the environment's scratch folders ----------

  /**
   * The containers and networks Orchestrator left (containers first: a network goes only once no container uses it),
   * and the environment's scratch folders older than any step. A folder may still be mounted by a container of the
   * environment, so it goes only while Docker lists none that stays, or there is no Docker at all.
   */
  private async findDocker(found: Found) {
    const list = this.o.docker ? await this.o.docker.list() : [];
    if ("unavailable" in list) found.notes.push(list.unavailable);
    const o = { pid: this.o.pid ?? process.pid, alive: this.o.alive ?? pidAlive, now: this.now() };
    const things = "unavailable" in list ? [] : list;
    found.docker = things.filter((t) => leftover(t, o)).sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "container" ? -1 : 1));
    if (!this.o.environmentRoot) return;
    for (const p of scratchFolders(this.o.environmentRoot)) {
      const st = await lstat(p).catch(() => undefined);
      if (st?.isDirectory() && o.now - st.mtimeMs >= LEFTOVER_AGE_MS) found.folders.paths.push(p);
    }
    if ("unavailable" in list) found.folders.blocked = "Docker did not answer, so nothing shows that no container uses it";
    else if (things.some((t) => t.kind === "container" && t.environment !== undefined && !leftover(t, o))) found.folders.blocked = STILL_MOUNTED;
  }

  /** The folders go only when, after the sweep's own removals, Docker lists no container of the environment. */
  private async removeFolders(f: Found["folders"], r: SweepReport) {
    if (!f.paths.length) return;
    let blocked = f.blocked;
    if (!blocked && this.o.docker) {
      const after = await this.o.docker.list();
      if ("unavailable" in after) blocked = "Docker did not answer, so nothing shows that no container uses it";
      else if (after.some((t) => t.kind === "container" && t.environment !== undefined)) blocked = STILL_MOUNTED;
    }
    if (blocked) return void r.notes.push(`${count(f.paths.length, "work folder")} of the project environment left: ${blocked}`);
    for (const p of f.paths) {
      try {
        removeTree(p);
        r.stages++;
      } catch (e) {
        r.notes.push(`Work folder ${p} was not removed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}

const STILL_MOUNTED = "a container of the environment may still use it";

/** The Activity event of a sweep, or undefined when it changed nothing. */
export function sweepMessage(r: SweepReport): string | undefined {
  const done = [
    r.archived ? `archived ${count(r.archived, "Codex thread")}` : "",
    r.trashed ? `moved ${count(r.trashed, "Claude session folder")} to the Trash` : "",
    r.containers ? `removed ${count(r.containers, "container")}` : "",
    r.networks ? `removed ${count(r.networks, "Docker network")}` : "",
    r.stages ? `removed ${count(r.stages, "work folder")}` : "",
  ].filter(Boolean);
  if (!done.length) return undefined;
  const list = done.length === 1 ? done[0] : `${done.slice(0, -1).join(", ")} and ${done.at(-1)}`;
  const held = r.held ? `; ${r.held === 1 ? "1 thread is held open by another app" : `${r.held} threads are held open by other apps`}` : "";
  return `${list[0].toUpperCase()}${list.slice(1)} that Orchestrator's runs left${held}`;
}

const count = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;

// ---------- reading the disk: never through a link ----------

async function listDir(dir: string) {
  try {
    if (!(await lstat(dir)).isDirectory()) return [];
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** The .jsonl files under Codex's sessions folder (YYYY/MM/DD), through real folders only. */
async function sessionFiles(dir: string, depth: number): Promise<string[]> {
  if (depth > MAX_DEPTH) return [];
  const out: string[] = [];
  for (const e of await listDir(dir)) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await sessionFiles(p, depth + 1)));
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

/** The start of a regular file, opened without following a link, and its time. */
async function readHead(file: string): Promise<{ text: string; mtimeMs: number } | undefined> {
  let fh;
  try {
    fh = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = await fh.stat();
    if (!st.isFile()) return undefined;
    const buf = Buffer.alloc(Math.min(HEAD_BYTES, st.size));
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return { text: buf.subarray(0, bytesRead).toString("utf8"), mtimeMs: st.mtimeMs };
  } catch {
    return undefined;
  } finally {
    await fh?.close();
  }
}

/** The owned folders as given and as the system resolves them (the CLI names a session by its real working folder). */
async function ownedPaths(folders: string[]): Promise<string[]> {
  const out = new Set<string>();
  for (const f of folders) {
    out.add(resolve(f));
    const real = await realpath(f).catch(() => undefined);
    if (real) out.add(real);
  }
  return [...out];
}

const inside = (path: string, roots: string[]) => roots.some((r) => path === r || path.startsWith(r + sep));

/**
 * A Claude session folder's newest change (the folder and its entries), and whether a transcript in it ran outside
 * Orchestrator's folders. The first `cwd` of each top-level transcript decides; a folder with none (only `memory/`,
 * say) is judged by its name.
 */
async function lookInto(dir: string, owned: string[]): Promise<{ newestMs: number; foreign: boolean } | undefined> {
  let newestMs: number;
  try {
    newestMs = (await lstat(dir)).mtimeMs;
  } catch {
    return undefined;
  }
  let foreign = false;
  for (const e of await listDir(dir)) {
    const p = join(dir, e.name);
    const st = await lstat(p).catch(() => undefined);
    if (st) newestMs = Math.max(newestMs, st.mtimeMs);
    if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
    const cwd = transcriptCwd((await readHead(p))?.text ?? "");
    if (cwd !== undefined && !inside(cwd, owned)) foreign = true;
  }
  return { newestMs, foreign };
}

/** The first `cwd` in a transcript's complete lines. */
export function transcriptCwd(text: string): string | undefined {
  for (const line of text.split("\n").slice(0, -1)) {
    try {
      const cwd = (JSON.parse(line) as { cwd?: unknown })?.cwd;
      if (typeof cwd === "string") return cwd;
    } catch {
      /* not a whole JSON line */
    }
  }
  return undefined;
}
