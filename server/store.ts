// Durable project store on SQLite (node:sqlite, no native dependency).
//
// The authoritative project state is one document, changed only by pure domain operations
// inside BEGIN IMMEDIATE transactions. Alongside it: an append-only command log with idempotency
// keys, a mirrored event table for querying, and a lease table for the single scheduler.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { InvalidCommandError, runCommand } from "../src/domain/commands";
import { buildSeed } from "../src/domain/seed";
import { ControlError, DEFAULT_AUTONOMY, DEFAULT_PR_DELIVERY, DEFAULT_RUN_LIMITS, StaleWriteError, type State } from "../src/domain/types";

export const STATE_FORMAT = 13;

/** In-place upgrades of the state document, keyed by the format they upgrade from. */
const MIGRATIONS: Record<number, (doc: Record<string, unknown>) => Record<string, unknown>> = {
  3: (doc) => {
    const project = doc.project as Record<string, unknown>;
    project.runLimits ??= { ...DEFAULT_RUN_LIMITS };
    doc.version = 4;
    return doc;
  },
  4: (doc) => {
    const project = doc.project as Record<string, unknown>;
    project.workerEnvironment ??= { claude: "isolated", codex: "isolated" };
    project.workerConnections ??= { claude: [], codex: [] };
    doc.version = 5;
    return doc;
  },
  5: (doc) => {
    const project = doc.project as Record<string, unknown>;
    project.sample ??= project.name === "Example Notes (sample)" || project.repoPath === "~/code/example-notes";
    project.id ??= project.sample ? "sample" : `p-${Date.now().toString(36)}`;
    doc.version = 6;
    return doc;
  },
  6: (doc) => {
    const project = doc.project as Record<string, unknown>;
    project.autonomy ??= { ...DEFAULT_AUTONOMY };
    doc.conversation ??= [];
    doc.leadRuns ??= [];
    doc.version = 7;
    return doc;
  },
  7: (doc) => {
    const a = (doc.project as Record<string, unknown>).autonomy as Record<string, unknown>;
    a.autoRetry ??= 0;
    a.autoDeliver ??= { enabled: false, branch: "main" };
    doc.version = 8;
    return doc;
  },
  8: (doc) => {
    const project = doc.project as Record<string, unknown>;
    const n = Number(project.workerLimit ?? 3);
    project.providerLimits ??= { claude: n, codex: n };
    doc.version = 9;
    return doc;
  },
  // ORC-008: pull-request delivery settings, off. Nothing observed and no review-later items are
  // created: earlier deliveries are never backfilled.
  9: (doc) => {
    const project = doc.project as Record<string, unknown>;
    project.prDelivery ??= structuredClone(DEFAULT_PR_DELIVERY);
    doc.version = 10;
    return doc;
  },
  // ORC-009: steering by conversation. Priorities the user set with the Set control are pinned from
  // their events (before ORC-009 only the user could reprioritize). Priorities chosen in the New task
  // form cannot be told apart from its default, so they are not pinned. Existing lead runs get no
  // visionRev: one that completes after the upgrade has its steering refused.
  10: (doc) => {
    const project = doc.project as Record<string, unknown>;
    doc.steering ??= [];
    project.steeringMode ??= "apply";
    const re = /^Priority P\d+ → P\d+$/;
    const tasks = (doc.tasks ?? []) as { id: string; userSet?: { priority?: string; run?: string } }[];
    for (const e of (doc.events ?? []) as { actor: string; kind: string; taskId?: string; message: string; at: string }[]) {
      if (e.actor !== "user" || e.kind !== "control" || !e.taskId || !re.test(e.message)) continue;
      const t = tasks.find((x) => x.id === e.taskId);
      if (t) (t.userSet ??= {}).priority = e.at;
    }
    doc.version = 11;
    return doc;
  },
  // ORC-012: the shaping stage. Every existing project keeps working as before (building); no drafts yet.
  11: (doc) => {
    const project = doc.project as Record<string, unknown>;
    project.stage ??= "building";
    doc.visionDrafts ??= [];
    doc.version = 12;
    return doc;
  },
  // ORC-014: vision documents. No project has any yet; existing revisions record none (`docIds` absent).
  // ORC-012 review 6: a project of the user's own with an empty vision cannot be building; it shapes first.
  // ORC-012 review 2: the roadmap's hold while shaping becomes its own flag; the user's hold before start
  // then follows the involvement setting, as a lead proposal's would.
  12: (doc) => {
    const project = doc.project as Record<string, unknown>;
    project.visionDocs ??= [];
    const visions = (project.visions ?? []) as { text?: unknown }[];
    const text = String(visions[visions.length - 1]?.text ?? "");
    const now = new Date().toISOString();
    const events = (doc.events ??= []) as { id: string; at: string; actor: string; kind: string; taskId?: string; message: string }[];
    if (!project.sample && !text.trim() && project.stage !== "shaping") {
      // ORC-014 review 12: a stage change is state the user can see: it is recorded, and shaping starts now.
      project.stage = "shaping";
      project.shapingSince = now;
      doc.seq = (typeof doc.seq === "number" ? doc.seq : 0) + 1;
      events.push({ id: `ev-${doc.seq}`, at: now, actor: "system", kind: "config", message: "Moved from building to shaping when the state format was upgraded: the project has no vision yet. Write or accept one, then start building." });
    }
    if (project.stage === "shaping") {
      project.shapingSince ??= now;
      const a = (project.autonomy ?? {}) as { enabled?: boolean; holdLeadProposals?: boolean };
      // ORC-014 review 12: a hold the user set on the task themselves stays the user's hold. The last
      // hold event decides: "enabled" by the user means theirs; released or removed means the roadmap's.
      const userHeld = new Set<string>();
      for (const e of events) {
        if (e.actor !== "user" || e.kind !== "control" || !e.taskId) continue;
        if (e.message === "Hold before start enabled") userHeld.add(e.taskId);
        else if (e.message === "Hold before start removed" || e.message.startsWith("Hold-before-start released")) userHeld.delete(e.taskId);
      }
      for (const t of (doc.tasks ?? []) as { id: string; fromShaping?: boolean; holdBeforeStart?: boolean; heldForShaping?: boolean; lifecycle?: string }[]) {
        if (!t.fromShaping || !t.holdBeforeStart || (t.lifecycle !== "proposed" && t.lifecycle !== "ready")) continue;
        if (userHeld.has(t.id)) continue;
        t.heldForShaping = true;
        t.holdBeforeStart = !a.enabled || !!a.holdLeadProposals;
      }
    }
    doc.version = 13;
    return doc;
  },
};
const SCHEMA_VERSION = 1;

