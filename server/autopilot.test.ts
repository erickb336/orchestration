// Reliability and optional human-in-the-loop: review gates, human edits re-submitted through the
// pipeline, per-provider concurrency, automatic retries, automatic delivery, import/export, cleanup.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as M from "../src/domain/model";
import type { State } from "../src/domain/types";
import { Scheduler } from "./scheduler";
import { Store } from "./store";
import { setTestPipeline } from "./testing/pipelines";
import { ScriptedAdapter } from "./testing/scripted";
import { WorkspaceManager } from "./workspaces";

// Real git and many scheduler cycles per test: a busy machine can take
// several times vitest's 5 s default, so these tests get 20 s. A real hang still fails.
vi.setConfig({ testTimeout: 20_000 });

let dir: string;
let repo: string;
let store: Store;
let claude: ScriptedAdapter;
let codex: ScriptedAdapter;
let workspaces: WorkspaceManager;
let scheduler: Scheduler;
let now = Date.parse("2026-09-29T12:00:00Z");
const iso = () => new Date(now).toISOString();
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
const commit = (file: string, text: string, msg: string) => {
  writeFileSync(join(repo, file), text);
  git("add", "-A");
  git("-c", "user.name=u", "-c", "user.email=u@u", "commit", "-q", "-m", msg);
};
const tick = (ms = 1000) => {
  now += ms;
  scheduler.tick(now);
};
const st = (): State => store.read().state;
const task = (id: string) => st().tasks.find((t) => t.id === id)!;
const step = (id: string, s: string) => task(id).steps.find((x) => x.id === s)!;
const run = (id: string) => M.activeAttempts(st(), id)[0];
let key = 0;
const cmd = (name: string, args: object = {}) => store.command(name, args, `k${++key}`, iso());
const newTask = (title: string, flowId = "change") =>
  (cmd("createTask", { title, area: "", outcome: `${title} outcome`, benefit: "", whyNow: "", approach: "do it", acceptance: ["ok"], priority: 1, holdBeforeStart: false, flowId }).result as { newId: string }).newId;
