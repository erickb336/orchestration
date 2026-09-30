// The evidence run for pull-request delivery (ORC-008 §17, "Real GitHub"). Started only by
// scripts/pr-sandbox-check.mjs, which explains what it does and refuses to start without an explicit
// repository and an explicit confirmation.
//
// It drives the real application code (the scheduler, the pull-request driver, the gh adapter and the
// workspace manager) against ONE repository that exists for this purpose, with scripted agents in
// place of Claude and Codex (no model runs, unless --real-agents), and records what happened.
//
//   --fake   the same scenarios against a local bare repository and the in-process fake GitHub, on a
//            simulated clock. Contacts nothing. Used to check the script itself.
//
// NOT VERIFIED: the real mode of this file has never been run against GitHub.

import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as D from "../../src/domain/delivery";
import * as M from "../../src/domain/model";
import type { PrDelivery, ProviderId, State, Task } from "../../src/domain/types";
import { GhCliHost, GhError, type GitHubHost, type RepoRef } from "../github";
import { redact } from "../redact";
import type { RuntimeAdapter } from "../runtimes/types";
import { Scheduler } from "../scheduler";
import { Store } from "../store";
import { WorkspaceManager, networkEnv } from "../workspaces";
import { FakeGitHub } from "./fakeGitHub";
import { ScriptedAdapter } from "./scripted";

/** Repositories this run never touches, whatever is asked. */
const NEVER = ["erickb336/orchestration"];
const RULESET = "orc-sandbox-protect-main";
const WORKFLOW = ".github/workflows/orc-sandbox-check.yml";
const REPO = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;

interface Options {
  repo: string;
  fake: boolean;
  keep: boolean;
  realAgents: boolean;
  checkSeconds: number;
  only: string[];
}

function parse(argv: string[]): Options {
  const value = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    repo: value("--repo") ?? "",
    fake: argv.includes("--fake"),
    keep: argv.includes("--keep"),
    realAgents: argv.includes("--real-agents"),
    checkSeconds: Math.max(10, Math.min(600, Number(value("--check-seconds") ?? 45) || 45)),
    only: (value("--only") ?? "").split(",").map((x) => x.trim()).filter(Boolean),
  };
}

const opts = parse(process.argv.slice(2));
const fail = (message: string): never => {
  console.error(`[pr-sandbox] ${message}`);
  process.exit(2);
};

// ---------- refusals (repeated here: this file must be safe even when started by hand) ----------

if (!opts.fake) {
  if (!opts.repo) fail("No repository given. Pass --repo <owner>/<name> of a throwaway repository. There is no default.");
  if (!REPO.test(opts.repo)) fail(`"${opts.repo}" is not an <owner>/<name> repository.`);
  if (NEVER.includes(opts.repo.toLowerCase())) fail(`${opts.repo} is never used for this run. Use a repository made for it.`);
  if (!process.argv.includes("--yes")) fail("Not confirmed. Pass --yes to let this run write to the repository.");
  if (process.env.ORC_SANDBOX_CONFIRMED !== opts.repo) fail("Start this run through scripts/pr-sandbox-check.mjs, which confirms the repository.");
}

// ---------- evidence ----------