export type FailureKind = "stale" | "control" | "invalid" | "internal";

export class CommandFailure extends Error {
  kind: FailureKind;
  constructor(kind: FailureKind, message: string) {
    super(message);
    this.name = "CommandFailure";
    this.kind = kind;
  }
}

function classify(e: unknown): CommandFailure {
  if (e instanceof CommandFailure) return e;
  const message = e instanceof Error ? e.message : String(e);
  if (e instanceof StaleWriteError) return new CommandFailure("stale", message);
  if (e instanceof ControlError) return new CommandFailure("control", message);
  if (e instanceof InvalidCommandError) return new CommandFailure("invalid", message);
  return new CommandFailure("internal", message);
}

export class LeaseLostError extends Error {
  constructor(name: string) {
    super(`Lease ${name} is no longer held by this instance`);
    this.name = "LeaseLostError";
  }
}

export interface CommandResult {
  version: number;
  result?: unknown;
  /** True when this idempotency key was already applied and the stored outcome was returned. */
  replayed: boolean;
}

export class Store {
  readonly path: string;
  private db: DatabaseSync;
  private listeners = new Set<() => void>();

  constructor(path: string, seed: () => State = () => buildSeed(Date.now(), { inFlightRuns: false })) {
    this.path = path;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.migrate();
    this.ensureState(seed);
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL,
        format INTEGER NOT NULL,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS commands (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key TEXT UNIQUE,
        name TEXT NOT NULL,
        args TEXT NOT NULL,
        at TEXT NOT NULL,
        version INTEGER NOT NULL,
        result TEXT,
        error_kind TEXT,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        at TEXT NOT NULL,
        actor TEXT NOT NULL,
        kind TEXT NOT NULL,
        task_id TEXT,
        message TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_task ON events (task_id, at);
      CREATE TABLE IF NOT EXISTS leases (name TEXT PRIMARY KEY, holder TEXT NOT NULL, expires_at INTEGER NOT NULL);
    `);
    this.db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO NOTHING").run(String(SCHEMA_VERSION));
  }

  private ensureState(seed: () => State) {
    this.tx(() => {
      // Read inside the transaction so two instances starting together cannot both seed.
      const row = this.db.prepare("SELECT format, version, json FROM state WHERE id = 1").get() as { format: number; version: number; json: string } | undefined;
      if (row && row.format === STATE_FORMAT) return;
      if (row && MIGRATIONS[row.format]) {
        // Upgrade in place, one format at a time, keeping a copy of the original.
        this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(`backup_format_${row.format}_v${row.version}`, row.json);
        let format = row.format;
        let doc = JSON.parse(row.json) as Record<string, unknown>;
        while (format < STATE_FORMAT && MIGRATIONS[format]) {
          doc = MIGRATIONS[format](doc);
          format += 1;
        }
        if (format === STATE_FORMAT) {
          this.db.prepare("UPDATE state SET version = ?, format = ?, json = ?, updated_at = ? WHERE id = 1").run(row.version + 1, STATE_FORMAT, JSON.stringify(doc), new Date().toISOString());
          // An event a migration records is mirrored like any other.
          this.mirrorEvents((JSON.parse(row.json) as { events?: State["events"] }).events ?? [], doc as unknown as State);
          return;
        }
      }
      if (row && row.format > STATE_FORMAT) {
        throw new Error(
          `The database at ${this.path} uses state format ${row.format}, which is newer than this version of Orchestrator supports (${STATE_FORMAT}). ` +
            "Update Orchestrator, or set ORCHESTRATION_DB to use a different database.",
        );
      }
      if (row) {
        // Prototype data from an older format: keep a copy, then start from the sample project.
        this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(`backup_format_${row.format}_v${row.version}`, row.json);
      }
      const s = seed();
      this.db
        .prepare("INSERT OR REPLACE INTO state (id, version, format, json, updated_at) VALUES (1, ?, ?, ?, ?)")
        .run((row?.version ?? 0) + 1, STATE_FORMAT, JSON.stringify(s), new Date().toISOString());
      this.mirrorEvents([], s);
    });
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  private load(): { version: number; state: State; json: string } {
    const row = this.db.prepare("SELECT version, json FROM state WHERE id = 1").get() as { version: number; json: string };
    return { version: row.version, state: JSON.parse(row.json) as State, json: row.json };
  }

  private persist(prevVersion: number, prev: State, next: State, now: string): number {
    const version = prevVersion + 1;
    const r = this.db.prepare("UPDATE state SET version = ?, json = ?, updated_at = ? WHERE id = 1 AND version = ?").run(version, JSON.stringify(next), now, prevVersion);
    if (r.changes !== 1) throw new Error("State version changed inside a transaction");
    this.mirrorEvents(prev.events, next);
    return version;
  }

  private mirrorEvents(prevEvents: State["events"], next: State) {
    const known = new Set(prevEvents.map((e) => e.id));
    const insert = this.db.prepare("INSERT OR REPLACE INTO events (id, at, actor, kind, task_id, message) VALUES (?, ?, ?, ?, ?, ?)");
    for (const e of next.events) if (!known.has(e.id)) insert.run(e.id, e.at, e.actor, e.kind, e.taskId ?? null, e.message);
  }

  read(): { version: number; state: State } {
    const { version, state } = this.load();
    return { version, state };
  }

  /** The command already recorded under an idempotency key, if any (its args as sent), so a retry is not re-validated as a new request. */
  recorded(idempotencyKey: string): { name: string; args: unknown } | undefined {
    const row = this.db.prepare("SELECT name, args FROM commands WHERE idempotency_key = ?").get(idempotencyKey) as { name: string; args: string } | undefined;
    return row ? { name: row.name, args: JSON.parse(row.args) as unknown } : undefined;
  }

  /**
   * Apply a named client command. A repeated idempotency key returns the recorded outcome
   * (success or failure) without applying the command again.
   */
  command(name: string, args: unknown, idempotencyKey: string, now: string): CommandResult {
    if (!idempotencyKey || idempotencyKey.length > 200) throw new CommandFailure("invalid", "idempotencyKey is required");
    let failure: CommandFailure | undefined;
    const out = this.tx((): CommandResult => {
      const prior = this.db.prepare("SELECT name, args, version, result, error_kind, error FROM commands WHERE idempotency_key = ?").get(idempotencyKey) as
        | { name: string; args: string; version: number; result: string | null; error_kind: FailureKind | null; error: string | null }
        | undefined;
      if (prior) {
        if (prior.name !== name || prior.args !== JSON.stringify(args ?? {})) {
          failure = new CommandFailure("invalid", "This idempotency key was already used for a different command.");
          return { version: prior.version, replayed: true };
        }
        if (prior.error_kind) failure = new CommandFailure(prior.error_kind, prior.error ?? "Command failed");
        return { version: prior.version, result: prior.result ? JSON.parse(prior.result) : undefined, replayed: true };
      }
      const cur = this.load();
      const record = this.db.prepare("INSERT INTO commands (idempotency_key, name, args, at, version, result, error_kind, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      let outcome: ReturnType<typeof runCommand>;
      try {
        outcome = runCommand(cur.state, name, args, now);
      } catch (e) {
        failure = classify(e);
        // Record the rejection so a retry with the same key reports the same outcome.
        record.run(idempotencyKey, name, JSON.stringify(args ?? {}), now, cur.version, null, failure.kind, failure.message);
        return { version: cur.version, replayed: false };
      }
      // Errors from here on are storage failures: they roll the whole transaction back.
      const version = this.persist(cur.version, cur.state, outcome.state, now);
      record.run(idempotencyKey, name, JSON.stringify(args ?? {}), now, version, outcome.result === undefined ? null : JSON.stringify(outcome.result), null, null);
      return { version, result: outcome.result, replayed: false };
    });
    if (failure) throw failure;
    if (!out.replayed) this.emit();
    return out;
  }

  /**
   * Apply an internal operation (scheduler, runtime reports). Writes only when the state changed.
   * With `lease`, the write happens only if that holder still holds the unexpired lease, checked
   * inside the same transaction; otherwise LeaseLostError is thrown and nothing is written.
   */
  update(fn: (s: State) => State, now: string, lease?: { name: string; holder: string; nowMs: number }): { version: number; changed: boolean } {
    const out = this.tx(() => {
      if (lease) {
        const row = this.db.prepare("SELECT holder, expires_at FROM leases WHERE name = ?").get(lease.name) as { holder: string; expires_at: number } | undefined;
        if (!row || row.holder !== lease.holder || row.expires_at <= lease.nowMs) throw new LeaseLostError(lease.name);
      }
      const cur = this.load();
      const next = fn(cur.state);
      const json = JSON.stringify(next);
      if (json === cur.json) return { version: cur.version, changed: false };
      return { version: this.persist(cur.version, cur.state, next, now), changed: true };
    });
    if (out.changed) this.emit();
    return out;
  }

  /** Acquire or renew a named lease. Returns true if `holder` holds it after the call. */
  acquireLease(name: string, holder: string, ttlMs: number, nowMs: number): boolean {
    return this.tx(() => {
      const row = this.db.prepare("SELECT holder, expires_at FROM leases WHERE name = ?").get(name) as { holder: string; expires_at: number } | undefined;
      if (row && row.holder !== holder && row.expires_at > nowMs) return false;
      this.db.prepare("INSERT INTO leases (name, holder, expires_at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at").run(name, holder, nowMs + ttlMs);
      return true;
    });
  }

  releaseLease(name: string, holder: string) {
    this.db.prepare("DELETE FROM leases WHERE name = ? AND holder = ?").run(name, holder);
  }

  commandCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM commands").get() as { n: number }).n;
  }

  eventCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Notify listeners of a change that is not a state write (for example scheduler role or sim settings). */
  emit() {
    for (const l of this.listeners) l();
  }

  close() {
    this.db.close();
  }
}
