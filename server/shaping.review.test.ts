// ORC-012 review findings, service level. While shaping no delivery work starts: no integration, no
// publish, push, merge or base update; GitHub is still observed; the labels say what waits; Start
// building resumes it (1). The format 12 → 13 migration gives the roadmap its own hold (2) and sends an
// empty-vision project of the user's own to shaping (6).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as D from "../src/domain/delivery";
import * as M from "../src/domain/model";
import type { State } from "../src/domain/types";
import { FakeAdapter, defaultFakeConfig } from "./runtimes/fake";
import { Scheduler } from "./scheduler";
import { Store } from "./store";

let dir: string;
let store: Store;
let scheduler: Scheduler;
let now = Date.parse("2026-09-30T12:00:00Z");
const iso = () => new Date(now).toISOString();
const st = (): State => store.read().state;
const task = (id: string) => st().tasks.find((t) => t.id === id)!;
let key = 0;
const cmd = (name: string, args: object = {}) => store.command(name, args, `k${++key}`, iso());
const tick = async (ms = 1000) => {
  now += ms;
  scheduler.tick(now);
  await scheduler.prIdle();
};
const oneStep = [{ id: "S1", purpose: "Implement", role: "coder", dependsOn: [], inputs: [], outputs: [{ name: "change", kind: "code-change" }] }];
function createOneStep(title: string) {
  const id = (cmd("createTask", { title, area: "", outcome: "o", benefit: "", whyNow: "", approach: "a", acceptance: ["ok"], priority: 1, holdBeforeStart: false, templateId: "change" }).result as { newId: string }).newId;
  cmd("setPipeline", { taskId: id, expectedRev: 1, steps: oneStep, reason: "one step" });
  cmd("setPriority", { taskId: id, priority: 1 });
  return id;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orch-shape-review-"));
  store = new Store(join(dir, "db.sqlite"));
  const config = defaultFakeConfig();
  scheduler = new Scheduler(store, { claude: new FakeAdapter("claude", config), codex: new FakeAdapter("codex", config) });
});
afterEach(async () => {
  await scheduler.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("review 1: no delivery work while shaping (simulated GitHub)", () => {
  it("an open pull request is not merged, a finished task is not integrated, the review row and the label say what waits, GitHub is still observed, and Start building resumes everything", async () => {
    cmd("setDeliveryMode", { mode: "pr" });
    cmd("setRoleDefault", { role: "coder", selection: { provider: "codex", model: "auto" } });
    cmd("setRoleDefault", { role: "code_reviewer", selection: { provider: "claude", model: "auto" } });
    const first = createOneStep("First change");
    for (let i = 0; i < 200 && !(task(first).integration?.pr?.phase === "open" && D.prReady(st(), task(first), now)); i++) await tick();
    expect(task(first).integration!.pr!.phase).toBe("open");
    // A second task is running when shaping starts: it finishes (nothing is stopped) but is not integrated.
    const second = createOneStep("Second change");
    for (let i = 0; i < 20 && !M.activeAttempts(st(), second).length; i++) await tick();
    expect(M.activeAttempts(st(), second)).toHaveLength(1);

    cmd("startShaping");
    const pr = task(first).integration!.pr!;
    cmd("requestPrReview", { taskId: first });
    cmd("requestPrMerge", { taskId: first, headSha: pr.headSha });
    const observedBefore = st().project.github!.observedAt;
    const mutationsBefore = st().project.github!.lastMutationAt;
    for (let i = 0; i < 12; i++) await tick(31_000);
    // The running second task finishes in its own time (the simulation advances per tick); nothing stops it.
    for (let i = 0; i < 100 && task(second).lifecycle !== "done"; i++) await tick(31_000);
    // Nothing was merged, pushed or brought up to date; the merge request still stands.
    expect(task(first).integration!.pr!).toMatchObject({ phase: "open", mergeRequested: { headSha: pr.headSha } });
    expect(task(first).integration!.pr!.op).toBeUndefined();
    expect(st().project.github!.lastMutationAt).toBe(mutationsBefore);
    // Reads went on.
    expect(st().project.github!.observedAt).not.toBe(observedBefore);
    // The planner never proposes delivery work while shaping.
    for (let i = 0; i < 5; i++) {
      const op = D.nextPrOp(st(), now + i * 60_000);
      expect(["observe", "fetch", "preflight", undefined]).toContain(op?.kind);
    }
    // Labels: the pull request, its gate and the review row say what they wait for, never "queued" or "paused".
    expect(D.prLabel(st(), task(first), now)).toEqual({ text: "PR #1000 waits until you start building (shaping) (simulated)", tone: "plain" });
    const gate = D.prGate(st(), task(first), now, { byUser: true }).items.find((x) => x.id === "not-paused")!;
    expect(gate).toMatchObject({ ok: false, state: "waiting" });
    expect(gate.detail).toMatch(/^Shaping: nothing is pushed, opened, merged or brought up to date until you start building\. Nothing is paused\.$/);
    const review = st().tasks.find((t) => t.reviewTarget?.taskId === first)!;
    expect(review).toBeDefined();
    expect(M.activeAttempts(st(), review.id)).toHaveLength(0);
    expect(D.reviewView(st(), task(first)).evidence.reason).toMatch(/is held: it waits until you start building \(shaping\)\.$/);
    expect(D.reviewView(st(), task(first)).evidence.reason).not.toMatch(/queued/);
    // The second task finished meanwhile and became Done, but was not integrated and got no pull request.
    expect(task(second).lifecycle).toBe("done");
    expect(task(second).integration).toMatchObject({ status: "pending" });
    expect(task(second).integration!.pr).toBeUndefined();
    expect(M.stateLabel(st(), task(second))).toBe("Done");

    // Start building: the review runs, the requested merge goes through, and the second task is delivered.
    cmd("startBuilding");
    for (let i = 0; i < 400 && task(first).integration!.pr!.phase !== "merged"; i++) await tick(3000);
    expect(task(first).integration!.pr!.phase).toBe("merged");
    for (let i = 0; i < 200 && task(second).integration?.pr?.phase !== "open"; i++) await tick();
    expect(task(second).integration!.pr!.phase).toBe("open");
    expect(task(second).integration!.status).toBe("integrated");
  }, 60_000);

  it("local branch delivery is not due while shaping", () => {
    let s = M.setAutonomy(st(), { ...st().project.autonomy, autoDeliver: { enabled: true, branch: "main" } }, iso());
    s = { ...s, project: { ...s.project, delivery: { pending: true } } };
    expect(M.deliveryDue(s, now)).toBe(true);
    expect(M.deliveryDue(M.startShaping(s, iso()), now)).toBe(false);
    expect(M.deliveryDue(M.startBuilding(M.startShaping(s, iso()), iso()), now)).toBe(true);
  });
});

describe("migration 12 → 13 (reviews 2 and 6)", () => {
  function reopen(mutate: (doc: Record<string, unknown>) => void): State {
    const path = join(dir, `old-${++key}.sqlite`);
    const seeded = new Store(path);
    seeded.close();
    const raw = new DatabaseSync(path);
    const doc = JSON.parse((raw.prepare("SELECT json FROM state WHERE id = 1").get() as { json: string }).json) as Record<string, unknown>;
    delete (doc.project as Record<string, unknown>).visionDocs;
    doc.version = 12;
    mutate(doc);
    raw.prepare("UPDATE state SET format = 12, json = ? WHERE id = 1").run(JSON.stringify(doc));
    raw.close();
    const upgraded = new Store(path);
    const s = upgraded.read().state;
    upgraded.close();
    return s;
  }
  type Doc = { project: { sample: boolean; stage: string; visions: { text: string }[]; autonomy: { enabled: boolean; holdLeadProposals: boolean } }; tasks: { id: string; lifecycle: string; holdBeforeStart: boolean; fromShaping?: boolean; heldForShaping?: boolean }[] };

  it("an empty-vision project of the user's own becomes shaping; the sample and a project with a vision stay building", () => {
    const empty = reopen((d) => {
      const doc = d as unknown as Doc;
      doc.project.sample = false;
      doc.project.visions[doc.project.visions.length - 1].text = "  ";
    });
    expect(empty.project.stage).toBe("shaping");
    expect(empty.version).toBe(13);
    const sample = reopen((d) => {
      (d as unknown as Doc).project.visions[0].text = "";
    });
    expect(sample.project.stage).toBe("building");
    const withVision = reopen((d) => {
      (d as unknown as Doc).project.sample = false;
    });
    expect(withVision.project.stage).toBe("building");
  });

  it("a shaping project's held roadmap tasks get the roadmap hold, with the hold before start following the involvement setting; a building project's are untouched", () => {
    const shaping = reopen((d) => {
      const doc = d as unknown as Doc;
      doc.project.stage = "shaping";
      doc.project.autonomy.enabled = true;
      doc.project.autonomy.holdLeadProposals = false;
      for (const t of doc.tasks) if (t.id === "EX-004") t.fromShaping = true; // ready, held before start in the sample
      for (const t of doc.tasks) if (t.id === "EX-003") t.fromShaping = true; // proposed, not held: not a roadmap hold
    });
    expect(shaping.tasks.find((t) => t.id === "EX-004")).toMatchObject({ heldForShaping: true, holdBeforeStart: false });
    expect(shaping.tasks.find((t) => t.id === "EX-003")!.heldForShaping).toBeUndefined();
    expect(shaping.tasks.filter((t) => t.id !== "EX-004").every((t) => t.heldForShaping === undefined)).toBe(true);
    expect(M.stateLabel(shaping, shaping.tasks.find((t) => t.id === "EX-004")!)).toBe("Planned; waits until you start building");
    const checkin = reopen((d) => {
      const doc = d as unknown as Doc;
      doc.project.stage = "shaping";
      doc.project.autonomy.enabled = true;
      doc.project.autonomy.holdLeadProposals = true;
      for (const t of doc.tasks) if (t.id === "EX-004") t.fromShaping = true;
    });
    expect(checkin.tasks.find((t) => t.id === "EX-004")).toMatchObject({ heldForShaping: true, holdBeforeStart: true });
    const building = reopen((d) => {
      for (const t of (d as unknown as Doc).tasks) if (t.id === "EX-004") t.fromShaping = true;
    });
    expect(building.tasks.find((t) => t.id === "EX-004")).toMatchObject({ holdBeforeStart: true });
    expect(building.tasks.find((t) => t.id === "EX-004")!.heldForShaping).toBeUndefined();
  });
});
