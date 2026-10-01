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
// The real mode stops at once, before anything is written, when the repository cannot take the
// sandbox ruleset (for example a private repository on a plan without rulesets). Any failed setup
// command is fatal. A scenario whose prerequisite failed is skipped, not waited on. It is safe to run
// again on a repository that an earlier run used: the project id, the branches and the files are new.
//
// NOT VERIFIED: the real mode of this file has never passed against GitHub.

import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as D from "../../src/domain/delivery";
import * as M from "../../src/domain/model";
import { isProvider, type PrDelivery, type ProviderId, type State, type Task } from "../../src/domain/types";
import { GhCliHost, GhError, type GitHubHost, type RepoRef } from "../github";
import { redact } from "../redact";
import type { RuntimeAdapter } from "../runtimes/types";
import { Scheduler } from "../scheduler";
import { Store } from "../store";
import { WorkspaceManager, networkEnv } from "../workspaces";
import { FakeGitHub } from "./fakeGitHub";
import { ScriptedAdapter } from "./scripted";

/** Repositories this run never touches, whatever is asked: the project's own, under its current and its former name. */
const NEVER = ["erickb336/orchestrator", "erickb336/orchestration"];
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
const slugOf = (url: string) => ((/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url.trim()) ?? [])[1] ?? "").toLowerCase();
/** The repository this checkout's `origin` points at ("" when there is none). Never used for the run. */
function ownOrigin(): string {
  const r = spawnSync("git", ["-C", resolve(import.meta.dirname, "..", ".."), "remote", "get-url", "origin"], { encoding: "utf8" });
  return r.status === 0 ? slugOf(String(r.stdout)) : "";
}

// ---------- refusals (repeated here: this file must be safe even when started by hand) ----------

if (!opts.fake) {
  if (!opts.repo) fail("No repository given. Pass --repo <owner>/<name> of a throwaway repository. There is no default.");
  if (!REPO.test(opts.repo)) fail(`"${opts.repo}" is not an <owner>/<name> repository.`);
  if (NEVER.includes(opts.repo.toLowerCase())) fail(`${opts.repo} is never used for this run. Use a repository made for it.`);
  if (ownOrigin() === opts.repo.toLowerCase()) fail(`${opts.repo} is the repository this checkout belongs to. Use a throwaway repository.`);
  if (!process.argv.includes("--yes")) fail("Not confirmed. Pass --yes to let this run write to the repository.");
  if (process.env.ORC_SANDBOX_CONFIRMED !== opts.repo) fail("Start this run through scripts/pr-sandbox-check.mjs, which confirms the repository.");
}

// ---------- evidence ----------

const started = new Date();
const stamp = started.toISOString().replace(/[:.]/g, "-");
/** Names this run's files apart from an earlier run's in the same repository. */
const runTag = started.getTime().toString(36);
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

/** A failed setup command. Always fatal: the run stops with this message and no scenario is started. */
class SetupError extends Error {}
const lastLine = (text: string) => redact(text).trim().split("\n").filter(Boolean).pop() ?? "";

/** The run's own gh calls (setup and teardown of the sandbox). The application never makes these. */
function rawGh(args: string[], stdin?: string): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync("gh", args, { encoding: "utf8", env: networkEnv(), input: stdin ?? "", cwd: join(work, "gh-setup") });
  record("gh (sandbox setup)", args, `${r.stdout ?? ""}${r.stderr ?? ""}`);
  return { ok: r.status === 0, stdout: String(r.stdout ?? ""), stderr: redact(String(r.stderr ?? "")) };
}

const workflow = (seconds: number) => `# Created by Orchestrator's scripts/pr-sandbox-check.mjs. One slow required check named "check".
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

const rulesetBody = (unattributed: boolean, enforcement: "active" | "disabled" = "active") => ({
  name: RULESET,
  target: "branch",
  enforcement,
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

/** A read of the GitHub API by the run itself that must succeed and return JSON. Anything else is fatal. */
function ghJson<T>(args: string[], what: string, stdin?: string): T {
  const r = rawGh(args, stdin);
  if (!r.ok) throw new SetupError(`${what} failed: ${lastLine(r.stderr) || lastLine(r.stdout) || "gh returned an error"}`);
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    throw new SetupError(`${what} failed: GitHub's answer was not JSON`);
  }
}