const oneStep = (id: string) =>
  setTestPipeline(store, id, [{ id: "S1", purpose: "Implement", role: "coder", dependsOn: [], inputs: [], outputs: [{ name: "change", kind: "code-change" }] }], iso(), "one step");

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "orch-auto-"));
  repo = join(dir, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  commit("README.md", "hello\n", "init");
  store = new Store(join(dir, "db.sqlite"));
  claude = new ScriptedAdapter("claude");
  codex = new ScriptedAdapter("codex");
  workspaces = new WorkspaceManager(join(dir, "worktrees"));
  scheduler = new Scheduler(store, { claude, codex }, { workspaces, leaseMs: 60_000, ackTimeoutMs: 10_000 });
  await scheduler.refreshHealth();
  cmd("initProject", { name: "Auto", repoPath: repo, vision: "v", focus: "f" });
  cmd("setRoleDefault", { role: "coder", selection: { provider: "codex", model: "codex-sample-large" } });
  cmd("setRoleDefault", { role: "code_reviewer", selection: { provider: "claude", model: "claude-sample-large" } });
  cmd("setLeadSelection", { selection: { provider: "claude", model: "claude-sample-large" } });
});
afterEach(async () => {
  await scheduler.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("review gates and human edits", () => {
  it("step-by-step review pauses the pipeline; an edited artifact is what the next step receives", () => {
    const id = newTask("Reviewed");
    cmd("setReviewEveryStep", { taskId: id, value: true });
    tick();
    codex.finish(run(id).id, { write: ["a.txt", "a\n"] });
    tick();
    expect(task(id).holdReason).toMatch(/Review S1/);
    cmd("resumeTask", { taskId: id });
    tick();
    tick();
    expect(run(id).stepId).toBe("S2");
    // The security review beside the code review finishes first; its pause is resumed at once (a result that
    // arrives while the task is held is not integrated, so the reviews are not finished under one hold).
    claude.finish(M.activeAttempts(st(), id).find((a) => a.stepId === "SR1")!.id, { findings: 0 });
    tick();
    expect(task(id).holdReason).toMatch(/Review SR1/);
    cmd("resumeTask", { taskId: id });
    claude.finish(run(id).id, { findings: 0 }); // the code review, clean: the task pauses on it
    tick();
    expect(task(id).hold).toBe(true);
    expect(task(id).holdReason).toMatch(/Review S2/);
    tick(5000);
    expect(M.activeAttempts(st(), id)).toHaveLength(0); // waits for the person
    const findings = st().artifacts.find((a) => a.taskId === id && a.stepId === "S2")!;
    cmd("editArtifact", { artifactId: findings.id, summary: "One real issue: a.txt lacks a trailing summary.", openFindings: 1, reason: "Reviewer missed this" });
    cmd("resumeTask", { taskId: id });
    tick();
    tick();
    const repair = run(id);
    expect(repair.stepId).toBe("S3"); // the edit's open finding makes repair run
    const received = repair.snapshot.inputs.find((i) => i.step === "S2")!;
    expect(received.version).toBe(2);
    expect(codex.runs.get(repair.id)!.prompt).toContain("edited by the user: Reviewer missed this");
  });

  it("editing an upstream artifact re-submits everything downstream that used it", () => {
    const id = newTask("Resubmit");
    tick();
    codex.finish(run(id).id, { write: ["b.txt", "b\n"] });
    tick();
    tick();
    const review = run(id);
    const change = st().artifacts.find((a) => a.taskId === id && a.stepId === "S1" && a.name === "change")!;
    cmd("editArtifact", { artifactId: change.id, summary: "Changed b.txt; please also check naming.", reason: "Clarify scope for the reviewer" });
    expect(st().attempts.find((a) => a.id === review.id)!.outcome).toBe("stopping"); // running reviewer stopped
    for (const a of st().attempts.filter((x) => x.taskId === id && x.outcome === "stopping")) claude.emit({ type: "stopped", attemptId: a.id, how: "interrupted" }); // both reviews beside each other
    tick();
    tick();
    const again = run(id);
    expect(again.stepId).toBe("S2");
    expect(again.snapshot.inputs.find((i) => i.output === "change")!.version).toBe(2);
  });

  it("step-by-step mode pauses after every step", () => {
    const id = newTask("Stepwise");
    cmd("setReviewEveryStep", { taskId: id, value: true });
    tick();
    codex.finish(run(id).id, { write: ["c.txt", "c\n"] });
    tick();
    expect(task(id).hold).toBe(true);
    cmd("resumeTask", { taskId: id });
    tick();
    expect(run(id).stepId).toBe("S2");
  });
});

describe("scale and autopilot", () => {
  it("per-provider limits bound concurrency independently", () => {
    cmd("setWorkerLimit", { limit: 10 });
    cmd("setProviderLimit", { provider: "codex", limit: 2 });
    for (let i = 0; i < 5; i++) newTask(`T${i}`);
    tick();
    const active = M.activeAttempts(st());
    expect(active.filter((a) => a.snapshot.provider === "codex")).toHaveLength(2);
  });

  it("automatic retry re-runs a failed step once; credential failures are never retried", () => {
    cmd("setAutonomy", { enabled: false, planningIntervalMinutes: 60, maxProposalsPerCycle: 3, maxOpenProposals: 5, holdLeadProposals: false, operatingHours: null, autoRetry: 1 });
    const a = newTask("Flaky");
    const b = newTask("NoKey");
    tick();
    codex.emit({ type: "failed", attemptId: run(a).id, message: "network hiccup" });
    codex.emit({ type: "failed", attemptId: run(b).id, message: "Codex is not signed in." });
    tick();
    tick();
    expect(run(a)).toBeUndefined(); // backs off before retrying
    tick(61_000);
    tick();
    expect(run(a)?.stepId).toBe("S1"); // retried
    expect(step(a, "S1").autoRetries).toBe(1);
    expect(step(b, "S1").state).toBe("blocked"); // not retryable
    codex.emit({ type: "failed", attemptId: run(a).id, message: "network hiccup" });
    tick(5 * 60_000);
    tick();
    expect(step(a, "S1").state).toBe("blocked"); // retry budget used up
  });

  it("autopilot delivers integrated work to the checked-out branch by fast-forward, merging the user's newer commits first", () => {
    cmd("applyAutopilot", { branch: "main" });
    cmd("setAutonomy", { ...st().project.autonomy, enabled: false }); // keep the lead out of this test
    const id = newTask("Deliver");
    oneStep(id);
    tick();
    const r = run(id);
    commit("USER.md", "user work\n", "user commit while the worker runs");
    codex.finish(r.id, { write: ["feature.txt", "feature\n"] });
    tick();
    tick();
    expect(task(id).integration?.status).toBe("integrated");
    expect(task(id).integration?.delivered?.status).toBe("delivered");
    expect(git("show", "main:feature.txt")).toBe("feature");
    expect(git("show", "main:USER.md")).toBe("user work");
    expect(git("status", "--porcelain")).toBe(""); // the working tree was updated too
  });

  it("delivery waits for a clean working tree and never overwrites uncommitted work", () => {
    cmd("setAutonomy", { enabled: false, planningIntervalMinutes: 60, maxProposalsPerCycle: 3, maxOpenProposals: 5, holdLeadProposals: false, operatingHours: null, autoDeliver: { enabled: true, branch: "main" } });
    const id = newTask("Dirty");
    oneStep(id);
    tick();
    writeFileSync(join(repo, "README.md"), "local edit\n");
    codex.finish(run(id).id, { write: ["g.txt", "g\n"] });
    tick();
    tick();
    expect(task(id).integration?.delivered?.status).toBe("skipped");
    expect(git("rev-list", "--count", "main")).toBe("1");
    expect(git("diff", "--name-only")).toBe("README.md");
  });
});

describe("import, export, cleanup", () => {
  it("imports a Markdown board once; open legacy tasks never run until a spec is written", () => {
    const md = `| Priority | ID | Proposed outcome | State |\n| --- | --- | --- | --- |\n| 1 | SF-002 | Find journal friction | proposed |\n| 2 | OPS-001 | Shared instructions | done |`;
    const r = cmd("importMarkdown", { markdown: md }).result as { imported: string[] };
    expect(r.imported).toEqual(["SF-002", "OPS-001"]);
    expect(task("OPS-001")).toMatchObject({ lifecycle: "done", legacySpecUnavailable: true });
    cmd("startHeldTask", { taskId: "SF-002" });
    for (let i = 0; i < 3; i++) tick();
    expect(M.activeAttempts(st(), "SF-002")).toHaveLength(0);
    const c = M.currentSpec(task("SF-002")).content;
    cmd("editSpec", { taskId: "SF-002", expectedRev: 1, content: { ...c, acceptance: ["Friction list published"] }, reason: "Write the spec" });
    tick();
    tick();
    expect(M.activeAttempts(st(), "SF-002")).toHaveLength(1);
    expect(() => cmd("importMarkdown", { markdown: "no table" })).toThrow(/No task table/);
    const out = M.exportMarkdown(st());
    expect(out).toContain("| SF-002 |");
    expect(out).toContain("| OPS-001 |");
  });

  it("cleanup removes finished runs' worktrees but never an active run's", () => {
    const a = newTask("Finished");
    oneStep(a);
    const b = newTask("Running");
    oneStep(b);
    tick();
    const ra = run(a);
    const rb = run(b);
    codex.finish(ra.id, { write: ["x.txt", "x\n"] });
    tick();
    const removed = scheduler.prune();
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(existsSync(ra.snapshot.workspace)).toBe(false);
    expect(existsSync(rb.snapshot.workspace)).toBe(true);
    expect(git("branch", "--list", "orchestration/*").length).toBeGreaterThan(0); // branches kept
  });
});

describe("delivery safety", () => {
  const deliverOn = () =>
    cmd("setAutonomy", { enabled: false, planningIntervalMinutes: 60, maxProposalsPerCycle: 3, maxOpenProposals: 5, holdLeadProposals: false, operatingHours: null, autoDeliver: { enabled: true, branch: "main" } });
  const deliverTask = (title: string, file: string, text: string) => {
    const id = newTask(title);
    oneStep(id);
    tick();
    codex.finish(run(id).id, { write: [file, text] });
    tick();
    tick();
    return id;
  };

  it("work started while another branch is checked out never carries that branch's commits to main", () => {
    deliverOn();
    git("switch", "-q", "-c", "experiment");
    commit("EXP.md", "unfinished\n", "unfinished experiment");
    const id = deliverTask("From experiment checkout", "f.txt", "f\n");
    expect(task(id).integration?.status).toBe("integrated");
    git("switch", "-q", "main");
    tick(61_000);
    expect(st().project.delivery?.status).toBe("delivered");
    expect(git("show", "main:f.txt")).toBe("f");
    expect(() => git("show", "main:EXP.md")).toThrow(); // the experiment never reaches main
  });

  it("a checkout of main in another worktree is fast-forwarded in place, never desynced", () => {
    deliverOn();
    git("switch", "-q", "-c", "other");
    const wt2 = join(dir, "wt-main");
    git("worktree", "add", "-q", wt2, "main");
    const id = deliverTask("Into linked worktree", "h.txt", "h\n");
    tick(61_000);
    expect(task(id).integration?.delivered?.status).toBe("delivered");
    expect(execFileSync("git", ["-C", wt2, "status", "--porcelain"], { encoding: "utf8" }).trim()).toBe("");
    expect(existsSync(join(wt2, "h.txt"))).toBe(true);
  });

  it("delivery never overwrites an existing ignored file", () => {
    deliverOn();
    writeFileSync(join(repo, ".env"), "SECRET=user\n");
    const id = deliverTask("Adds .env", ".env", "AGENT=1\n");
    tick(61_000);
    expect(task(id).integration?.delivered?.status).toBe("skipped");
    expect(git("rev-list", "--count", "main")).toBe("1");
    expect(execFileSync("cat", [join(repo, ".env")], { encoding: "utf8" })).toBe("SECRET=user\n");
  });

  it("after the user resets main backwards, delivery stops instead of restoring removed work", () => {
    deliverOn();
    deliverTask("First", "one.txt", "1\n");
    tick(61_000);
    expect(git("show", "main:one.txt")).toBe("1");
    git("reset", "-q", "--hard", git("rev-list", "--max-parents=0", "main"));
    deliverTask("Second", "two.txt", "2\n");
    tick(61_000);
    expect(st().project.delivery?.status).toBe("blocked");
    expect(st().project.autonomy.autoDeliver.enabled).toBe(false);
    expect(() => git("show", "main:one.txt")).toThrow();
  });

  it("a delivery skipped for a dirty tree is retried once the tree is clean", () => {
    deliverOn();
    writeFileSync(join(repo, "README.md"), "local edit\n");
    const id = deliverTask("Retry later", "r.txt", "r\n");
    tick(61_000);
    expect(task(id).integration?.delivered?.status).toBe("skipped");
    git("checkout", "--", "README.md");
    tick(61_000);
    expect(task(id).integration?.delivered?.status).toBe("delivered");
    expect(git("show", "main:r.txt")).toBe("r");
  });

  it("cleanup keeps worktrees that hold uncommitted work", () => {
    const id = newTask("Partial");
    oneStep(id);
    tick();
    const r = run(id);
    writeFileSync(join(r.snapshot.workspace, "partial.txt"), "wip\n");
    codex.emit({ type: "activity", attemptId: r.id, note: "Time limit reached" });
    codex.emit({ type: "stopped", attemptId: r.id, how: "interrupted" });
    tick();
    scheduler.prune();
    expect(existsSync(join(r.snapshot.workspace, "partial.txt"))).toBe(true);
  });

  it("an edited code change must name a commit hash", () => {
    const id = newTask("Ref");
    tick();
    codex.finish(run(id).id, { write: ["q.txt", "q\n"] });
    tick();
    const change = st().artifacts.find((a) => a.taskId === id && a.name === "change")!;
    expect(() => cmd("editArtifact", { artifactId: change.id, summary: "mine", reason: "use main", ref: "main" })).toThrow(/commit hash/);
    expect(() => cmd("editArtifact", { artifactId: change.id, summary: "mine", reason: "flag", ref: "--help" })).toThrow(/commit hash/);
  });

  it("imported ids must be valid branch names and cannot be LEAD", () => {
    const md = "| ID | Title |\n| --- | --- |\n| a..b | Bad |\n| LEAD | Reserved |\n| [GOOD-1](x.md) | Linked |";
    const r = cmd("importMarkdown", { markdown: md }).result as { imported: string[]; skipped: string[] };
    expect(r.imported).toEqual(["GOOD-1"]);
    expect(r.skipped.length).toBe(2);
  });
});
