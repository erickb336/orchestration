// Durable project store on SQLite (node:sqlite, no native dependency).
//
// The authoritative project state is one document, changed only by pure domain operations
// inside BEGIN IMMEDIATE transactions. Alongside it: an append-only command log with idempotency
// keys, a mirrored event table for querying, and a lease table for the single scheduler.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { InvalidCommandError, runCommand } from "../src/domain/commands";
import { INTERNAL_PATTERN_IDS, internalPattern } from "../src/domain/internalPatterns";
import { captureOutcomes } from "../src/domain/outcomes";
import { builtInCatalog, patternRef } from "../src/domain/patterns";
import { toDef } from "../src/domain/pipeline";
import { buildSeed } from "../src/domain/seed";
import { ControlError, DEFAULT_AUTONOMY, DEFAULT_CHECKS, DEFAULT_PR_DELIVERY, DEFAULT_REVIEW_BOTS, DEFAULT_RUN_LIMITS, StaleWriteError, type PatternRef, type RetiredTemplate, type State, type StepDef } from "../src/domain/types";
import { V13_TEMPLATE_STEPS, V14_TEMPLATES, v14TemplateSteps } from "./legacyTemplates";

export const STATE_FORMAT = 15;

export { V13_TEMPLATE_STEPS };

/** Step lists compared in their normalised form, so key order and absent optionals do not count as edits. */
const sameSteps = (a: StepDef[], b: StepDef[]) => JSON.stringify(a.map(toDef)) === JSON.stringify(b.map(toDef));

/**
 * ORC-016: what a task from before patterns ran. Service-owned tasks name their internal pattern; every
 * other task is "legacy": the format-14 template its first pipeline revision names, or "custom".
 */
