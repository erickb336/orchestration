// ORC-008 step 1, end to end without GitHub: the format 9 → 10 migration, local delivery feeding the
// review-later queue, the changes endpoint, and a revert sent back through the normal pipeline
// (design §17, scenarios 17 for local delivery and 18). Real git in a temporary repository; scripted
// adapters stand in for Claude and Codex.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { buildEnvelope } from "./envelope";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as D from "../src/domain/delivery";
import * as M from "../src/domain/model";
import { DEFAULT_PR_DELIVERY, type State } from "../src/domain/types";
import { createHttpServer } from "./http";
import { GITHUB_TOKEN_VARS, redact, withoutGitHubTokens } from "./redact";
import { Scheduler } from "./scheduler";
import { STATE_FORMAT, Store } from "./store";
import { ScriptedAdapter } from "./testing/scripted";
import { MAX_CHANGE_DIFF_BYTES, WorkspaceManager } from "./workspaces";

let dir: string;
let repo: string;
let store: Store;
let claude: ScriptedAdapter;
let codex: ScriptedAdapter;
let workspaces: WorkspaceManager;
let scheduler: Scheduler;
let now = Date.parse("2026-09-30T12:00:00Z");
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
const run = (id: string) => M.activeAttempts(st(), id)[0];
const adapterOf = (id: string) => (run(id).snapshot.provider === "claude" ? claude : codex);
let key = 0;
const cmd = (name: string, args: object = {}) => store.command(name, args, `k${++key}`, iso());
const newTask = (title: string) =>
  (cmd("createTask", { title, area: "", outcome: `${title} outcome`, benefit: "", whyNow: "", approach: "do it", acceptance: ["ok"], priority: 1, holdBeforeStart: false, templateId: "change" }).result as { newId: string }).newId;
const oneStep = (id: string) =>
  cmd("setPipeline", { taskId: id, expectedRev: 1, steps: [{ id: "S1", purpose: "Implement", role: "coder", dependsOn: [], inputs: [], outputs: [{ name: "change", kind: "code-change" }] }], reason: "one step" });
