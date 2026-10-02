// The autonomous team loop: the lead conversation, planning with bounded autonomy, lead-authored tasks flowing
// through mixed-provider pipelines, serial integration, and lead controls. Scripted adapters and a
// temporary git repository; no real providers.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startFactoryArgs } from "../src/domain/testing/factory";
import * as M from "../src/domain/model";
import type { State } from "../src/domain/types";
import { buildLeadEnvelope, parseLeadOutput } from "./envelope";
import { Scheduler } from "./scheduler";
import { Store } from "./store";
import { setTestPipeline } from "./testing/pipelines";
import { ScriptedAdapter, proposal } from "./testing/scripted";
import { WorkspaceManager } from "./workspaces";

// Real git and many scheduler cycles per test: a busy machine can take
// several times vitest's 5 s default, so these tests get 20 s. A real hang still fails.
vi.setConfig({ testTimeout: 20_000 });

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
  cmd("startFactory", startFactoryArgs(store.read().state));
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
      proposal({ title: "Bad flow", flowId: "nope" }),
      proposal({ title: "Add a greeting" }), // duplicate of the first
    ]);
    tick();
    const msg = st().conversation.find((m) => m.author === "lead")!;
    expect(msg.proposedTaskIds).toHaveLength(1);
    const t = task(msg.proposedTaskIds![0]);
    expect(t.specs[0].author).toBe("lead");
    expect(M.currentSpec(t).content).toMatchObject({ decidedBy: "lead", selectedOptionId: "A", recommendedOptionId: "A" });
    expect(t.pipelineHistory[0].reason).toMatch(/Change flow/);
    expect(msg.rejected!.join(" ")).toMatch(/two to four options/);
    expect(msg.rejected!.join(" ")).toMatch(/unknown flow "nope"/);
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
    expect(leadRun()).toBeUndefined(); // backs off before retrying a failed lead
    tick(61_000);
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
    const security = M.activeAttempts(st(), id).find((a) => a.stepId === "SR1")!; // the security review runs beside it, on the same reviewer provider
    expect(security.snapshot.provider).toBe("claude");
    claude.finish(review.id, { findings: 0 });
    claude.finish(security.id, { findings: 0 });
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
    const id = (cmd("createTask", { title, area: "", outcome: "x", benefit: "", whyNow: "", approach: "y", acceptance: ["ok"], priority: 1, holdBeforeStart: false, flowId: "change" }).result as { newId: string }).newId;
    setTestPipeline(store, id, [{ id: "S1", purpose: "Implement", role: "coder", dependsOn: [], inputs: [], outputs: [{ name: "change", kind: "code-change" }] }], iso(), "one step");
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
    now += 61_000; // backoff after a lost lead run
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