export function legacyPatternRef(t: { reviewTarget?: unknown; checkTarget?: unknown; revertOf?: unknown; pipelineHistory?: { reason?: string }[] }): PatternRef {
  const internal = t.reviewTarget ? "delivery-review" : t.checkTarget ? "delivery-checks" : t.revertOf ? "revert" : undefined;
  // No hash: the format-14 internal template may have been edited, and the task's purposes were rewritten by delivery (step 1 review, finding 5).
  if (internal) {
    const { hash: _hash, ...ref } = patternRef(internalPattern(internal), "migration");
    return ref;
  }
  const reason = t.pipelineHistory?.[0]?.reason ?? "";
  const named = /(?:from|applied) the (.+) template/.exec(reason)?.[1]?.trim();
  const v14 = named ? Object.values(V14_TEMPLATES).find((x) => x.name === named || x.id === named) : undefined;
  return { id: v14?.id ?? "custom", name: v14?.name ?? named ?? "Custom pipeline", source: "legacy", chosenBy: "migration" };
}

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
  // ORC-013: quality gates. Defaults are added: checks off, findings routed to the lead on projects that
  // plan on their own (so Autopilot keeps running) and to the user otherwise, conventions on, the
  // pull-request triage settings. Nothing is backfilled: no artifact gains findings or coverage, no
  // decision is created, and running tasks keep their steps. Built-in templates the user never
  // edited gain the Checks steps; edited ones are left alone, with an event.
  13: (doc) => {
    const project = doc.project as Record<string, unknown>;
    const autonomy = (project.autonomy ?? {}) as { enabled?: boolean };
    project.checks ??= structuredClone(DEFAULT_CHECKS);
    project.triage ??= { askUserBy: autonomy.enabled ? "lead" : "user" };
    project.conventions ??= { include: true };
    const prDelivery = (project.prDelivery ??= structuredClone(DEFAULT_PR_DELIVERY)) as Record<string, unknown>;
    prDelivery.rerunBudget ??= 1;
    prDelivery.reviewBotApps ??= [...DEFAULT_REVIEW_BOTS];
    prDelivery.noCi ??= false;
    for (const t of (doc.tasks ?? []) as { integration?: { pr?: { counters?: Record<string, number> } } }[]) {
      const c = t.integration?.pr?.counters;
      if (!c) continue;
      c.reruns ??= 0;
      c.checks ??= 0;
    }
    doc.decisions ??= [];
    const now = new Date().toISOString();
    const events = (doc.events ??= []) as { id: string; at: string; actor: string; kind: string; taskId?: string; message: string }[];
    const note = (message: string) => {
      doc.seq = (typeof doc.seq === "number" ? doc.seq : 0) + 1;
      events.push({ id: `ev-${doc.seq}`, at: now, actor: "system", kind: "config", message });
    };
    // ORC-016: this reads the frozen format-14 templates, so the upgrade keeps working now that the live
    // code has patterns instead of templates.
    for (const t of (project.templates ?? []) as { id: string; builtIn?: boolean; rev: number; steps: StepDef[]; description?: string }[]) {
      const legacy = V13_TEMPLATE_STEPS[t.id];
      if (!t.builtIn || !legacy) continue;
      if (sameSteps(t.steps, legacy)) {
        t.steps = v14TemplateSteps(t.id);
        // Review 1 (11): the description follows the steps, so the template does not show as "edited".
        const builtIn = V14_TEMPLATES[t.id];
        if (builtIn) t.description = builtIn.description;
        t.rev += 1;
        note(`Template ${t.id} gained the Checks steps (run by the service; skipped while checks are off) when the state format was upgraded`);
      } else note(`Template ${t.id} was edited, so it did not gain the Checks steps; Restore in Settings offers the new built-in`);
    }
    doc.version = 14;
    return doc;
  },
  // ORC-016: pipelines come from patterns. Custom templates and edited built-ins are retired into
  // `retiredTemplates` (the server writes each once as a pattern file of yours at the next start, never
  // overwriting); unedited built-ins are dropped, since the catalog provides them. Tasks are not touched
  // (P9): no step, revision, history, pin or state changes, and a run active across the upgrade finishes
  // normally. Each task records what it ran as a legacy or internal pattern reference.
  14: (doc) => {
    const project = doc.project as Record<string, unknown>;
    const now = new Date().toISOString();
    const events = (doc.events ??= []) as { id: string; at: string; actor: string; kind: string; taskId?: string; message: string }[];
    const note = (message: string) => {
      doc.seq = (typeof doc.seq === "number" ? doc.seq : 0) + 1;
      events.push({ id: `ev-${doc.seq}`, at: now, actor: "system", kind: "config", message });
    };
    const retired = (doc.retiredTemplates ??= []) as RetiredTemplate[];
    for (const t of (project.templates ?? []) as { id: string; name: string; description: string; steps: StepDef[] }[]) {
      const b = V14_TEMPLATES[t.id];
      const internal = (INTERNAL_PATTERN_IDS as string[]).includes(t.id);
      const unedited = b && sameSteps(t.steps, b.steps) && t.name === b.name && t.description === b.description;
      if (unedited) continue; // the catalog provides it; the service's own pipelines stay in code (step 1 review, finding 2)
      retired.push({ id: t.id, name: t.name, description: t.description, steps: t.steps.map(toDef), kind: b ? "edited-built-in" : "custom", ...(internal ? { internal: true as const } : {}), retiredAt: now });
      note(`Template "${t.name}" was retired: pipelines now come from patterns. It is saved as a pattern file of yours when the service starts${internal ? ", marked experimental: the service keeps its own copy of this pipeline" : ""}.`);
    }
    delete project.templates;
    project.defaultPatternId ??= "change";
    doc.patterns = builtInCatalog(); // the server replaces it at start
    for (const t of (doc.tasks ?? []) as Record<string, unknown>[]) {
      t.pattern ??= legacyPatternRef(t as Parameters<typeof legacyPatternRef>[0]);
      t.patternSince ??= 0;
    }
    doc.version = 15;
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

/** ORC-018 §5.2: one row of `trace_exports`: a task's settle and whether its trace was sent. */
export interface TraceExportRow {
  taskId: string;
  settledAt: string;
  status: "pending" | "sent" | "failed";
  tries: number;
  nextAt: number | null;
  lastError: string | null;
  sentAt: string | null;
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
      CREATE TABLE IF NOT EXISTS trace_exports (
        task_id TEXT NOT NULL, settled_at TEXT NOT NULL,
        status TEXT NOT NULL,
        tries INTEGER NOT NULL DEFAULT 0, next_at INTEGER, last_error TEXT, sent_at TEXT, error_at TEXT,
        PRIMARY KEY (task_id, settled_at)
      );
    `);
    // A trace_exports table from a build before `error_at` existed gains the column (it only orders "last error").
    const columns = (this.db.prepare("PRAGMA table_info(trace_exports)").all() as { name: string }[]).map((c) => c.name);
    if (!columns.includes("error_at")) this.db.exec("ALTER TABLE trace_exports ADD COLUMN error_at TEXT");
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
      // ORC-016 P11: a task that settled in this command gets its outcome record here, in the same transaction.
      const version = this.persist(cur.version, cur.state, captureOutcomes(cur.state, outcome.state, now), now);
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
      // ORC-016 P11: the other capture point; together with `command` these are the only writes.
      const next = captureOutcomes(cur.state, fn(cur.state), now);
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

  // ---- ORC-018 §5.2: the trace export's bookkeeping, one row per (task, settle), outside the state ----

  /** Queue the settles that have no row yet as `pending`. Returns how many were new. */
  queueTraceExports(keys: { taskId: string; settledAt: string }[]): number {
    const insert = this.db.prepare("INSERT OR IGNORE INTO trace_exports (task_id, settled_at, status, tries) VALUES (?, ?, 'pending', 0)");
    let n = 0;
    this.tx(() => {
      for (const k of keys) n += Number(insert.run(k.taskId, k.settledAt).changes);
    });
    return n;
  }

  /** The pending rows due at `nowMs`, oldest settle first, at most `limit`. */
  dueTraceExports(nowMs: number, limit: number): TraceExportRow[] {
    return this.db.prepare("SELECT task_id AS taskId, settled_at AS settledAt, status, tries, next_at AS nextAt, last_error AS lastError, sent_at AS sentAt FROM trace_exports WHERE status = 'pending' AND (next_at IS NULL OR next_at <= ?) ORDER BY settled_at ASC, task_id ASC LIMIT ?").all(nowMs, limit) as unknown as TraceExportRow[];
  }

  /** One row (any status), for tests and the exporter's stale check. */
  traceExport(taskId: string, settledAt: string): TraceExportRow | undefined {
    return this.db.prepare("SELECT task_id AS taskId, settled_at AS settledAt, status, tries, next_at AS nextAt, last_error AS lastError, sent_at AS sentAt FROM trace_exports WHERE task_id = ? AND settled_at = ?").get(taskId, settledAt) as unknown as TraceExportRow | undefined;
  }

  /** Mark one row: `sent` (with `sentAt`), `pending` again after a failure (with `tries`, `nextAt` and the error), or `failed`. */
  markTraceExport(taskId: string, settledAt: string, mark: { status: "sent"; sentAt: string } | { status: "pending" | "failed"; tries: number; nextAt: number | null; error: string; at: string }) {
    if (mark.status === "sent") this.db.prepare("UPDATE trace_exports SET status = 'sent', sent_at = ?, next_at = NULL, last_error = NULL WHERE task_id = ? AND settled_at = ?").run(mark.sentAt, taskId, settledAt);
    else this.db.prepare("UPDATE trace_exports SET status = ?, tries = ?, next_at = ?, last_error = ?, error_at = ? WHERE task_id = ? AND settled_at = ?").run(mark.status, mark.tries, mark.nextAt, mark.error, mark.at, taskId, settledAt);
  }

  /** A settle that no longer matches the task's outcome (it settled again): nothing to send for it. */
  dropTraceExport(taskId: string, settledAt: string) {
    this.db.prepare("DELETE FROM trace_exports WHERE task_id = ? AND settled_at = ?").run(taskId, settledAt);
  }

  /** "Retry failed": every failed row becomes pending and due now. Returns how many. */
  retryFailedTraceExports(): number {
    return Number(this.db.prepare("UPDATE trace_exports SET status = 'pending', tries = 0, next_at = NULL WHERE status = 'failed'").run().changes);
  }

  /** Every (task, settle) with a row, as `taskId|settledAt`: what "Send finished tasks" would not queue again. */
  traceExportKeys(): Set<string> {
    return new Set((this.db.prepare("SELECT task_id AS t, settled_at AS s FROM trace_exports").all() as { t: string; s: string }[]).map((r) => `${r.t}|${r.s}`));
  }

  /** Rows due to be sent now: pending with no next try or a next try in the past. Cheap; read every pass. */
  dueTraceExportCount(nowMs: number): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM trace_exports WHERE status = 'pending' AND (next_at IS NULL OR next_at <= ?)").get(nowMs) as { n: number }).n);
  }

  /** The state's version alone, without reading or parsing the state. */
  version(): number {
    return Number((this.db.prepare("SELECT version FROM state WHERE id = 1").get() as { version: number }).version);
  }

  /** Counts by status, the last success, and the most recent error still recorded. */
  traceExportCounts(): { pending: number; sent: number; failed: number; lastSentAt?: string; lastError?: string } {
    const out = { pending: 0, sent: 0, failed: 0 } as { pending: number; sent: number; failed: number; lastSentAt?: string; lastError?: string };
    for (const r of this.db.prepare("SELECT status, COUNT(*) AS n FROM trace_exports GROUP BY status").all() as { status: string; n: number }[]) {
      if (r.status === "pending" || r.status === "sent" || r.status === "failed") out[r.status] = Number(r.n);
    }
    const sent = this.db.prepare("SELECT MAX(sent_at) AS at FROM trace_exports WHERE status = 'sent'").get() as { at: string | null };
    if (sent.at) out.lastSentAt = sent.at;
    // The most recent error, by when it happened (review L11: a failed row has no next try to sort by).
    const err = this.db.prepare("SELECT last_error AS e FROM trace_exports WHERE last_error IS NOT NULL ORDER BY error_at DESC, settled_at DESC LIMIT 1").get() as { e: string } | undefined;
    if (err?.e) out.lastError = err.e;
    return out;
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
