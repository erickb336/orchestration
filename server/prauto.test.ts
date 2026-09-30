// ORC-008 step 3, end to end: independent review and automatic merge (design §17, scenarios 2 to 7),
// and the step 2 review findings that need a real repository. No test contacts GitHub: a local bare
// repository is `origin`, FakeGitHub stands in for the GitHub API on top of it, and scripted adapters
// stand in for Claude and Codex. git fetch, ls-remote, merge-tree and push run for real against the bare
// repository.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as D from "../src/domain/delivery";
import * as M from "../src/domain/model";
import { DEFAULT_CHECKS, type PrDelivery, type State, type Task } from "../src/domain/types";
import { buildEnvelope, buildLeadEnvelope } from "./envelope";
import { Scheduler } from "./scheduler";
import { Store } from "./store";
import { FakeGitHub } from "./testing/fakeGitHub";
import { ScriptedAdapter, ScriptedChecks } from "./testing/scripted";
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
const tick = async (ms = 1000) => {
  now += ms;
  scheduler.tick(now);
  await scheduler.prIdle();
};
const ticks = async (n: number, ms = 1000) => {
  for (let i = 0; i < n; i++) await tick(ms);
};
const until = async (what: string, pred: () => boolean, ms = 5000, max = 150) => {
  for (let i = 0; i < max && !pred(); i++) await tick(ms);
  expect(pred(), what).toBe(true);
};
const st = (): State => store.read().state;
const task = (id: string): Task => st().tasks.find((t) => t.id === id)!;
const pr = (id: string): PrDelivery => task(id).integration!.pr!;
let key = 0;
const cmd = (name: string, args: object = {}) => store.command(name, args, `k${++key}`, iso());
/** A task on the built-in "change" pipeline: implement, code review, repair if needed, verify. */
const newTask = (title: string) =>
  (cmd("createTask", { title, area: "", outcome: `${title} outcome`, benefit: "", whyNow: "", approach: "do it", acceptance: ["ok"], priority: 1, holdBeforeStart: false, templateId: "change" }).result as { newId: string }).newId;
const branches = () => remote("for-each-ref", "--format=%(refname)", "refs/heads/").split("\n").filter((r) => r.includes("orchestration/"));
const events = (text: string) => st().events.filter((e) => e.message.includes(text));
const adapter = (p: string) => (p === "codex" ? codex : claude);
const reviewTasks = (id: string) => st().tasks.filter((t) => t.reviewTarget?.taskId === id);
const repairTasks = (id: string) => st().tasks.filter((t) => t.deliverInto?.taskId === id);
const merges = () => fake.calls.filter((c) => c.method === "merge").map((c) => c.args as { number: number; headSha: string });

interface Script {
  /** What the n-th coder run of a task writes (n from 0). */
  write?: (taskId: string, n: number) => [string, string];
  /** Open findings the n-th review of a task reports (n from 0). */
  findings?: (taskId: string, n: number) => number;
}
const counts = new Map<string, number>();
const next = (k: string) => {
  const n = counts.get(k) ?? 0;
  counts.set(k, n + 1);
  return n;
};
/** Run the given tasks' pipelines to the end: coders write, reviewers report findings, the lead verifies. */
const drive = async (ids: string[], script: Script = {}) => {
  for (let i = 0; i < 120 && ids.some((id) => task(id).lifecycle !== "done"); i++) {
    for (const a of M.activeAttempts(st()).filter((x) => ids.includes(x.taskId) && x.outcome === "running")) {
      const ad = adapter(a.snapshot.provider);
      if (!ad.runs.has(a.id)) continue;
      const role = task(a.taskId).steps.find((x) => x.id === a.stepId)!.role;
      if (role === "coder") ad.finish(a.id, { write: script.write?.(a.taskId, next(`w:${a.taskId}`)) ?? [`${a.taskId}.txt`, `${a.taskId}\n`] });
      else if (role === "code_reviewer") ad.finish(a.id, { findings: script.findings?.(a.taskId, next(`r:${a.taskId}`)) ?? 0 });
      else ad.finish(a.id);
    }
    await tick();
  }
  for (const id of ids) expect(task(id).lifecycle, id).toBe("done");
};
/** A finished task whose pull request is open and was seen once on GitHub. */
const openPr = async (title: string, script: Script = {}) => {
  const id = newTask(title);
  await drive([id], script);
  await until(`${id} is open`, () => task(id).integration?.pr?.phase === "open" && !!pr(id).observed, 2000, 30);
  return id;
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "orch-auto-"));
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
  counts.clear();
  scheduler = new Scheduler(store, { claude, codex }, { workspaces, github: fake, leaseMs: 120_000, ackTimeoutMs: 10_000 });
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

/** Pull-request delivery on (the read-only check and the first fetch happen), with the given merge mode. */
const prModeOn = async (merge: "hold" | "auto" = "auto") => {
  cmd("setDeliveryMode", { mode: "pr" });
  await ticks(3);
  expect(st().project.github).toMatchObject({ ok: true, repo: "test/repo", requiredChecks: ["check"] });
  if (merge === "auto") cmd("setPrDelivery", { config: { merge: "auto" } });
};

