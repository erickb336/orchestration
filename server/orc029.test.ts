// ORC-029 pass 2, through the store: the format 18 → 19 upgrade.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STATE_FORMAT, Store } from "./store";

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
  delete project.budgets;
  doc.version = 18;
  edit(doc);
  raw.prepare("UPDATE state SET format = 18, json = ? WHERE id = 1").run(JSON.stringify(doc));
  raw.close();
  return doc;
}

describe("the format 18 → 19 migration", () => {
  it("adds the budgets, not set, and moves nothing else; a backup of the original is kept", () => {
    const path = join(dir, "old.db");
    const before = format18(path);
    const upgraded = new Store(path);
    opened.push(upgraded);
    const s = upgraded.read().state;
    expect(STATE_FORMAT).toBe(19);
    expect(s.version).toBe(19);
    expect(s.project.budgets).toEqual({ buildingUsd: null, maintenanceUsdPerMonth: null });
    expect(s.project.budgetContinued).toBeUndefined();
    const { budgets: _b, ...project } = s.project;
    expect(project).toEqual(before.project);
    expect(s.tasks).toEqual(before.tasks);
    expect(s.attempts).toEqual(before.attempts);
    // The owner can set a budget on the upgraded project.
    upgraded.command("setBudgets", { buildingUsd: 25, maintenanceUsdPerMonth: 10 }, "b1", new Date().toISOString());
    expect(upgraded.read().state.project.budgets).toEqual({ buildingUsd: 25, maintenanceUsdPerMonth: 10 });
    const check = new DatabaseSync(path);
    expect((check.prepare("SELECT format FROM state WHERE id = 1").get() as { format: number }).format).toBe(19);
    expect(check.prepare("SELECT value FROM meta WHERE key LIKE 'backup_format_18_%'").get()).toBeDefined();
    check.close();
  });
});