const started = new Date();
const stamp = started.toISOString().replace(/[:.]/g, "-");
const out = resolve(import.meta.dirname, "..", "..", "evidence", "ORC-008", `${opts.fake ? "fake" : "run"}-${stamp}`);
mkdirSync(out, { recursive: true });
const commandLog = join(out, "commands.log");
const evidence: {
  mode: "fake" | "real";
  repo: string;
  startedAt: string;
  finishedAt?: string;
  agents: string;
  checks: Record<string, { ok: boolean; detail?: unknown }>;
  facts: Record<string, unknown>;
  skipped: Record<string, string>;
  created: string[];
  ok: boolean;
} = { mode: opts.fake ? "fake" : "real", repo: opts.fake ? "(local bare repository)" : opts.repo, startedAt: started.toISOString(), agents: opts.realAgents ? "real Claude and Codex" : "scripted (no model runs)", checks: {}, facts: {}, skipped: {}, created: [], ok: false };
const t0 = Date.now();
const log = (msg: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(7)}s] ${msg}`);
const check = (name: string, ok: boolean, detail?: unknown) => {
  evidence.checks[name] = { ok: !!ok, ...(detail === undefined ? {} : { detail }) };
  log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ` ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
};
const fact = (name: string, value: unknown) => {
  evidence.facts[name] = value;
  log(`fact ${name}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
};
const save = () => writeFileSync(join(out, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
/** Every command the run itself issues, and every gh call the application makes, with redacted output. */
const record = (what: string, args: string[], result: string) => appendFileSync(commandLog, `${new Date().toISOString()} ${what} ${redact(args.join(" "))}\n${redact(result).slice(0, 2000).replace(/^/gm, "    ")}\n`);

// ---------- the clock: real time against GitHub, simulated against the fake ----------

let simulated = Date.parse("2026-09-30T12:00:00Z");
const nowMs = () => (opts.fake ? simulated : Date.now());
const iso = () => new Date(nowMs()).toISOString();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------- the repository ----------

const work = join(out, "work");
mkdirSync(work, { recursive: true });
const repoPath = join(work, "repo");
const git = (...args: string[]) => {
  const r = spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8", env: networkEnv() });
  record("git", args, `${r.stdout ?? ""}${r.stderr ?? ""}`);
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${redact(String(r.stderr ?? "")).trim().split("\n").slice(-2).join(" ")}`);
  return String(r.stdout).trim();
};
const commitFile = (file: string, text: string, message: string) => {
  mkdirSync(join(repoPath, file, ".."), { recursive: true });
  writeFileSync(join(repoPath, file), text);
  git("add", "-A");
  git("-c", "user.name=Orchestration sandbox setup", "-c", "user.email=sandbox-setup@localhost", "commit", "-q", "-m", message);
};

/** The run's own gh calls (setup and teardown of the sandbox). The application never makes these. */
function rawGh(args: string[], stdin?: string): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync("gh", args, { encoding: "utf8", env: networkEnv(), input: stdin ?? "", cwd: join(work, "gh-setup") });
  record("gh (sandbox setup)", args, `${r.stdout ?? ""}${r.stderr ?? ""}`);
  return { ok: r.status === 0, stdout: String(r.stdout ?? ""), stderr: redact(String(r.stderr ?? "")) };
}

const workflow = (seconds: number) => `# Created by Orchestration's scripts/pr-sandbox-check.mjs. One slow required check named "check".
name: orc-sandbox-check
on:
  pull_request:
  push:
    branches: [main]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: sleep ${seconds}
      - run: test ! -f FAIL_CHECK
`;

const rulesetBody = (unattributed: boolean) => ({
  name: RULESET,
  target: "branch",
  enforcement: "active",
  conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
  // The posture of the user's own repository: an admin can bypass, always. The application never does.
  bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }],
  rules: [
    {
      type: "pull_request",
      parameters: {
        required_approving_review_count: 0,
        dismiss_stale_reviews_on_push: false,
        require_code_owner_review: false,
        require_last_push_approval: false,
        required_review_thread_resolution: false,
        ...(unattributed ? { require_extra_approval_for_unattributed_changes: true } : {}),
      },
    },
    { type: "required_status_checks", parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: "check" }] } },
  ],
});

let rulesetId: string | undefined;
let bare = "";
let fake: FakeGitHub | undefined;

