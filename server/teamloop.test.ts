// Milestone 4: the lead conversation, planning with bounded autonomy, lead-authored tasks flowing
// through mixed-provider pipelines, serial integration, and lead controls. Scripted adapters and a
// temporary git repository; no real providers.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as M from "../src/domain/model";
import type { State } from "../src/domain/types";
import { buildLeadEnvelope, parseLeadOutput } from "./envelope";
import { Scheduler } from "./scheduler";
import { Store } from "./store";
import { ScriptedAdapter, proposal } from "./testing/scripted";
import { WorkspaceManager } from "./workspaces";

let dir: string;
let repo: string;
let store: Store;
let claude: ScriptedAdapter;
let codex: ScriptedAdapter;
let scheduler: Scheduler;
let now = Date.parse("2026-09-29T12:00:00Z");
const iso = () => new Date(now).toISOString();
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
const tick = (ms = 1000) => {
  now += ms;
  scheduler.tick(now);
};
const st = (): State => store.read().state;
const task = (id: string) => st().tasks.find((t) => t.id === id)!;
let key = 0;
const cmd = (name: string, args: object = {}) => store.command(name, args, `k${++key}`, iso());
const leadRun = () => M.activeLeadRun(st());
const adapterFor = (p: string) => (p === "claude" ? claude : codex);
const autonomy = (over: Record<string, unknown> = {}) =>
  cmd("setAutonomy", { enabled: true, planningIntervalMinutes: 60, maxProposalsPerCycle: 2, maxOpenProposals: 5, holdLeadProposals: false, operatingHours: null, ...over });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "orch-loop-"));
  repo = join(dir, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "README.md"), "hello\n");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  store = new Store(join(dir, "db.sqlite"));
  claude = new ScriptedAdapter("claude");
  codex = new ScriptedAdapter("codex");
  scheduler = new Scheduler(store, { claude, codex }, { workspaces: new WorkspaceManager(join(dir, "worktrees")), leaseMs: 60_000, ackTimeoutMs: 10_000 });
  await scheduler.refreshHealth();
  cmd("initProject", { name: "Loop", repoPath: repo, vision: "A tiny greeting library.", focus: "Greeting" });
  cmd("setRoleDefault", { role: "coder", selection: { provider: "codex", model: "codex-sample-large" } });
  cmd("setRoleDefault", { role: "code_reviewer", selection: { provider: "claude", model: "claude-sample-large" } });
  cmd("setLeadSelection", { selection: { provider: "claude", model: "claude-sample-large" } });
});
afterEach(async () => {
  await scheduler.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("lead conversation", () => {
  it("a message wakes the lead; messages sent meanwhile are answered together by the next run", () => {
    cmd("postMessage", { text: "What should we build first?" });
    tick();
    const r1 = leadRun()!;
    expect(r1.trigger).toBe("message");
    const a = claude.runs.get(r1.id)!;
    expect(a.role).toBe("lead");
    expect(a.workspace.access).toBe("read");
    expect(a.prompt).toContain("What should we build first?");
    cmd("postMessage", { text: "Also, keep it tiny." });
    cmd("postMessage", { text: "And document it." });
    tick();
    expect(leadRun()!.id).toBe(r1.id); // one lead at a time
    claude.reply(r1.id, "Start with greet().");
    tick(); // applies the reply
    tick(); // starts the next run for the messages that arrived meanwhile
    const r2 = leadRun()!;
    expect(r2.id).not.toBe(r1.id);
    expect(r2.messageIds).toHaveLength(2);
    claude.reply(r2.id, "Noted both.");
    tick();
    const lead = st().conversation.filter((m) => m.author === "lead").map((m) => m.text);
    expect(lead).toEqual(["Start with greet().", "Noted both."]);
    expect(M.pendingMessages(st())).toHaveLength(0);
  });

  it("the lead's valid proposals become lead-authored tasks; invalid ones are rejected with reasons", () => {
    autonomy({ enabled: false, maxProposalsPerCycle: 5 });
    cmd("postMessage", { text: "Plan the first tasks." });
    tick();
    const r = leadRun()!;
    claude.reply(r.id, "Here is the plan.", [
      proposal(),
      proposal({ title: "No options", options: [] }),
      proposal({ title: "Bad template", templateId: "nope" }),
      proposal({ title: "Add a greeting" }), // duplicate of the first
    ]);
    tick();
    const msg = st().conversation.find((m) => m.author === "lead")!;
    expect(msg.proposedTaskIds).toHaveLength(1);
    const t = task(msg.proposedTaskIds![0]);
    expect(t.specs[0].author).toBe("lead");
    expect(M.currentSpec(t).content).toMatchObject({ decidedBy: "lead", selectedOptionId: "A", recommendedOptionId: "A" });
    expect(t.pipelineHistory[0].reason).toMatch(/Change template/);
    expect(msg.rejected!.join(" ")).toMatch(/two to four options/);
    expect(msg.rejected!.join(" ")).toMatch(/unknown template/);
    expect(msg.rejected!.join(" ")).toMatch(/already exists/);
  });

  it("a reply without a JSON block is still shown; failures leave messages pending", () => {
    cmd("postMessage", { text: "Hi" });
    tick();
    const r = leadRun()!;
    claude.emit({ type: "failed", attemptId: r.id, message: "Claude needs an Anthropic API key" });
    tick();
    expect(st().conversation.some((m) => m.author === "system" && /API key/.test(m.text))).toBe(true);
    expect(M.pendingMessages(st())).toHaveLength(1);
    tick();
    const r2 = leadRun()!;
    claude.emit({ type: "completed", attemptId: r2.id, finalText: "Just a plain answer." });
    tick();
    expect(st().conversation.filter((m) => m.author === "lead").pop()!.text).toBe("Just a plain answer.");
  });
});

describe("autonomy", () => {
  it("is off by default: no planning without a message", () => {
    for (let i = 0; i < 5; i++) tick(10 * 60_000);
    expect(st().leadRuns).toHaveLength(0);
  });

  it("plans on the interval, caps proposals per cycle and open proposals, and respects operating hours", () => {
    autonomy({ maxProposalsPerCycle: 1, maxOpenProposals: 1 });
    tick();
    const r = leadRun()!;
    expect(r.trigger).toBe("planning");
    claude.reply(r.id, "Two ideas.", [proposal({ title: "One" }), proposal({ title: "Two" })]);
    tick();
    expect(st().tasks).toHaveLength(1); // capped per cycle
    expect(st().conversation.pop()!.rejected!.join(" ")).toMatch(/more than 1 proposals/);
    // Open proposals at the cap: no further planning even after the interval.
    tick(2 * 60 * 60_000);
    expect(M.activeLeadRun(st())).toBeUndefined();
  });

  it("does not plan outside operating hours or while the project is paused", () => {
    const h = new Date(now + 1000).getHours();
    const outside = `${String((h + 2) % 24).padStart(2, "0")}:00`;
    const outsideEnd = `${String((h + 3) % 24).padStart(2, "0")}:00`;
    autonomy({ operatingHours: { start: outside, end: outsideEnd } });
    tick();
    expect(leadRun()).toBeUndefined();
    autonomy({ operatingHours: null });
    cmd("pauseProject");
    tick();
    expect(leadRun()).toBeUndefined();
  });

  it("vision → lead proposal → mixed-provider implementation → independent review → done → integrated, without prompting", () => {
    autonomy();
    tick();
    claude.reply(leadRun()!.id, "Proposing greet().", [proposal()]);
    tick();
    const id = st().tasks[0].id;
    tick(); // promote + dispatch
    const impl = M.activeAttempts(st(), id)[0];
    expect(impl.snapshot.provider).toBe("codex");
    codex.finish(impl.id, { write: ["greet.js", "export const greet = (n) => `Hello, ${n}`;\n"] });
    tick();
    tick();
    const review = M.activeAttempts(st(), id)[0];
    expect(review.snapshot.provider).toBe("claude"); // independent reviewer on the other provider
    claude.finish(review.id, { findings: 0 });
    tick();
    tick();
    const verify = M.activeAttempts(st(), id)[0]; // repair skipped; lead verifies
    expect(verify.stepId).toBe("S4");
    claude.finish(verify.id);
    tick();
    tick();
    expect(task(id).lifecycle).toBe("done");
    expect(task(id).integration?.status).toBe("integrated");
    const branch = `orchestration/${st().project.id}/integration`;
    expect(git("show", `${branch}:greet.js`)).toContain("Hello");
    expect(git("rev-list", "--count", "main")).toBe("1"); // the user's branch is untouched
  });
});

describe("integration queue", () => {
  const finishChange = (title: string, file: string, content: string) => {
    const id = (cmd("createTask", { title, area: "", outcome: "x", benefit: "", whyNow: "", approach: "y", acceptance: ["ok"], priority: 1, holdBeforeStart: false, templateId: "change" }).result as { newId: string }).newId;
    cmd("setPipeline", { taskId: id, expectedRev: 1, steps: [{ id: "S1", purpose: "Implement", role: "coder", dependsOn: [], inputs: [], outputs: [{ name: "change", kind: "code-change" }] }], reason: "one step" });
    tick();
    const r = M.activeAttempts(st(), id)[0];
    return { id, r, done: () => codex.finish(r.id, { write: [file, content] }) };
  };

  it("integrates serially and reports conflicts without leaving a half-merged branch", () => {
    const a = finishChange("A", "same.txt", "from A\n");
    const b = finishChange("B", "same.txt", "from B\n");
    a.done();
    b.done();
    tick();
    tick();
    tick();
    const states = [task(a.id).integration?.status, task(b.id).integration?.status].sort();
    expect(states).toEqual(["conflict", "integrated"]);
    const conflicted = [task(a.id), task(b.id)].find((t) => t.integration?.status === "conflict")!;
    expect(conflicted.integration!.message).toMatch(/same\.txt/);
    // The lead sees conflicts in its next envelope.
    cmd("postMessage", { text: "status?" });
    tick();
    expect(claude.runs.get(leadRun()!.id)!.prompt).toContain("Integration conflicts");
    expect(claude.runs.get(leadRun()!.id)!.prompt).toContain(conflicted.id);
  });

  it("integration is frozen while the project is paused", () => {
    const a = finishChange("A", "a.txt", "a\n");
    a.done();
    cmd("pauseProject");
    tick();
    tick();
    expect(task(a.id).lifecycle).toBe("active"); // completion arrived after the pause: not integrated
    cmd("resumeProject");
    tick();
  });
});

describe("lead controls", () => {
  it("project pause stops the lead run; Pausing until confirmed; the pending message survives", () => {
    cmd("postMessage", { text: "Hello" });
    tick();
    const r = leadRun()!;
    cmd("pauseProject");
    tick();
    expect(claude.interrupts).toContain(r.id);
    expect(leadRun()!.outcome).toBe("stopping");
    claude.emit({ type: "stopped", attemptId: r.id, how: "interrupted" });
    tick();
    expect(st().leadRuns.find((x) => x.id === r.id)!.outcome).toBe("stopped");
    expect(M.pendingMessages(st())).toHaveLength(1);
    cmd("resumeProject");
    tick();
    expect(leadRun()!.messageIds).toHaveLength(1);
  });

  it("either provider can lead; switching stops the active lead run first", () => {
    cmd("postMessage", { text: "Who leads?" });
    tick();
    const r = leadRun()!;
    expect(r.provider).toBe("claude");
    cmd("setLeadSelection", { selection: { provider: "codex", model: "codex-sample-large" } });
    tick();
    expect(claude.interrupts).toContain(r.id);
    claude.emit({ type: "stopped", attemptId: r.id, how: "interrupted" });
    tick();
    tick();
    const r2 = leadRun()!;
    expect(r2.provider).toBe("codex");
    expect(adapterFor("codex").runs.has(r2.id)).toBe(true);
    codex.reply(r2.id, "Codex leading now.");
    tick();
    expect(st().conversation.filter((m) => m.author === "lead").pop()!.text).toBe("Codex leading now.");
  });

  it("restart reconciliation marks a live lead run lost; its messages are answered by the next run", async () => {
    cmd("postMessage", { text: "Hi" });
    tick();
    const r = leadRun()!;
    const claude2 = new ScriptedAdapter("claude");
    const codex2 = new ScriptedAdapter("codex");
    const s2 = new Scheduler(store, { claude: claude2, codex: codex2 }, { workspaces: new WorkspaceManager(join(dir, "worktrees")), leaseMs: 60_000 });
    await s2.refreshHealth();
    await scheduler.stop();
    now += 1000;
    s2.tick(now);
    expect(st().leadRuns.find((x) => x.id === r.id)!.outcome).toBe("lost");
    now += 1000;
    s2.tick(now);
    expect(M.activeLeadRun(st())!.messageIds).toHaveLength(1);
    await s2.stop();
  });
});

describe("lead envelope and parser", () => {
  it("includes vision, board, templates, and the proposal contract; parses replies leniently", () => {
    cmd("postMessage", { text: "hello lead" });
    const s = M.startLeadRun(st(), { provider: "claude", model: "m", trigger: "message" }, iso()).state;
    const text = buildLeadEnvelope(s, M.activeLeadRun(s)!, "read");
    expect(text).toContain("A tiny greeting library.");
    expect(text).toContain("hello lead");
    expect(text).toContain("change: Change");
    expect(text).toContain('"recommendedOptionId"');
    expect(parseLeadOutput("plain").proposals).toEqual([]);
    expect(parseLeadOutput('x\n```json\n{"reply":"r","proposals":[{"title":"t"},3]}\n```').proposals).toHaveLength(1);
  });
});