interface Ruleset {
  id: number;
  name: string;
  enforcement: string;
  conditions?: { ref_name?: { include?: string[] } };
  rules?: { type: string; parameters?: { required_status_checks?: { context: string }[]; required_approving_review_count?: number } }[];
}

/** Read the sandbox ruleset back and check it is what this run needs. Throws a SetupError otherwise. */
function verifyRuleset(id: string, enforcement?: "active" | "disabled"): Ruleset {
  const r = ghJson<Ruleset>(["api", `repos/${opts.repo}/rulesets/${id}`], "Reading the sandbox ruleset back");
  const problems: string[] = [];
  if (String(r.id) !== id || r.name !== RULESET) problems.push("it is not the sandbox ruleset");
  if (enforcement ? r.enforcement !== enforcement : r.enforcement !== "active" && r.enforcement !== "disabled") problems.push(`its enforcement is "${r.enforcement}"${enforcement ? `, not "${enforcement}"` : ""}`);
  if (!r.conditions?.ref_name?.include?.some((x) => x === "refs/heads/main" || x === "~DEFAULT_BRANCH")) problems.push("it does not apply to main");
  if (!r.rules?.some((x) => x.type === "required_status_checks" && x.parameters?.required_status_checks?.some((c) => c.context === "check"))) problems.push('it does not require the status check "check"');
  if (!r.rules?.some((x) => x.type === "pull_request" && (x.parameters?.required_approving_review_count ?? 0) === 0)) problems.push("it does not require a pull request with 0 approvals");
  if (problems.length) throw new SetupError(`The sandbox ruleset (id ${id}) was read back and is not as needed: ${problems.join("; ")}.`);
  return r;
}

/** Replace the sandbox ruleset's content, read it back and verify it. */
function putRuleset(enforcement: "active" | "disabled", unattributed = false) {
  if (!rulesetId) throw new SetupError("There is no sandbox ruleset to change.");
  ghJson<Ruleset>(["api", "-X", "PUT", `repos/${opts.repo}/rulesets/${rulesetId}`, "--input", "-"], `Setting the sandbox ruleset to "${enforcement}"`, JSON.stringify(rulesetBody(unattributed, enforcement)));
  verifyRuleset(rulesetId, enforcement);
}

/**
 * Preconditions, checked before anything is pushed: the repository is a throwaway one this account
 * administers, it is not the project's own (by its canonical name, so a renamed repository that
 * redirects is caught), and the sandbox ruleset can be created, read back and verified. It is created
 * switched off, so the workflow can still be pushed to main; setupReal switches it on afterwards.
 */