describe("automatic merge (scenario 2)", () => {
  it("Codex writes, Claude reviews the exact change, the required check passes on the exact head: one merge, no person, recorded only after GitHub reports it", async () => {
    await prModeOn();
    const id = await openPr("Adds a greeting", { write: () => ["greet.txt", "hi there\n"] });
    const head = pr(id).headSha;
    expect(pr(id)).toMatchObject({ policy: "auto", policySource: "project", changeAuthor: "codex", changeSha: head });
    // The task's own review covers the final change and ran on the other provider: no extra run.
    expect(pr(id).review).toMatchObject({ ok: true, source: "pipeline", provider: "claude", forSha: head, taskId: id });
    expect(reviewTasks(id)).toEqual([]);
    // The reviewer was handed the changed lines, not only file names.
    const review = claude.started.find((a) => a.taskId === id && a.role === "code_reviewer")!;
    expect(review.prompt).toMatch(/## Change under review \([0-9a-f]{12}\.\.[0-9a-f]{12}\)/);
    expect(review.prompt).toContain("+hi there");
    expect(review.prompt).toContain("Any weakening of tests, CI or build scripts is a blocking finding.");
    expect(review.workspace.access).toBe("read");
    expect(events("it merges by itself after an independent review and passing required checks")).toHaveLength(1);

    // The required check has not reported: nothing merges, however long it takes.
    await ticks(12, 31_000);
    expect(merges()).toEqual([]);
    expect(D.prGate(st(), task(id), now, { byUser: false }).status).toBe("waiting");
    fake.setCheck(1, "SKIPPED"); // a skipped required check is not a pass
    await ticks(4, 31_000);
    expect(merges()).toEqual([]);

    // It passes. The merge is sent once, bound to the exact head; while GitHub's answer is slow the
    // pull request is "merging", never "merged".
    const release = fake.hold("merge", "after");
    fake.setCheck(1, "SUCCESS", "check", { replace: true }); // GitHub shows the passing attempt in place of the skipped one (review M3)
    for (let i = 0; i < 60 && pr(id).op?.kind !== "merge"; i++) {
      now += 5000;
      scheduler.tick(now); // do not wait: the merge stays in flight
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(pr(id).op).toMatchObject({ kind: "merge", headSha: head });
    expect(pr(id).phase).toBe("open");
    expect(task(id).integration!.landed).toBeUndefined();
    expect(fake.pr(1).state).toBe("MERGED"); // GitHub already merged it; the app has not seen that yet
    release();
    await scheduler.prIdle();
    await tick();
    expect(pr(id).phase).toBe("merged");
    expect(merges()).toEqual([{ number: 1, headSha: head }].map((m) => expect.objectContaining(m)));
    const landed = task(id).integration!.landed!;
    expect(landed).toMatchObject({ via: "pr", by: "app", status: "unreviewed", flags: [], pr: { number: 1, repo: "test/repo" }, review: { ok: true, provider: "claude", forSha: head }, mainCheck: { state: "pending" } });
    expect(landed.commit).toBe(remote("rev-parse", "main"));
    expect(remote("rev-parse", `${landed.commit}^2`)).toBe(head);
    expect(events("merged into main by Orchestrator, automatically")).toHaveLength(1);
    expect(st().project.github!.autoMerges).toMatchObject({ count: 1 });
    expect(D.unreviewedCount(st())).toBe(1);

    // The check on the base branch is watched afterwards.
    fake.baseChecks.set(landed.commit, [{ name: "check", required: true, status: "COMPLETED", conclusion: "SUCCESS" }]);
    await until("the base check is recorded", () => task(id).integration!.landed!.mainCheck!.state === "success", 31_000, 10);
    // Nothing else ever merged, and nothing was pushed but the one branch.
    await ticks(6, 61_000);
    expect(merges()).toHaveLength(1);
    expect(branches()).toEqual([`refs/heads/orchestration/${st().project.id}/pr/${id}-1`]);
    expect(git("status", "--porcelain")).toBe("");
  }, 20_000); // real git and many scheduler cycles: more than vitest's default under a full-suite load

  it("the reverse pairing: Claude writes and Codex reviews", async () => {
    cmd("setRoleDefault", { role: "coder", selection: { provider: "claude", model: "claude-sample-large" } });
    cmd("setRoleDefault", { role: "code_reviewer", selection: { provider: "codex", model: "codex-sample-large" } });
    await prModeOn();
    const id = await openPr("Reverse");
    expect(pr(id)).toMatchObject({ changeAuthor: "claude", review: { ok: true, source: "pipeline", provider: "codex" } });
    fake.setCheck(1, "SUCCESS");
    await until("it merges", () => pr(id).phase === "merged");
    expect(merges()).toHaveLength(1);
    expect(reviewTasks(id)).toEqual([]);
  }, 20_000); // real git and many scheduler cycles: more than vitest's default under a full-suite load

  it("paused project, a hold, or hold policy: nothing merges by itself, and the user can still merge", async () => {
    await prModeOn();
    const id = await openPr("Held");
    cmd("holdPr", { taskId: id });
    fake.setCheck(1, "SUCCESS");
    await ticks(10, 31_000);
    expect(merges()).toEqual([]);
    cmd("releasePr", { taskId: id });
    cmd("pauseProject");
    await ticks(6, 61_000);
    expect(merges()).toEqual([]);
    cmd("resumeProject");
    cmd("setPrPolicy", { taskId: id, policy: "hold" });
    await ticks(10, 31_000);
    expect(merges()).toEqual([]);
    expect(D.prReady(st(), task(id), now)).toBe(true);
    cmd("setPrPolicy", { taskId: id, policy: null }); // follow the project again: automatic
    await until("it merges", () => pr(id).phase === "merged");
    expect(merges()).toHaveLength(1);
  }, 20_000); // real git and many scheduler cycles: more than vitest's default under a full-suite load
});

describe("the independent review (scenarios 3 and 4)", () => {
  it("scenario 3: the task's reviewer is the writer's provider, so one dedicated review runs on the other provider, with the diff, at the exact commit", async () => {
    cmd("setRoleDefault", { role: "code_reviewer", selection: { provider: "codex", model: "codex-sample-large" } });
    await prModeOn();
    const id = await openPr("Same provider", { write: () => ["same.txt", "same provider line\n"] });
    const head = pr(id).headSha;
    fake.setCheck(1, "SUCCESS");
    await until("a dedicated review is created", () => reviewTasks(id).length === 1, 2000, 20);
    const rv = reviewTasks(id)[0];
    expect(rv).toMatchObject({ id: `${id}-RV1`, reviewTarget: { taskId: id, n: 1, headSha: head } });
    // Green checks are not enough: no merge while the review is running.
    await ticks(8, 31_000);
    expect(merges()).toEqual([]);
    expect(pr(id).review.ok).toBe(false);
    // It resolved to the other provider, by the independence rule, and nothing else ran it.
    const run = M.activeAttempts(st(), rv.id)[0];
    expect(run.snapshot).toMatchObject({ provider: "claude", source: "independence", routingReason: "Claude: other provider than the writer (Codex)", reviewedSha: head });
    expect(codex.started.some((a) => a.taskId === rv.id)).toBe(false);
    const assignment = claude.runs.get(run.id)!;
    expect(assignment.prompt).toMatch(/## Change under review/);
    expect(assignment.prompt).toContain("+same provider line");
    // Its worktree is detached at exactly the commit under review.
    expect(execFileSync("git", ["-C", assignment.workspace.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(head);
    claude.finish(run.id, { findings: 0 });
    await until("it merges", () => pr(id).phase === "merged");
    expect(task(id).integration!.landed!.review).toMatchObject({ ok: true, source: "dedicated", provider: "claude", forSha: head, taskId: rv.id });
    expect(reviewTasks(id)).toHaveLength(1);
    expect(merges()).toEqual([expect.objectContaining({ number: 1, headSha: head })]);
    expect(task(rv.id).integration).toMatchObject({ status: "not-needed" }); // a review has nothing to deliver
  }, 20_000); // real git and many scheduler cycles: more than vitest's default under a full-suite load

  it("scenario 4 (mutation check: coverage): a repair loop that ran out leaves the last repair unreviewed, so nothing merges until a dedicated review saw it", async () => {
    await prModeOn();
    const id = await openPr("Loop", { write: (_t, n) => ["loop.txt", `round ${n}\n`], findings: () => 1 });
    // Three repairs ran; the last one was never reviewed; the task is done all the same.
    expect(task(id).steps.filter((x) => x.role === "coder" && x.state === "done")).toHaveLength(4);
    expect(readFileSync(join(codex.started.filter((a) => a.taskId === id).at(-1)!.workspace.path, "loop.txt"), "utf8")).toBe("round 3\n");
    expect(pr(id).review).toMatchObject({ ok: false, source: "none" });
    fake.setCheck(1, "SUCCESS");
    await until("a dedicated review is created", () => reviewTasks(id).length === 1, 2000, 20);
    await ticks(8, 31_000);
    expect(merges()).toEqual([]);
    const rv = reviewTasks(id)[0];
    const run = M.activeAttempts(st(), rv.id)[0];
    expect(claude.runs.get(run.id)!.prompt).toContain("+round 3"); // the whole change against the base, as it stands
    claude.finish(run.id, { findings: 0 });
    await until("it merges", () => pr(id).phase === "merged");
    expect(merges()).toHaveLength(1);
    expect(remote("show", "main:loop.txt")).toBe("round 3");
  }, 20_000); // real git and many scheduler cycles: more than vitest's default under a full-suite load

  it("with only one provider enabled the review cannot run: the pull request waits and says so, and nothing is substituted", async () => {
    cmd("setRoleDefault", { role: "code_reviewer", selection: { provider: "codex", model: "codex-sample-large" } });
    cmd("setRoleDefault", { role: "lead", selection: { provider: "codex", model: "codex-sample-large" } });
    cmd("setProviderEnabled", { provider: "claude", enabled: false });
    await prModeOn();
    const id = await openPr("One provider");
    fake.setCheck(1, "SUCCESS");
    await until("the review is blocked", () => pr(id).attention?.code === "review-blocked", 2000, 30);
    expect(pr(id).attention!.message).toMatch(/Independent review needs Claude, which is not enabled/);
    const rv = reviewTasks(id)[0];
    expect(st().attempts.filter((a) => a.taskId === rv.id)).toEqual([]); // no run on Codex instead
    await ticks(8, 31_000);
    expect(merges()).toEqual([]);
    expect(reviewTasks(id)).toHaveLength(1);
    // The user lets any agent count: the task's own review now counts, and it merges.
    cmd("setPrDelivery", { config: { reviewer: "any-agent" } });
    await until("it merges", () => pr(id).phase === "merged");
    expect(task(id).integration!.landed!.review).toMatchObject({ ok: true, provider: "codex" });
    expect(task(rv.id).lifecycle).toBe("cancelled"); // the review that never ran is cancelled with the merge
  }, 20_000); // real git and many scheduler cycles: more than vitest's default under a full-suite load
});

describe("the base moves (scenario 5)", () => {
  it("the candidate gets a two-parent merge of the base made by Orchestrator, pushed as a fast-forward; the checks run again; the review is not repeated; what lands is what was checked", async () => {
    await prModeOn();
    const id = await openPr("Behind", { write: () => ["feature.txt", "feature\n"] });
    const first = pr(id).headSha;
    const branch = pr(id).branch;
    // Someone else's work lands on main.
    commit("other.txt", "other\n", "someone else's work");
    git("push", "-q", "origin", "main");
    const base = remote("rev-parse", "main");
    await until("the pull request is brought up to date", () => pr(id).headSha !== first && !pr(id).pendingHead);
    const head = pr(id).headSha;
    expect(remote("rev-parse", `refs/heads/${branch}`)).toBe(head);
    expect(remote("rev-list", "--parents", "-n", "1", head).split(" ")).toEqual([head, first, base]); // a fast-forward of the old head
    expect(remote("log", "-1", "--format=%an <%ae>|%s", head)).toBe(`Orchestration <orchestration@localhost>|Merge main into ${branch}`);
    expect(pr(id)).toMatchObject({ changeSha: first, baseSha: base, counters: { baseUpdates: 1 } });
    expect(events("up to date with main")).toHaveLength(1);
    // The reviewed change is unchanged: the review still counts and is not repeated.
    expect(pr(id).review).toMatchObject({ ok: true, forSha: first });
    expect(reviewTasks(id)).toEqual([]);
    expect(claude.started.filter((a) => a.role === "code_reviewer")).toHaveLength(1);
    // No check has reported on the new head: nothing merges.
    await ticks(10, 31_000);
    expect(merges()).toEqual([]);
    expect(D.prGate(st(), task(id), now, { byUser: false }).items.find((i) => i.id === "checks")).toMatchObject({ ok: false, state: "waiting" });
    fake.setCheck(1, "SUCCESS");
    await until("it merges", () => pr(id).phase === "merged");
    expect(merges()).toEqual([expect.objectContaining({ number: 1, headSha: head })]);
    // The tree that landed is exactly the tree the checks ran on.
    expect(remote("rev-parse", "main^{tree}")).toBe(remote("rev-parse", `${head}^{tree}`));
    expect(remote("show", "main:other.txt")).toBe("other");
    expect(remote("show", "main:feature.txt")).toBe("feature");
    expect(branches()).toEqual([`refs/heads/${branch}`]); // one branch, never forced
    expect(git("rev-parse", "main")).toBe(base); // the user's branch was not moved
  }, 20_000); // real git and many scheduler cycles: more than vitest's default under a full-suite load

  it("a held pull request is never updated by the app", async () => {
    await prModeOn("hold");
    const id = await openPr("Held behind");
    const first = pr(id).headSha;
    commit("other.txt", "other\n", "someone else's work");
    git("push", "-q", "origin", "main");
    await ticks(10, 61_000);
    expect(pr(id).headSha).toBe(first);
    expect(remote("rev-parse", `refs/heads/${pr(id).branch}`)).toBe(first);
  }, 20_000); // real git and many scheduler cycles: more than vitest's default under a full-suite load
});

describe("conflict with a sibling (scenario 6)", () => {
  it("the second pull request conflicts after the first merges: a fix task resolves the prepared merge, is pushed onto the same pull request, and merges; leftover markers are refused", async () => {
    await prModeOn();
    const a = newTask("First");
    const b = newTask("Second");
    await drive([a, b], { write: (t) => ["shared.txt", `from ${t}\n`] });
    await until("both are open", () => [a, b].every((id) => task(id).integration?.pr?.phase === "open" && !!pr(id).observed), 2000, 40);
    const [na, nb] = [pr(a).number!, pr(b).number!];
    // One at a time: the older one is first in line, the other waits behind it.
    expect(D.mergeCandidate(st())!.id).toBe(a);
    expect(D.autoQueue(st()).map((t) => t.id)).toEqual([a, b]);
    expect(D.queueAhead(st(), task(b))!.id).toBe(a);
    expect(na).toBeLessThan(nb);
    fake.setCheck(na, "SUCCESS");
    fake.setCheck(nb, "SUCCESS");
    await until("the first merges", () => pr(a).phase === "merged");
    const headB = pr(b).headSha;
    // The second cannot be brought up to date: a conflict, found locally, with nothing pushed.
    await until("a fix task is created", () => repairTasks(b).length === 1);
    expect(pr(b)).toMatchObject({ headSha: headB, baseConflict: { files: ["shared.txt"] }, attention: { code: "conflict" }, counters: { repairs: 1 } });
    expect(remote("rev-parse", `refs/heads/${pr(b).branch}`)).toBe(headB);
    expect(merges()).toHaveLength(1);
    const fix = repairTasks(b)[0];
    expect(fix).toMatchObject({ id: `${b}-F1`, deliverInto: { taskId: b, n: 1, mergeBase: true } });

    // The fix starts on the pull request's head with the merge of the base prepared, conflicts marked.
    await until("the fix is running", () => M.activeAttempts(st(), fix.id).length === 1, 1000, 20);
    const run = M.activeAttempts(st(), fix.id)[0];
    const ws = codex.runs.get(run.id)!;
    expect(ws.prompt).toContain("## Prepared in this workspace");
    expect(ws.prompt).toContain("- shared.txt");
    expect(readFileSync(join(ws.workspace.path, "shared.txt"), "utf8")).toMatch(/^<<<<<<< /m);
    // Leftover markers are refused: nothing is recorded.
    codex.finish(run.id, { write: ["note.txt", "left the conflict alone\n"] });
    await until("the run is refused", () => task(fix.id).steps[0].state === "blocked", 1000, 10);
    expect(st().attempts.find((x) => x.id === run.id)!.note).toMatch(/unresolved conflict markers in shared\.txt/);
    expect(st().artifacts.filter((x) => x.taskId === fix.id)).toEqual([]);
    // Tried again, and resolved this time.
    cmd("retryStep", { taskId: fix.id, stepId: "S1" });
    await drive([fix.id], { write: () => ["shared.txt", `from ${a} and ${b}\n`] });
    await until("the fix is pushed onto the same pull request", () => pr(b).headSha !== headB && !pr(b).pendingHead);
    const head = pr(b).headSha;
    expect(pr(b)).toMatchObject({ number: nb, changeSha: head, changeTaskId: fix.id, changeAuthor: "codex" });
    expect(task(fix.id).integration).toMatchObject({ status: "integrated" });
    expect(task(fix.id).integration!.pr).toBeUndefined();
    expect(remote("rev-parse", `refs/heads/${pr(b).branch}`)).toBe(head);
    // A merge commit by Orchestration: the old head first, then the base it was merged with.
    expect(remote("rev-list", "--parents", "-n", "1", head).split(" ")).toEqual([head, headB, remote("rev-parse", "main")]);
    expect(remote("log", "--format=%an", `main..${head}`).split("\n").every((x) => x === "Orchestration")).toBe(true);
    // The fix task's own review saw the whole change, on the other provider.
    expect(pr(b).review).toMatchObject({ ok: true, source: "pipeline", taskId: fix.id, provider: "claude", forSha: head });
    await ticks(6, 31_000);
    expect(merges()).toHaveLength(1); // the checks have not run on the new head
    fake.setCheck(nb, "SUCCESS");
    await until("the second merges", () => pr(b).phase === "merged");
    expect(merges().map((m) => m.number)).toEqual([na, nb]);
    expect(remote("show", "main:shared.txt")).toBe(`from ${a} and ${b}`);
    expect(fake.count("createPr")).toBe(2); // the fix opened no pull request of its own
    expect(branches()).toHaveLength(2);
  }, 20_000); // real git and many scheduler cycles: more than vitest's default under a full-suite load
});

describe("a failing required check (scenario 7)", () => {
  it("a fix task pushes onto the same pull request; after two, a third failure needs the user", async () => {
    await prModeOn();
    const id = await openPr("Fails its check", { write: () => ["f.txt", "v0\n"] });
    const heads = [pr(id).headSha];
    for (let k = 1; k <= 2; k++) {
      fake.setCheck(1, "FAILURE");
      await until(`fix task ${k} is created`, () => repairTasks(id).length === k);
      const fix = repairTasks(id)[k - 1];
      expect(fix).toMatchObject({ id: `${id}-F${k}`, deliverInto: { taskId: id, n: 1, mergeBase: false } });
      expect(M.currentSpec(fix).content.scopeIncluded[0]).toMatch(/Make the required check "check" pass \(https:\/\/github\.com\/test\/repo\/actions\/runs\/1\)/);
      expect(pr(id).attention).toMatchObject({ code: "checks-failed" });
      expect(D.needsYou(st(), now)).toBe(0); // being fixed by the app
      await drive([fix.id], { write: () => ["f.txt", `v${k}\n`] });
      // The fix continued from the pull request's head.
      expect(codex.started.find((a) => a.taskId === fix.id)!.prompt).not.toContain("## Prepared in this workspace");
      await until(`fix ${k} is pushed`, () => pr(id).headSha !== heads[k - 1] && !pr(id).pendingHead);
      heads.push(pr(id).headSha);
      expect(remote("rev-parse", `refs/heads/${pr(id).branch}`)).toBe(heads[k]);
      expect(remote("rev-parse", `${heads[k]}^`)).toBe(heads[k - 1]); // a fast-forward
      expect(pr(id)).toMatchObject({ number: 1, changeTaskId: fix.id, review: { ok: true, taskId: fix.id } });
    }
    // The third failure: no third fix task. It waits for the user and says why.
    fake.setCheck(1, "FAILURE");
    await until("it needs the user", () => pr(id).attention?.code === "checks-failed" && /2 fix tasks already ran/.test(pr(id).attention!.message));
    await ticks(10, 61_000);
    expect(repairTasks(id)).toHaveLength(2);
    expect(D.needsYou(st(), now)).toBe(1);
    expect(merges()).toEqual([]);
    expect(fake.count("createPr")).toBe(1);
    expect(branches()).toHaveLength(1);
    // The lead sees it, and is told what it may not do.
    const lead = buildLeadEnvelope(st(), { id: "lead-x", trigger: "planning", provider: "claude", model: "m", startedAt: iso(), outcome: "running", messageIds: [] }, "read");
    expect(lead).toContain("## Delivery");
    expect(lead).toMatch(new RegExp(`- ${id} PR #1 needs attention \\(checks-failed\\)`));
    expect(lead).toContain("You cannot merge, push, comment, close a pull request, send work back or mark anything reviewed");
    // A re-run that passes makes the gate ready again, for the exact head. GitHub shows the passing attempt in
    // place of the failed one: a failure next to a later success stays red (review M3).
    fake.setCheck(1, "SUCCESS", "check", { replace: true });
    await until("it merges", () => pr(id).phase === "merged");
    expect(merges()).toEqual([expect.objectContaining({ number: 1, headSha: heads[2] })]);
    expect(remote("show", "main:f.txt")).toBe("v2");
  }, 20_000); // real git and many scheduler cycles: more than vitest's default under a full-suite load

  it("main is red: a failed check on the base after the app's merge pauses automatic merging until it passes again", async () => {
    await prModeOn();
    const a = await openPr("Breaks main");
    fake.setCheck(1, "SUCCESS");
    await until("it merges", () => pr(a).phase === "merged");
    const landed = task(a).integration!.landed!.commit;
    fake.baseChecks.set(landed, [{ name: "check", required: true, status: "COMPLETED", conclusion: "FAILURE" }]);
    await until("automatic merging is paused", () => !!st().project.github!.autoMergePaused, 31_000, 10);
    expect(st().project.github!.autoMergePaused).toMatchObject({ sticky: false, taskId: a });
    expect(task(a).integration!.landed!.flags).toEqual(["main-check-failed"]);
    const b = await openPr("Waits for main");
    fake.setCheck(2, "SUCCESS");
    await ticks(10, 61_000);
    expect(pr(b).phase).toBe("open");
    expect(merges()).toHaveLength(1);
    expect(st().tasks.some((t) => t.revertOf)).toBe(false); // nothing is reverted automatically
    // The check passes when it runs again: the pause ends and the next pull request merges.
    fake.baseChecks.set(landed, [{ name: "check", required: true, status: "COMPLETED", conclusion: "SUCCESS" }]);
    await until("the second merges", () => pr(b).phase === "merged", 10_000, 120); // fine ticks: a merge needs a read of GitHub at most 15 s old
    expect(st().project.github!.autoMergePaused).toBeUndefined();
    expect(merges()).toHaveLength(2);
  }, 20_000); // real git and many scheduler cycles: more than vitest's default under a full-suite load
});

describe("what the reviewer is handed", () => {
  it("a large change is cut at 60 KB with the list of all changed files; the envelope stays a fenced block", () => {
    commit("big.txt", "start\n", "big file");
    const from = git("rev-parse", "HEAD");
    commit("big.txt", `${Array.from({ length: 4000 }, (_, i) => `line ${i} ${"x".repeat(30)}`).join("\n")}\n`, "much bigger");
    commit("small.txt", "```\nnot a fence end\n```\n", "a file with backticks");
    const d = workspaces.reviewDiff({ repoPath: repo, to: git("rev-parse", "HEAD"), from })!;
    expect(d.truncated).toBe(true);
    expect(d.text.length).toBeLessThan(62 * 1024);
    expect(d.text).toMatch(/\[truncated; \d+ of 2 files not shown in full\. Read them in the workspace\. All changed files:\]\n- big\.txt\n- small\.txt/);
    const small = workspaces.reviewDiff({ repoPath: repo, to: git("rev-parse", "HEAD"), from: git("rev-parse", "HEAD~1") })!;
    expect(small).toMatchObject({ truncated: false, from: git("rev-parse", "HEAD~1") });
    const id = newTask("Envelope");
    const prompt = buildEnvelope({ state: st(), task: task(id), step: task(id).steps.find((x) => x.id === "S2")!, attemptId: "run-x", access: "read", changeUnderReview: small });
    // The diff holds a ``` line: the fence around it is longer, so the diff cannot close it.
    expect(prompt).toContain("````diff\n");
    expect(prompt).toMatch(/\+not a fence end\n\+```\n````\nReport as findings only issues/);
    expect(workspaces.reviewDiff({ repoPath: repo, to: "0".repeat(40) })).toBeUndefined();
  }, 20_000); // real git and many scheduler cycles: more than vitest's default under a full-suite load
});

// ====================================================================================================
// Step 2 review findings that need a real repository
// ====================================================================================================

describe("step 2 review: H1, only the pull-request branch is ever pushed", () => {
  it("a git configuration that follows tags or recurses into submodules does not make the push publish anything else", async () => {
    // The user's own configuration, as hostile as it gets for a push.
    git("config", "push.followTags", "true");
    git("config", "push.recurseSubmodules", "on-demand");
    git("config", "remote.origin.push", "refs/heads/*:refs/heads/*");
    git("-c", "user.name=u", "-c", "user.email=u@u", "tag", "-a", "v-private", "-m", "not for publishing", "HEAD");
    git("branch", "private-work");
    await prModeOn("hold");
    const id = await openPr("Only this branch");
    const refs = remote("for-each-ref", "--format=%(refname)").split("\n").sort();
    expect(refs).toEqual(["refs/heads/main", `refs/heads/${pr(id).branch}`].sort());
    expect(remote("tag")).toBe("");
  }, 20_000); // real git and many scheduler cycles: more than vitest's default under a full-suite load

  it("the push guard accepts exactly one commit to one of the app's branches, after the end of options, and refuses the rest before git runs", () => {
    const sha = "a".repeat(40);
    const ok = `${sha}:refs/heads/orchestration/p1/pr/T-1-1`;
    const safe = ["-c", "push.followTags=false", "-C", "/r", "push", "--porcelain", "--no-verify", "--no-follow-tags", "--no-recurse-submodules", "--end-of-options", "origin", ok];
    expect(() => assertSafePush(safe)).not.toThrow();
    expect(() => assertSafePush(["push", "--follow-tags", "origin", ok])).toThrow(/refusing/);
    expect(() => assertSafePush(["push", "--recurse-submodules=on-demand", "origin", ok])).toThrow(/refusing/);
    expect(() => assertSafePush(["push", "--end-of-options", "--force", ok])).toThrow(/refusing/); // an option where the remote goes
    expect(() => assertSafePush(["push", "--end-of-options", "origin", ok, "refs/tags/v1"])).toThrow(/refusing/);
    expect(() => assertSafePush(["push", "-origin", ok])).toThrow(/refusing/);
  }, 20_000); // real git and many scheduler cycles: more than vitest's default under a full-suite load
});

describe("step 2 review: H2, a remote that now names another repository", () => {
  it("the app never reads, merges, closes or comments on the same number there; the pull request says why", async () => {
    await prModeOn("hold");
    const id = await openPr("Opened here");
    fake.setCheck(1, "SUCCESS");
    cmd("requestPrMerge", { taskId: id, headSha: pr(id).headSha });
    // Before the merge is sent, the remote is pointed at another repository.
    const other = join(dir, "other.git");
    execFileSync("git", ["clone", "-q", "--bare", bare, other]);
    fake.addRemote(other, "test/other");
    git("remote", "set-url", "origin", other);
    cmd("recheckGitHub");
    const before = fake.calls.length;
    await ticks(40, 31_000);
    expect(st().project.github).toMatchObject({ ok: true, repo: "test/other" });
    expect(pr(id)).toMatchObject({ repo: "test/repo", phase: "open", attention: { code: "repo-changed" } });
    expect(pr(id).op).toBeUndefined();
    const after = fake.calls.slice(before);
    expect(after.filter((c) => ["merge", "close", "comment", "findComment", "createPr"].includes(c.method))).toEqual([]);
    expect(fake.wrongRepoCalls).toEqual([]); // nothing was even attempted against the wrong repository
    for (const c of after.filter((x) => x.method === "observe")) expect((c.args as { prs: number[] }).prs).not.toContain(1);
    expect(fake.pr(1).state).toBe("OPEN");
    expect(() => cmd("requestPrMerge", { taskId: id, headSha: pr(id).headSha })).toThrow(/does not merge it there/);
    // Abandoning it here sends nothing to either repository.
    cmd("closePr", { taskId: id });
    await ticks(4, 3000);
    expect(pr(id).phase).toBe("closed");
    expect(fake.count("close")).toBe(0);
    expect(fake.pr(1).state).toBe("OPEN");
  }, 20_000); // real git and many scheduler cycles: more than vitest's default under a full-suite load

  it("the fake honours the repository argument: a pull request exists only where it was opened", async () => {
    await prModeOn("hold");
    const id = await openPr("Where it lives");
    const here = { owner: "test", name: "repo" };
    const there = { owner: "test", name: "other" };
    expect((await fake.observe({ repo: here, prs: [1], commits: [] })).prs).toHaveLength(1);
    expect((await fake.observe({ repo: there, prs: [1], commits: [] })).prs).toEqual([]);
    await expect(fake.merge({ repo: there, number: 1, headSha: pr(id).headSha, subject: "s", body: "b" })).rejects.toThrow(/not found in test\/other/);
    await expect(fake.close({ repo: there, number: 1, comment: "c" })).rejects.toThrow(/not found in test\/other/);
    expect(await fake.findPr({ repo: there, head: pr(id).branch, marker: D.prMarker(st().project.id, id, 1) })).toBeUndefined();
    expect(fake.wrongRepoCalls.map((c) => c.method)).toEqual(["merge", "close"]);
    expect(fake.pr(1).state).toBe("OPEN");
  }, 20_000); // real git and many scheduler cycles: more than vitest's default under a full-suite load
});

describe("step 2 review: M2, a base that cannot be fetched", () => {
  it("a base branch that does not exist is found by the repository check itself: one notice, no flapping, and a truthful reason", async () => {
    cmd("setDeliveryMode", { mode: "pr" });
    cmd("setPrDelivery", { config: { base: "release" } });
    for (let i = 0; i < 80; i++) await tick(30_000); // 40 simulated minutes
    const gh = st().project.github!;
    expect(gh).toMatchObject({ ok: false, problem: { code: "remote" } });
    expect(gh.problem!.message).toMatch(/The branch release does not exist on origin/);
    expect(gh.problem!.message).not.toMatch(/gh auth login/);
    expect(gh.base).toBeUndefined();
    expect(events("GitHub delivery stopped")).toHaveLength(1);
    expect(Date.parse(gh.problem!.since)).toBeLessThan(now - 35 * 60_000); // one problem since it began
    expect(fake.count("preflight")).toBeLessThanOrEqual(8); // backed off, not once per cycle
    // The branch appears: it recovers by itself.
    git("push", "-q", "origin", "main:release");
    await until("it recovers", () => !!st().project.github!.ok && !!st().project.github!.base, 61_000, 60);
    expect(st().project.github!.problem).toBeUndefined();
    expect(st().project.github!.base!.sha).toBe(remote("rev-parse", "release"));
  }, 20_000); // real git and many scheduler cycles: more than vitest's default under a full-suite load

  it("a fetch that fails while the check passes is backed off on its own and announced once", async () => {
    await prModeOn("hold");
    // The private base ref cannot be written: every fetch fails, while gh and ls-remote work.
    const real = workspaces.fetchBase.bind(workspaces);
    let failing = true;
    workspaces.fetchBase = async (o) => {
      if (failing) throw new Error("fatal: unable to write the fetched objects");
      return real(o);
    };
    const preflights = fake.count("preflight");
    for (let i = 0; i < 80; i++) await tick(30_000); // 40 simulated minutes
    const gh = st().project.github!;
    expect(gh.fetchFailures!.count).toBeGreaterThanOrEqual(3);
    expect(gh.fetchFailures!.count).toBeLessThanOrEqual(8); // 1, 2, 5, 15, 30 minutes apart
    expect(gh).toMatchObject({ ok: false, problem: { since: gh.fetchFailures!.since } });
    expect(events("GitHub delivery stopped")).toHaveLength(1);
    expect(gh.problem!.message).not.toMatch(/gh auth login/);
    expect(fake.count("preflight") - preflights).toBeLessThanOrEqual(1); // the fetch itself is what is retried
    failing = false;
    await until("it recovers", () => !!st().project.github!.ok, 61_000, 60);
    expect(st().project.github!.fetchFailures).toBeUndefined();
    expect(st().project.github!.problem).toBeUndefined();
  }, 20_000); // real git and many scheduler cycles: more than vitest's default under a full-suite load
});

describe("step 2 leftovers", () => {
  it("switching from local delivery to pull requests warns about Orchestrator commits the remote does not have, and never pushes them", async () => {
    cmd("setDeliveryMode", { mode: "local", branch: "main" });
    const id = newTask("Delivered locally");
    await drive([id], { write: () => ["local.txt", "local\n"] });
    await until("it is delivered to the local branch", () => task(id).integration?.delivered?.status === "delivered", 2000, 60);
    const before = remote("rev-parse", "main");
    expect(git("rev-parse", "main")).not.toBe(before);
    cmd("setDeliveryMode", { mode: "pr" });
    await ticks(4);
    const item = st().project.github!.posture.find((x) => x.id === "unpushed-local")!;
    expect(item).toMatchObject({ status: "warn" });
    expect(item.label).toMatch(/^\d+ Orchestrator commits? on main (is|are) not on origin\/main$/);
    expect(item.detail).toMatch(/The app does not push (it|them)/);
    expect(remote("rev-parse", "main")).toBe(before); // nothing was pushed
    expect(branches()).toEqual([]);
    // A later repository check keeps the warning; pushing the branch yourself ends it at the next fetch.
    cmd("recheckGitHub");
    await ticks(3);
    expect(st().project.github!.posture.some((x) => x.id === "unpushed-local")).toBe(true);
    git("push", "-q", "origin", "main");
    await until("the warning is gone", () => !st().project.github!.posture.some((x) => x.id === "unpushed-local"), 61_000, 20);
  }, 20_000); // real git and many scheduler cycles: more than vitest's default under a full-suite load
});

describe("step 3 review: findings 4 and 5", () => {
  it("finding 4: an observation is stamped when GitHub was read, not when its result is applied; a merge waits for a fresh read", async () => {
    await prModeOn("auto");
    const id = await openPr("Slow read");
    await until("its own review covers it", () => pr(id).review.ok, 2000, 30);
    // The next read of GitHub sees the green check at once, and its answer arrives two minutes later.
    const release = fake.hold("observe", "after");
    fake.setCheck(pr(id).number!, "SUCCESS");
    const before = fake.count("observe");
    for (let i = 0; i < 80 && fake.count("observe") === before; i++) {
      now += 5000;
      scheduler.tick(now);
      await Promise.race([scheduler.prIdle(), new Promise((r) => setTimeout(r, 100))]);
    }
    expect(fake.count("observe")).toBe(before + 1);
    const readAt = new Date(now).toISOString(); // the tick that sent the read
    now += 120_000;
    scheduler.tick(now); // time passes while the read is in flight
    release();
    await scheduler.prIdle();
    await tick(1000); // its result is applied here, 121 s after the read
    expect(pr(id).observed).toMatchObject({ at: readAt, checks: [{ name: "check", conclusion: "SUCCESS" }] });
    expect(Date.parse(pr(id).observed!.at)).toBe(now - 121_000);
    expect(merges()).toEqual([]); // nothing merges on a read that old
    // A fresh read, then the merge.
    await until("it merges on a fresh read", () => pr(id).phase === "merged", 5000, 60);
    expect(merges()).toHaveLength(1);
    expect(fake.count("observe")).toBeGreaterThan(before + 1);
  }, 20_000); // real git and many scheduler cycles: more than vitest's default under a full-suite load

  it("finding 5: a pinned commit with the right parents and author but another tree is not adopted as the base update", async () => {
    await prModeOn("hold");
    const id = await openPr("Update me");
    const head = pr(id).headSha;
    commit("other.txt", "other\n", "someone else's work");
    git("push", "-q", "origin", "main");
    const baseSha = git("rev-parse", "HEAD");
    const o = { repoPath: repo, projectId: st().project.id, taskId: id, n: 1, base: "main", headSha: head, baseSha };
    const pin = `refs/orchestration/${pr(id).branch.slice("orchestration/".length)}`;
    const expected = git("merge-tree", "--write-tree", "--no-messages", head, baseSha).split("\n")[0];
    // Same parents, same author, and the tree of the head alone: the base's changes are missing from it.
    const bogus = git("-c", "user.name=Orchestration", "-c", "user.email=orchestration@localhost", "commit-tree", git("rev-parse", `${head}^{tree}`), "-p", head, "-p", baseSha, "-m", "not the merge");
    git("update-ref", pin, bogus);
    const r = workspaces.baseUpdate(o);
    expect(r.status).toBe("updated");
    const sha = (r as { sha: string }).sha;
    expect(sha).not.toBe(bogus);
    expect(git("rev-parse", `${sha}^{tree}`)).toBe(expected);
    expect(git("rev-parse", pin)).toBe(sha);
    // The real merge, once pinned, is reused: repeating it makes no second commit.
    expect(workspaces.baseUpdate(o)).toEqual({ status: "updated", sha });
  }, 20_000); // real git and many scheduler cycles: more than vitest's default under a full-suite load
});

// ---------- ORC-013 §6.9: the service's own checks in pull-request mode ----------

describe("service checks in pull-request mode (ORC-013 §6.9)", () => {
  let checks: ScriptedChecks;
  const CONFIG = { ...DEFAULT_CHECKS, enabled: true, commands: [{ id: "test", label: "test", kind: "check" as const, argv: ["npm", "test"] }] };
  beforeEach(async () => {
    await scheduler.stop();
    checks = new ScriptedChecks();
    scheduler = new Scheduler(store, { claude, codex }, { workspaces, github: fake, checks, dataDir: dir, leaseMs: 120_000, ackTimeoutMs: 10_000 });
    await scheduler.refreshHealth();
  });
  const checkTasks = (id: string) => st().tasks.filter((t) => t.checkTarget?.taskId === id);
  /** GitHub's own required check passes on whatever head the pull request has now (re-applied as heads move). */
  const passing = (number: number) => {
    fake.setCheck(number, "SUCCESS");
    return true;
  };
  /** Like `drive`, and it also completes check runs: `failing(taskId, n)` says whether the n-th check run of a task fails. */
  const driveChecked = async (ids: () => string[], script: Script = {}, failing: (taskId: string, n: number) => boolean = () => false, rounds = 160) => {
    for (let i = 0; i < rounds && ids().some((id) => task(id).lifecycle !== "done"); i++) {
      for (const a of M.activeAttempts(st()).filter((x) => ids().includes(x.taskId) && x.outcome === "running")) {
        if (a.snapshot.provider === "service") {
          if (checks.has(a.id)) checks.finish(a.id, failing(a.taskId, next(`c:${a.taskId}`)) ? { fail: ["test"] } : {});
          continue;
        }
        const ad = adapter(a.snapshot.provider);
        if (!ad.runs.has(a.id)) continue;
        const role = task(a.taskId).steps.find((x) => x.id === a.stepId)!.role;
        if (role === "coder") ad.finish(a.id, { write: script.write?.(a.taskId, next(`w:${a.taskId}`)) ?? [`${a.taskId}.txt`, `${a.taskId}\n`] });
        else if (role === "code_reviewer") ad.finish(a.id, { findings: script.findings?.(a.taskId, next(`r:${a.taskId}`)) ?? 0 });
        else ad.finish(a.id);
      }
      await tick();
    }
  };

  it("a change with its own passing checks merges with no extra check task; the merge commit's landed item carries no check flag", async () => {
    await prModeOn("auto");
    cmd("setChecks", { config: CONFIG });
    for (let i = 0; i < 4 && st().project.checksHealth?.status !== "ready"; i++) await tick();
    const id = newTask("Checked");
    await driveChecked(() => [id]);
    expect(st().artifacts.filter((a) => a.taskId === id && a.kind === "check-results")).toHaveLength(2); // C1 and the reused C2
    await until(`${id} is open`, () => task(id).integration?.pr?.phase === "open" && !!pr(id).observed, 2000, 30);
    expect(pr(id).checks).toMatchObject({ ok: true, forSha: pr(id).changeSha, configRev: 1 });
    expect(checkTasks(id)).toEqual([]);
    await until(`${id} merged`, () => passing(1) && pr(id).phase === "merged", 2000, 60);
    expect(task(id).integration?.landed?.flags ?? []).not.toContain("checks-not-run");
    expect(merges()).toHaveLength(1);
  }, 20_000); // real git and many scheduler cycles: more than vitest's default under a full-suite load

  it("a change without check evidence gets one dedicated check run; a failing one starts a repair that carries its own checks, and the merge waits for passing evidence under the current settings", async () => {
    await prModeOn("auto");
    // The task finished while checks were off (its Checks steps skipped), then checks were turned on.
    const id = await openPr("Unchecked");
    expect(task(id).steps.filter((s) => s.role === "checks").every((s) => s.state === "skipped")).toBe(true);
    cmd("setChecks", { config: CONFIG });
    for (let i = 0; i < 4 && st().project.checksHealth?.status !== "ready"; i++) await tick();
    await until("a check task exists", () => checkTasks(id).length === 1, 1000, 20);
    const ck = checkTasks(id)[0];
    expect(ck).toMatchObject({ id: `${id}-CK1`, checkTarget: { taskId: id, n: 1, sha: pr(id).changeSha } });
    expect(pr(id).counters.checks).toBe(1);
    expect(D.prGate(st(), task(id), now, { byUser: false }).items.find((i) => i.id === "service-checks")).toMatchObject({ state: "waiting" });
    fake.setCheck(1, "SUCCESS");
    await ticks(3, 2000);
    expect(merges()).toHaveLength(0); // GitHub's check passed, the review is clean: only the service's own checks hold it
    // Its run checks exactly the pull request's change; it fails: a repair follows, never a second check run for the same change.
    await until("the check run started", () => checks.started.some((a) => a.taskId === ck.id), 1000, 20);
    const run = checks.started.find((a) => a.taskId === ck.id)!;
    expect(run.target).toBe(pr(id).changeSha);
    checks.finish(run.attemptId, { fail: ["test"] });
    await ticks(3);
    expect(task(ck.id).lifecycle).toBe("done");
    expect(pr(id).checks).toMatchObject({ ok: false, attemptId: run.attemptId, reason: `test failed on ${pr(id).changeSha.slice(0, 12)}.` });
    await until("a repair started", () => repairTasks(id).length === 1, 1000, 20);
    expect(checkTasks(id)).toHaveLength(1);
    const fix = repairTasks(id)[0];
    expect(M.currentSpec(task(fix.id)).content.whyNow).toContain("the project's check test failed");
    expect(M.currentSpec(task(fix.id)).content.scopeIncluded[0]).toMatch(/Make the project's check "test" pass \(it exited 1\)/);
    // The repair's own pipeline checks its change (C1, then C2 reused); the pushed fix arrives with evidence and the merge follows.
    await driveChecked(() => [fix.id]);
    expect(st().artifacts.filter((a) => a.taskId === fix.id && a.kind === "check-results").length).toBeGreaterThanOrEqual(1);
    await until(`${id} merged`, () => passing(1) && pr(id).phase === "merged", 2000, 80);
    expect(pr(id).checks).toMatchObject({ ok: true, forSha: pr(id).changeSha, taskId: fix.id });
    expect(checkTasks(id)).toHaveLength(1); // the head moved on to the fix's commit; no check task was started for it: the fix brought its own evidence
    expect(merges()).toHaveLength(1);
  }, 30_000);

  it("a settings change after the evidence was recorded makes it stale: the merge waits and a new check run is started", async () => {
    await prModeOn("auto");
    cmd("setChecks", { config: CONFIG });
    for (let i = 0; i < 4 && st().project.checksHealth?.status !== "ready"; i++) await tick();
    const id = newTask("Stale");
    await driveChecked(() => [id]);
    await until(`${id} is open`, () => task(id).integration?.pr?.phase === "open" && !!pr(id).observed, 2000, 30);
    fake.setCheck(1, "SUCCESS");
    cmd("setChecks", { config: { ...CONFIG, commandTimeoutMinutes: 5 } });
    await ticks(2);
    expect(pr(id).checks).toMatchObject({ ok: false, reason: expect.stringMatching(/settings changed after the last run/) });
    await until("a check task for the new settings exists", () => checkTasks(id).length === 1, 1000, 20);
    await ticks(3, 2000);
    expect(merges()).toHaveLength(0);
    // The new run passes on the same commit under the new settings: evidence again, and the merge follows.
    await driveChecked(() => checkTasks(id).map((t) => t.id));
    await until(`${id} merged`, () => passing(1) && pr(id).phase === "merged", 2000, 60);
    expect(pr(id).checks).toMatchObject({ ok: true, configRev: 2 });
  }, 20_000); // real git and many scheduler cycles: more than vitest's default under a full-suite load
});
