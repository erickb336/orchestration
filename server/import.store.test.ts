// ORC-032 through the store: the state stays format 19. A database written before the import's fields existed loads
// as it was, and loading writes nothing; an imported project round-trips.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tallyImport } from "../src/domain/testing/import";
import { STATE_FORMAT, Store } from "./store";

let dir: string;
const opened: Store[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orc032-store-"));
});
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
  rmSync(dir, { recursive: true, force: true });
});

const stored = (path: string) => {
  const raw = new DatabaseSync(path);
  const row = raw.prepare("SELECT version, format, json FROM state WHERE id = 1").get() as { version: number; format: number; json: string };
  raw.close();
  return row;
};

describe("the import's state upgrade", () => {
  it("a format-19 database with no import, no import step on a run, no commit on a provenance and no tests on a rule loads unchanged, and nothing is written", () => {
    const path = join(dir, "before.db");
    const first = new Store(path);
    first.close();
    const before = stored(path);
    expect(before.format).toBe(19);
    const doc = JSON.parse(before.json) as Record<string, unknown>;
    expect(JSON.stringify(doc)).not.toMatch(/"import"|"importStep"|"commit"|"tests"|"baseline"/);
    const store = new Store(path);
    opened.push(store);
    expect(STATE_FORMAT).toBe(19);
    expect(JSON.parse(JSON.stringify(store.read().state))).toEqual(doc);
    expect(stored(path)).toEqual(before);
  });

  it("an imported project in review round-trips through the store, its import intact", () => {
    const path = join(dir, "imported.db");
    const { s } = tallyImport("review");
    const store = new Store(path, () => s);
    opened.push(store);
    expect(store.read().state.studio.import).toEqual(s.studio.import);
    store.close();
    opened.splice(opened.indexOf(store), 1);
    const again = new Store(path);
    opened.push(again);
    expect(again.read().state.studio.import).toEqual(s.studio.import);
    expect(again.read().state.studio.runs.filter((r) => r.importStep).map((r) => [r.kind, r.importStep, r.status])).toEqual([
      ["designer", "words", "completed"],
      ["reader", "rules", "completed"],
      ["designer", "parts", "completed"],
    ]);
  });
});
