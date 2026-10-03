// ORC-029 pass 5 (5b) at the service: the lead's brief for a change order, the simulated lead's answer to it, and the
// scheduler starting the lead's change-order run after the owner's Lock in on the simulated runtime.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as M from "../src/domain/model";
import { LEAD_REPLY_SCHEMA, schemaMismatch, withNulls } from "../src/domain/model/leadReplySchema";
import * as B from "../src/domain/studio/blueprint";
import { at, changeOrdered } from "../src/domain/testing/changeOrders";
import { startFactoryArgs } from "../src/domain/testing/factory";
import { lockInArgs } from "../src/domain/testing/studio";
import type { LeadRun, SpecContent, State } from "../src/domain/types";
import { buildLeadEnvelope, parseLeadOutput } from "./envelope";
import { FakeAdapter, defaultFakeConfig, fakeLeadReply, fakeLeadText } from "./runtimes/fake";
import { Scheduler } from "./scheduler";
import { Store } from "./store";
import { WorkspaceManager } from "./workspaces";

const runOf = (s: State, id: string) => s.leadRuns.find((r) => r.id === id) as LeadRun;

describe("the lead's brief for a change order", () => {
  it("lists each changed item with the version it replaces and what changed, each dropped and added item, each touched task with its update, and the new work", () => {
    const f = changeOrdered();
    const rev = B.blueprintRev(f.s);
    const r = M.startLeadRun(f.s, { provider: "claude", model: "m", trigger: "change-order" }, at(20));
    const brief = buildLeadEnvelope(r.state, runOf(r.state, r.runId), "read");
    expect(brief).toMatch(/^# Lead run \S+ \(change order\)/);
    const t = (id: string) => r.state.tasks.find((x) => x.id === id)!;
    const label = (id: string) => M.stateLabel(r.state, t(id));
    expect(brief).toContain(
      [
        `## Change order r${rev}: adjust the factory to the user's Lock in`,
        `The user locked in blueprint r${rev} at ${at(18)}. The factory builds from it now. Adjust the tasks it touches and plan its new work, in "changeOrder". Say what each update does in the design's words: what the user sees and does, not the code.`,
        "",
        "What changed:",
        `- Changed: ${f.ids.plan} screen "Trip plan" v2, replacing v1. What changed: the user on v1: "Day list first, the map below it.".`,
        `- Added: ${f.ids.packing} screen "Packing list" v1.`,
        `- Dropped: ${f.ids.remind} screen "Reminders" v1: the factory no longer builds it.`,
        "",
        "The tasks it touches:",
        `- ${f.tasks.running} "Trip plan screen" [${label(f.tasks.running)}]: cites ${f.ids.plan} (changed). Planned at the Lock in: it finishes, then the lead revises it. Your update: "revise".`,
        `- ${f.tasks.queued} "Trip list screen" [${label(f.tasks.queued)}]: cites ${f.ids.plan} (changed), ${f.ids.list} (unchanged). Planned at the Lock in: the lead updates its spec. Your update: "update-spec".`,
        `- ${f.tasks.retiring} "Outing reminders" [${label(f.tasks.retiring)}]: cites ${f.ids.remind} (dropped). Planned at the Lock in: retired. Your update: "retire".`,
        `- ${f.tasks.early} "Early trip plan" [${label(f.tasks.early)}]: cites ${f.ids.plan} (changed). Planned at the Lock in: the lead plans a revision. Your update: "revise".`,
        "",
        "New work:",
        `- ${f.ids.packing} screen "Packing list" v1: no task cites it yet. Your update: "new-task", citing ${f.ids.packing}.`,
      ].join("\n"),
    );
    expect(brief).toContain("- The service applies each update at once, and the user can undo each one alone.\n- PE review of new work is on: an updated spec, a revision task and a new task each wait for the PE before they start.");
    expect(brief).toContain(`Adjust the factory to the change order under "Change order r${rev}"`);
    expect(brief).toContain(`  "changeOrder": {\n    "rev": ${rev},`);
    // Any other run has neither the section nor the field.
    const other = { ...runOf(r.state, r.runId), id: "lead-other", trigger: "planning" as const };
    expect(buildLeadEnvelope(r.state, other, "read")).not.toMatch(/## Change order|"changeOrder"/);
  });

  it("with change orders set to ask first, it says the updates wait for the user's go-ahead", () => {
    const f = changeOrdered("user");
    const r = M.startLeadRun(f.s, { provider: "claude", model: "m", trigger: "change-order" }, at(20));
    expect(buildLeadEnvelope(r.state, runOf(r.state, r.runId), "read")).toContain("- The user asked to see change order updates first: each of your updates waits for the user's go-ahead, and nothing changes until then.");
  });
});

describe("the simulated lead's answer", () => {
  it("answers each touched task as its brief says (a spec update, revision tasks, a retirement) and plans the new work; the schema accepts it, and the change order closes", () => {
    const f = changeOrdered();
    const r = M.startLeadRun(f.s, { provider: "claude", model: "m", trigger: "change-order" }, at(20));
    const brief = buildLeadEnvelope(r.state, runOf(r.state, r.runId), "read");
    const reply = fakeLeadReply(r.runId, "change-order", brief);
    expect(schemaMismatch(LEAD_REPLY_SCHEMA, withNulls(LEAD_REPLY_SCHEMA, reply))).toBeUndefined();
    const out = parseLeadOutput(fakeLeadText(r.runId, "change-order", brief));
    const done = M.completeLeadRun(r.state, r.runId, { ...out, answerText: "" }, at(21), { simulated: true });
    const co = done.blueprint.changeOrders.at(-1)!;
    expect(co.lines!.map((l) => [l.kind, l.taskId])).toEqual([
      ["revise", f.tasks.running],
      ["update-spec", f.tasks.queued],
      ["retire", f.tasks.retiring],
      ["revise", f.tasks.early],
      ["new-task", undefined],
    ]);
    expect(co.status).toBe("done");
    expect(done.steering.find((x) => x.id === `cs-${r.runId}`)).toMatchObject({ simulated: true, reason: `Change order r${co.rev}` });
    expect(done.conversation.at(-1)).toMatchObject({ author: "lead", text: expect.stringMatching(/^I answered change order r\d+ with 5 updates/) });
    expect(done.conversation.at(-1)!.rejected).toBeUndefined();
    // The lead's next brief lists each line under its recent changes, in the design's words.
    const next = M.startLeadRun(M.postMessage(done, "How did the change go?", at(30)), { provider: "claude", model: "m", trigger: "message" }, at(30));
    expect(buildLeadEnvelope(next.state, runOf(next.state, next.runId), "read")).toContain(`- ${co.lines![1].changeId} (${at(21)}): change order r${co.rev}: ${co.lines![1].words} — applied\n`);
  });
});

describe("on the simulated runtime", () => {
  let dir: string;
  let repo: string;
  let store: Store;
  let scheduler: Scheduler;
  let now = Date.parse(at(0));
  let key = 0;
  const cmd = <R = unknown>(name: string, args: object = {}) => store.command(name, args, `k${++key}`, new Date(now).toISOString()).result as R;
  const st = (): State => store.read().state;
  const tickUntil = (done: () => boolean, max = 300) => {
    for (let i = 0; i < max && !done(); i++) {
      now += 1000;
      scheduler.tick(now);
    }
    return done();
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "orc029-changeorder-"));
    repo = join(dir, "repo");
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    writeFileSync(join(repo, "README.md"), "hello\n");
    execFileSync("git", ["-C", repo, "add", "-A"]);
    execFileSync("git", ["-C", repo, "-c", "user.name=u", "-c", "user.email=u@u", "commit", "-q", "-m", "init"]);
    store = new Store(join(dir, "db.sqlite"));
    const config = { ...defaultFakeConfig(), progressPerTick: 100, ackDelayMs: 0 };
    scheduler = new Scheduler(store, { claude: new FakeAdapter("claude", config), codex: new FakeAdapter("codex", config) }, { workspaces: new WorkspaceManager(join(dir, "worktrees")), dataDir: join(dir, "data"), leaseMs: 60_000, ackTimeoutMs: 10_000 });
    await scheduler.refreshHealth();
    cmd("initProject", { name: "Trips", repoPath: repo, vision: "Weekend trips for a small group of friends.", focus: "Plan a trip" });
    cmd("setLeadSelection", { selection: { provider: "claude", model: "auto" } });
  });
  afterEach(async () => {
    await scheduler.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A screen in the open round, agreed by the PE, approved into the draft. */
  const approvedScreen = (round: number, title: string, artifactId?: string) => {
    const a = cmd<{ artifactId: string; version: number }>("addStudioArtifact", { round, kind: "screen", title, variants: [], files: [{ path: "s/index.html", sha256: "a".repeat(64) }], devices: ["desktop"], madeBy: { role: "designer", provider: "claude", model: "m", attemptId: "run-d" }, ...(artifactId ? { artifactId } : {}) });
    cmd("addPeVerdicts", { artifactId: a.artifactId, version: a.version, verdicts: [{ verdict: "feasible", reasons: "Fits." }] });
    cmd("approveArtifact", { artifactId: a.artifactId, version: a.version });
    return a.artifactId;
  };
  /** A queued task of the owner's citing these items, waiting for the owner's go-ahead. */
  const ownTask = (title: string, refs: string[]) => {
    const id = cmd<{ newId: string }>("createTask", { title, area: "Trips", outcome: "x", benefit: "", whyNow: "", approach: "y", acceptance: ["ok"], priority: 1, holdBeforeStart: true, flowId: "change" }).newId;
    const t = st().tasks.find((x) => x.id === id)!;
    cmd("editSpec", { taskId: id, expectedRev: 1, content: { ...M.currentSpec(t).content, blueprintRefs: refs } satisfies SpecContent, reason: "Cites the blueprint" });
    return id;
  };

  it("a Lock in starts the lead's change-order run; the simulated lead updates, retires and plans; the change order closes with its record", () => {
    cmd("openRound", { focus: "experience" });
    const plan = approvedScreen(1, "Trip plan");
    const remind = approvedScreen(1, "Reminders");
    cmd("startFactory", startFactoryArgs(st(), { autonomy: "manual", pausePoints: { tradeoffs: "user", changeOrders: "lead", startEachTask: false } }));
    const item = (artifactId: string) => B.blueprintItems(st()).find((i) => i.artifactId === artifactId)!.id;
    const queued = ownTask("Trip plan screen", [item(plan)]);
    const retiring = ownTask("Outing reminders", [item(remind)]);
    cmd("closeRound", { round: 1 });
    cmd("openRound", { focus: "experience" });
    approvedScreen(2, "Trip plan", plan);
    cmd("dropBlueprintItem", { itemId: item(remind) });
    const packing = approvedScreen(2, "Packing list");
    cmd("lockIn", lockInArgs(st()));
    const co = () => st().blueprint.changeOrders.at(-1)!;
    expect(co()).toMatchObject({ status: "open", tasks: [{ taskId: queued, handling: "update-spec" }, { taskId: retiring, handling: "retire" }], newWork: [item(packing)] });
    expect(tickUntil(() => co().status === "done")).toBe(true);
    const lead = st().leadRuns.find((r) => r.trigger === "change-order")!;
    expect(lead).toMatchObject({ outcome: "completed", changeSetId: `cs-${lead.id}` });
    const made = co().lines!.find((l) => l.kind === "new-task")!.madeTaskId!;
    expect(co().closed!.record).toEqual([`Updated ${queued} → builds Trip plan v2`, `Retired ${retiring}: builds only the dropped Reminders screen`, `New ${made} → builds Packing list v1`]);
    // Only one change-order run, and the updated and new work went to the PE (simulated).
    expect(st().leadRuns.filter((r) => r.trigger === "change-order")).toHaveLength(1);
    expect(tickUntil(() => st().studio.runs.some((r) => r.review?.taskId === made))).toBe(true);
    expect(st().studio.runs.some((r) => r.review?.taskId === queued)).toBe(true);
  });
});
