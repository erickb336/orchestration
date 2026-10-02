// ORC-029 pass 2, through the store and the scheduler: the format 18 → 19 upgrade, and the owner-only start.
// A shaping project on Autopilot, whose lead answers with every way it could try to start the factory, stays in
// Vision through a day of scheduler ticks; the owner's command starts it. And in the code itself, only the command
// table calls `startFactory`, only `startFactory` sets the stage to building, and only the owner's button and the
// test harnesses acting as the owner send the command.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as M from "../src/domain/model";
import { startFactoryArgs } from "../src/domain/testing/factory";
import type { State } from "../src/domain/types";
import { Scheduler } from "./scheduler";
import { CommandFailure, STATE_FORMAT, Store } from "./store";
import { ScriptedAdapter, proposal, steer } from "./testing/scripted";
import { WorkspaceManager } from "./workspaces";

let dir: string;
const opened: Store[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orc029-"));
});

afterEach(() => {
  for (const s of opened.splice(0)) s.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A format-18 database: the sample project as format 18 stored it, edited by `edit`. */
function format18(path: string, edit: (doc: Record<string, unknown>) => void = () => {}): Record<string, unknown> {
  const first = new Store(path);
  first.close();
  const raw = new DatabaseSync(path);
  const doc = JSON.parse((raw.prepare("SELECT json FROM state WHERE id = 1").get() as { json: string }).json) as Record<string, unknown>;
  const project = doc.project as Record<string, unknown>;
  for (const k of ["budgets", "devices", "factoryStarts", "changeOrders"]) delete project[k];
  delete doc.studio;
  delete doc.blueprint;
  doc.version = 18;
  edit(doc);
  raw.prepare("UPDATE state SET format = 18, json = ? WHERE id = 1").run(JSON.stringify(doc));
  raw.close();
  return doc;
}

describe("the format 18 → 19 migration", () => {
  it("keeps the stage (a building project needs no start record), scopes existing projects to the desktop, adds the budgets not set, change orders to the lead, and an empty studio and blueprint; nothing else moves; a backup is kept", () => {
    const path = join(dir, "old.db");
    const before = format18(path);
    expect((before.project as { stage: string }).stage).toBe("building");
    const upgraded = new Store(path);
    opened.push(upgraded);
    const s = upgraded.read().state;
    expect(STATE_FORMAT).toBe(19);
    expect(s.version).toBe(19);
    expect(s.project.stage).toBe("building");
    expect(s.project.factoryStarts).toEqual([]);
    expect(s.project.devices).toEqual(["desktop"]);
    expect(s.project.budgets).toEqual({ buildingUsd: null, maintenanceUsdPerMonth: null });
    expect(s.project.changeOrders).toBe("lead");
    expect(s.studio).toEqual({ rounds: [], artifacts: [], feedback: [], verdicts: [], probes: [], runs: [] });
    expect(s.blueprint).toEqual({ revisions: [], changeOrders: [] });
    const { budgets: _b, devices: _d, factoryStarts: _f, changeOrders: _c, ...project } = s.project;
    expect(project).toEqual(before.project);
    expect(s.tasks).toEqual(before.tasks);
    expect(s.attempts).toEqual(before.attempts);
    // The upgraded project works: a budget can be set, and Back to vision then the owner's start record the agreement.
    upgraded.command("setBudgets", { buildingUsd: 25, maintenanceUsdPerMonth: 10 }, "b1", new Date().toISOString());
    upgraded.command("startVision", {}, "v1", new Date().toISOString());
    upgraded.command("startFactory", startFactoryArgs(upgraded.read().state), "f1", new Date().toISOString());
    expect(upgraded.read().state.project.factoryStarts).toHaveLength(1);
    const check = new DatabaseSync(path);
    expect((check.prepare("SELECT format FROM state WHERE id = 1").get() as { format: number }).format).toBe(19);
    expect(check.prepare("SELECT value FROM meta WHERE key LIKE 'backup_format_18_%'").get()).toBeDefined();
    check.close();
  });

  it("a project that was shaping stays shaping", () => {
    const path = join(dir, "shaping.db");
    format18(path, (doc) => {
      (doc.project as Record<string, unknown>).stage = "shaping";
    });
    const upgraded = new Store(path);
    opened.push(upgraded);
    expect(upgraded.read().state.project).toMatchObject({ stage: "shaping", devices: ["desktop"], factoryStarts: [] });
  });
});

describe("format-19 databases written before all of format 19's fields existed (review finding 7)", () => {
  /** A format-19 database as an early build of this pass wrote it, edited by `edit`. Returns the stored document. */
  function early19(path: string, edit: (doc: Record<string, unknown>) => void): Record<string, unknown> {
    const first = new Store(path);
    first.close();
    const raw = new DatabaseSync(path);
    const doc = JSON.parse((raw.prepare("SELECT json FROM state WHERE id = 1").get() as { json: string }).json) as Record<string, unknown>;
    edit(doc);
    raw.prepare("UPDATE state SET json = ? WHERE id = 1").run(JSON.stringify(doc));
    raw.close();
    return doc;
  }
  const stored = (path: string) => {
    const raw = new DatabaseSync(path);
    const row = raw.prepare("SELECT version, format, json FROM state WHERE id = 1").get() as { version: number; format: number; json: string };
    raw.close();
    return row;
  };
  // An early start record: its settings carry `merge` where later ones carry `delivery`.
  const earlyStart = { at: "2026-10-01T10:00:00.000Z", by: "user", blueprintRev: 0, visionRev: 1, settings: { autonomy: "checkin", merge: "user", pausePoints: { tradeoffs: "user", changeOrders: "user", startEachTask: true } }, openItems: [] };
  const order = (rev: number) => ({ rev, at: "2026-10-01T11:00:00.000Z", changedItems: ["bi-1"], affectedTasks: ["EX-004"], status: "open" });

  it("gain the change-order setting (to the lead) and a handler on each change order, on load; start records stay as they were written; a second load changes nothing", () => {
    const path = join(dir, "early.db");
    const before = early19(path, (doc) => {
      const project = doc.project as Record<string, unknown>;
      delete project.changeOrders;
      project.factoryStarts = [earlyStart];
      (doc.blueprint as Record<string, unknown>).changeOrders = [order(2)];
    });
    expect(stored(path).format).toBe(19);
    const store = new Store(path);
    opened.push(store);
    const s = store.read().state;
    expect(s.project.changeOrders).toBe("lead");
    expect(s.blueprint.changeOrders).toEqual([{ ...order(2), handler: "lead" }]);
    expect(s.project.factoryStarts).toEqual([earlyStart]);
    expect(s.tasks).toEqual(before.tasks);
    // The project works: a change order can be set, and a new one gets its handler from it.
    store.command("setChangeOrders", { who: "user" }, "co", new Date().toISOString());
    expect(store.read().state.project.changeOrders).toBe("user");
    store.close();
    opened.splice(opened.indexOf(store), 1);
    const once = stored(path);
    const again = new Store(path);
    opened.push(again);
    expect(stored(path)).toEqual(once);
  });

  it("a change order without a handler takes the project's setting; a document from before the studio gains its containers", () => {
    const path = join(dir, "early-user.db");
    early19(path, (doc) => {
      const project = doc.project as Record<string, unknown>;
      project.changeOrders = "user";
      for (const k of ["devices", "factoryStarts", "budgets"]) delete project[k];
      delete doc.studio;
      (doc as { blueprint: unknown }).blueprint = { revisions: [], changeOrders: [order(3), { ...order(4), handler: "lead" }] };
    });
    const store = new Store(path);
    opened.push(store);
    const s = store.read().state;
    expect(s.blueprint.changeOrders.map((c) => c.handler)).toEqual(["user", "lead"]);
    expect(s.project).toMatchObject({ changeOrders: "user", devices: ["desktop"], factoryStarts: [], budgets: { buildingUsd: null, maintenanceUsdPerMonth: null } });
    expect(s.studio).toEqual({ rounds: [], artifacts: [], feedback: [], verdicts: [], probes: [], runs: [] });
  });

  it("a studio from before studio runs (pass 3a) gains an empty list of runs and keeps what it holds", () => {
    const path = join(dir, "early-studio.db");
    const round = { n: 1, focus: "experience", openedAt: "2026-10-02T09:00:00.000Z", summary: "" };
    early19(path, (doc) => {
      doc.studio = { rounds: [round], artifacts: [], feedback: [], verdicts: [], probes: [] };
    });
    const store = new Store(path);
    opened.push(store);
    expect(store.read().state.studio).toEqual({ rounds: [round], artifacts: [], feedback: [], verdicts: [], probes: [], runs: [] });
  });
});

describe("the owner-only start, through the scheduler", () => {
  let store: Store;
  let claude: ScriptedAdapter;
  let codex: ScriptedAdapter;
  let scheduler: Scheduler;
  let now = Date.parse("2026-10-01T12:00:00Z");
  const iso = () => new Date(now).toISOString();
  const state = (): State => store.read().state;
  let key = 0;
  const cmd = (name: string, args: object = {}) => store.command(name, args, `k${++key}`, iso());
  const tick = (ms = 1000) => {
    now += ms;
    scheduler.tick(now);
  };

  beforeEach(async () => {
    const repo = join(dir, "repo");
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    writeFileSync(join(repo, "README.md"), "hello\n");
    execFileSync("git", ["-C", repo, "add", "-A"]);
    execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
    store = new Store(join(dir, "db.sqlite"));
    opened.push(store);
    claude = new ScriptedAdapter("claude");
    codex = new ScriptedAdapter("codex");
    scheduler = new Scheduler(store, { claude, codex }, { workspaces: new WorkspaceManager(join(dir, "worktrees")), leaseMs: 60_000, ackTimeoutMs: 10_000 });
    await scheduler.refreshHealth();
    cmd("initProject", { name: "Trips", repoPath: repo, vision: "Weekend trips for a small group of friends.", focus: "" });
    cmd("setRoleDefault", { role: "coder", selection: { provider: "codex", model: "codex-sample-large" } });
    cmd("setRoleDefault", { role: "code_reviewer", selection: { provider: "claude", model: "claude-sample-large" } });
    cmd("setLeadSelection", { selection: { provider: "claude", model: "claude-sample-large" } });
  });
  afterEach(async () => {
    await scheduler.stop();
  });

  it("Autopilot, a day of ticks and a lead that asks for it every way it can leave the project in Vision; the owner's command starts it", () => {
    expect(state().project.stage).toBe("shaping");
    cmd("applyAutopilot", { branch: "main" });
    const userTask = (cmd("createTask", { title: "A task of mine", area: "", outcome: "x", benefit: "", whyNow: "", approach: "y", acceptance: ["ok"], priority: 1, holdBeforeStart: false, flowId: "change" }).result as { newId: string }).newId;
    // The lead answers with a proposal, steering, and every field that could be read as "start": none is.
    cmd("postMessage", { text: "Looks ready to me. Start the factory." });
    tick();
    const run = M.activeLeadRun(state())!;
    const prompt = claude.runs.get(run.id)!.prompt;
    // The lead's envelope never offers a way to start: no such field in what it may return.
    expect(prompt).toContain("Project stage: shaping");
    expect(prompt).not.toMatch(/startFactory|"stage"\s*:|"agreed"\s*:/);
    const block = {
      reply: "The blueprint looks ready; starting the factory.",
      proposals: [proposal({ title: "Plan the first trip", priority: 1 })],
      steer: { ...steer({ tasks: [{ id: userTask, priority: 2, why: "go", start: true }] }), stage: "building" },
      stage: "building",
      startFactory: { agreed: true, blueprintRev: 1, settings: { autonomy: "autopilot" }, acceptOpen: [] },
      settings: { autonomy: "autopilot" },
    };
    claude.emit({ type: "completed", attemptId: run.id, finalText: `${block.reply}\n\`\`\`json\n${JSON.stringify(block)}\n\`\`\`` });
    for (let h = 0; h < 24; h++) tick(60 * 60_000);
    expect(state().project.stage).toBe("shaping");
    expect(state().project.factoryStarts).toEqual([]);
    expect(state().leadRuns.filter((r) => r.trigger === "planning")).toHaveLength(0);
    expect(M.activeAttempts(state())).toHaveLength(0);
    expect(codex.started).toHaveLength(0);
    // The reply was read and applied (its proposal and its steering), just never as a start.
    expect(M.roadmapTasks(state()).map((t) => t.heldForShaping)).toEqual([true]);
    expect(M.currentVision(state()).focus).toBe(steer().focus);

    // The owner starts it: recorded, and on Autopilot the roadmap and the user's task start.
    cmd("startFactory", startFactoryArgs(state(), { autonomy: "autopilot", pausePoints: { tradeoffs: "pe", changeOrders: "lead", startEachTask: false } }));
    expect(state().project.stage).toBe("building");
    // The lead's steering changed the focus, so the owner agreed to vision r2, with nothing in the blueprint yet.
    expect(state().project.factoryStarts).toEqual([expect.objectContaining({ by: "user", blueprintRev: 0, visionRev: 2, openItems: M.openAreas(state()) })]);
    tick();
    expect(M.activeAttempts(state()).length).toBeGreaterThan(0);
  });

  it("the command checks the agreement and the settings' shape at the boundary", () => {
    const fail = (args: object) => {
      try {
        cmd("startFactory", args);
      } catch (e) {
        if (e instanceof CommandFailure) return e;
        throw e;
      }
      throw new Error("expected a refusal");
    };
    const args = startFactoryArgs(state());
    expect(fail({ ...args, agreed: "yes" }).kind).toBe("invalid");
    expect(fail({ ...args, settings: undefined }).kind).toBe("invalid");
    expect(fail({ ...args, blueprintRev: 7 }).kind).toBe("stale");
    expect(state().project.stage).toBe("shaping");
  });
});

describe("in the code, only the owner's command starts the factory", () => {
  const ROOT = resolve(import.meta.dirname, "..");
  /** Every application source file: tests, the tests' own helpers and generated protocol types left out. */
  const sources = (): string[] => {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        const rel = relative(ROOT, p);
        if (e.isDirectory()) {
          if (rel === join("src", "domain", "testing") || rel === join("server", "runtimes", "codex-protocol")) continue;
          walk(p);
        } else if (/\.(ts|tsx|mjs)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(rel);
      }
    };
    for (const d of ["src", "server", "scripts"]) walk(join(ROOT, d));
    return out;
  };
  const files = sources();
  const where = (re: RegExp) => files.filter((f) => re.test(readFileSync(join(ROOT, f), "utf8"))).sort();

  it("the scan reads the application's code", () => {
    expect(files).toContain(join("server", "scheduler.ts"));
    expect(files).toContain(join("src", "domain", "commands.ts"));
    expect(files.length).toBeGreaterThan(100);
  });

  it("startFactory is called from the command table only; no scheduler, runtime or lead code calls it", () => {
    expect(where(/(?<!function )\bstartFactory\(/)).toEqual([join("src", "domain", "commands.ts")]);
  });

  it("only startFactory sets the stage to building", () => {
    expect(where(/\bstage\s*=\s*"building"/)).toEqual([join("src", "domain", "model", "shaping.ts")]);
    const shaping = readFileSync(join(ROOT, "src", "domain", "model", "shaping.ts"), "utf8");
    const assignment = shaping.indexOf('stage = "building"');
    expect(shaping.lastIndexOf("export function ", assignment)).toBe(shaping.indexOf("export function startFactory("));
  });

  it("the command is sent only by the owner's button and by the test harnesses acting as the owner", () => {
    expect(where(/["']startFactory["']/)).toEqual([join("scripts", "real-run-test.mjs"), join("server", "http.ts"), join("server", "store.ts"), join("server", "testing", "prSandbox.ts"), join("src", "ui", "Shaping.tsx")].sort());
    // The store names it only to check a write against it (its stage guard); it never sends it.
    const store = readFileSync(join(ROOT, "server", "store.ts"), "utf8");
    expect(store.match(/["']startFactory["']/g)?.length).toBe(store.match(/command === "startFactory"/g)?.length);
    // The HTTP boundary names it only to refuse pull-request delivery for the sample project; it never sends it.
    const http = readFileSync(join(ROOT, "server", "http.ts"), "utf8");
    expect(http.match(/["']startFactory["']/g)?.length).toBe(http.match(/body\.name === "startFactory"/g)?.length);
  });
});