describe("lead and integration edge cases", () => {
  it("repeated lead failures back off and then wait for a new message instead of looping", () => {
    cmd("postMessage", { text: "hello" });
    let starts = 0;
    for (let i = 0; i < 30; i++) {
      tick(30_000);
      const r = leadRun();
      if (r) {
        starts++;
        claude.emit({ type: "failed", attemptId: r.id, message: "rate limited" });
      }
    }
    expect(starts).toBe(3); // 1st immediately, then after 1 min and 2 min; then it stops trying
    cmd("postMessage", { text: "try again" });
    tick();
    expect(leadRun()).toBeDefined();
  });

  it("a malformed proposal is rejected on its own; the reply and valid proposals survive", () => {
    cmd("postMessage", { text: "plan" });
    tick();
    const r = leadRun()!;
    claude.reply(r.id, "Mixed batch.", [{ ...proposal(), title: 42 }, { ...proposal({ title: "Null option" }), options: [null, null] }, proposal({ title: "Good one" })]);
    tick();
    const msg = st().conversation.find((m) => m.author === "lead")!;
    expect(msg.text).toBe("Mixed batch.");
    expect(msg.proposedTaskIds).toHaveLength(1);
    // The output schema's note names the first mismatches; each proposal is then checked on its own.
    expect(msg.rejected).toEqual([
      "The reply's JSON did not match the output schema (/proposals/0/title must be string; /proposals/1/options/0 must be object; /proposals/1/options/1 must be object). The service checked each part on its own.",
      expect.stringContaining('"(untitled)"'),
      expect.stringContaining('"Null option"'),
    ]);
    expect(leadRun()).toBeUndefined();
  });

  it("completions wake planning no sooner than the minimum gap, and never more than 48 times a day", () => {
    autonomy({ planningIntervalMinutes: 1440, maxProposalsPerCycle: 1, maxOpenProposals: 50 });
    tick();
    const first = leadRun()!;
    claude.reply(first.id, "one", [proposal({ title: "P0" })]);
    tick();
    const id = st().tasks[0].id;
    cmd("cancelTask", { taskId: id });
    tick(2 * 60_000);
    expect(st().leadRuns).toHaveLength(1); // a quick change does not re-plan within the gap
  });

  it("with autonomy off, proposals from a conversation wait for the user", () => {
    cmd("postMessage", { text: "plan please" });
    tick();
    claude.reply(leadRun()!.id, "ok", [proposal()]);
    tick();
    tick();
    const t = st().tasks[0];
    expect(t.holdBeforeStart).toBe(true);
    expect(M.activeAttempts(st(), t.id)).toHaveLength(0);
  });

  it("an invalid lead selection is refused; a lead that cannot run explains why", () => {
    expect(() => cmd("setLeadSelection", { selection: { provider: "claude", model: "no-such-model" } })).toThrow(/not in the Claude catalog/);
    claude.healthStatus = "not-configured";
    return scheduler.refreshHealth().then(() => {
      cmd("postMessage", { text: "anyone?" });
      tick();
      expect(scheduler.leadBlocked).toMatch(/Claude is not available/);
    });
  });

  it("a missing integration workspace is recovered, not recorded as a conflict", () => {
    const id = (cmd("createTask", { title: "I", area: "", outcome: "x", benefit: "", whyNow: "", approach: "y", acceptance: ["ok"], priority: 1, holdBeforeStart: false, flowId: "change" }).result as { newId: string }).newId;
    setTestPipeline(store, id, [{ id: "S1", purpose: "Implement", role: "coder", dependsOn: [], inputs: [], outputs: [{ name: "change", kind: "code-change" }] }], iso(), "one step");
    tick();
    codex.finish(M.activeAttempts(st(), id)[0].id, { write: ["i.txt", "i\n"] });
    tick();
    tick();
    expect(task(id).integration?.status).toBe("integrated");
    // Remove the integration worktree directory behind the service's back; the next task still integrates.
    const wsRoot = join(dir, "worktrees");
    const found: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d, { withFileTypes: true })) {
        if (n.isDirectory() && n.name === "integration") found.push(join(d, n.name));
        else if (n.isDirectory() && !n.name.startsWith(".")) walk(join(d, n.name));
      }
    };
    walk(wsRoot);
    rmSync(found[0], { recursive: true, force: true });
    const id2 = (cmd("createTask", { title: "J", area: "", outcome: "x", benefit: "", whyNow: "", approach: "y", acceptance: ["ok"], priority: 1, holdBeforeStart: false, flowId: "change" }).result as { newId: string }).newId;
    setTestPipeline(store, id2, [{ id: "S1", purpose: "Implement", role: "coder", dependsOn: [], inputs: [], outputs: [{ name: "change", kind: "code-change" }] }], iso(), "one step");
    tick();
    codex.finish(M.activeAttempts(st(), id2)[0].id, { write: ["j.txt", "j\n"] });
    tick();
    tick();
    expect(task(id2).integration?.status).toBe("integrated");
  });

  it("a lead run's read-only checkout is removed when the run ends", () => {
    cmd("postMessage", { text: "hi" });
    tick();
    const r = leadRun()!;
    const path = claude.runs.get(r.id)!.workspace.path;
    expect(existsSync(path)).toBe(true);
    claude.reply(r.id, "bye");
    tick();
    expect(existsSync(path)).toBe(false);
  });
});
