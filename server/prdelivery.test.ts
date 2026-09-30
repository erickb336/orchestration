// ORC-008 step 2, end to end: pull-request delivery in hold-and-notify mode (design §17, scenarios 1,
// 8–16 and 20; scenario 19 is in prsim.test.ts). No test contacts GitHub: a local bare repository is
// `origin`, FakeGitHub stands in for the GitHub API on top of it, and scripted adapters stand in for
// Claude and Codex. git fetch, ls-remote and push run for real against the bare repository.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLIENT_HEADER } from "../src/api";
import { createHttpServer } from "./http";
import * as D from "../src/domain/delivery";
import * as M from "../src/domain/model";
import type { PrDelivery, State } from "../src/domain/types";
import { GhError } from "./github";
import { PrDriver } from "./prdelivery";
import { Scheduler } from "./scheduler";
import { Store } from "./store";
import { FakeGitHub } from "./testing/fakeGitHub";
import { ScriptedAdapter } from "./testing/scripted";
import { WorkspaceManager, assertSafePush } from "./workspaces";

let dir: string;
let repo: string;
let bare: string;
let store: Store;
let claude: ScriptedAdapter;
let codex: ScriptedAdapter;
let workspaces: WorkspaceManager;
let scheduler: Scheduler;
let fake: FakeGitHub;
let extra: Scheduler[] = [];
let now = Date.parse("2026-09-30T12:00:00Z");
const iso = () => new Date(now).toISOString();
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const remote = (...args: string[]) => execFileSync("git", ["--git-dir", bare, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const commit = (file: string, text: string, msg: string) => {
  writeFileSync(join(repo, file), text);
  git("add", "-A");
  git("-c", "user.name=u", "-c", "user.email=u@u", "commit", "-q", "-m", msg);
};
/** One scheduler tick, then wait for the GitHub operation it started (if any) to settle. */
const tick = async (ms = 1000, sch: Scheduler = scheduler) => {
  now += ms;
  sch.tick(now);
  await sch.prIdle();
};
const ticks = async (n: number, ms = 1000, sch: Scheduler = scheduler) => {
  for (let i = 0; i < n; i++) await tick(ms, sch);
};
const st = (): State => store.read().state;
const task = (id: string) => st().tasks.find((t) => t.id === id)!;
const pr = (id: string): PrDelivery => task(id).integration!.pr!;
const run = (id: string) => M.activeAttempts(st(), id)[0];
let key = 0;
const cmd = (name: string, args: object = {}) => store.command(name, args, `k${++key}`, iso());
const newTask = (title: string) =>
  (cmd("createTask", { title, area: "", outcome: `${title} outcome`, benefit: "", whyNow: "", approach: "do it", acceptance: ["ok"], priority: 1, holdBeforeStart: false, templateId: "change" }).result as { newId: string }).newId;
const oneStep = (id: string) =>
  cmd("setPipeline", { taskId: id, expectedRev: 1, steps: [{ id: "S1", purpose: "Implement", role: "coder", dependsOn: [], inputs: [], outputs: [{ name: "change", kind: "code-change" }] }], reason: "one step" });
const branches = () => remote("for-each-ref", "--format=%(refname)", "refs/heads/").split("\n").filter((r) => r.includes("orchestration/"));
const events = (text: string) => st().events.filter((e) => e.message.includes(text));
const newScheduler = (leaseMs = 120_000) => {
  const s = new Scheduler(store, { claude, codex }, { workspaces, github: fake, leaseMs, ackTimeoutMs: 10_000 });
  extra.push(s);
  return s;
};

/** A one-step task that writes one file and finishes; its head is prepared as a pull request. */
const finishTask = async (title: string, file: string, text: string) => {
  const id = newTask(title);
  oneStep(id);
  await tick();
  const r = run(id);
  const ws = codex.runs.get(r.id)!.workspace.path;
  mkdirSync(join(ws, file, ".."), { recursive: true });
  codex.finish(r.id, { write: [file, text] });
  await tick(); // the result is recorded
  await tick(); // the task is done and its head is prepared
  return id;
};
/** …and its pull request is opened and seen once on GitHub. */
const openPr = async (title: string, file: string, text: string) => {
  const id = await finishTask(title, file, text);
  for (let i = 0; i < 6 && !pr(id).observed; i++) await tick(2000);
  expect(pr(id).phase).toBe("open");
  return id;
};
/** The required check passes and the app sees it. */
const green = async (id: string) => {
  fake.setCheck(pr(id).number!, "SUCCESS");
  await seen();
};
/** Enough time for the app to read GitHub again and record what it saw. */
const seen = async () => {
  // Twice: a read that was already in flight is applied first, then a fresh one is made and applied.
  for (let i = 0; i < 2; i++) {
    await tick(121_000);
    await ticks(2);
  }
};
/** The user merges from the app, and the app sees the result. */
const mergeFromApp = async (id: string) => {
  cmd("requestPrMerge", { taskId: id, headSha: pr(id).headSha });
  for (let i = 0; i < 8 && pr(id).phase === "open"; i++) await tick(3000);
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "orch-pr-"));
  repo = join(dir, "repo");
  bare = join(dir, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  commit("README.md", "hello\n", "init");
  git("remote", "add", "origin", bare);
  git("push", "-q", "origin", "main");
  store = new Store(join(dir, "db.sqlite"));
  claude = new ScriptedAdapter("claude");
  codex = new ScriptedAdapter("codex");
  workspaces = new WorkspaceManager(join(dir, "worktrees"));
  fake = new FakeGitHub(bare);
  extra = [];
  scheduler = newScheduler();
  await scheduler.refreshHealth();
  cmd("initProject", { name: "PRs", repoPath: repo, vision: "v", focus: "f" });
  cmd("setRoleDefault", { role: "coder", selection: { provider: "codex", model: "codex-sample-large" } });
  cmd("setRoleDefault", { role: "code_reviewer", selection: { provider: "claude", model: "claude-sample-large" } });
  cmd("setLeadSelection", { selection: { provider: "claude", model: "claude-sample-large" } });
});
afterEach(async () => {
  for (const s of extra) await s.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Switch pull-request delivery on and let the read-only check and the first fetch happen. */
const prModeOn = async () => {
  cmd("setDeliveryMode", { mode: "pr" });
  await ticks(3);
  expect(st().project.github).toMatchObject({ ok: true, repo: "test/repo", requiredChecks: ["check"] });
  expect(st().project.github!.base!.sha).toBe(remote("rev-parse", "refs/heads/main"));
};

describe("hold and notify (scenario 1)", () => {
  it("switching the mode on only reads: a check of the repository and a fetch into a private ref", async () => {
    const heads = git("for-each-ref", "refs/heads", "refs/remotes");
    await prModeOn();
    expect(fake.calls.map((c) => c.method)).toEqual(["preflight"]);
    expect(git("for-each-ref", "refs/heads", "refs/remotes")).toBe(heads); // the user's refs are untouched
    expect(git("rev-parse", workspaces.baseRef(st().project.id))).toBe(remote("rev-parse", "main"));
    expect(existsSync(join(repo, ".git", "FETCH_HEAD"))).toBe(false);
    expect(branches()).toEqual([]);
    expect(st().project.github!.posture.some((p) => p.id === "not-verified" && p.status === "unverified")).toBe(true);
  });

  it("one pull request whose head is exactly the final commit; one ready notice; a merge bound to that head; the item lands unreviewed", async () => {
    await prModeOn();
    const id = await finishTask("Adds a greeting", "greet.txt", "hi\n");
    const change = M.finalChange(st(), task(id))!.ref!.split(" ")[0];
    const branch = `orchestration/${st().project.id}/pr/${id}-1`;
    expect(task(id).integration).toMatchObject({ status: "integrated", pr: { n: 1, branch, base: "main", repo: "test/repo", policy: "hold", changeAuthor: "codex" } });
    expect(pr(id).headSha.startsWith(change)).toBe(true);
    expect(events(`Prepared pull request branch ${branch}`)).toHaveLength(1);
    expect(events("Integrated into the integration branch")).toHaveLength(0);
    expect(git("for-each-ref", "refs/heads/orchestration/*/integration")).toBe(""); // nothing was merged locally

    for (let i = 0; i < 6 && !pr(id).observed; i++) await tick(2000);
    // Exactly the task's final commit was pushed, to exactly the app's branch.
    expect(branches()).toEqual([`refs/heads/${branch}`]);
    expect(remote("rev-parse", `refs/heads/${branch}`)).toBe(pr(id).headSha);
    expect(remote("log", "--format=%an <%ae>", `main..${branch}`)).toBe("Orchestration <orchestration@localhost>");
    expect(fake.count("createPr")).toBe(1);
    const created = fake.calls.find((c) => c.method === "createPr")!.args as { head: string; base: string; title: string; body: string };
    expect(created).toMatchObject({ head: branch, base: "main", title: `${id}: Adds a greeting` });
    expect(created.body).toContain(`<!-- orchestration:pr:${st().project.id}/${id}/1 -->`);
    expect(created.body).toContain("Opened by Orchestration using this GitHub account");
    expect(pr(id)).toMatchObject({ phase: "open", number: 1, url: "https://github.com/test/repo/pull/1" });
    expect(pr(id).op).toBeUndefined();

    // Checks still running: waiting, not ready, and nobody is told.
    expect(D.prGate(st(), task(id), now, { byUser: true }).status).toBe("waiting");
    expect(D.prReady(st(), task(id), now)).toBe(false);
    expect(D.needsYou(st(), now)).toBe(0);

    expect(events("is ready for you")).toHaveLength(0);
    await green(id);
    expect(D.prReady(st(), task(id), now)).toBe(true);
    expect(D.needsYou(st(), now)).toBe(1);
    expect(events("is ready for you").map((e) => e.message)).toEqual([`PR #1 is ready for you: required checks passed on ${pr(id).headSha.slice(0, 12)}`]);
    // Once per change, not once per poll (the notification keys are tested in src/ui/notifications.test.ts).
    const polls = fake.count("observe");
    await ticks(8, 121_000);
    expect(fake.count("observe")).toBeGreaterThan(polls + 2);
    expect(events("is ready for you")).toHaveLength(1);
    expect(pr(id).attention).toBeUndefined();
    expect(fake.count("merge")).toBe(0); // held: nothing merges by itself

    // A Merge click for another commit than the one shown is refused.
    expect(() => cmd("requestPrMerge", { taskId: id, headSha: "f".repeat(40) })).toThrow(/changed since you looked/);
    await mergeFromApp(id);
    expect(fake.count("merge")).toBe(1);
    expect(fake.calls.find((c) => c.method === "merge")!.args).toMatchObject({ number: 1, headSha: pr(id).headSha });
    const landed = task(id).integration!.landed!;
    expect(pr(id).phase).toBe("merged");
    expect(landed).toMatchObject({ via: "pr", target: "test/repo main", by: "app", status: "unreviewed", flags: [], pr: { number: 1, url: "https://github.com/test/repo/pull/1" } });
    // The recorded commit is GitHub's merge commit: on the remote base, second parent the head.
    expect(landed.commit).toBe(remote("rev-parse", "main"));
    expect(remote("rev-parse", `${landed.commit}^2`)).toBe(pr(id).headSha);
    expect(landed.checks).toEqual([expect.objectContaining({ name: "check", conclusion: "SUCCESS" })]);
    expect(events("merged into main by Orchestration, at your request")).toHaveLength(1);

    expect(D.unreviewedCount(st())).toBe(1);
    cmd("markLandedReviewed", { taskIds: [id], reviewed: true });
    expect(D.unreviewedCount(st())).toBe(0);
    // Local delivery never touches a task delivered as a pull request.
    expect(task(id).integration!.delivered).toBeUndefined();
    expect(git("status", "--porcelain")).toBe("");
  });

  it("a merge waits for GitHub: requested early, it is sent only once the required check passed on that head", async () => {
    await prModeOn();
    const id = await openPr("Early click", "a.txt", "a\n");
    cmd("requestPrMerge", { taskId: id, headSha: pr(id).headSha });
    await ticks(4, 31_000);
    expect(fake.count("merge")).toBe(0);
    fake.setCheck(1, "SKIPPED"); // a skipped required check is not a pass
    await ticks(3, 31_000);
    expect(fake.count("merge")).toBe(0);
    expect(pr(id).attention?.code).toBe("checks-failed");
    fake.setCheck(1, "SUCCESS");
    await ticks(4, 31_000);
    expect(fake.count("merge")).toBe(1);
    expect(pr(id).phase).toBe("merged");
  });

  it("the changes of an open pull request can be shown, from the base it contains to its head", async () => {
    await prModeOn();
    const id = await openPr("Shown", "shown.txt", "shown line\n");
    const d = workspaces.changeDiff({ repoPath: repo, commit: pr(id).headSha, from: pr(id).baseSha })!;
    expect(d.diff).toContain("+shown line");
    expect(pr(id).changed).toMatchObject({ files: 1, additions: 1, deletions: 0, paths: ["shown.txt"], protectedHits: [], workflowHits: [] });
  });
});

describe("what is never published", () => {
  it("a push that could force, delete or leave the app's branches is refused before git runs", () => {
    const sha = "a".repeat(40);
    const ok = `${sha}:refs/heads/orchestration/p1/pr/T-1-1`;
    expect(() => assertSafePush(["-C", "/r", "push", "--porcelain", "--no-verify", "origin", ok])).not.toThrow();
    for (const flag of ["--force", "-f", "--force-with-lease", "--force-with-lease=x", "--mirror", "--all", "--tags", "--delete", "-d"]) {
      expect(() => assertSafePush(["-C", "/r", "push", flag, "origin", ok]), flag).toThrow(/refusing/);
    }
    expect(() => assertSafePush(["push", "origin", `+${ok}`])).toThrow(/refusing/);
    expect(() => assertSafePush(["push", "origin", `${sha}:refs/heads/main`])).toThrow(/not one of the app's/);
    expect(() => assertSafePush(["push", "origin", `${sha}:refs/heads/orchestration/p1/integration`])).toThrow(/not one of the app's/);
    expect(() => assertSafePush(["push", "origin", `main:refs/heads/orchestration/p1/pr/T-1-1`])).toThrow(/refusing/);
    expect(() => assertSafePush(["push", "origin"])).toThrow(/refusing/);
  });

  it("scenario 9: work built on the user's unpushed commit is not pushed; the task names the author", async () => {
    // The task starts from the local HEAD, which holds a commit the user never pushed.
    commit("private.txt", "mine\n", "my unpushed work");
    const id = newTask("On top of private work");
    oneStep(id);
    await tick();
    const r = run(id);
    await prModeOn();
    codex.finish(r.id, { write: ["w.txt", "w\n"] });
    await ticks(6, 2000);
    expect(task(id).integration).toMatchObject({ status: "conflict" });
    expect(task(id).integration!.message).toMatch(/contains 1 commit\(s\) not made by Orchestration \(authors: u\); nothing was pushed/);
    expect(branches()).toEqual([]);
    expect(fake.count("createPr")).toBe(0);
    // The guard is checked again before any push, whatever prepared the head.
    const sha = M.finalChange(st(), task(id))!.ref!.split(" ")[0];
    const full = git("rev-parse", sha);
    await expect(workspaces.pushHead({ repoPath: repo, projectId: st().project.id, remote: "origin", branch: `orchestration/${st().project.id}/pr/${id}-1`, sha: full })).rejects.toThrow(/not made by Orchestration/);
    expect(branches()).toEqual([]);
  });

  it("scenario 10: a change to CI workflow files is not pushed until it is allowed; then it is pushed and marked protected", async () => {
    await prModeOn();
    const id = await finishTask("Touches CI", ".github/workflows/ci.yml", "on: push\n");
    expect(pr(id).changed.workflowHits).toEqual([".github/workflows/ci.yml"]);
    expect(pr(id).attention?.code).toBe("workflow-change");
    await ticks(5, 5000);
    expect(pr(id).phase).toBe("built");
    expect(branches()).toEqual([]);
    expect(fake.count("createPr")).toBe(0);
    expect(D.needsYou(st(), now)).toBe(1);

    cmd("allowWorkflowPush", { taskId: id });
    expect(events("Allowed pushing the workflow change")).toHaveLength(1);
    await ticks(4, 2000);
    expect(pr(id)).toMatchObject({ phase: "open", policy: "hold" });
    expect(pr(id).changed.protectedHits).toEqual([".github/workflows/ci.yml"]);
    expect(branches()).toHaveLength(1);
    // It is held for the user like every pull request in this version; a merge they make is flagged.
    await green(id);
    await mergeFromApp(id);
    expect(task(id).integration!.landed!.flags).toEqual(["protected-paths"]);
  });

  it("a remote branch that holds something else is never overwritten", async () => {
    await prModeOn();
    // Somebody already owns that branch name on the remote, with unrelated history.
    const id = newTask("Collides");
    oneStep(id);
    const branch = `orchestration/${st().project.id}/pr/${id}-1`;
    commit("other.txt", "other\n", "unrelated");
    git("push", "-q", "origin", `HEAD:refs/heads/${branch}`);
    const theirs = remote("rev-parse", `refs/heads/${branch}`);
    await tick();
    codex.finish(run(id).id, { write: ["c.txt", "c\n"] });
    await ticks(6, 2000);
    expect(pr(id)).toMatchObject({ phase: "built", attention: { code: "remote-diverged" } });
    await ticks(5, 120_000);
    expect(remote("rev-parse", `refs/heads/${branch}`)).toBe(theirs);
    expect(fake.count("createPr")).toBe(0);
  });
});

describe("people on GitHub", () => {
  it("scenario 8: a push by someone else to the pull request branch is a sticky hold; the app never pushes or merges it again", async () => {
    await prModeOn();
    const id = await openPr("Pushed to", "p.txt", "p\n");
    await green(id);
    // A person adds a commit to the branch on the remote.
    const tmp = join(dir, "person");
    execFileSync("git", ["clone", "-q", "--branch", pr(id).branch, bare, tmp]);
    writeFileSync(join(tmp, "extra.txt"), "extra\n");
    execFileSync("git", ["-C", tmp, "add", "-A"]);
    execFileSync("git", ["-C", tmp, "-c", "user.name=octocat", "-c", "user.email=o@o", "commit", "-q", "-m", "extra"]);
    execFileSync("git", ["-C", tmp, "push", "-q", "origin", `HEAD:${pr(id).branch}`]);
    const theirs = remote("rev-parse", `refs/heads/${pr(id).branch}`);
    await seen();
    expect(pr(id).foreignHead).toMatchObject({ sha: theirs });
    expect(pr(id).attention?.code).toBe("foreign-push");
    expect(() => cmd("requestPrMerge", { taskId: id, headSha: pr(id).headSha })).toThrow(/Someone else pushed/);
    expect(() => cmd("requestPrMerge", { taskId: id, headSha: theirs })).toThrow(/changed since you looked/);
    const since = pr(id).attention!.since;
    await ticks(5, 121_000);
    // Sticky, and not repeated: one reason, no merge, the person's commit is still the head.
    expect(pr(id).foreignHead).toMatchObject({ sha: theirs });
    expect(pr(id).attention).toMatchObject({ code: "foreign-push", since });
    expect(events("needs you")).toHaveLength(1);
    expect(fake.count("merge")).toBe(0);
    expect(remote("rev-parse", `refs/heads/${pr(id).branch}`)).toBe(theirs);
    // The person merges it on GitHub: recorded, by them, and flagged because it was not the app's head.
    fake.mergeByPerson(1);
    await seen();
    expect(task(id).integration!.landed).toMatchObject({ by: "person", mergedBy: "octocat", flags: ["merged-without-clean-gate"] });
  });

  it("scenario 11: merged by a person → landed by that person; closed by a person → never reopened, and Deliver again opens number 2", async () => {
    await prModeOn();
    const a = await openPr("Merged by hand", "a.txt", "a\n");
    await green(a);
    fake.mergeByPerson(pr(a).number!, "octocat");
    await seen();
    expect(pr(a).phase).toBe("merged");
    expect(task(a).integration!.landed).toMatchObject({ via: "pr", by: "person", mergedBy: "octocat", status: "unreviewed", flags: [] });
    expect(D.landedTasks(st()).map((t) => t.id)).toEqual([a]);
    expect(fake.count("merge")).toBe(0);

    const b = await openPr("Closed by hand", "b.txt", "b\n");
    const n = pr(b).number!;
    fake.closeByPerson(n, "octocat");
    await seen();
    expect(pr(b)).toMatchObject({ phase: "closed", observed: { state: "CLOSED", closedBy: "octocat" } });
    expect(events("was closed on GitHub without merging by octocat")).toHaveLength(1);
    expect(task(b).integration!.landed).toBeUndefined();
    const calls = fake.calls.length;
    await ticks(4, 121_000);
    // Nothing is pushed, reopened, or even watched for the closed one (the landed commit's check still is).
    expect(fake.calls.slice(calls).every((c) => c.method === "preflight" || (c.method === "observe" && !(c.args as { prs: number[] }).prs.includes(n)))).toBe(true);
    expect(() => cmd("requestPrMerge", { taskId: b, headSha: pr(b).headSha })).toThrow(/closed/);

    cmd("redeliver", { taskIds: [b] });
    for (let i = 0; i < 8 && !(pr(b).n === 2 && pr(b).phase === "open"); i++) await tick(2000);
    expect(pr(b)).toMatchObject({ n: 2, phase: "open", branch: `orchestration/${st().project.id}/pr/${b}-2` });
    expect(pr(b).number).not.toBe(n);
    expect(fake.pr(n).state).toBe("CLOSED");
    expect(branches()).toHaveLength(3); // a-1, b-1 (kept) and b-2
  });

  it("scenario 16: GitHub BLOCKED with green checks is reported as an approval the app cannot give, and never bypassed", async () => {
    await prModeOn();
    const id = await openPr("Needs approval", "n.txt", "n\n");
    fake.pr(1).mergeStateStatus = "BLOCKED";
    fake.pr(1).reviewDecision = "REVIEW_REQUIRED";
    await green(id);
    expect(pr(id).attention?.code).toBe("approval-required");
    expect(pr(id).attention!.message).toContain("require_extra_approval_for_unattributed_changes");
    expect(D.prGate(st(), task(id), now, { byUser: true }).status).toBe("blocked");
    cmd("requestPrMerge", { taskId: id, headSha: pr(id).headSha });
    await ticks(5, 31_000);
    expect(fake.count("merge")).toBe(0);
    expect(JSON.stringify(fake.calls)).not.toMatch(/--admin|--auto|--force/);

    // Without a review requirement GitHub may still clear by itself: it is waited on, then reported.
    fake.pr(1).reviewDecision = null;
    now = Date.parse(pr(id).headSince!) + 5 * 60_000; // still inside the 10 minutes GitHub is given
    await ticks(4, 31_000);
    expect(pr(id).attention).toBeUndefined();
    expect(D.prGate(st(), task(id), now, { byUser: true }).status).toBe("waiting");
    await ticks(3, 5 * 60_000);
    expect(pr(id).attention?.code).toBe("github-blocked");
    expect(fake.count("merge")).toBe(0);
    // Once GitHub reports it clean, the user's merge goes through.
    fake.pr(1).mergeStateStatus = "CLEAN";
    await ticks(4, 31_000);
    expect(pr(id).phase).toBe("merged");
  });

  it("a merge GitHub refuses is tried twice for a head, then waits for the user", async () => {
    await prModeOn();
    const id = await openPr("Refused", "r.txt", "r\n");
    await green(id);
    fake.failNext("merge", new GhError("rejected", "Pull request is not mergeable: the base branch policy prohibits the merge"));
    fake.failNext("merge", new GhError("rejected", "Pull request is not mergeable: the base branch policy prohibits the merge"));
    cmd("requestPrMerge", { taskId: id, headSha: pr(id).headSha });
    await ticks(40, 31_000);
    expect(fake.count("merge")).toBe(2);
    expect(pr(id)).toMatchObject({ phase: "open", attention: { code: "merge-rejected" }, counters: { mergeAttempts: 2 } });
    expect(pr(id).attention!.message).toContain("base branch policy prohibits");
    expect(task(id).integration!.landed).toBeUndefined();
  });
});

describe("pause and hold (scenario 12)", () => {
  it("a project pause stops every write while GitHub is still watched; a hold on one pull request survives resume", async () => {
    await prModeOn();
    const id = await finishTask("Paused before publish", ".github/workflows/ci.yml", "on: push\n");
    expect(pr(id).phase).toBe("built");
    cmd("allowWorkflowPush", { taskId: id });
    // Pause lands between planning and the write: the committed intent is refused.
    const op = D.nextPrOp(st(), now + 3000)!;
    expect(op.kind).toBe("publish");
    expect(D.beginPrOp(st(), op, new Date(now + 3000).toISOString()).started).toBe(true);
    cmd("pauseProject");
    expect(D.beginPrOp(st(), op, new Date(now + 3000).toISOString())).toMatchObject({ started: false });
    expect(D.nextPrOp(st(), now + 3000)).toBeUndefined();
    await ticks(5, 5000);
    expect(pr(id).phase).toBe("built");
    expect(branches()).toEqual([]);
    expect(fake.count("createPr")).toBe(0);

    cmd("resumeProject");
    for (let i = 0; i < 6 && !pr(id).observed; i++) await tick(2000);
    expect(pr(id).phase).toBe("open");
    await green(id);

    // Paused with a merge requested: nothing is merged or commented, but GitHub is still read.
    cmd("pauseProject");
    cmd("requestPrMerge", { taskId: id, headSha: pr(id).headSha });
    const observes = fake.count("observe");
    await ticks(4, 5 * 60_000 + 1000);
    expect(fake.count("merge")).toBe(0);
    expect(fake.count("observe")).toBeGreaterThan(observes);
    expect(D.prGate(st(), task(id), now, { byUser: true }).items.find((i) => i.id === "not-paused")).toMatchObject({ ok: false });

    // A hold on this pull request outlives the project pause.
    cmd("holdPr", { taskId: id, reason: "want to read it first" });
    expect(pr(id).mergeRequested).toBeUndefined(); // the hold withdrew the unsent merge request
    cmd("resumeProject");
    expect(() => cmd("requestPrMerge", { taskId: id, headSha: pr(id).headSha })).not.toThrow();
    await ticks(4, 31_000);
    expect(pr(id).userHold).toMatchObject({ reason: "want to read it first" });
    expect(fake.count("merge")).toBe(0);
    cmd("releasePr", { taskId: id });
    await ticks(4, 31_000);
    expect(fake.count("merge")).toBe(1);
    expect(pr(id).phase).toBe("merged");
  });

  it("a merge already sent to GitHub when the pause arrives is recorded with its real outcome", async () => {
    await prModeOn();
    const id = await openPr("In flight", "f.txt", "f\n");
    await green(id);
    const release = fake.hold("merge", "after"); // GitHub merges, but the answer is slow
    cmd("requestPrMerge", { taskId: id, headSha: pr(id).headSha });
    for (let i = 0; i < 6 && pr(id).op?.kind !== "merge"; i++) {
      now += 3000;
      scheduler.tick(now); // do not wait: the merge stays in flight
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(pr(id).op).toMatchObject({ kind: "merge", headSha: pr(id).headSha });
    expect(D.prIntentLine(pr(id))).toMatch(/already sent to GitHub; cannot be interrupted/);
    cmd("pauseProject");
    cmd("holdPr", { taskId: id });
    expect(pr(id).phase).toBe("open"); // not "merged" until GitHub reports it
    release();
    await scheduler.prIdle();
    await tick();
    expect(pr(id).phase).toBe("merged");
    expect(task(id).integration!.landed).toMatchObject({ by: "app", commit: remote("rev-parse", "main") });
    expect(fake.count("merge")).toBe(1);
  });

  it("Close: the pull request is closed on GitHub, shows as closed only once GitHub reports it, and the branch is kept", async () => {
    await prModeOn();
    const id = await openPr("To close", "c.txt", "c\n");
    cmd("closePr", { taskId: id });
    expect(pr(id).phase).toBe("open");
    await ticks(3, 3000);
    expect(pr(id)).toMatchObject({ phase: "closed" });
    expect(pr(id).closeRequested).toBeUndefined();
    expect(fake.pr(1).state).toBe("CLOSED");
    expect(branches()).toHaveLength(1);
    // A delivery that was never pushed is abandoned without contacting GitHub.
    const other = await finishTask("Never pushed", ".github/workflows/x.yml", "on: push\n");
    expect(pr(other).phase).toBe("built");
    cmd("closePr", { taskId: other });
    expect(pr(other).phase).toBe("closed");
    expect(fake.count("close")).toBe(1);
  });
});

describe("interruption (scenarios 13 and 14)", () => {
  /** A new scheduler on the same database, as after a crash: the old one is gone without cleaning up. */
  const crash = async () => {
    await scheduler.stop(); // its in-flight result is dropped, like a process that died
    scheduler = newScheduler();
    await scheduler.refreshHealth();
  };

  it("scenario 13: a restart after the push, after the create, after the merge and after the comment leaves one branch, one pull request, one merge and one comment", async () => {
    await prModeOn();
    // After the push, before the pull request exists.
    let release = fake.hold("findPr", "before");
    const id = await (async () => {
      const t = newTask("Survives restarts");
      oneStep(t);
      await tick();
      codex.finish(run(t).id, { write: ["s.txt", "s\n"] });
      now += 1000;
      scheduler.tick(now);
      for (let i = 0; i < 100 && pr(t)?.op?.kind !== "publish"; i++) {
        now += 1000;
        scheduler.tick(now);
        await new Promise((r) => setTimeout(r, 5));
      }
      for (let i = 0; i < 200 && fake.count("findPr") === 0; i++) await new Promise((r) => setTimeout(r, 10));
      return t;
    })();
    expect(pr(id)).toMatchObject({ phase: "built", op: { kind: "publish" } });
    expect(branches()).toHaveLength(1); // pushed
    await crash();
    release();
    // The new scheduler waits out the old operation's timeout and grace before trying again.
    await ticks(5, 10_000);
    expect(pr(id)).toMatchObject({ phase: "built", op: { kind: "publish" } });
    expect(fake.count("createPr")).toBe(0);

    // After the create: GitHub has the pull request, the service never learned its number.
    release = fake.hold("createPr", "after");
    now += D.OP_TIMEOUT_MS.publish + D.PR_LIMITS.graceMs;
    scheduler.tick(now);
    for (let i = 0; i < 200 && fake.prs.size === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(fake.prs.size).toBe(1);
    expect(pr(id).number).toBeUndefined();
    await crash();
    release();
    await tick(D.OP_TIMEOUT_MS.publish + D.PR_LIMITS.graceMs + 1000);
    await tick();
    // Found by its branch and marker, not opened a second time.
    expect(pr(id)).toMatchObject({ phase: "open", number: 1 });
    expect(fake.count("createPr")).toBe(1);
    expect(fake.prs.size).toBe(1);
    expect(branches()).toHaveLength(1);

    // After the merge was sent.
    await green(id);
    release = fake.hold("merge", "after");
    cmd("requestPrMerge", { taskId: id, headSha: pr(id).headSha });
    for (let i = 0; i < 100 && pr(id).op?.kind !== "merge"; i++) {
      now += 3000;
      scheduler.tick(now);
      await new Promise((r) => setTimeout(r, 5));
    }
    for (let i = 0; i < 200 && fake.pr(1).state !== "MERGED"; i++) await new Promise((r) => setTimeout(r, 10));
    expect(pr(id)).toMatchObject({ phase: "open", op: { kind: "merge" } });
    await crash();
    release();
    await ticks(3, 10_000);
    expect(pr(id).phase).toBe("open"); // still inside the grace time: nothing is assumed
    await tick(D.OP_TIMEOUT_MS.merge + D.PR_LIMITS.graceMs);
    await tick();
    expect(pr(id).phase).toBe("merged");
    expect(task(id).integration!.landed).toMatchObject({ by: "app" }); // the intent was the app's
    expect(fake.count("merge")).toBe(1);
    expect(remote("rev-list", "--count", "--merges", "main")).toBe("1");

    // After the comment was posted.
    release = fake.hold("comment", "after");
    cmd("addLandedNote", { taskId: id, text: "Worth a second look at naming.", postToGitHub: true });
    const noteId = task(id).integration!.landed!.notes[0].id;
    for (let i = 0; i < 100 && fake.pr(1).comments.length === 0; i++) {
      now += 3000;
      scheduler.tick(now);
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(fake.pr(1).comments).toHaveLength(1);
    expect(task(id).integration!.landed!.notes[0].comment).toMatchObject({ status: "pending" }); // no URL recorded, so not "posted"
    await crash();
    release();
    await ticks(4, 3000);
    const note = task(id).integration!.landed!.notes[0];
    expect(note.comment).toMatchObject({ status: "posted", url: "https://github.com/test/repo/pull/1#issuecomment-1" });
    expect(fake.count("comment")).toBe(1);
    expect(fake.pr(1).comments).toHaveLength(1);
    expect(fake.pr(1).comments[0].body).toBe(`Worth a second look at naming.\n\n<!-- orchestration:note:${st().project.id}/${noteId} -->`);
  });

  it("scenario 14: a lease lost during a slow create drops the late result; the new holder reconciles to exactly one pull request", async () => {
    await scheduler.stop();
    const a = newScheduler(15_000);
    const b = newScheduler(15_000);
    scheduler = a;
    await a.refreshHealth();
    await b.refreshHealth();
    await prModeOn();
    const release = fake.hold("createPr", "after"); // GitHub opens it, but the answer is slow
    const id = newTask("Two schedulers");
    oneStep(id);
    await tick();
    codex.finish(run(id).id, { write: ["t.txt", "t\n"] });
    for (let i = 0; i < 100 && fake.prs.size === 0; i++) {
      now += 1000;
      a.tick(now);
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(pr(id)).toMatchObject({ phase: "built", op: { kind: "publish" } });
    expect(a.active).toBe(true);
    // A stalls; its lease expires and B takes over.
    now += 20_000;
    b.tick(now);
    expect(b.active).toBe(true);
    a.tick(now + 1); // A notices it lost the lease: its operation is abandoned
    expect(a.active).toBe(false);
    release(); // the answer arrives late
    await new Promise((r) => setTimeout(r, 30));
    expect(fake.prs.size).toBe(1);
    now += 1000;
    a.tick(now);
    expect(pr(id)).toMatchObject({ phase: "built", op: { kind: "publish" } }); // the late result was not written
    expect(pr(id).number).toBeUndefined();
    // B renews its lease and, after the grace time, reconciles instead of creating again.
    for (let i = 0; i < 40 && pr(id).phase !== "open"; i++) await tick(10_000, b);
    expect(pr(id)).toMatchObject({ phase: "open", number: 1 });
    expect(fake.count("createPr")).toBe(1);
    expect(fake.prs.size).toBe(1);
    expect(branches()).toHaveLength(1);
  });

  it("nothing starts without a committed intent: a write planned on a state that changed meanwhile is dropped", async () => {
    await prModeOn();
    const id = await finishTask("Planned, then paused", ".github/workflows/ci.yml", "on: push\n");
    cmd("allowWorkflowPush", { taskId: id });
    const planned = st(); // what the driver read…
    expect(D.nextPrOp(planned, now + 3000)).toMatchObject({ kind: "publish" });
    cmd("pauseProject"); // …and what changed before its intent could be committed
    const stale = { read: () => ({ version: 0, state: planned }), update: store.update.bind(store) } as unknown as Store;
    const driver = new PrDriver(stale, fake, workspaces);
    const calls = fake.calls.length;
    driver.tick(now + 3000, { name: "scheduler", holder: scheduler.holder, nowMs: now + 3000 });
    expect(driver.busy).toBe(false);
    await driver.idle();
    expect(fake.calls.length).toBe(calls);
    expect(branches()).toEqual([]);
    expect(pr(id).op).toBeUndefined();
  });

  it("a stale result changes nothing: another operation id, another number, or another head", async () => {
    await prModeOn();
    const id = await finishTask("Stale", ".github/workflows/ci.yml", "on: push\n");
    cmd("allowWorkflowPush", { taskId: id });
    const op = D.nextPrOp(st(), now + 3000)!;
    const at = new Date(now + 3000).toISOString();
    const begun = D.beginPrOp(st(), op, at);
    expect(begun.started).toBe(true);
    const mine = begun.state.tasks.find((t) => t.id === id)!.integration!.pr!.op!;
    expect(mine.id).toBe(op.id);
    const published = { number: 7, url: "https://github.com/test/repo/pull/7" };
    if (op.kind !== "publish") throw new Error("expected publish");
    for (const stale of [{ ...op, id: "other" }, { ...op, n: 2 }, { ...op, headSha: "f".repeat(40) }]) {
      expect(D.reportPrOp(begun.state, { op: stale, published }, at)).toBe(begun.state);
    }
    const applied = D.reportPrOp(begun.state, { op, published }, at);
    expect(applied.tasks.find((t) => t.id === id)!.integration!.pr).toMatchObject({ phase: "open", number: 7 });
    // A second intent cannot start while one is recorded and may still be running.
    expect(D.beginPrOp(begun.state, { ...op, id: "again" }, new Date(now + 10_000).toISOString()).started).toBe(false);
  });
});

describe("GitHub problems (scenario 15)", () => {
  it("a lost sign-in stops everything with one notice, is not retried in a storm, and recovers by itself", async () => {
    await prModeOn();
    const id = await openPr("Signed out", "o.txt", "o\n");
    const calls = fake.calls.length;
    fake.authLost = true;
    for (let i = 0; i < 60; i++) await tick(30_000); // 30 simulated minutes
    expect(st().project.github).toMatchObject({ ok: false, problem: { code: "auth" } });
    expect(st().project.github!.problem!.message).toMatch(/gh auth login/);
    expect(events("GitHub delivery stopped")).toHaveLength(1);
    const since = st().project.github!.problem!.since;
    expect(Date.parse(since)).toBeLessThan(now - 25 * 60_000); // one problem since it began, not a new one per check
    expect(fake.calls.length - calls).toBeLessThanOrEqual(6); // 5 → 30 minute backoff
    expect(pr(id).phase).toBe("open"); // phases do not change while GitHub cannot be reached
    expect(D.needsYou(st(), now)).toBe(1);
    // While signed out nothing is written, whatever the user asks.
    fake.setCheck(1, "SUCCESS");
    expect(fake.count("merge")).toBe(0);

    fake.authLost = false;
    for (let i = 0; i < 70 && !st().project.github!.ok; i++) await tick(30_000);
    expect(st().project.github).toMatchObject({ ok: true });
    expect(st().project.github!.problem).toBeUndefined();
    await seen();
    expect(D.prReady(st(), task(id), now)).toBe(true);
  });

  it("a repository that is not GitHub, or a remote that moved, stops before anything is pushed", async () => {
    git("remote", "set-url", "origin", join(dir, "elsewhere.git"));
    cmd("setDeliveryMode", { mode: "pr" });
    await ticks(3);
    expect(st().project.github).toMatchObject({ ok: false, problem: { code: "remote" } });
    expect(D.writersHeld(st())).toMatch(/waiting for the first fetch of origin\/main/);
    // Writers wait; nothing is blocked or failed.
    const id = newTask("Waits for the base");
    oneStep(id);
    await ticks(3);
    expect(run(id)).toBeUndefined();
    expect(task(id).steps[0].state).toBe("pending");
    git("remote", "set-url", "origin", bare);
    cmd("recheckGitHub");
    await ticks(4);
    expect(st().project.github).toMatchObject({ ok: true });
    expect(run(id)).toBeDefined();
    // The writer starts from the fetched base, never from the local checkout.
    expect(execFileSync("git", ["-C", codex.runs.get(run(id).id)!.workspace.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(remote("rev-parse", "main"));
  });
});

describe("sample projects never contact GitHub", () => {
  it("the real service refuses pull-request delivery for the sample project, and the driver does nothing for one", async () => {
    const sample = new Store(join(dir, "sample.sqlite")); // seeded with the sample project
    const s2 = new Scheduler(sample, { claude, codex }, { workspaces, github: fake, leaseMs: 120_000 });
    extra.push(s2);
    expect(sample.read().state.project.sample).toBe(true);
    const server = createHttpServer({ store: sample, scheduler: s2, workspaces, startedAt: iso(), allowedHosts: [] });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    server.close();
    const real = createHttpServer({ store: sample, scheduler: s2, workspaces, startedAt: iso(), allowedHosts: [`127.0.0.1:${port}`] });
    await new Promise<void>((r) => real.listen(port, "127.0.0.1", r));
    try {
      const post = (args: object) =>
        fetch(`http://127.0.0.1:${port}/api/commands`, { method: "POST", headers: { "Content-Type": "application/json", [CLIENT_HEADER]: "1" }, body: JSON.stringify({ name: "setDeliveryMode", args, idempotencyKey: `s-${JSON.stringify(args)}` }) });
      const refused = await post({ mode: "pr" });
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { error: string }).error).toMatch(/sample project/);
      expect(D.deliveryMode(sample.read().state)).toBe("off");
      expect((await post({ mode: "local", branch: "main" })).status).toBe(200);
    } finally {
      real.closeAllConnections();
      real.close();
    }
    // Even if the mode were on (an older database, say), the driver does nothing for a sample.
    sample.command("setDeliveryMode", { mode: "pr" }, "direct", iso());
    for (let i = 0; i < 5; i++) {
      now += 1000;
      s2.tick(now);
      await s2.prIdle();
    }
    expect(fake.calls).toEqual([]);
    expect(sample.read().state.project.github?.checkedAt).toBeUndefined();
    await s2.stop();
    sample.close();
  });
});

describe("dependent tasks (scenario 20)", () => {
  it("a dependent starts only after its prerequisite's pull request merged and the base was fetched; its workspace holds that code", async () => {
    await prModeOn();
    const a = await openPr("Prerequisite", "lib.txt", "library\n");
    const b = (cmd("createFollowUp", { taskId: a }).result as { newId: string }).newId;
    cmd("startHeldTask", { taskId: b });
    expect(task(b).dependsOn).toEqual([a]);
    await ticks(3, 5000);
    expect(run(b)).toBeUndefined();
    expect(M.waitingOn(st(), task(b))).toBe(a);
    expect(M.waitingDetail(st(), a)).toBe(`Waiting for ${a}'s PR #1 to merge`);

    await green(a);
    await ticks(2, 5000);
    expect(run(b)).toBeUndefined(); // ready for the user is not merged
    await mergeFromApp(a);
    expect(pr(a).phase).toBe("merged");
    // Merged, but the base new work starts from has not been fetched since.
    if (st().project.github!.base!.fetchedAt < task(a).integration!.landed!.at) {
      expect(M.prerequisiteReady(st(), task(a))).toBe(false);
      expect(M.waitingDetail(st(), a)).toMatch(/merged; waiting for the next fetch/);
    }
    for (let i = 0; i < 6 && !run(b); i++) await tick(31_000);
    expect(st().project.github!.base!.sha).toBe(remote("rev-parse", "main"));
    const ws = codex.runs.get(run(b).id)!.workspace.path;
    expect(readFileSync(join(ws, "lib.txt"), "utf8")).toBe("library\n");
    expect(execFileSync("git", ["-C", ws, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(task(a).integration!.landed!.commit);
    // Its own pull request then contains only its own commit on top of the merged base.
    codex.finish(run(b).id, { write: ["use.txt", "uses the library\n"] });
    for (let i = 0; i < 8 && task(b).integration?.pr?.phase !== "open"; i++) await tick(2000);
    expect(remote("log", "--format=%an", `main..${pr(b).branch}`)).toBe("Orchestration");
    expect(pr(b).changed.paths).toEqual(["use.txt"]);
  });

  it("a prerequisite whose pull request was closed blocks its dependents with the reason, until it is delivered again", async () => {
    await prModeOn();
    const a = await openPr("Closed prerequisite", "lib.txt", "library\n");
    const b = (cmd("createFollowUp", { taskId: a }).result as { newId: string }).newId;
    cmd("startHeldTask", { taskId: b });
    fake.closeByPerson(1);
    await seen();
    expect(M.blockedReason(st(), task(b))).toBe(`${a}'s PR #1 was closed without merging. Deliver ${a} again, or remove the prerequisite.`);
    expect(M.column(st(), task(b))).toBe("blocked");
    cmd("redeliver", { taskIds: [a] });
    expect(M.blockedReason(st(), task(b))).toBeUndefined();
    expect(M.waitingOn(st(), task(b))).toBe(a);
  });

  it("switching pull-request delivery off leaves open pull requests watched and unwritten; local delivery skips their tasks", async () => {
    await prModeOn();
    const id = await openPr("Left open", "l.txt", "l\n");
    await green(id);
    cmd("setDeliveryMode", { mode: "local", branch: "main" });
    expect(() => cmd("requestPrMerge", { taskId: id, headSha: pr(id).headSha })).toThrow(/Pull-request delivery is off/);
    const observes = fake.count("observe");
    await ticks(3, 121_000);
    expect(fake.count("observe")).toBeGreaterThan(observes);
    expect(fake.count("merge")).toBe(0);
    expect(task(id).integration!.delivered).toBeUndefined();
    expect(D.undeliveredTasks(st())).toEqual([]);
    // A person merges it: still recorded.
    fake.mergeByPerson(1);
    await seen();
    expect(task(id).integration!.landed).toMatchObject({ via: "pr", by: "person" });
  });
});