function preconditions() {
  mkdirSync(join(work, "gh-setup"), { recursive: true });
  const facts = ghJson<{ full_name: string; private: boolean; archived: boolean; fork: boolean; default_branch: string; admin: boolean; push: boolean; stars: number }>(
    ["api", `repos/${opts.repo}`, "--jq", "{full_name:.full_name,private:.private,archived:.archived,fork:.fork,default_branch:.default_branch,admin:.permissions.admin,push:.permissions.push,stars:.stargazers_count}"],
    `Reading the repository ${opts.repo} with your gh sign-in`,
  );
  fact("repository", facts);
  // The name GitHub knows the repository by. A former name redirects, so the name given proves nothing.
  const canonical = String(facts.full_name ?? "").toLowerCase();
  if (!REPO.test(canonical)) throw new SetupError(`GitHub did not report the canonical name of ${opts.repo}. Nothing was changed.`);
  const own = ownOrigin();
  // The origin may itself be a former name: ask GitHub what it is called now (read-only; best effort).
  const ownNow = own ? rawGh(["api", `repos/${own}`, "--jq", ".full_name"]) : undefined;
  const ownCanonical = ownNow?.ok ? ownNow.stdout.trim().toLowerCase() : "";
  if (NEVER.includes(canonical) || (own && canonical === own) || (ownCanonical && canonical === ownCanonical))
    throw new SetupError(`${opts.repo} is ${facts.full_name}, the project's own repository${canonical !== opts.repo.toLowerCase() ? " under a former name" : ""}. It is never used for this run. Nothing was changed.`);
  if (canonical !== opts.repo.toLowerCase()) throw new SetupError(`${opts.repo} is now named ${facts.full_name}. Pass the repository by its current name. Nothing was changed.`);
  if (facts.archived || !facts.push || !facts.admin) throw new SetupError(`${opts.repo} must be a repository you administer (needed to create and remove the sandbox ruleset), and not archived. Nothing was changed.`);
  if (facts.stars > 0 || facts.fork) throw new SetupError(`${opts.repo} has stars or is a fork: it does not look like a throwaway repository. Nothing was changed.`);
  if ((facts.default_branch ?? "main") !== "main") throw new SetupError(`${opts.repo}'s default branch is ${facts.default_branch}; this run needs it to be main. Nothing was changed.`);
  if (!facts.private) log("NOTE: the repository is public. Pull request titles, descriptions and comments made by this run are public.");

  // Rulesets: list (read-only), then create, read back and verify. Without a required check nothing
  // in this run can pass, so any failure here ends the run before a single commit is pushed.
  const noRulesets = (r: { stdout: string; stderr: string }) =>
    /upgrade to github|make this repository public/i.test(`${r.stdout} ${r.stderr}`) || (facts.private && /HTTP 403/.test(r.stderr))
      ? `this repository is private on a plan without rulesets; make it public or use a plan that supports them. Nothing was changed. (GitHub said: ${lastLine(r.stderr) || lastLine(r.stdout)})`
      : undefined;
  const list = rawGh(["api", `repos/${opts.repo}/rulesets`]);
  if (!list.ok) throw new SetupError(noRulesets(list) ?? `The rulesets of ${opts.repo} could not be read: ${lastLine(list.stderr) || lastLine(list.stdout)}. Nothing was changed.`);
  let all: { id: number; name: string }[];
  try {
    all = JSON.parse(list.stdout) as { id: number; name: string }[];
    if (!Array.isArray(all)) throw new Error("not a list");
  } catch {
    throw new SetupError(`The rulesets of ${opts.repo} could not be read: GitHub's answer was not a list. Nothing was changed.`);
  }
  const existing = all.find((x) => x.name === RULESET);
  if (existing) {
    // Left by an earlier run (--keep, or a run that was interrupted): it is used again.
    if (!/^\d+$/.test(String(existing.id))) throw new SetupError("The existing sandbox ruleset has no usable id. Nothing was changed.");
    rulesetId = String(existing.id);
    fact("ruleset", { id: rulesetId, name: RULESET, reused: true });
    // Put into the state this run starts from, which also proves it can be changed, read back and verified.
    putRuleset("disabled");
    return;
  }
  const made = rawGh(["api", "-X", "POST", `repos/${opts.repo}/rulesets`, "--input", "-"], JSON.stringify(rulesetBody(false, "disabled")));
  if (!made.ok) throw new SetupError(noRulesets(made) ?? `The sandbox ruleset could not be created: ${lastLine(made.stderr) || lastLine(made.stdout)}. Nothing else was changed.`);
  let id = "";
  try {
    id = String((JSON.parse(made.stdout) as { id?: number }).id ?? "");
  } catch {
    id = "";
  }
  if (!/^\d+$/.test(id)) throw new SetupError("The sandbox ruleset could not be created: GitHub's answer carried no ruleset id. Look at the repository's rulesets before running this again.");
  rulesetId = id;
  evidence.created.push(`ruleset "${RULESET}" (id ${rulesetId}) on main`);
  fact("ruleset", { id: rulesetId, name: RULESET, reused: false });
  verifyRuleset(rulesetId, "disabled");
}

