// ORC-018 §6: the board folds done tasks older than 7 days under "Done earlier (n)" in both views, closed
// by default, and never hides one that still asks something of you. Rendered statically with a seed state.

import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import type { ServiceInfo } from "../api";
import { buildSeed } from "../domain/seed";
import type { Landed, State, Task } from "../domain/types";
import { Board } from "./Board";
import { StoreContext, type ServiceStore } from "./store";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const ago = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

let view: "list" | "board" = "list";

beforeAll(() => {
  // The board reads the area filter from the URL and its view from browser storage; neither exists in node.
  Object.defineProperty(globalThis, "location", { value: { hash: "#/tasks" }, configurable: true, writable: true });
  Object.defineProperty(globalThis, "localStorage", { value: { getItem: (k: string) => (k === "orchestration.view" ? view : null), setItem() {}, removeItem() {} }, configurable: true, writable: true });
});

const landed = (status: Landed["status"]): Landed => ({ at: ago(20), via: "local", target: "main", commit: "b".repeat(40), by: "app", flags: [], status, notes: [], followUps: [] });

function stateWithOldDone(): State {
  const base = buildSeed(NOW);
  const done = base.tasks.find((t) => t.lifecycle === "done")!;
  const clone = (id: string, over: Partial<Task>): Task => ({ ...structuredClone(done), id, integration: undefined, outcome: undefined, ...over });
  return {
    ...base,
    tasks: [
      ...base.tasks,
      clone("OLD-1", { updatedAt: ago(20) }),
      clone("OLD-2", { updatedAt: ago(20), integration: { status: "integrated", landed: landed("unreviewed") } }),
      clone("OLD-3", { updatedAt: ago(20), integration: { status: "integrated", landed: landed("reviewed") } }),
    ],
  };
}

function render(state: State, v: "list" | "board"): string {
  view = v;
  const store = {
    state,
    version: 1,
    service: { startedAt: ago(1), scheduler: "active", runtime: "fake", sim: { auto: false, ackMode: "normal" }, dbPath: "", providers: {} } as unknown as ServiceInfo,
    status: "online",
    disabled: false,
    loadFailed: false,
    confirmedAt: NOW,
    notice: null,
  } as unknown as ServiceStore;
  return renderToStaticMarkup(
    <StoreContext.Provider value={store}>
      <Board />
    </StoreContext.Provider>,
  );
}

describe("Done earlier", () => {
  const state = stateWithOldDone();

  it("in the list view: a final closed group with the count, keeping what still needs review above", () => {
    const html = render(state, "list");
    expect(html).toContain('<h2 id="g-done-earlier">Done earlier</h2><span class="chip">2</span>');
    expect(html).toContain('aria-expanded="false" aria-controls="done-earlier-list"');
    expect(html).toContain(">Show<");
    // Closed by default: the folded tasks are not on the page.
    expect(html).not.toContain("OLD-1");
    expect(html).not.toContain("OLD-3");
    // Landed and unreviewed: never hidden, so it stays in Done.
    expect(html).toContain("OLD-2");
    expect(html).toContain('<h2 id="g-done">Done</h2><span class="chip">2</span>');
  });

  it("on the board: the Done column shows the recent ones and a button for the rest", () => {
    const html = render(state, "board");
    expect(html).toContain('aria-label="Done"');
    expect(html).toContain(">Done earlier (2)<");
    expect(html).toContain('aria-controls="done-earlier-col"');
    expect(html).not.toContain("OLD-1");
    expect(html).toContain("OLD-2");
  });

  it("shows nothing extra when every done task is recent", () => {
    const html = render(buildSeed(NOW), "list");
    expect(html).not.toContain("Done earlier");
  });
});