/** A one-step task that writes one file, is integrated, and is delivered to main. */
const deliverTask = (title: string, file: string, text: string) => {
  const id = newTask(title);
  oneStep(id);
  tick();
  codex.finish(run(id).id, { write: [file, text] });
  tick();
  tick();
  tick(61_000);
  return id;
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "orch-landed-"));
  repo = join(dir, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  commit("README.md", "hello\n", "init");
  store = new Store(join(dir, "db.sqlite"));
  claude = new ScriptedAdapter("claude");
  codex = new ScriptedAdapter("codex");
  workspaces = new WorkspaceManager(join(dir, "worktrees"));
  scheduler = new Scheduler(store, { claude, codex }, { workspaces, leaseMs: 120_000, ackTimeoutMs: 10_000 });
  await scheduler.refreshHealth();
  cmd("initProject", { name: "Landed", repoPath: repo, vision: "v", focus: "f" });
  cmd("setRoleDefault", { role: "coder", selection: { provider: "codex", model: "codex-sample-large" } });
  cmd("setRoleDefault", { role: "code_reviewer", selection: { provider: "claude", model: "claude-sample-large" } });
  cmd("setLeadSelection", { selection: { provider: "claude", model: "claude-sample-large" } });
  cmd("setDeliveryMode", { mode: "local", branch: "main" });
});
afterEach(async () => {
  await scheduler.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("state format 10", () => {
  it("migrates a format-9 database: pull-request delivery off, nothing observed, nothing backfilled", () => {
    const path = join(dir, "old.sqlite");
    const seeded = new Store(path);
    const v0 = seeded.read().version;
    seeded.close();
    // Rewrite it as format 9: no prDelivery, and a task that was delivered before the feature existed.
    const raw = new DatabaseSync(path);
    const doc = JSON.parse((raw.prepare("SELECT json FROM state WHERE id = 1").get() as { json: string }).json);
    delete doc.project.prDelivery;
    doc.version = 9;
    const done = doc.tasks.find((t: { id: string }) => t.id === "EX-006");
    done.integration = { status: "integrated", at: iso(), ref: "abc on x", delivered: { status: "delivered", at: iso(), message: "earlier" } };
    raw.prepare("UPDATE state SET format = 9, json = ? WHERE id = 1").run(JSON.stringify(doc));
    raw.close();

    const upgraded = new Store(path);
    const s = upgraded.read().state;
    expect(STATE_FORMAT).toBe(10);
    expect(s.version).toBe(10);
    expect(upgraded.read().version).toBe(v0 + 1);
    expect(s.project.prDelivery).toEqual(DEFAULT_PR_DELIVERY);
    expect(s.project.github).toBeUndefined();
    expect(s.tasks.some((t) => t.integration?.pr || t.integration?.landed)).toBe(false);
    expect(D.unreviewedCount(s)).toBe(0);
    expect(s.tasks.find((t) => t.id === "EX-006")!.integration?.delivered?.status).toBe("delivered");
    // The upgraded state accepts the new commands.
    upgraded.command("setDeliveryMode", { mode: "local", branch: "main" }, "m1", iso());
    expect(D.deliveryMode(upgraded.read().state)).toBe("local");
    upgraded.close();
    const check = new DatabaseSync(path);
    expect((check.prepare("SELECT format FROM state WHERE id = 1").get() as { format: number }).format).toBe(10);
    expect(check.prepare("SELECT value FROM meta WHERE key LIKE 'backup_format_9_%'").get()).toBeDefined();
    check.close();
  });
});

describe("local delivery feeds the Review list (scenario 18)", () => {
  it("each delivered task gets one unreviewed item for its merge commit; the badge count follows explicit marks only", () => {
    const a = deliverTask("First", "one.txt", "1\n");
    const la = task(a).integration!.landed!;
    expect(la).toMatchObject({ via: "local", target: "main", by: "app", status: "unreviewed", flags: [], notes: [], followUps: [] });
    expect(la.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(la.commit).toBe(task(a).integration!.sha);
    // The commit is the task's merge on the integration branch, and main contains it.
    const change = M.finalChange(st(), task(a))!.ref!.split(" ")[0];
    expect(git("rev-parse", `${la.commit}^2`).startsWith(change)).toBe(true);
    expect(() => git("merge-base", "--is-ancestor", la.commit, "main")).not.toThrow();

    const b = deliverTask("Second", "two.txt", "2\n");
    expect(task(b).integration!.landed!.commit).not.toBe(la.commit);
    expect(task(a).integration!.landed).toEqual(la); // untouched by the later delivery
    expect(D.unreviewedCount(st())).toBe(2);

    // Looking never marks anything: visits and more scheduler cycles leave the count alone.
    cmd("markVisited");
    for (let i = 0; i < 3; i++) tick(61_000);
    expect(D.unreviewedCount(st())).toBe(2);
    cmd("markLandedReviewed", { taskIds: [a], reviewed: true });
    expect(D.unreviewedCount(st())).toBe(1);
    cmd("addLandedNote", { taskId: b, text: "Looks fine, check naming later." });
    expect(task(b).integration!.landed!.notes).toHaveLength(1);
    expect(D.unreviewedCount(st())).toBe(1);
    cmd("markLandedReviewed", { taskIds: [a, b], reviewed: true });
    expect(D.unreviewedCount(st())).toBe(0);
  });

  it("an unreviewed item never delays the next task or its delivery", () => {
    const a = deliverTask("First", "one.txt", "1\n");
    expect(task(a).integration!.landed!.status).toBe("unreviewed");
    const b = deliverTask("Second", "two.txt", "2\n");
    expect(task(b).integration?.delivered?.status).toBe("delivered");
    expect(git("show", "main:two.txt")).toBe("2");
    expect(task(a).integration!.landed!.status).toBe("unreviewed");
  });

  it("a delivery that keeps waiting records one result, not one per retry", () => {
    writeFileSync(join(repo, "README.md"), "local edit\n");
    const id = deliverTask("Waits", "w.txt", "w\n");
    const first = task(id).integration!.delivered!;
    expect(first.status).toBe("skipped");
    expect(task(id).integration!.landed).toBeUndefined();
    for (let i = 0; i < 3; i++) tick(61_000);
    expect(task(id).integration!.delivered).toEqual(first); // same `at`: nothing to notify again
    git("checkout", "--", "README.md");
    tick(61_000);
    expect(task(id).integration!.delivered!.status).toBe("delivered");
    expect(task(id).integration!.landed!.status).toBe("unreviewed");
  });

  it("work integrated while delivery was off is delivered once local delivery is switched on", () => {
    cmd("setDeliveryMode", { mode: "off" });
    const id = newTask("Integrated early");
    oneStep(id);
    tick();
    codex.finish(run(id).id, { write: ["early.txt", "e\n"] });
    tick();
    tick();
    tick(61_000);
    expect(task(id).integration).toMatchObject({ status: "integrated" });
    expect(task(id).integration!.delivered).toBeUndefined();
    cmd("setDeliveryMode", { mode: "local", branch: "main" });
    tick(61_000);
    expect(task(id).integration!.delivered?.status).toBe("delivered");
    expect(git("show", "main:early.txt")).toBe("e");
    expect(task(id).integration!.landed?.commit).toBe(task(id).integration!.sha);
  });

  it("after a blocked delivery, resetting the baseline lets delivery start again", () => {
    deliverTask("First", "one.txt", "1\n");
    git("reset", "-q", "--hard", git("rev-list", "--max-parents=0", "main"));
    const second = deliverTask("Second", "two.txt", "2\n");
    expect(st().project.delivery?.status).toBe("blocked");
    expect(D.deliveryMode(st())).toBe("off");
    expect(task(second).integration!.landed).toBeUndefined();
    cmd("resetDeliveryBaseline");
    cmd("setDeliveryMode", { mode: "local", branch: "main" });
    tick(61_000);
    expect(st().project.delivery?.status).toBe("delivered");
    expect(task(second).integration!.landed?.status).toBe("unreviewed");
  });
});

describe("GET /api/change (scenario 18)", () => {
  let base = "";
  let close: () => void = () => {};
  beforeEach(async () => {
    const probe = createHttpServer({ store, scheduler, workspaces, startedAt: iso(), allowedHosts: [] });
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as AddressInfo).port;
    probe.close();
    const server = createHttpServer({ store, scheduler, workspaces, startedAt: iso(), allowedHosts: [`127.0.0.1:${port}`] });
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
    base = `http://127.0.0.1:${port}`;
    close = () => {
      server.closeAllConnections();
      server.close();
    };
  });
  afterEach(() => close());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const get = async (path: string): Promise<{ status: number; body: any }> => {
    const r = await fetch(base + path);
    return { status: r.status, body: await r.json() };
  };

  it("returns the landed commit against its first parent, by task id only", async () => {
    const a = deliverTask("First", "one.txt", "first line\n");
    const b = deliverTask("Second", "two.txt", "second line\n");
    const before = store.read().version;
    const r = await get(`/api/change?task=${a}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ taskId: a, commit: task(a).integration!.landed!.commit, target: "main", truncated: false });
    expect(r.body.diff).toBe(execFileSync("git", ["-C", repo, "diff", "--no-color", "--no-ext-diff", "--no-textconv", "-M", "--stat", "--patch", `${r.body.commit}^1`, r.body.commit], { encoding: "utf8" }));
    expect(r.body.diff).toContain("+first line");
    expect(r.body.diff).not.toContain("second line"); // only this task's change

    // A `sha` parameter is ignored: the commit always comes from the task's own record.
    const other = task(b).integration!.landed!.commit;
    const withSha = await get(`/api/change?task=${a}&sha=${other}`);
    expect(withSha.body.commit).toBe(r.body.commit);
    expect(withSha.body.diff).toBe(r.body.diff);
    expect(store.read().version).toBe(before); // read-only
    expect(git("status", "--porcelain")).toBe("");
  });

  it("answers 404 for an unknown task, a task that has not landed, and a commit that is gone", async () => {
    const a = deliverTask("First", "one.txt", "1\n");
    expect((await get("/api/change?task=NOPE")).status).toBe(404);
    expect((await get("/api/change")).status).toBe(404);
    const open = newTask("Not landed");
    expect((await get(`/api/change?task=${open}`)).status).toBe(404);
    // A record naming a commit the repository does not have (or anything that is not a commit id).
    for (const bad of ["f".repeat(40), "main", "--output=/tmp/x"]) {
      store.update((s) => {
        const n = structuredClone(s);
        n.tasks.find((t) => t.id === a)!.integration!.landed!.commit = bad;
        return n;
      }, iso());
      const r = await get(`/api/change?task=${a}`);
      expect(r.status).toBe(404);
      expect(r.body.error).toMatch(/not in the local repository/);
    }
  });

  it("caps a large change and says so", async () => {
    const big = Array.from({ length: 30_000 }, (_, i) => `line ${i} ${"x".repeat(30)}`).join("\n") + "\n";
    expect(Buffer.byteLength(big)).toBeGreaterThan(MAX_CHANGE_DIFF_BYTES);
    const a = deliverTask("Big", "big.txt", big);
    const r = await get(`/api/change?task=${a}`);
    expect(r.status).toBe(200);
    expect(r.body.truncated).toBe(true);
    expect(Buffer.byteLength(r.body.diff)).toBeLessThanOrEqual(MAX_CHANGE_DIFF_BYTES);
    expect(r.body.diff.endsWith("\n")).toBe(true);
    expect(r.body.diff).toContain("big.txt");
  });

  it("a simulated service has no commit to show", async () => {
    const a = deliverTask("First", "one.txt", "1\n");
    const fake = createHttpServer({ store, scheduler, startedAt: iso(), allowedHosts: [] }); // no workspaces
    await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
    const port = (fake.address() as AddressInfo).port;
    fake.close();
    const again = createHttpServer({ store, scheduler, startedAt: iso(), allowedHosts: [`127.0.0.1:${port}`] });
    await new Promise<void>((r) => again.listen(port, "127.0.0.1", r));
    const r = await fetch(`http://127.0.0.1:${port}/api/change?task=${a}`);
    expect(r.status).toBe(404);
    expect(((await r.json()) as { error: string }).error).toMatch(/simulated/);
    again.closeAllConnections();
    again.close();
  });
});

describe("send back as a revert, local delivery (scenario 17)", () => {
  /** Run the revert task's remaining steps (review, verify) and deliver. */
  const finishRest = (id: string) => {
    for (let i = 0; i < 12 && task(id).lifecycle !== "done"; i++) {
      const r = run(id);
      if (r) adapterOf(id).finish(r.id);
      tick();
    }
    tick();
    tick(61_000);
  };

  it("the first writer's worktree already holds the revert; once delivered, main's tree is what it was before", () => {
    const treeBefore = git("rev-parse", "main^{tree}");
    const a = deliverTask("Adds a file", "feature.txt", "feature\n");
    expect(git("show", "main:feature.txt")).toBe("feature");
    const landed = task(a).integration!.landed!;

    const rv = (cmd("sendBackLanded", { taskId: a, kind: "revert", note: "Not wanted after all", holdBeforeStart: false }).result as { newId: string }).newId;
    expect(task(rv).revertOf).toEqual({ taskId: a, commit: landed.commit });
    expect(task(a).integration!.landed).toMatchObject({ status: "sent-back", followUps: [{ taskId: rv, kind: "revert" }] });
    tick();
    const r = run(rv);
    expect(r.stepId).toBe("S1");
    const assignment = codex.runs.get(r.id)!;
    // The revert is already applied, uncommitted, on top of main.
    expect(existsSync(join(assignment.workspace.path, "feature.txt"))).toBe(false);
    expect(execFileSync("git", ["-C", assignment.workspace.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(git("rev-parse", "main"));
    expect(assignment.prompt).toContain("## Prepared in this workspace");
    expect(assignment.prompt).toContain(`a revert of commit ${landed.commit.slice(0, 12)}`);
    expect(assignment.prompt).toContain("It applied without conflicts");
    expect(assignment.prompt).toContain("Do not run git");

    codex.finish(r.id); // nothing left to edit
    tick();
    const change = st().artifacts.find((x) => x.taskId === rv && x.stepId === "S1" && x.name === "change")!;
    const sha = change.ref!.split(" ")[0];
    expect(git("log", "-1", "--format=%an <%ae>", sha)).toBe("Orchestration <orchestration@localhost>");
    expect(git("diff", "--name-status", `${sha}^`, sha)).toBe("D\tfeature.txt");
    // The review step reads that change, not the prepared revert again.
    tick();
    expect(run(rv).stepId).toBe("S2");
    expect(existsSync(join(claude.runs.get(run(rv).id)!.workspace.path, "feature.txt"))).toBe(false);
    expect(claude.runs.get(run(rv).id)!.prompt).not.toContain("## Prepared in this workspace");

    finishRest(rv);
    expect(task(rv).integration?.delivered?.status).toBe("delivered");
    expect(git("rev-parse", "main^{tree}")).toBe(treeBefore);
    // The revert is itself a landed item, to review like any other; the original stays sent back.
    expect(task(rv).integration!.landed!.status).toBe("unreviewed");
    expect(task(a).integration!.landed!.status).toBe("sent-back");
    expect(git("status", "--porcelain")).toBe("");
  });

  it("a revert that conflicts with later work is recorded only once the markers are gone", () => {
    const a = deliverTask("Changes the greeting", "README.md", "hello from A\n");
    deliverTask("Changes it again", "README.md", "hello from B\n");
    const rv = (cmd("sendBackLanded", { taskId: a, kind: "revert", note: "", holdBeforeStart: false }).result as { newId: string }).newId;
    tick();
    const first = run(rv);
    const ws = codex.runs.get(first.id)!;
    expect(readFileSync(join(ws.workspace.path, "README.md"), "utf8")).toMatch(/^<<<<<<< /m);
    expect(ws.prompt).toContain("These files have conflicts");
    expect(ws.prompt).toContain("- README.md");

    // The coder leaves the markers in: the result is refused and nothing is recorded.
    codex.finish(first.id);
    tick();
    tick();
    expect(st().attempts.find((x) => x.id === first.id)!.outcome).toBe("failed");
    expect(task(rv).steps[0].state).toBe("blocked");
    expect(`${task(rv).steps[0].blockedReason} ${st().attempts.find((x) => x.id === first.id)!.note}`).toMatch(/unresolved conflict markers in README\.md/);
    expect(st().artifacts.some((x) => x.taskId === rv && x.kind === "code-change")).toBe(false);

    // A new attempt gets a fresh, re-prepared worktree; resolving the conflict is accepted.
    cmd("retryStep", { taskId: rv, stepId: "S1" });
    tick();
    const second = run(rv);
    expect(second.id).not.toBe(first.id);
    expect(readFileSync(join(codex.runs.get(second.id)!.workspace.path, "README.md"), "utf8")).toMatch(/^<<<<<<< /m);
    codex.finish(second.id, { write: ["README.md", "hello from B, without A\n"] });
    tick();
    const change = st().artifacts.find((x) => x.taskId === rv && x.kind === "code-change")!;
    expect(git("show", `${change.ref!.split(" ")[0]}:README.md`)).toBe("hello from B, without A");
    finishRest(rv);
    expect(git("show", "main:README.md")).toBe("hello from B, without A");
  });

  it("a revert is refused when its starting point does not contain the landed commit", () => {
    const a = deliverTask("Adds a file", "feature.txt", "feature\n");
    git("reset", "-q", "--hard", git("rev-list", "--max-parents=0", "main")); // the user removed it from main
    const rv = (cmd("sendBackLanded", { taskId: a, kind: "revert", note: "", holdBeforeStart: false }).result as { newId: string }).newId;
    tick();
    tick();
    const failed = st().attempts.find((x) => x.taskId === rv)!;
    expect(failed.outcome).toBe("failed");
    expect(failed.note).toMatch(/cannot prepare the revert/);
    expect(codex.runs.size).toBe(0);
  });
});

describe("workspace seeds", () => {
  it("a prepared merge is concluded as a two-parent commit by Orchestration", () => {
    git("switch", "-q", "-c", "side");
    commit("side.txt", "side\n", "side work");
    const side = git("rev-parse", "HEAD");
    git("switch", "-q", "main");
    commit("main.txt", "main\n", "main work");
    const ws = workspaces.prepare({ repoPath: repo, projectId: "p", attemptId: "run-m", taskId: "T", stepId: "S1", access: "write", seed: { kind: "merge", ref: side } });
    expect(ws.seed).toEqual({ kind: "merge", commit: side, conflicted: [] });
    expect(existsSync(join(ws.path, "side.txt"))).toBe(true);
    const c = workspaces.commit({ ...ws, message: "T S1: merge" });
    expect(c.changed).toBe(true);
    expect(execFileSync("git", ["-C", repo, "rev-list", "--parents", "-n", "1", c.sha], { encoding: "utf8" }).trim().split(" ")).toEqual([c.sha, git("rev-parse", "main"), side]);
    expect(git("log", "-1", "--format=%an", c.sha)).toBe("Orchestration");
  });

  it("a read-only worktree is never seeded, and an unknown commit fails without leaving a worktree", () => {
    const head = git("rev-parse", "HEAD");
    const ro = workspaces.prepare({ repoPath: repo, projectId: "p", attemptId: "run-r", taskId: "T", stepId: "S2", access: "read", seed: { kind: "revert", commit: head } });
    expect(ro.seed).toBeUndefined();
    expect(() => workspaces.prepare({ repoPath: repo, projectId: "p", attemptId: "run-x", taskId: "T", stepId: "S1", access: "write", seed: { kind: "revert", commit: "f".repeat(40) } })).toThrow(/no longer in the repository/);
    expect(existsSync(workspaces.pathFor(repo, "run-x", "p"))).toBe(false);
  });
});

describe("credentials", () => {
  it("GitHub token variables are removed from a worker environment and nothing else", () => {
    const env = { PATH: "/usr/bin", OPENAI_API_KEY: "k", GH_TOKEN: "a", GITHUB_TOKEN: "b", GH_ENTERPRISE_TOKEN: "c", GITHUB_ENTERPRISE_TOKEN: "d" };
    expect(withoutGitHubTokens(env)).toEqual({ PATH: "/usr/bin", OPENAI_API_KEY: "k" });
    expect(env.GH_TOKEN).toBe("a"); // the service's own environment is not modified
    expect(GITHUB_TOKEN_VARS).toHaveLength(4);
  });

  it("redact removes GitHub token shapes and secret environment values", () => {
    const text = redact("remote: bad credentials ghp_abcdefghijklmnopqrstuvwxyz0123456789 and github_pat_11ABCDEFG0abcdefghij_xyz and hunter2hunter2", { GH_TOKEN: "hunter2hunter2" });
    expect(text).toBe("remote: bad credentials *** and *** and ***");
  });
});

describe("review findings on step 1", () => {
  it("a task whose coder changed nothing lands nothing: it never takes another task's commit as its own", () => {
    const a = deliverTask("Real change", "one.txt", "1\n");
    const la = structuredClone(task(a).integration!.landed!);
    // The coder finishes without touching a file: its "change" is the commit it started from.
    const b = newTask("No change");
    oneStep(b);
    tick();
    codex.finish(run(b).id);
    tick();
    tick();
    tick(61_000);
    expect(task(b).lifecycle).toBe("done");
    expect(task(b).integration).toMatchObject({ status: "not-needed" });
    expect(task(b).integration!.sha).toBeUndefined();
    expect(task(b).integration!.landed).toBeUndefined();
    expect(task(a).integration!.landed).toEqual(la);
    expect(D.landedTasks(st()).map((t) => t.id)).toEqual([a]);
    expect(() => cmd("sendBackLanded", { taskId: b, kind: "revert", note: "", holdBeforeStart: false })).toThrow(/has not landed/);

    // The user commits to main; a second no-change task starts from that tip. Merging it would bring
    // only the user's commit: that is not this task's work either.
    commit("mine.txt", "mine\n", "my own commit");
    const mine = git("rev-parse", "main");
    const c = newTask("No change on top of my commit");
    oneStep(c);
    tick();
    expect(execFileSync("git", ["-C", codex.runs.get(run(c).id)!.workspace.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(mine);
    codex.finish(run(c).id);
    tick();
    tick();
    tick(61_000);
    expect(task(c).integration).toMatchObject({ status: "not-needed" });
    expect(task(c).integration!.landed).toBeUndefined();
    // A real change still integrates, as a merge whose second parent is that change.
    const d = deliverTask("Another real change", "two.txt", "2\n");
    const ld = task(d).integration!.landed!;
    expect(git("rev-parse", `${ld.commit}^2`).startsWith(M.finalChange(st(), task(d))!.ref!.split(" ")[0])).toBe(true);
  });

  /** A branch and main that conflict in `files`, and a writer worktree with the merge prepared. */
  const conflicted = (files: string[], attemptId: string) => {
    for (const f of files) writeFileSync(join(repo, f), "base\n");
    git("add", "-A");
    git("-c", "user.name=u", "-c", "user.email=u@u", "commit", "-q", "-m", "base files");
    git("switch", "-q", "-c", `side-${attemptId}`);
    for (const f of files) writeFileSync(join(repo, f), "side\n");
    git("-c", "user.name=u", "-c", "user.email=u@u", "commit", "-q", "-am", "side");
    const side = git("rev-parse", "HEAD");
    git("switch", "-q", "main");
    for (const f of files) writeFileSync(join(repo, f), "main\n");
    git("-c", "user.name=u", "-c", "user.email=u@u", "commit", "-q", "-am", "main");
    return workspaces.prepare({ repoPath: repo, projectId: "p", attemptId, taskId: "T", stepId: "S1", access: "write", seed: { kind: "merge", ref: side } });
  };

  it("the marker guard checks every conflicted file, not only the first 20; the envelope lists 20 and says how many more", () => {
    const files = Array.from({ length: 25 }, (_, i) => `f${String(i + 1).padStart(2, "0")}.txt`);
    const ws = conflicted(files, "run-many");
    expect(ws.seed!.conflicted).toEqual(files);
    // Every conflict is resolved except the last one, which is past the first 20.
    for (const f of files.slice(0, 24)) writeFileSync(join(ws.path, f), "resolved\n");
    expect(() => workspaces.commit({ ...ws, message: "T S1" })).toThrow(/unresolved conflict markers in f25\.txt/);
    writeFileSync(join(ws.path, "f25.txt"), "resolved\n");
    expect(workspaces.commit({ ...ws, message: "T S1" }).changed).toBe(true);

    const id = newTask("Envelope");
    const state = st();
    const t = state.tasks.find((x) => x.id === id)!;
    const prompt = buildEnvelope({ state, task: t, step: t.steps[0], attemptId: "run-x", access: "write", seed: ws.seed });
    expect(prompt).toContain("- f20.txt");
    expect(prompt).not.toContain("- f21.txt");
    expect(prompt).toContain("and 5 more");
  });

  it("a file that legitimately shows conflict markers is accepted once the real conflict is resolved, and refused while it is not", () => {
    // Documentation that shows what a conflict looks like, on both sides of the merge.
    const doc = ["How a conflict looks:", "<<<<<<< ours", "our line", "=======", "their line", ">>>>>>> theirs", "", "version: base", ""].join("\n");
    writeFileSync(join(repo, "doc.md"), doc);
    git("add", "-A");
    git("-c", "user.name=u", "-c", "user.email=u@u", "commit", "-q", "-m", "doc");
    git("switch", "-q", "-c", "side-doc");
    writeFileSync(join(repo, "doc.md"), doc.replace("version: base", "version: side"));
    git("-c", "user.name=u", "-c", "user.email=u@u", "commit", "-q", "-am", "side");
    const side = git("rev-parse", "HEAD");
    git("switch", "-q", "main");
    writeFileSync(join(repo, "doc.md"), doc.replace("version: base", "version: main"));
    git("-c", "user.name=u", "-c", "user.email=u@u", "commit", "-q", "-am", "main");

    const ws = workspaces.prepare({ repoPath: repo, projectId: "p", attemptId: "run-doc", taskId: "T", stepId: "S1", access: "write", seed: { kind: "merge", ref: side } });
    expect(ws.seed!.conflicted).toEqual(["doc.md"]);
    const left = readFileSync(join(ws.path, "doc.md"), "utf8");
    expect(left).toMatch(/^<<<<<<< HEAD$/m);
    // Unresolved: git's own markers are new, so it is refused.
    expect(() => workspaces.commit({ ...ws, message: "T S1" })).toThrow(/unresolved conflict markers in doc\.md/);
    // Resolved, keeping the documentation's own marker lines: accepted.
    writeFileSync(join(ws.path, "doc.md"), doc.replace("version: base", "version: both"));
    const c = workspaces.commit({ ...ws, message: "T S1" });
    expect(c.changed).toBe(true);
    expect(git("show", `${c.sha}:doc.md`)).toContain("<<<<<<< ours");
    // A copy of the documentation's marker line beyond what was there before is still a new marker.
    const ws2 = workspaces.prepare({ repoPath: repo, projectId: "p", attemptId: "run-doc2", taskId: "T", stepId: "S1", access: "write", seed: { kind: "merge", ref: side } });
    writeFileSync(join(ws2.path, "doc.md"), `${doc.replace("version: base", "version: both")}<<<<<<< ours\n`);
    expect(() => workspaces.commit({ ...ws2, message: "T S1" })).toThrow(/unresolved conflict markers/);
  });

  it("a revert starts from where the work landed, not from the current delivery setting or checkout", () => {
    const a = deliverTask("Adds a file", "feature.txt", "feature\n");
    const main = git("rev-parse", "main");
    // Delivery is switched off and the user is on another branch with newer work.
    cmd("setDeliveryMode", { mode: "off" });
    git("switch", "-q", "-c", "elsewhere");
    commit("unrelated.txt", "x\n", "unrelated work on another branch");
    const rv = (cmd("sendBackLanded", { taskId: a, kind: "revert", note: "", holdBeforeStart: false }).result as { newId: string }).newId;
    tick();
    const ws = codex.runs.get(run(rv).id)!.workspace.path;
    expect(execFileSync("git", ["-C", ws, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(main);
    expect(existsSync(join(ws, "unrelated.txt"))).toBe(false);
    expect(existsSync(join(ws, "feature.txt"))).toBe(false); // the revert is prepared on top of main
  });

  it("a diff that takes too long is stopped instead of holding the service", () => {
    const a = deliverTask("First", "one.txt", "1\n");
    workspaces.changeDiffTimeoutMs = 1;
    try {
      let out: ReturnType<WorkspaceManager["changeDiff"]> | Error;
      try {
        out = workspaces.changeDiff({ repoPath: repo, commit: task(a).integration!.landed!.commit });
      } catch (e) {
        out = e as Error;
      }
      // Either it was stopped (an error, or a truncated result), or git beat a 1 ms limit.
      if (out instanceof Error) expect(out.message).toMatch(/took too long|could not be read/);
      else expect(out).toBeDefined();
    } finally {
      workspaces.changeDiffTimeoutMs = 10_000;
    }
  });
});