function setupReal() {
  preconditions();

  const clone = spawnSync("git", ["clone", "-q", `https://github.com/${opts.repo}.git`, repoPath], { encoding: "utf8", env: networkEnv() });
  record("git", ["clone", `https://github.com/${opts.repo}.git`], `${clone.stdout ?? ""}${clone.stderr ?? ""}`);
  if (clone.status !== 0) throw new SetupError(`git could not clone ${opts.repo}: ${lastLine(String(clone.stderr))}`);
  const hasMain = spawnSync("git", ["-C", repoPath, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"]).status === 0;
  if (hasMain) git("checkout", "-q", "-B", "main", "origin/main");
  else git("checkout", "-q", "-b", "main");
  // The one required check, slow on purpose. A workflow an earlier run left is used as it is.
  const present = hasMain && existsSync(join(repoPath, WORKFLOW)) ? readFileSync(join(repoPath, WORKFLOW), "utf8") : "";
  const sleeps = /^\s*- run: sleep (\d+)\s*$/m.exec(present);
  if (sleeps && /^\s{2}check:\s*$/m.test(present)) {
    const seconds = Number(sleeps[1]);
    if (seconds !== opts.checkSeconds) log(`NOTE: the workflow already in the repository sleeps ${seconds} s (not ${opts.checkSeconds}); it is used as it is, and the waits follow it.`);
    opts.checkSeconds = Math.max(1, Math.min(600, seconds));
    fact("workflow", { file: WORKFLOW, reused: true, checkSeconds: opts.checkSeconds });
  } else {
    // Pushed directly to main while the ruleset is switched off.
    commitFile(WORKFLOW, workflow(opts.checkSeconds), "Orchestrator sandbox: add the slow required check");
    git("push", "-q", "origin", "main");
    evidence.created.push(`commit on main adding ${WORKFLOW}`);
    fact("workflow", { file: WORKFLOW, reused: false, checkSeconds: opts.checkSeconds });
  }
  // Switched on, read back and verified: from here on main takes changes only through pull requests with the check passed.
  putRuleset("active");
  log(`The sandbox ruleset (id ${rulesetId}) is active and verified: a pull request and the status check "check" are required on main.`);
}

function teardownReal() {
  if (opts.keep || !rulesetId) return;
  const gone = rawGh(["api", "-X", "DELETE", `repos/${opts.repo}/rulesets/${rulesetId}`]);
  check("teardown: the sandbox ruleset was removed", gone.ok, gone.ok ? undefined : lastLine(gone.stderr));
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
    if (a.outcome !== "running" || !isProvider(a.snapshot.provider)) continue;
    const ad = adapters[a.snapshot.provider] as ScriptedAdapter;
    if (!ad.runs.has(a.id)) continue;
    const t = task(a.taskId);
    const role = t.steps.find((x) => x.id === a.stepId)?.role;
    if (role === "coder" && !t.revertOf) ad.finish(a.id, { write: [`orc-sandbox-${runTag}-${a.taskId}.txt`, `${a.taskId} by ${a.snapshot.provider} (run ${runTag})\n`] });
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

/**
 * How long each wait may take, in seconds of the run's clock. Sized to what is waited for, so that a
 * run that cannot work ends in minutes: the service reads GitHub every 30 s while something is urgent
 * and every 2 min otherwise, and a hosted check needs a runner before it starts to sleep.
 */
const WAIT = {
  preflight: 120,
  /** A scripted task: two or three runs that finish at once. Real agents take as long as they take. */
  taskDone: () => (opts.realAgents ? 1800 : 120),
  /** Push, open, and the first read of GitHub. */
  prOpen: 180,
  /** The required check on a new head: a runner, the sleep, and the next read. */
  check: () => opts.checkSeconds + 300,
  /** A merge, a close or a comment the service was asked for: the next read, then the command, then a read. */
  act: 150,
  /** Something a person did on GitHub, noticed at the slow cadence. */
  notice: 300,
  /** An automatic merge: the check, then perhaps one update to the base and the check again. */
  autoMerge: () => 2 * (opts.checkSeconds + 300),
};

function createTask(title: string): string {
  const id = (cmd("createTask", { title, area: "Sandbox", outcome: `${title}: a small file is added`, benefit: "Evidence", whyNow: "Evidence run", approach: "Add one small file", acceptance: ["The file exists"], priority: 1, holdBeforeStart: false, patternId: "change" }).result as { newId: string }).newId;
  log(`task ${id}: ${title}`);
  return id;
}

/** A task run to its pull request, open and seen on GitHub. */
async function openPullRequest(title: string): Promise<string> {
  const id = createTask(title);
  await until(`${id} is done`, () => task(id).lifecycle === "done", WAIT.taskDone());
  await until(`${id}'s pull request is open and seen`, () => task(id).integration?.pr?.phase === "open" && !!pr(id).observed, WAIT.prOpen);
  evidence.created.push(`branch ${pr(id).branch} and pull request #${pr(id).number}`);
  return id;
}

const remoteHead = (branch: string) => {
  const r = spawnSync("git", ["-C", repoPath, "ls-remote", "--refs", "origin", `refs/heads/${branch}`], { encoding: "utf8", env: networkEnv() });
  return String(r.stdout).split(/\s+/)[0] ?? "";
};
const selected = (name: string) => opts.only.length === 0 || opts.only.includes(name);
/**
 * Run one scenario. `needs` names what it cannot run without and returns why that is missing, if it is:
 * the scenario is then skipped at once (and counted as not passed), never started and waited on.
 * `always`: part of the setup of every other scenario, so --only does not leave it out.
 */
async function scenario(name: string, title: string, run: () => Promise<void>, o: { needs?: () => string | undefined; always?: boolean } = {}) {
  if (!selected(name) && !o.always) {
    evidence.skipped[name] = "not selected (--only)";
    return;
  }
  const missing = o.needs?.();
  if (missing) {
    evidence.skipped[name] = `prerequisite failed: ${missing}`;
    log(`SKIP (${name}) ${title}: ${missing}`);
    // Selected and impossible is a failure of the run, reported once, without waiting for anything.
    check(`(${name}) ${title}`, false, `skipped: ${missing}`);
    save();
    return;
  }
  log(`--- (${name}) ${title}`);
  try {
    await run();
  } catch (e) {
    check(`(${name}) ${title}`, false, e instanceof Error ? e.message : String(e));
    save();
    // The sandbox itself is no longer as it must be: nothing after this could be trusted.
    if (e instanceof SetupError) throw e;
  }
  save();
}

// ---------- the scenarios ----------

let landedHold: string | undefined;
let beforeHold = "";

async function scenarios() {
  await scenario("a", "the read-only repository check and what it found", async () => {
    cmd("setDeliveryMode", { mode: "pr" });
    await until("the repository is checked and the base fetched", () => !!st().project.github?.checkedAt && (!!st().project.github?.base || !!st().project.github?.problem), WAIT.preflight);
    const gh = st().project.github!;
    fact("preflight", { ok: gh.ok, repo: gh.repo, login: gh.login, ghVersion: gh.ghVersion, requiredChecks: gh.requiredChecks, autoMergeBlockers: gh.autoMergeBlockers, problem: gh.problem?.message });
    fact("posture", gh.posture.map((p) => `${p.status}: ${p.label}`));
    check("(a) the repository check passed and found the required check", gh.ok && gh.requiredChecks.includes("check"), gh.problem?.message);
    check("(a) automatic merging is available here", gh.autoMergeBlockers.length === 0, gh.autoMergeBlockers);
    if (!opts.fake) check("(a) the account's bypass of the rules is reported", gh.posture.some((p) => p.id === "bypass"));
    if (!gh.ok) throw new Error("the repository check did not pass; the remaining scenarios cannot run");
  }, { always: true });
  // What the other scenarios cannot run without. Each is skipped at once when it is missing.
  const checked = () => {
    const gh = st().project.github;
    if (!gh?.ok) return `the repository check did not pass${gh?.problem ? ` (${gh.problem.message})` : ""}`;
    if (!gh.requiredChecks.includes("check")) return 'the application found no required check named "check" on main, so no pull request could ever become ready';
    if (!gh.base) return "the base branch was not fetched";
    return undefined;
  };
  const auto = () => checked() ?? (st().project.github!.autoMergeBlockers.length ? `automatic merging is not available here: ${st().project.github!.autoMergeBlockers.join("; ")}` : undefined);
  const landed = () => checked() ?? (landedHold ? undefined : "scenario (b) did not land a pull request");

  await scenario("b", "hold and notify, end to end", async () => {
    beforeHold = remoteHead("main");
    const id = await openPullRequest("Hold and notify");
    const head = pr(id).headSha;
    check("(b) the branch on the remote holds exactly the task's final commit", remoteHead(pr(id).branch) === head, { branch: pr(id).branch, head });
    check("(b) nothing merges by itself in hold mode", pr(id).policy === "hold" && pr(id).phase === "open");
    await until("the pull request is ready for the user", () => D.prReady(st(), task(id), nowMs()), WAIT.check());
    await until("the ready notice was written", () => st().events.some((e) => e.taskId === id && e.message.includes("is ready for you")), 60);
    check("(b) the user is told once that it is ready", st().events.filter((e) => e.taskId === id && e.message.includes("is ready for you")).length === 1);
    fact("(b) independent review", pr(id).review);
    cmd("requestPrMerge", { taskId: id, headSha: head });
    await until("it merges", () => pr(id).phase !== "open", WAIT.act);
    const landed = task(id).integration?.landed;
    check("(b) merged by the app at the user's request, recorded from what GitHub reported", pr(id).phase === "merged" && landed?.by === "app", { phase: pr(id).phase, by: landed?.by, commit: landed?.commit });
    check("(b) GitHub's merge commit is the tip of main", !!landed && remoteHead("main") === landed.commit);
    landedHold = pr(id).phase === "merged" ? id : undefined;
  }, { needs: checked });

  await scenario("e", "a note posted as a comment on the merged pull request, and found again by its marker", async () => {
    const id = landedHold!;
    const number = task(id).integration!.landed!.pr!.number;
    cmd("addLandedNote", { taskId: id, text: "Evidence run: a note posted from the Review list.", postToGitHub: true });
    const first = () => task(id).integration!.landed!.notes[0];
    await until("the note is posted", () => first().comment?.status !== "pending", WAIT.act);
    check("(e) the note is posted only with its address", first().comment?.status === "posted" && !!first().comment?.url, first().comment);
    // An earlier, interrupted attempt already posted the comment: the app must find it, not post again.
    cmd("pauseProject");
    cmd("addLandedNote", { taskId: id, text: "Evidence run: this one was already posted by an interrupted attempt.", postToGitHub: true });
    const second = task(id).integration!.landed!.notes[1];
    const marker = D.noteMarker(st().project.id, second.id);
    await host.comment({ repo: repoRef(), number, body: `${second.text}\n\n${marker}` });
    cmd("resumeProject");
    await until("the second note is reconciled", () => task(id).integration!.landed!.notes[1].comment?.status !== "pending", WAIT.act);
    const found = await host.findComment({ repo: repoRef(), number, marker });
    check("(e) the comment that already existed is adopted by its marker", task(id).integration!.landed!.notes[1].comment?.url === found?.url, task(id).integration!.landed!.notes[1].comment);
    if (fake) check("(e) exactly one comment carries the marker", fake.pr(number).comments.filter((c) => c.body.includes(marker)).length === 1);
  }, { needs: landed });

  await scenario("f", "a revert delivered as a pull request", async () => {
    const r = cmd("sendBackLanded", { taskId: landedHold!, kind: "revert", note: "Evidence run: undo it again.", holdBeforeStart: false }).result as { newId: string };
    await until(`${r.newId} is done`, () => task(r.newId).lifecycle === "done", WAIT.taskDone() + 120);
    await until("the revert's pull request is open", () => task(r.newId).integration?.pr?.phase === "open" && !!pr(r.newId).observed, WAIT.prOpen);
    evidence.created.push(`branch ${pr(r.newId).branch} and pull request #${pr(r.newId).number}`);
    await until("it is ready", () => D.prReady(st(), task(r.newId), nowMs()), WAIT.check());
    cmd("requestPrMerge", { taskId: r.newId, headSha: pr(r.newId).headSha });
    await until("the revert merges", () => pr(r.newId).phase !== "open", WAIT.act);
    check("(f) the revert merged", pr(r.newId).phase === "merged");
    git("fetch", "-q", "origin", "main");
    const tree = (rev: string) => git("rev-parse", `${rev}^{tree}`);
    check("(f) main holds the files it held before the reverted change", tree("FETCH_HEAD") === tree(beforeHold), { before: beforeHold.slice(0, 12), now: remoteHead("main").slice(0, 12) });
  }, { needs: landed });

  await scenario("c", "automatic merge with a slow check, and a push by someone else", async () => {
    // First, a push by someone else to a pull request branch: the merge command is bound to the head it
    // was given, and the app never touches that pull request again.
    const held = await openPullRequest("Pushed to by someone else");
    const old = pr(held).headSha;
    git("fetch", "-q", "origin", pr(held).branch);
    git("checkout", "-q", "--detach", "FETCH_HEAD");
    commitFile(`orc-sandbox-${runTag}-foreign-${held}.txt`, "pushed by a person\n", "A person's commit on the pull request branch");
    git("push", "-q", "origin", `HEAD:refs/heads/${pr(held).branch}`);
    git("checkout", "-q", "main");
    let refusal = "the merge was NOT refused";
    try {
      await host.merge({ repo: repoRef(), number: pr(held).number!, headSha: old, subject: "must not merge", body: "evidence run: a merge bound to a head that is no longer the head" });
    } catch (e) {
      refusal = e instanceof GhError ? `${e.code}: ${e.message}` : String(e);
    }
    check("(c) a merge bound to the old head is refused by --match-head-commit", refusal !== "the merge was NOT refused", refusal);
    await until("the app sees the foreign push", () => !!pr(held).foreignHead, WAIT.notice);
    check("(c) the app holds that pull request for good", pr(held).attention?.code === "foreign-push" && pr(held).phase === "open");
    cmd("closePr", { taskId: held });
    await until("it is closed", () => pr(held).phase === "closed", WAIT.act);

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
    await until("it merges by itself", () => (sample(), pr(id).phase !== "open"), WAIT.autoMerge());
    fact("(c) what GitHub reported for the pull request over time (bypass account)", pending);
    const before = pending.filter((x) => x.check !== "SUCCESS");
    const landed = task(id).integration?.landed;
    // The run saw the check unfinished first, and the merged head carries the passed check.
    check("(c) the app merged only after the required check passed on that head", pr(id).phase === "merged" && before.length > 0 && landed?.checks?.some((c) => c.name === "check" && c.conclusion === "SUCCESS") === true, { samplesBeforeSuccess: before });
    check("(c) merged by the app, automatically, with a clean independent review for that change", landed?.by === "app" && !!landed.review?.ok && landed.review.forSha === pr(id).changeSha, landed?.review);
    check("(c) the writer and the reviewer are different providers", !!landed?.review?.provider && landed.review.provider !== pr(id).changeAuthor, { writer: pr(id).changeAuthor, reviewer: landed?.review?.provider });
    check("(c) the merged head is the head the checks passed on", !!landed && git("rev-parse", "--verify", "--quiet", `${head}^{commit}`) === head && landed.checks?.every((c) => c.conclusion === "SUCCESS") === true, landed?.checks);
    await until("the check on main after the merge is recorded", () => task(id).integration!.landed!.mainCheck?.state !== "pending", WAIT.check());
    fact("(c) the check on main after the merge", task(id).integration!.landed!.mainCheck);
  }, { needs: auto });
  // Whatever happened in (c), the scenarios after it start from hold mode.
  if (st().project.prDelivery.merge !== "hold") cmd("setPrDelivery", { config: { merge: "hold" } });

  await scenario("d", "the ruleset's extra approval for unattributed changes", async () => {
    if (opts.fake || !rulesetId) {
      evidence.skipped.d = "needs a real repository and its ruleset";
      return;
    }
    if (!/^\d+$/.test(rulesetId)) throw new Error("the sandbox ruleset has no usable id");
    const on = rawGh(["api", "-X", "PUT", `repos/${opts.repo}/rulesets/${rulesetId}`, "--input", "-"], JSON.stringify(rulesetBody(true)));
    if (!on.ok) {
      evidence.skipped.d = `GitHub did not accept the option on a ruleset: ${lastLine(on.stderr)}`;
      log(`skipped (d): ${evidence.skipped.d}`);
      return;
    }
    try {
      const id = await openPullRequest("With the unattributed-changes rule");
      await until("the required check passed or the app reports why it cannot merge", () => !!pr(id).attention || D.prReady(st(), task(id), nowMs()), WAIT.check());
      const o = pr(id).observed;
      fact("(d) with the rule on, a pull request of commits authored by Orchestrator", { mergeStateStatus: o?.mergeStateStatus, reviewDecision: o?.reviewDecision, attention: pr(id).attention?.code, ready: D.prReady(st(), task(id), nowMs()) });
      check("(d) the app either may merge, or holds with the reason and never bypasses", D.prReady(st(), task(id), nowMs()) || pr(id).attention?.code === "approval-required" || pr(id).attention?.code === "github-blocked", pr(id).attention);
      cmd("closePr", { taskId: id });
      await until("it is closed", () => pr(id).phase === "closed", WAIT.act);
    } finally {
      let back = "";
      try {
        putRuleset("active", false);
      } catch (e) {
        back = e instanceof Error ? e.message : String(e);
      }
      check("(d) the ruleset was put back, read back and verified", !back, back || undefined);
      // Without the ruleset as it was, nothing after this can be trusted: the run stops here.
      if (back) throw new SetupError(back);
    }
  }, { needs: checked });

  await scenario("g", "a restart while a merge is in flight", async () => {
    const id = await openPullRequest("Restart during the merge");
    await until("it is ready", () => D.prReady(st(), task(id), nowMs()), WAIT.check());
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
    await until("the merge is recorded, or made once", () => pr(id).phase !== "open", (D.OP_TIMEOUT_MS.merge + D.PR_LIMITS.graceMs) / 1000 + 2 * WAIT.act);
    git("fetch", "-q", "origin", "main");
    const mergesOfThisPr = git("log", "--merges", "--format=%H %P", `${mainBefore}..FETCH_HEAD`).split("\n").filter((l) => l.includes(pr(id).headSha));
    check("(g) exactly one merge of that pull request is on main", pr(id).phase === "merged" && mergesOfThisPr.length === 1, { merges: mergesOfThisPr.length, by: task(id).integration?.landed?.by });
    check("(g) it is attributed to the app", task(id).integration?.landed?.by === "app");
  }, { needs: checked });

  await scenario("h", "mixed providers: Codex writes and Claude reviews, then the reverse", async () => {
    cmd("setPrDelivery", { config: { merge: "auto" } });
    for (const [writer, reviewer] of [["codex", "claude"], ["claude", "codex"]] as [ProviderId, ProviderId][]) {
      cmd("setRoleDefault", { role: "coder", selection: { provider: writer, model: "auto" } });
      cmd("setRoleDefault", { role: "code_reviewer", selection: { provider: reviewer, model: "auto" } });
      const id = await openPullRequest(`${M.providerLabel(writer)} writes, ${M.providerLabel(reviewer)} reviews`);
      await until("it merges by itself", () => pr(id).phase !== "open", WAIT.autoMerge());
      const review = task(id).integration?.landed?.review;
      check(`(h) ${writer} wrote, ${reviewer} reviewed, merged with no person`, pr(id).phase === "merged" && pr(id).changeAuthor === writer && review?.provider === reviewer && task(id).integration?.landed?.by === "app", { writer: pr(id).changeAuthor, reviewer: review?.provider, source: review?.source });
    }
    if (!opts.realAgents) evidence.skipped["h (real agents)"] = "scripted agents stood in for Claude and Codex; pass --real-agents to use the real ones (this costs usage)";
    cmd("setPrDelivery", { config: { merge: "hold" } });
  }, { needs: auto });
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
  // A new store for every run, so the project id, and with it every branch name, is new.
  cmd("initProject", { name: `PR sandbox ${runTag}`, repoPath, vision: "Evidence for pull-request delivery.", focus: "Small files only." });
  cmd("setRoleDefault", { role: "coder", selection: { provider: "codex", model: "auto" } });
  cmd("setRoleDefault", { role: "code_reviewer", selection: { provider: "claude", model: "auto" } });
  cmd("setLeadSelection", { selection: { provider: "claude", model: "auto" } });
  fact("project", { id: st().project.id, branches: `orchestration/${st().project.id}/pr/<task>-<n>`, files: `orc-sandbox-${runTag}-<task>.txt` });
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
  const message = e instanceof Error ? e.message : String(e);
  check("the run itself", false, message);
  console.error(`[pr-sandbox] Stopped: ${message}`);
  evidence.finishedAt = new Date().toISOString();
  save();
  try {
    if (!opts.fake) teardownReal();
  } catch {
    /* recorded above */
  }
  process.exit(1);
});