function setupFake() {
  bare = join(work, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", repoPath]);
  commitFile("README.md", "# Sandbox\n", "init");
  git("remote", "add", "origin", bare);
  git("push", "-q", "origin", "main");
  fake = new FakeGitHub(bare);
}

function setupReal() {
  mkdirSync(join(work, "gh-setup"), { recursive: true });
  // Read-only first: who is signed in, and is this a repository this account administers?
  const repo = rawGh(["api", `repos/${opts.repo}`, "--jq", "{private:.private,archived:.archived,fork:.fork,default_branch:.default_branch,admin:.permissions.admin,push:.permissions.push,stars:.stargazers_count}"]);
  if (!repo.ok) throw new Error(`The repository ${opts.repo} could not be read with your gh sign-in: ${repo.stderr.trim().split("\n").pop()}`);
  const facts = JSON.parse(repo.stdout) as { private: boolean; archived: boolean; fork: boolean; default_branch: string; admin: boolean; push: boolean; stars: number };
  fact("repository", facts);
  if (facts.archived || !facts.push || !facts.admin) throw new Error(`${opts.repo} must be a repository you administer (needed to create and remove the sandbox ruleset), and not archived.`);
  if (facts.stars > 0 || facts.fork) throw new Error(`${opts.repo} has stars or is a fork: it does not look like a throwaway repository. Nothing was changed.`);
  if (!facts.private) log("NOTE: the repository is public. Pull request titles, descriptions and comments made by this run are public.");

  const clone = spawnSync("git", ["clone", "-q", `https://github.com/${opts.repo}.git`, repoPath], { encoding: "utf8", env: networkEnv() });
  record("git", ["clone", `https://github.com/${opts.repo}.git`], `${clone.stdout ?? ""}${clone.stderr ?? ""}`);
  if (clone.status !== 0) throw new Error(`git could not clone ${opts.repo}: ${redact(String(clone.stderr)).trim().split("\n").pop()}`);
  const hasMain = spawnSync("git", ["-C", repoPath, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"]).status === 0;
  if (hasMain) git("checkout", "-q", "-B", "main", "origin/main");
  else git("checkout", "-q", "-b", "main");
  // The one required check, slow on purpose. Pushed directly to main BEFORE the ruleset exists.
  if (!existsSync(join(repoPath, WORKFLOW)) || !hasMain) {
    commitFile(WORKFLOW, workflow(opts.checkSeconds), "Orchestration sandbox: add the slow required check");
    git("push", "-q", "origin", "main");
    evidence.created.push(`commit on main adding ${WORKFLOW}`);
  }
  const existing = rawGh(["api", `repos/${opts.repo}/rulesets`, "--jq", `.[] | select(.name == "${RULESET}") | .id`]);
  rulesetId = existing.stdout.trim().split("\n").filter(Boolean)[0];
  if (!rulesetId) {
    const made = rawGh(["api", "-X", "POST", `repos/${opts.repo}/rulesets`, "--input", "-"], JSON.stringify(rulesetBody(false)));
    if (!made.ok) throw new Error(`The sandbox ruleset could not be created: ${made.stderr.trim().split("\n").pop()}`);
    rulesetId = String((JSON.parse(made.stdout) as { id: number }).id);
    evidence.created.push(`ruleset "${RULESET}" (id ${rulesetId}) on main`);
  }
  fact("ruleset", { id: rulesetId, name: RULESET });
}

function teardownReal() {
  if (opts.keep || !rulesetId) return;
  const gone = rawGh(["api", "-X", "DELETE", `repos/${opts.repo}/rulesets/${rulesetId}`]);
  check("teardown: the sandbox ruleset was removed", gone.ok, gone.ok ? undefined : gone.stderr.trim().split("\n").pop());
}

// ---------- the application under test ----------

/** The application's own gh adapter, with every invocation recorded. It is not changed in any other way. */
class RecordedGh extends GhCliHost {
  override async gh(args: string[], o: { stdin?: string } = {}): Promise<string> {
    try {
      const stdout = await super.gh(args, o);
      record("gh (application)", args, stdout);
      return stdout;
    } catch (e) {
      record("gh (application)", args, `ERROR ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    }
  }
}

let store: Store;
let scheduler: Scheduler;
let workspaces: WorkspaceManager;
let host: GitHubHost;
let adapters: Record<ProviderId, RuntimeAdapter>;
let key = 0;
const st = (): State => store.read().state;
const task = (id: string): Task => st().tasks.find((t) => t.id === id)!;
const pr = (id: string): PrDelivery => task(id).integration!.pr!;
const cmd = (name: string, args: object = {}) => store.command(name, args, `sandbox-${++key}`, iso());
const repoRef = (): RepoRef => {
  const [owner, name] = (st().project.github?.repo ?? "").split("/");
  return { owner, name };
};

function newScheduler(): Scheduler {
  return new Scheduler(store, adapters, { workspaces, github: host, leaseMs: 120_000, ackTimeoutMs: 10_000, log: (m) => record("service", [], m) });
}

/** Scripted agents: a coder writes one small file (a revert is already prepared for it), a reviewer finds nothing. */
function driveAgents() {
  if (opts.realAgents) return;
  for (const a of M.activeAttempts(st())) {
    if (a.outcome !== "running") continue;
    const ad = adapters[a.snapshot.provider] as ScriptedAdapter;
    if (!ad.runs.has(a.id)) continue;
    const t = task(a.taskId);
    const role = t.steps.find((x) => x.id === a.stepId)?.role;
    if (role === "coder" && !t.revertOf) ad.finish(a.id, { write: [`orc-sandbox-${a.taskId}.txt`, `${a.taskId} by ${a.snapshot.provider}\n`] });
    else if (role === "code_reviewer" || role === "ux_reviewer") ad.finish(a.id, { findings: 0 });
    else ad.finish(a.id);
  }
}

/** The fake's continuous integration: the required check passes on each new head after the configured delay. */
const ci = new Map<string, number>();
function driveFakeCi() {
  if (!fake) return;
  for (const p of fake.open) {
    const head = execFileSync("git", ["--git-dir", bare, "rev-parse", `refs/heads/${p.head}`], { encoding: "utf8" }).trim();
    const k = `${p.number}:${head}`;
    if (!ci.has(k)) ci.set(k, nowMs() + opts.checkSeconds * 1000);
    else if (ci.get(k)! > 0 && nowMs() >= ci.get(k)!) {
      fake.setCheck(p.number, "SUCCESS");
      ci.set(k, -1);
    }
  }
  for (const t of st().tasks) {
    const l = t.integration?.landed;
    if (l?.via === "pr" && l.mainCheck?.state === "pending") fake.baseChecks.set(l.commit, [{ name: "check", required: true, status: "COMPLETED", conclusion: "SUCCESS" }]);
  }
}

/** One step of the service, then wait for the GitHub operation it started. */
async function step(wait = true) {
  if (opts.fake) simulated += 5000;
  driveAgents();
  driveFakeCi();
  scheduler.tick(nowMs());
  if (wait) await scheduler.prIdle();
  await sleep(opts.fake ? 1 : 1000);
}

/** Run the service until `pred` holds. Throws with `what` after `timeoutS` (of the run's clock). */
async function until(what: string, pred: () => boolean, timeoutS: number): Promise<void> {
  const end = nowMs() + timeoutS * 1000;
  while (!pred()) {
    if (nowMs() > end) throw new Error(`timed out after ${timeoutS} s waiting for: ${what}`);
    await step();
  }
}

const CHECK_WAIT = () => opts.checkSeconds + (opts.fake ? 600 : 900);

function createTask(title: string): string {
  const id = (cmd("createTask", { title, area: "Sandbox", outcome: `${title}: a small file is added`, benefit: "Evidence", whyNow: "Evidence run", approach: "Add one small file", acceptance: ["The file exists"], priority: 1, holdBeforeStart: false, templateId: "change" }).result as { newId: string }).newId;
  log(`task ${id}: ${title}`);
  return id;
}

/** A task run to its pull request, open and seen on GitHub. */
async function openPullRequest(title: string): Promise<string> {
  const id = createTask(title);
  await until(`${id} is done`, () => task(id).lifecycle === "done", opts.realAgents ? 1800 : 300);
  await until(`${id}'s pull request is open and seen`, () => task(id).integration?.pr?.phase === "open" && !!pr(id).observed, 600);
  evidence.created.push(`branch ${pr(id).branch} and pull request #${pr(id).number}`);
  return id;
}

const remoteHead = (branch: string) => {
  const r = spawnSync("git", ["-C", repoPath, "ls-remote", "--refs", "origin", `refs/heads/${branch}`], { encoding: "utf8", env: networkEnv() });
  return String(r.stdout).split(/\s+/)[0] ?? "";
};
const selected = (name: string) => opts.only.length === 0 || opts.only.includes(name);
async function scenario(name: string, title: string, run: () => Promise<void>) {
  if (!selected(name)) {
    evidence.skipped[name] = "not selected (--only)";
    return;
  }
  log(`--- (${name}) ${title}`);
  try {
    await run();
  } catch (e) {
    check(`(${name}) ${title}`, false, e instanceof Error ? e.message : String(e));
  }
  save();
}

// ---------- the scenarios ----------

let landedHold: string | undefined;
let beforeHold = "";

async function scenarios() {
  await scenario("a", "the read-only repository check and what it found", async () => {
    cmd("setDeliveryMode", { mode: "pr" });
    await until("the repository is checked and the base fetched", () => !!st().project.github?.checkedAt && (!!st().project.github?.base || !!st().project.github?.problem), 180);
    const gh = st().project.github!;
    fact("preflight", { ok: gh.ok, repo: gh.repo, login: gh.login, ghVersion: gh.ghVersion, requiredChecks: gh.requiredChecks, autoMergeBlockers: gh.autoMergeBlockers, problem: gh.problem?.message });
    fact("posture", gh.posture.map((p) => `${p.status}: ${p.label}`));
    check("(a) the repository check passed and found the required check", gh.ok && gh.requiredChecks.includes("check"), gh.problem?.message);
    check("(a) automatic merging is available here", gh.autoMergeBlockers.length === 0, gh.autoMergeBlockers);
    if (!opts.fake) check("(a) the account's bypass of the rules is reported", gh.posture.some((p) => p.id === "bypass"));
    if (!gh.ok) throw new Error("the repository check did not pass; the remaining scenarios cannot run");
  });
  if (!st().project.github?.ok) return;

  await scenario("b", "hold and notify, end to end", async () => {
    beforeHold = remoteHead("main");
    const id = await openPullRequest("Hold and notify");
    const head = pr(id).headSha;
    check("(b) the branch on the remote holds exactly the task's final commit", remoteHead(pr(id).branch) === head, { branch: pr(id).branch, head });
    check("(b) nothing merges by itself in hold mode", pr(id).policy === "hold" && pr(id).phase === "open");
    await until("the pull request is ready for the user", () => D.prReady(st(), task(id), nowMs()), CHECK_WAIT());
    await until("the ready notice was written", () => st().events.some((e) => e.taskId === id && e.message.includes("is ready for you")), 120);
    check("(b) the user is told once that it is ready", st().events.filter((e) => e.taskId === id && e.message.includes("is ready for you")).length === 1);
    fact("(b) independent review", pr(id).review);
    cmd("requestPrMerge", { taskId: id, headSha: head });
    await until("it merges", () => pr(id).phase !== "open", 300);
    const landed = task(id).integration?.landed;
    check("(b) merged by the app at the user's request, recorded from what GitHub reported", pr(id).phase === "merged" && landed?.by === "app", { phase: pr(id).phase, by: landed?.by, commit: landed?.commit });
    check("(b) GitHub's merge commit is the tip of main", !!landed && remoteHead("main") === landed.commit);
    landedHold = pr(id).phase === "merged" ? id : undefined;
  });

  await scenario("e", "a note posted as a comment on the merged pull request, and found again by its marker", async () => {
    if (!landedHold) throw new Error("scenario (b) did not land a pull request");
    const id = landedHold;
    const number = task(id).integration!.landed!.pr!.number;
    cmd("addLandedNote", { taskId: id, text: "Evidence run: a note posted from the Review list.", postToGitHub: true });
    const first = () => task(id).integration!.landed!.notes[0];
    await until("the note is posted", () => first().comment?.status !== "pending", 300);
    check("(e) the note is posted only with its address", first().comment?.status === "posted" && !!first().comment?.url, first().comment);
    // An earlier, interrupted attempt already posted the comment: the app must find it, not post again.
    cmd("pauseProject");
    cmd("addLandedNote", { taskId: id, text: "Evidence run: this one was already posted by an interrupted attempt.", postToGitHub: true });
    const second = task(id).integration!.landed!.notes[1];
    const marker = D.noteMarker(st().project.id, second.id);
    await host.comment({ repo: repoRef(), number, body: `${second.text}\n\n${marker}` });
    cmd("resumeProject");
    await until("the second note is reconciled", () => task(id).integration!.landed!.notes[1].comment?.status !== "pending", 300);
    const found = await host.findComment({ repo: repoRef(), number, marker });
    check("(e) the comment that already existed is adopted by its marker", task(id).integration!.landed!.notes[1].comment?.url === found?.url, task(id).integration!.landed!.notes[1].comment);
    if (fake) check("(e) exactly one comment carries the marker", fake.pr(number).comments.filter((c) => c.body.includes(marker)).length === 1);
  });

  await scenario("f", "a revert delivered as a pull request", async () => {
    if (!landedHold) throw new Error("scenario (b) did not land a pull request");
    const r = cmd("sendBackLanded", { taskId: landedHold, kind: "revert", note: "Evidence run: undo it again.", holdBeforeStart: false }).result as { newId: string };
    await until(`${r.newId} is done`, () => task(r.newId).lifecycle === "done", 600);
    await until("the revert's pull request is open", () => task(r.newId).integration?.pr?.phase === "open" && !!pr(r.newId).observed, 600);
    evidence.created.push(`branch ${pr(r.newId).branch} and pull request #${pr(r.newId).number}`);
    await until("it is ready", () => D.prReady(st(), task(r.newId), nowMs()), CHECK_WAIT());
    cmd("requestPrMerge", { taskId: r.newId, headSha: pr(r.newId).headSha });
    await until("the revert merges", () => pr(r.newId).phase !== "open", 300);
    check("(f) the revert merged", pr(r.newId).phase === "merged");
    git("fetch", "-q", "origin", "main");
    const tree = (rev: string) => git("rev-parse", `${rev}^{tree}`);
    check("(f) main holds the files it held before the reverted change", tree("FETCH_HEAD") === tree(beforeHold), { before: beforeHold.slice(0, 12), now: remoteHead("main").slice(0, 12) });
  });

  await scenario("c", "automatic merge with a slow check, and a push by someone else", async () => {
    // First, a push by someone else to a pull request branch: the merge command is bound to the head it
    // was given, and the app never touches that pull request again.
    const held = await openPullRequest("Pushed to by someone else");
    const old = pr(held).headSha;
    git("fetch", "-q", "origin", pr(held).branch);
    git("checkout", "-q", "--detach", "FETCH_HEAD");
    commitFile(`orc-sandbox-foreign-${held}.txt`, "pushed by a person\n", "A person's commit on the pull request branch");
    git("push", "-q", "origin", `HEAD:refs/heads/${pr(held).branch}`);
    git("checkout", "-q", "main");
    let refusal = "the merge was NOT refused";
    try {
      await host.merge({ repo: repoRef(), number: pr(held).number!, headSha: old, subject: "must not merge", body: "evidence run: a merge bound to a head that is no longer the head" });
    } catch (e) {
      refusal = e instanceof GhError ? `${e.code}: ${e.message}` : String(e);
    }
    check("(c) a merge bound to the old head is refused by --match-head-commit", refusal !== "the merge was NOT refused", refusal);
    await until("the app sees the foreign push", () => !!pr(held).foreignHead, 600);
    check("(c) the app holds that pull request for good", pr(held).attention?.code === "foreign-push" && pr(held).phase === "open");
    cmd("closePr", { taskId: held });
    await until("it is closed", () => pr(held).phase === "closed", 300);

    cmd("setPrDelivery", { config: { merge: "auto" } });
    const id = await openPullRequest("Merged automatically");
    const head = pr(id).headSha;
    // What GitHub reports to this (bypass) account while the required check is still running.
    const pending: { mergeable: string; mergeStateStatus: string; check: string }[] = [];
    const sample = () => {
      const o = pr(id).observed;
      if (o && o.headSha === pr(id).headSha && pr(id).phase === "open") {
        const c = o.checks.find((x) => x.name === "check");
        const s = { mergeable: o.mergeable, mergeStateStatus: o.mergeStateStatus, check: c ? (c.conclusion ?? c.status) : "not reported" };
        if (!pending.some((x) => JSON.stringify(x) === JSON.stringify(s))) pending.push(s);
      }
    };
    await until("it merges by itself", () => (sample(), pr(id).phase !== "open"), CHECK_WAIT() + 600);
    fact("(c) what GitHub reported for the pull request over time (bypass account)", pending);
    const before = pending.filter((x) => x.check !== "SUCCESS");
    const landed = task(id).integration?.landed;
    // The run saw the check unfinished first, and the merged head carries the passed check.
    check("(c) the app merged only after the required check passed on that head", pr(id).phase === "merged" && before.length > 0 && landed?.checks?.some((c) => c.name === "check" && c.conclusion === "SUCCESS") === true, { samplesBeforeSuccess: before });
    check("(c) merged by the app, automatically, with a clean independent review for that change", landed?.by === "app" && !!landed.review?.ok && landed.review.forSha === pr(id).changeSha, landed?.review);
    check("(c) the writer and the reviewer are different providers", !!landed?.review?.provider && landed.review.provider !== pr(id).changeAuthor, { writer: pr(id).changeAuthor, reviewer: landed?.review?.provider });
    check("(c) the merged head is the head the checks passed on", !!landed && git("rev-parse", "--verify", "--quiet", `${head}^{commit}`) === head && landed.checks?.every((c) => c.conclusion === "SUCCESS") === true, landed?.checks);
    await until("the check on main after the merge is recorded", () => task(id).integration!.landed!.mainCheck?.state !== "pending", CHECK_WAIT());
    fact("(c) the check on main after the merge", task(id).integration!.landed!.mainCheck);
    cmd("setPrDelivery", { config: { merge: "hold" } });
  });

  await scenario("d", "the ruleset's extra approval for unattributed changes", async () => {
    if (opts.fake || !rulesetId) {
      evidence.skipped.d = "needs a real repository and its ruleset";
      return;
    }
    const on = rawGh(["api", "-X", "PUT", `repos/${opts.repo}/rulesets/${rulesetId}`, "--input", "-"], JSON.stringify(rulesetBody(true)));
    if (!on.ok) {
      evidence.skipped.d = `GitHub did not accept the option on a ruleset: ${on.stderr.trim().split("\n").pop()}`;
      log(`skipped (d): ${evidence.skipped.d}`);
      return;
    }
    try {
      const id = await openPullRequest("With the unattributed-changes rule");
      await until("the required check passed or the app reports why it cannot merge", () => !!pr(id).attention || D.prReady(st(), task(id), nowMs()), CHECK_WAIT());
      const o = pr(id).observed;
      fact("(d) with the rule on, a pull request of commits authored by Orchestration", { mergeStateStatus: o?.mergeStateStatus, reviewDecision: o?.reviewDecision, attention: pr(id).attention?.code, ready: D.prReady(st(), task(id), nowMs()) });
      check("(d) the app either may merge, or holds with the reason and never bypasses", D.prReady(st(), task(id), nowMs()) || pr(id).attention?.code === "approval-required" || pr(id).attention?.code === "github-blocked", pr(id).attention);
      cmd("closePr", { taskId: id });
      await until("it is closed", () => pr(id).phase === "closed", 300);
    } finally {
      const off = rawGh(["api", "-X", "PUT", `repos/${opts.repo}/rulesets/${rulesetId}`, "--input", "-"], JSON.stringify(rulesetBody(false)));
      check("(d) the ruleset was put back", off.ok);
    }
  });

  await scenario("g", "a restart while a merge is in flight", async () => {
    const id = await openPullRequest("Restart during the merge");
    await until("it is ready", () => D.prReady(st(), task(id), nowMs()), CHECK_WAIT());
    const mainBefore = remoteHead("main");
    cmd("requestPrMerge", { taskId: id, headSha: pr(id).headSha });
    // Tick without waiting until the merge intent is recorded, then stop the service at once.
    for (let i = 0; i < 120 && pr(id).op?.kind !== "merge" && pr(id).phase === "open"; i++) await step(false);
    const intent = pr(id).op;
    await scheduler.stop();
    fact("(g) when the service stopped", { intent, phase: pr(id).phase });
    scheduler = newScheduler();
    await scheduler.refreshHealth();
    // The new service reconciles with GitHub before doing anything again (after the grace time).
    await until("the merge is recorded, or made once", () => pr(id).phase !== "open", (D.OP_TIMEOUT_MS.merge + D.PR_LIMITS.graceMs) / 1000 + 900);
    git("fetch", "-q", "origin", "main");
    const mergesOfThisPr = git("log", "--merges", "--format=%H %P", `${mainBefore}..FETCH_HEAD`).split("\n").filter((l) => l.includes(pr(id).headSha));
    check("(g) exactly one merge of that pull request is on main", pr(id).phase === "merged" && mergesOfThisPr.length === 1, { merges: mergesOfThisPr.length, by: task(id).integration?.landed?.by });
    check("(g) it is attributed to the app", task(id).integration?.landed?.by === "app");
  });

  await scenario("h", "mixed providers: Codex writes and Claude reviews, then the reverse", async () => {
    cmd("setPrDelivery", { config: { merge: "auto" } });
    for (const [writer, reviewer] of [["codex", "claude"], ["claude", "codex"]] as [ProviderId, ProviderId][]) {
      cmd("setRoleDefault", { role: "coder", selection: { provider: writer, model: "auto" } });
      cmd("setRoleDefault", { role: "code_reviewer", selection: { provider: reviewer, model: "auto" } });
      const id = await openPullRequest(`${M.providerLabel(writer)} writes, ${M.providerLabel(reviewer)} reviews`);
      await until("it merges by itself", () => pr(id).phase !== "open", CHECK_WAIT() + 600);
      const review = task(id).integration?.landed?.review;
      check(`(h) ${writer} wrote, ${reviewer} reviewed, merged with no person`, pr(id).phase === "merged" && pr(id).changeAuthor === writer && review?.provider === reviewer && task(id).integration?.landed?.by === "app", { writer: pr(id).changeAuthor, reviewer: review?.provider, source: review?.source });
    }
    if (!opts.realAgents) evidence.skipped["h (real agents)"] = "scripted agents stood in for Claude and Codex; pass --real-agents to use the real ones (this costs usage)";
    cmd("setPrDelivery", { config: { merge: "hold" } });
  });
}

// ---------- run ----------

async function main() {
  log(opts.fake ? "FAKE run: a local bare repository and the in-process fake GitHub. Nothing is contacted." : `REAL run against ${opts.repo}. Evidence: ${out}`);
  if (opts.fake) setupFake();
  else setupReal();
  store = new Store(join(work, "orchestration.db"));
  workspaces = new WorkspaceManager(join(work, "worktrees"));
  host = fake ?? new RecordedGh({ cwd: join(work, "gh-neutral") });
  if (opts.realAgents) {
    const [{ ClaudeAdapter }, { CodexAdapter }] = await Promise.all([import("../runtimes/claude"), import("../runtimes/codex")]);
    adapters = { claude: new ClaudeAdapter({ log: (m) => record("claude", [], m) }), codex: new CodexAdapter({ log: (m) => record("codex", [], m) }) };
  } else adapters = { claude: new ScriptedAdapter("claude"), codex: new ScriptedAdapter("codex") };
  scheduler = newScheduler();
  await scheduler.refreshHealth();
  cmd("initProject", { name: "PR sandbox", repoPath, vision: "Evidence for pull-request delivery.", focus: "Small files only." });
  cmd("setRoleDefault", { role: "coder", selection: { provider: "codex", model: "auto" } });
  cmd("setRoleDefault", { role: "code_reviewer", selection: { provider: "claude", model: "auto" } });
  cmd("setLeadSelection", { selection: { provider: "claude", model: "auto" } });
  try {
    await scenarios();
  } finally {
    await scheduler.stop().catch(() => undefined);
    if (!opts.fake) teardownReal();
    store.close();
  }
  const results = Object.values(evidence.checks);
  evidence.ok = results.length > 0 && results.every((c) => c.ok);
  evidence.finishedAt = new Date().toISOString();
  save();
  log(`${evidence.ok ? "PASSED" : "FAILED"}: ${results.filter((c) => c.ok).length} of ${results.length} checks. Evidence: ${join(out, "evidence.json")}`);
  if (!opts.fake) {
    log("Left in the repository on purpose (the app never deletes a branch): the orchestration/*/pr/* branches, the pull requests (merged or closed), and the workflow file.");
    if (opts.keep) log(`The ruleset "${RULESET}" was kept (--keep).`);
  }
  process.exit(evidence.ok ? 0 : 1);
}

main().catch((e) => {
  check("the run itself", false, e instanceof Error ? e.message : String(e));
  save();
  try {
    if (!opts.fake) teardownReal();
  } catch {
    /* recorded above */
  }
  process.exit(1);
});
