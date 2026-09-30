// The GitHub side of pull-request delivery (ORC-008): one interface, and its implementation on the
// user's own `gh` CLI. Only the service calls this; workers never do.
//
// Safety rules enforced here, before anything is spawned:
//   - no bypass and no force: never --admin, --auto, -d, --delete-branch or --force; no call to a merge
//     endpoint and no merge or auto-merge mutation. The only merge is
//     `gh pr merge <n> -R <o/r> --merge --match-head-commit <sha>`. A POST goes only to an issue's
//     comments or to a GitHub Actions job's re-run endpoint (ORC-013);
//   - credentials: the app uses the user's own gh sign-in. It never reads, stores, prints or sets a
//     token, never runs `gh auth token`, and never passes --show-token;
//   - every call runs from an empty neutral directory with an explicit repository, takes bodies on
//     stdin, and has its error output redacted and cut before it is kept.
//
// Checked against GitHub with gh 2.101.0 by scripts/pr-sandbox-check.mjs (2026-09-30, see
// docs/tasks/ORC-008.md); tests use a fake `gh`.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import type { Observations, OpErrorCode, PrObservation, PreflightReport } from "../src/domain/delivery";
import type { CheckObs, PostureItem } from "../src/domain/types";
import { redact } from "./redact";
import { gitEnv, networkEnv } from "./workspaces";

export type { Observations, PrObservation };
export type PreflightResult = PreflightReport;

export interface RepoRef {
  owner: string;
  name: string;
}

export type GhErrorCode = Extract<OpErrorCode, "auth" | "not-found" | "head-mismatch" | "rejected" | "rate-limit" | "network" | "timeout" | "unknown">;

export class GhError extends Error {
  code: GhErrorCode;
  retryAt?: string;
  constructor(code: GhErrorCode, message: string, retryAt?: string) {
    super(message);
    this.name = "GhError";
    this.code = code;
    this.retryAt = retryAt;
  }
}

export interface GitHubHost {
  /** True when nothing real is contacted: every record made through this host is labelled simulated. */
  readonly simulated: boolean;
  /** The repository a push URL names, or undefined when it is not one this host can serve. */
  parseRemote(url: string): RepoRef | undefined;
  /** Read-only check of the tools, the sign-in and the repository's rules. */
  preflight(a: { remoteUrl: string; base: string }): Promise<PreflightResult>;
  findPr(a: { repo: RepoRef; head: string; marker: string }): Promise<{ number: number; url: string } | undefined>;
  /** `headSha` is informational (used by the simulated host); the head is whatever the branch holds. */
  createPr(a: { repo: RepoRef; base: string; head: string; title: string; body: string; headSha?: string }): Promise<{ number: number; url: string }>;
  observe(a: { repo: RepoRef; prs: number[]; commits: string[] }): Promise<Observations>;
  /** Ask GitHub to merge exactly this head. The caller observes afterwards; success here records nothing. */
  merge(a: { repo: RepoRef; number: number; headSha: string; subject: string; body: string }): Promise<void>;
  findComment(a: { repo: RepoRef; number: number; marker: string }): Promise<{ url: string } | undefined>;
  comment(a: { repo: RepoRef; number: number; body: string }): Promise<{ url: string }>;
  close(a: { repo: RepoRef; number: number; comment: string }): Promise<void>;
  /**
   * ORC-013: ask GitHub Actions to run one job again (`POST repos/<o>/<r>/actions/jobs/<id>/rerun`).
   * Only for a job seen on the app's own pull request at its current head. The caller observes
   * afterwards; success here records nothing.
   */
  rerunJob(a: { repo: RepoRef; jobId: number }): Promise<void>;
  /** Simulated hosts only (no git runs there): the pull request's branch now holds this commit. */
  pushed?(a: { repo: RepoRef; number: number; headSha: string }): void;
  abortAll(): void;
}

// ---------- pure helpers (tested directly) ----------

const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const HEX = /^[0-9a-f]{40,64}$/;

/** `github.com[:/]<owner>/<name>(.git)`: https, ssh and scp-like forms. Anything else is not GitHub. */
export function parseGitHubRemote(url: string): RepoRef | undefined {
  const m = /^(?:https:\/\/(?:[^@/\s]+@)?github\.com\/|ssh:\/\/git@github\.com(?::\d+)?\/|git@github\.com:)([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m && NAME.test(m[1]) && NAME.test(m[2]) ? { owner: m[1], name: m[2] } : undefined;
}

/** The pull request number in the URL `gh pr create` prints. */
export function parsePrUrl(text: string): { number: number; url: string } | undefined {
  const m = /https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/(\d+)/.exec(text);
  return m ? { number: Number(m[1]), url: m[0] } : undefined;
}

/** "gh version 2.101.0 (2026-09-15)" or "git version 2.55.0" → [2, 101, 0]. */
export function parseVersion(text: string): [number, number, number] | undefined {
  const m = /version (\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : undefined;
}
const atLeast = (v: [number, number, number], major: number, minor: number) => v[0] > major || (v[0] === major && v[1] >= minor);

/** Arguments the app never passes to gh. Checked before every spawn. */
const FORBIDDEN_ARGS = new Set(["--admin", "--auto", "-d", "--delete-branch", "--force", "--show-token", "--disable-auto", "--squash", "--rebase", "-s", "-r"]);

/**
 * The part of a request body that GitHub executes: the GraphQL query. A REST body (a comment's text,
 * for example) is data and is not scanned, so a note that mentions a mutation by name can be posted.
 */
function executable(args: string[], stdin: string): string {
  if (args[1] !== "graphql") return "";
  try {
    const doc = JSON.parse(stdin) as { query?: unknown };
    if (doc && typeof doc === "object" && typeof doc.query === "string") return doc.query;
  } catch {
    /* not JSON: the whole body is treated as the query */
  }
  return stdin;
}

/** The only two shapes of endpoint the app ever POSTs to (ORC-013 narrowed this from "any non-merge path"). */
const POST_ENDPOINTS = [/^repos\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/issues\/\d+\/comments$/, /^repos\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/actions\/jobs\/\d+\/rerun$/];
/** gh api flags that take a value: the value is never the endpoint. */
const API_VALUE_FLAGS = new Set(["-X", "--method", "--jq", "-q", "--input", "-f", "--raw-field", "-F", "--field", "-H", "--header", "-t", "--template", "--hostname", "--cache", "-p", "--preview"]);

/** The endpoint of a `gh api` invocation: its first argument that is not a flag or a flag's value. */
function apiEndpoint(args: string[]): string | undefined {
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith("-")) {
      if (API_VALUE_FLAGS.has(args[i])) i++;
      continue;
    }
    return args[i];
  }
  return undefined;
}

/** Throws when a gh invocation could bypass rules, force, delete a branch, merge by API, or reveal a token. */
export function assertAllowedGh(args: string[], stdin = "") {
  for (const a of args) if (FORBIDDEN_ARGS.has(a)) throw new GhError("rejected", `refusing to run gh with ${a}`);
  if (args[0] === "auth") throw new GhError("rejected", "refusing to run gh auth: the app never reads or changes the sign-in");
  if (args[0] === "api") {
    // Only the endpoint and the query are scanned, never the text of a body.
    const text = `${args.join(" ")} ${executable(args, stdin)}`;
    if (/\/pulls\/\d+\/merge\b/.test(text) || /\/merges\b/.test(text)) throw new GhError("rejected", "refusing to call a GitHub merge endpoint");
    if (/mergePullRequest|enablePullRequestAutoMerge|enqueuePullRequest|deleteRef|updateRef/.test(text)) throw new GhError("rejected", "refusing to send a merge or ref mutation");
    const x = args.indexOf("-X") >= 0 ? args[args.indexOf("-X") + 1] : args.indexOf("--method") >= 0 ? args[args.indexOf("--method") + 1] : undefined;
    if (x && x.toUpperCase() !== "POST" && x.toUpperCase() !== "GET") throw new GhError("rejected", `refusing to call the GitHub API with ${x}`);
    // A POST goes only to the two endpoints the app writes to: a pull request's comments, or a job re-run.
    if (x && x.toUpperCase() === "POST") {
      const endpoint = apiEndpoint(args) ?? "";
      if (!POST_ENDPOINTS.some((re) => re.test(endpoint))) throw new GhError("rejected", `refusing to POST to ${endpoint || "an unknown endpoint"}: the app writes only comments and job re-runs`);
    }
  }
  if (args[0] === "pr" && args[1] === "merge" && (!args.includes("--merge") || !args.includes("--match-head-commit"))) throw new GhError("rejected", "refusing to merge without --merge and --match-head-commit");
}

/** Redacted, last two lines, at most 300 characters: the only form in which child output is kept. */
export function shortError(stderr: string): string {
  const lines = redact(stderr).trim().split("\n").map((l) => l.trim()).filter(Boolean);
  // gh's own hints ("use --auto", "use --admin") name ways around the rules the app never takes: they
  // are not the problem, and are never shown as one.
  const real = lines.filter((l) => !/--auto\b|--admin\b|--disable-auto\b/.test(l));
  return (real.length ? real : lines.length ? ["GitHub refused the request."] : []).slice(-2).join(" ").slice(0, 300);
}

/** What kind of failure a gh (or git) exit was. The message is already redacted and cut. */
export function classifyGhError(exitCode: number | null, stderr: string): GhError {
  const msg = shortError(stderr) || `gh exited with status ${exitCode ?? "unknown"}`;
  const t = stderr;
  if (exitCode === 4 || /HTTP 401|bad credentials|authentication (failed|required)|gh auth login|not logged in/i.test(t)) return new GhError("auth", msg);
  if (/rate limit|HTTP 429|abuse detection|secondary rate/i.test(t)) return new GhError("rate-limit", msg);
  if (/head (branch|commit|sha)[^\n]*(modified|changed|does not match|mismatch)|match-head-commit|expected head sha/i.test(t)) return new GhError("head-mismatch", msg);
  if (/HTTP 404|not found|could not resolve to a/i.test(t)) return new GhError("not-found", msg);
  if (/could not resolve host|dial tcp|connection (refused|reset|timed out)|network is unreachable|tls handshake|timeout|EOF$/im.test(t)) return new GhError("network", msg);
  if (/not mergeable|HTTP 40[359]|HTTP 422|protected branch|rule violations|required status|review is required|merge conflict|cannot be merged|is not mergeable/i.test(t)) return new GhError("rejected", msg);
  return new GhError("unknown", msg);
}

/** One node of a commit's status check rollup, as GitHub's GraphQL API returns it. */
export interface RollupNode {
  __typename?: string;
  name?: string;
  status?: string;
  conclusion?: string | null;
  detailsUrl?: string;
  context?: string;
  state?: string;
  targetUrl?: string;
  isRequired?: boolean;
  /** CheckRun: the check run's id (a GitHub Actions job id when the app is github-actions). */
  databaseId?: number;
  startedAt?: string | null;
  checkSuite?: { app?: { slug?: string } | null; workflowRun?: { databaseId?: number } | null } | null;
  /** StatusContext: who posted it. */
  creator?: { login?: string } | null;
}

/** A whole-second UTC time, as GitHub reports `startedAt`: the only form supersession trusts. */
const WHOLE_SECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const startedMs = (c: CheckObs): number | undefined => (c.kind === "run" && c.startedAt && WHOLE_SECOND.test(c.startedAt) ? Date.parse(c.startedAt) : undefined);

/**
 * One rollup → checks, one per name. No rollup at all means nothing has reported.
 *
 * When a name reports more than once (ORC-013 §7.1), the newest run wins: the group is represented by
 * its newest dated check run when that run is a success or still going, and every other run that is
 * not a success is completed, has a whole-second `startedAt`, and started strictly before it. A
 * cancelled run therefore no longer stays red next to a later green re-run, and a re-run still going
 * keeps the name pending rather than red. In every other case the worst wins, as in ORC-008: an
 * undated or tied run keeps the name red, an older pending run keeps it pending, and a status context
 * is never grouped or superseded (GitHub reports one state per context). A passing run never hides a
 * failing one it cannot be shown to have replaced, and a newer run never hides a newer failure.
 */
export function parseChecks(rollup: { contexts?: { nodes?: RollupNode[] } } | null | undefined): CheckObs[] {
  const groups = new Map<string, CheckObs[]>();
  for (const n of rollup?.contexts?.nodes ?? []) {
    let c: CheckObs;
    if (n.__typename === "StatusContext" || n.context !== undefined) {
      const done = n.state === "SUCCESS" || n.state === "FAILURE" || n.state === "ERROR";
      const login = n.creator?.login?.replace(/\[bot\]$/, "");
      c = { name: n.context ?? "", required: !!n.isRequired, status: done ? "COMPLETED" : "PENDING", conclusion: done ? n.state! : null, ...(n.targetUrl ? { url: n.targetUrl } : {}), kind: "status", ...(login ? { app: login } : {}) };
    } else {
      const jobId = Number.isInteger(n.databaseId) && n.databaseId! > 0 ? n.databaseId : undefined;
      const runId = Number.isInteger(n.checkSuite?.workflowRun?.databaseId) && n.checkSuite!.workflowRun!.databaseId! > 0 ? n.checkSuite!.workflowRun!.databaseId : undefined;
      const app = n.checkSuite?.app?.slug;
      c = {
        name: n.name ?? "",
        required: !!n.isRequired,
        status: n.status ?? "PENDING",
        conclusion: n.conclusion ?? null,
        ...(n.detailsUrl ? { url: n.detailsUrl } : {}),
        kind: "run",
        ...(app ? { app } : {}),
        ...(jobId !== undefined ? { jobId } : {}),
        ...(runId !== undefined ? { runId } : {}),
        ...(typeof n.startedAt === "string" && n.startedAt ? { startedAt: n.startedAt } : {}),
      };
    }
    if (!c.name) continue;
    groups.set(c.name, [...(groups.get(c.name) ?? []), c]);
  }
  const rank = (c: CheckObs) => (c.conclusion === null ? 1 : c.conclusion === "SUCCESS" ? 0 : 2);
  const out: CheckObs[] = [];
  for (const [, runs] of groups) {
    const required = runs.some((c) => c.required);
    // Newest run wins: the newest dated check run, when it is a success or still going (never a
    // failure), and every other non-success is a completed, dated check run that started strictly before it.
    const newest = runs.filter((c) => startedMs(c) !== undefined).sort((a, b) => startedMs(b)! - startedMs(a)!)[0];
    const superseded =
      !!newest &&
      (newest.conclusion === "SUCCESS" || newest.conclusion === null) &&
      runs.every((c) => {
        if (c === newest || c.conclusion === "SUCCESS") return true;
        const t = startedMs(c);
        return c.kind === "run" && c.status === "COMPLETED" && t !== undefined && t < startedMs(newest)!;
      });
    if (superseded) {
      out.push({ ...newest, required });
      continue;
    }
    // Worst wins. Among equals the newer run is kept (the one a re-run would target), else the later one.
    let worst = runs[0];
    for (const c of runs.slice(1)) {
      const r = rank(c) - rank(worst);
      const a = startedMs(c);
      const b = startedMs(worst);
      if (r > 0 || (r === 0 && (a === undefined || b === undefined || a >= b))) worst = c;
    }
    out.push({ ...worst, required });
  }
  return out;
}

const contexts = (n?: number) => {
  const req = n === undefined ? "" : ` isRequired(pullRequestNumber:${n})`;
  return `statusCheckRollup{contexts(first:50){nodes{__typename ... on CheckRun{name status conclusion detailsUrl databaseId startedAt checkSuite{app{slug} workflowRun{databaseId}}${req}} ... on StatusContext{context state targetUrl creator{login}${req}}}}}`;
};

/** The one batched read: an alias per pull request and per landed commit, plus the rate limit. */
export function buildObserveQuery(repo: RepoRef, prs: number[], commits: string[]): string {
  if (!NAME.test(repo.owner) || !NAME.test(repo.name)) throw new GhError("rejected", "invalid repository name");
  const parts: string[] = [];
  for (const n of prs) {
    if (!Number.isInteger(n) || n <= 0) throw new GhError("rejected", "invalid pull request number");
    parts.push(
      `p${n}:pullRequest(number:${n}){number state isDraft isCrossRepository url mergedAt mergedBy{login} mergeCommit{oid} headRefName headRefOid baseRefName mergeable mergeStateStatus reviewDecision labels(first:20){nodes{name}} timelineItems(last:1,itemTypes:[CLOSED_EVENT]){nodes{... on ClosedEvent{actor{login}}}} commits(last:1){nodes{commit{oid ${contexts(n)}}}}}`,
    );
  }
  commits.forEach((oid, k) => {
    if (!HEX.test(oid)) throw new GhError("rejected", "invalid commit id");
    parts.push(`c${k}:object(oid:"${oid}"){... on Commit{oid ${contexts()}}}`);
  });
  return `query{repository(owner:"${repo.owner}",name:"${repo.name}"){${parts.join(" ")}} rateLimit{remaining resetAt}}`;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function parseObserveResponse(json: string, prs: number[], commits: string[]): Observations {
  let doc: any;
  try {
    doc = JSON.parse(json);
  } catch {
    throw new GhError("unknown", "GitHub's answer could not be read");
  }
  const r = doc?.data?.repository ?? {};
  const out: Observations = { prs: [], commits: [] };
  for (const n of prs) {
    const p = r[`p${n}`];
    if (!p || typeof p.number !== "number") continue;
    const commit = p.commits?.nodes?.[0]?.commit;
    const state = p.state === "MERGED" || p.state === "CLOSED" ? p.state : "OPEN";
    out.prs.push({
      number: p.number,
      state,
      isDraft: !!p.isDraft,
      crossRepo: !!p.isCrossRepository,
      url: String(p.url ?? ""),
      headRef: String(p.headRefName ?? ""),
      headSha: String(p.headRefOid ?? ""),
      baseRef: String(p.baseRefName ?? ""),
      mergeable: String(p.mergeable ?? "UNKNOWN"),
      mergeStateStatus: String(p.mergeStateStatus ?? "UNKNOWN"),
      reviewDecision: p.reviewDecision ?? null,
      labels: (p.labels?.nodes ?? []).map((l: any) => String(l.name)),
      checks: parseChecks(commit?.statusCheckRollup),
      checksFor: String(commit?.oid ?? ""),
      ...(p.mergedAt ? { mergedAt: String(p.mergedAt) } : {}),
      ...(p.mergeCommit?.oid ? { mergeCommit: String(p.mergeCommit.oid) } : {}),
      ...(p.mergedBy?.login ? { mergedBy: String(p.mergedBy.login) } : {}),
      ...(state === "CLOSED" && p.timelineItems?.nodes?.[0]?.actor?.login ? { closedBy: String(p.timelineItems.nodes[0].actor.login) } : {}),
    });
  }
  commits.forEach((oid, k) => {
    const c = r[`c${k}`];
    if (c) out.commits.push({ oid, checks: parseChecks(c.statusCheckRollup) });
  });
  if (typeof doc?.data?.rateLimit?.remaining === "number") out.rateRemaining = doc.data.rateLimit.remaining;
  if (doc?.data?.rateLimit?.resetAt) out.rateResetAt = String(doc.data.rateLimit.resetAt);
  return out;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const UNATTRIBUTED = "require_extra_approval_for_unattributed_changes";

// ---------- the gh CLI ----------

export class GhCliHost implements GitHubHost {
  readonly simulated = false;
  private readonly ghBin: string;
  private readonly gitBin: string;
  private readonly cwd: string;
  private readonly timeoutMs: number;
  private readonly children = new Set<ChildProcess>();

  /** `cwd` is an empty directory the service owns, so gh never picks a repository up from where it runs. */
  constructor(o: { ghBin?: string; gitBin?: string; cwd: string; timeoutMs?: number }) {
    this.ghBin = o.ghBin ?? "gh";
    this.gitBin = o.gitBin ?? "git";
    this.cwd = o.cwd;
    this.timeoutMs = o.timeoutMs ?? 60_000;
    mkdirSync(this.cwd, { recursive: true });
  }

  parseRemote(url: string): RepoRef | undefined {
    return parseGitHubRemote(url);
  }

  /**
   * Run gh. The arguments are checked first; nothing forbidden is ever spawned. No shell. The body,
   * if any, goes on stdin. A process that outlives the timeout is killed with its whole group.
   */
  gh(args: string[], o: { stdin?: string } = {}): Promise<string> {
    try {
      assertAllowedGh(args, o.stdin);
    } catch (e) {
      return Promise.reject(e);
    }
    return new Promise((resolveRun, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(this.ghBin, args, { cwd: this.cwd, env: networkEnv(), stdio: ["pipe", "pipe", "pipe"], detached: true });
      } catch (e) {
        return reject(new GhError("unknown", shortError(e instanceof Error ? e.message : String(e))));
      }
      this.children.add(child);
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      const kill = (sig: NodeJS.Signals) => {
        try {
          if (child.pid) process.kill(-child.pid, sig);
        } catch {
          child.kill(sig);
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill("SIGTERM");
        setTimeout(() => kill("SIGKILL"), 5000).unref();
      }, this.timeoutMs);
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.children.delete(child);
        fn();
      };
      child.stdout!.on("data", (c: Buffer) => {
        if (stdout.length < 5 * 1024 * 1024) stdout += c.toString("utf8");
      });
      child.stderr!.on("data", (c: Buffer) => {
        if (stderr.length < 64 * 1024) stderr += c.toString("utf8");
      });
      child.on("error", (e: NodeJS.ErrnoException) => done(() => reject(e.code === "ENOENT" ? Object.assign(new GhError("unknown", "gh is not installed or not on the PATH"), { missing: true }) : new GhError("unknown", shortError(e.message)))));
      child.on("close", (code, signal) =>
        done(() => {
          if (timedOut) return reject(new GhError("timeout", `gh did not answer within ${Math.round(this.timeoutMs / 1000)} s and was stopped`));
          if (signal) return reject(new GhError("timeout", "gh was stopped"));
          if (code === 0) return resolveRun(stdout);
          reject(classifyGhError(code, stderr));
        }),
      );
      child.stdin!.on("error", () => undefined);
      child.stdin!.end(o.stdin ?? "");
    });
  }

  private git(args: string[]): Promise<string> {
    return new Promise((resolveRun, reject) => {
      execFile(this.gitBin, args, { encoding: "utf8", env: gitEnv(), timeout: 10_000 }, (err, stdout) => (err ? reject(err) : resolveRun(String(stdout))));
    });
  }

  abortAll() {
    for (const c of this.children) {
      try {
        if (c.pid) process.kill(-c.pid, "SIGTERM");
      } catch {
        c.kill("SIGTERM");
      }
    }
  }

  private async json(args: string[]): Promise<unknown> {
    const out = await this.gh(args);
    try {
      return JSON.parse(out);
    } catch {
      throw new GhError("unknown", "GitHub's answer could not be read");
    }
  }

  async preflight(a: { remoteUrl: string; base: string }): Promise<PreflightResult> {
    const empty = { requiredChecks: [], autoMergeBlockers: [], posture: [] };
    const stop = (code: NonNullable<PreflightResult["problem"]>["code"], message: string, extra: Partial<PreflightResult> = {}): PreflightResult => ({ ok: false, problem: { code, message }, ...empty, ...extra });
    // Tools.
    let ghVersion: string;
    try {
      const v = parseVersion(await this.gh(["--version"]));
      if (!v) return stop("gh-missing", "The GitHub CLI (gh) did not report a version. Install it from cli.github.com.");
      ghVersion = v.join(".");
      if (!atLeast(v, 2, 13)) return stop("gh-old", `The GitHub CLI is version ${ghVersion}; 2.13 or newer is needed. Update gh.`, { ghVersion });
    } catch (e) {
      if ((e as { missing?: boolean }).missing) return stop("gh-missing", "The GitHub CLI (gh) is not installed or not on the PATH. Install it from cli.github.com, then run gh auth login.");
      return stop("gh-missing", `The GitHub CLI (gh) could not be run: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      const v = parseVersion(await this.git(["--version"]));
      if (!v || !atLeast(v, 2, 40)) return stop("git-old", `git ${v ? v.join(".") : "(unknown version)"} is too old; 2.40 or newer is needed.`, { ghVersion });
    } catch {
      return stop("git-old", "git could not be run.", { ghVersion });
    }
    // The repository.
    const repo = this.parseRemote(a.remoteUrl);
    if (!repo) return stop("remote", "The remote is not a github.com repository (expected github.com/<owner>/<name>). GitHub Enterprise hosts are not supported.", { ghVersion });
    const slug = `${repo.owner}/${repo.name}`;
    const base = a.base.split("/").map(encodeURIComponent).join("/");
    const fail = (e: unknown, what: string): PreflightResult => {
      const g = e instanceof GhError ? e : new GhError("unknown", String(e));
      if (g.code === "auth") return stop("auth", "GitHub sign-in needed: run `gh auth login` in a terminal.", { ghVersion, repo: slug });
      if (g.code === "rate-limit") return { ...stop("rate-limit", `GitHub's rate limit was reached while ${what}.`, { ghVersion, repo: slug }) };
      if (g.code === "not-found") return stop("permission", `${slug} was not found, or this GitHub account cannot see it.`, { ghVersion, repo: slug });
      if (g.code === "network" || g.code === "timeout") return stop("network", `GitHub could not be reached while ${what}: ${g.message}`, { ghVersion, repo: slug });
      return stop("network", `${what} failed: ${g.message}`, { ghVersion, repo: slug });
    };
    let login: string;
    try {
      login = (await this.gh(["api", "user", "--jq", ".login"])).trim();
    } catch (e) {
      return fail(e, "checking the sign-in");
    }
    let facts: { push?: boolean; admin?: boolean; archived?: boolean; mergeCommit?: boolean; autoMerge?: boolean; deleteOnMerge?: boolean; private?: boolean };
    try {
      facts = (await this.json([
        "api",
        `repos/${slug}`,
        "--jq",
        "{push:.permissions.push,admin:.permissions.admin,archived:.archived,mergeCommit:.allow_merge_commit,autoMerge:.allow_auto_merge,deleteOnMerge:.delete_branch_on_merge,private:.private}",
      ])) as typeof facts;
    } catch (e) {
      return fail(e, "reading the repository");
    }
    if (facts.archived) return stop("permission", `${slug} is archived; nothing can be pushed to it.`, { ghVersion, repo: slug, login });
    if (!facts.push) return stop("permission", `The GitHub account ${login} cannot push to ${slug}.`, { ghVersion, repo: slug, login });

    // The rules on the base branch. Every call is a read.
    const required = new Set<string>();
    let prRequired = false;
    let approvals = 0;
    let mergeQueue = false;
    let unattributed = false;
    let rulesRead = true;
    try {
      const rules = (await this.json(["api", `repos/${slug}/rules/branches/${base}`])) as { type?: string; parameters?: Record<string, unknown> }[];
      for (const r of Array.isArray(rules) ? rules : []) {
        if (r.type === "required_status_checks") for (const c of (r.parameters?.required_status_checks as { context?: string }[] | undefined) ?? []) if (c.context) required.add(c.context);
        if (r.type === "pull_request") {
          prRequired = true;
          approvals = Math.max(approvals, Number(r.parameters?.required_approving_review_count ?? 0));
          if (r.parameters?.[UNATTRIBUTED]) unattributed = true;
        }
        if (r.type === "merge_queue") mergeQueue = true;
      }
    } catch (e) {
      const g = e instanceof GhError ? e : undefined;
      if (g && (g.code === "auth" || g.code === "rate-limit" || g.code === "network" || g.code === "timeout")) return fail(e, "reading the branch rules");
      rulesRead = false;
    }
    try {
      const legacy = (await this.json(["api", `repos/${slug}/branches/${base}/protection/required_status_checks`, "--jq", ".contexts"])) as string[];
      for (const c of Array.isArray(legacy) ? legacy : []) required.add(String(c));
    } catch (e) {
      const g = e instanceof GhError ? e : undefined;
      if (g && (g.code === "auth" || g.code === "rate-limit" || g.code === "network" || g.code === "timeout")) return fail(e, "reading the branch protection");
      // 404: the branch has no classic protection. 403: this account cannot read it.
    }
    // Approvals required by classic branch protection count like the ones a ruleset requires.
    try {
      const n = Number((await this.gh(["api", `repos/${slug}/branches/${base}/protection/required_pull_request_reviews`, "--jq", ".required_approving_review_count"])).trim());
      if (Number.isInteger(n) && n > 0) {
        prRequired = true;
        approvals = Math.max(approvals, n);
      }
    } catch (e) {
      const g = e instanceof GhError ? e : undefined;
      if (g && (g.code === "auth" || g.code === "rate-limit" || g.code === "network" || g.code === "timeout")) return fail(e, "reading the branch protection");
    }
    let bypass: string | undefined;
    let ids: string[] = [];
    try {
      ids = (await this.gh(["api", `repos/${slug}/rulesets`, "--jq", ".[].id"])).split("\n").map((x) => x.trim()).filter((x) => /^\d+$/.test(x)).slice(0, 10);
    } catch (e) {
      const g = e instanceof GhError ? e : undefined;
      if (g && (g.code === "auth" || g.code === "rate-limit" || g.code === "network" || g.code === "timeout")) return fail(e, "reading the rulesets");
    }
    for (const id of ids) {
      // One ruleset that cannot be read (deleted meanwhile, or not visible) does not hide the others.
      try {
        const rs = (await this.json(["api", `repos/${slug}/rulesets/${id}`, "--jq", "{name,enforcement,current_user_can_bypass}"])) as { name?: string; enforcement?: string; current_user_can_bypass?: string };
        if (rs.enforcement === "active" && rs.current_user_can_bypass && rs.current_user_can_bypass !== "never") bypass = `${rs.name ?? id} (${rs.current_user_can_bypass})`;
      } catch (e) {
        const g = e instanceof GhError ? e : undefined;
        if (g && (g.code === "auth" || g.code === "rate-limit" || g.code === "network" || g.code === "timeout")) return fail(e, "reading the rulesets");
      }
    }

    const requiredChecks = [...required].sort();
    const posture: PostureItem[] = [];
    const item = (id: string, status: PostureItem["status"], label: string, detail: string) => posture.push({ id, status, label, detail });
    if (!rulesRead) item("rules", "unverified", "The branch rules could not be read", `The rules for ${a.base} could not be read with this account, so the required checks below may be incomplete.`);
    item("pull-request", prRequired ? "ok" : "warn", prRequired ? `A pull request is required for ${a.base}` : `No rule requires a pull request for ${a.base}`, prRequired ? "Changes reach the base branch only through a pull request." : "Direct pushes to the base branch are possible for accounts that can push. The app only ever opens pull requests.");
    item(
      "required-checks",
      requiredChecks.length ? "ok" : "fail",
      requiredChecks.length ? `Required checks: ${requiredChecks.join(", ")}` : `No required check on ${a.base}`,
      requiredChecks.length ? "Read from the repository's rules. The app merges only a head on which every one of them passed." : "The app merges only what a required check has passed, so it will not merge here. You can still merge on GitHub.",
    );
    if (bypass) item("bypass", "warn", "You can bypass these rules", `You can bypass these rules (${bypass}). The app never does, but your own account and anything using it could. Consider narrowing the bypass on the ruleset.`);
    item("auto-merge", "ok", facts.autoMerge ? "Repository auto-merge is on" : "Repository auto-merge is off", "It is not needed: the app never uses GitHub's auto-merge and merges only after its own checks.");
    if (unattributed) item("unattributed", "unverified", `${UNATTRIBUTED} is on`, `${UNATTRIBUTED} is on. Pull requests whose commits are authored by Orchestrator may need an approval from a second account. Unverified.`);
    if (approvals > 0) item("approvals", "warn", `${approvals} approving review${approvals === 1 ? "" : "s"} required`, "GitHub will not merge a pull request until a person approves it. The app cannot approve; it holds the pull request and says so.");
    item("merge-commits", facts.mergeCommit ? "ok" : "fail", facts.mergeCommit ? "Merge commits are allowed" : "Merge commits are not allowed", facts.mergeCommit ? "The app merges with a merge commit, so each task has one commit to show and to revert." : "The app merges only with merge commits. Allow them in the repository settings, or merge on GitHub.");
    item("delete-on-merge", "ok", facts.deleteOnMerge ? "Branches are deleted on merge" : "Branches are kept after a merge", "The app never deletes a branch itself.");
    if (mergeQueue) item("merge-queue", "fail", "A merge queue is required", "A merge queue is not supported: a merge from the app would enqueue the pull request or switch on GitHub's own auto-merge, which the app never uses. It merges nothing here, by itself or at your click. Merge on GitHub.");
    if (facts.private === false) item("public", "warn", "This repository is public", "This repository is public: PR titles, descriptions and review summaries are public.");

    const autoMergeBlockers = [
      ...(requiredChecks.length ? [] : ["no required check"]),
      ...(mergeQueue ? ["a merge queue is required"] : []),
      ...(facts.mergeCommit ? [] : ["merge commits are not allowed"]),
      ...(approvals > 0 ? [`${approvals} approving review(s) required`] : []),
    ];
    return { ok: true, repo: slug, login, ghVersion, requiredChecks, autoMergeBlockers, posture, ...(mergeQueue ? { mergeQueue: true } : {}), ...(facts.mergeCommit ? {} : { mergeCommitsAllowed: false }) };
  }

  async findPr(a: { repo: RepoRef; head: string; marker: string }): Promise<{ number: number; url: string } | undefined> {
    const list = (await this.json(["pr", "list", "-R", `${a.repo.owner}/${a.repo.name}`, "--head", a.head, "--state", "all", "--json", "number,url,state,body,isCrossRepository", "--limit", "10"])) as {
      number: number;
      url: string;
      body?: string;
      isCrossRepository?: boolean;
    }[];
    // Only the app's own pull request: found by its branch, carrying its marker, from this repository.
    const mine = (Array.isArray(list) ? list : []).find((p) => !p.isCrossRepository && typeof p.body === "string" && p.body.includes(a.marker));
    return mine ? { number: mine.number, url: mine.url } : undefined;
  }

  async createPr(a: { repo: RepoRef; base: string; head: string; title: string; body: string }): Promise<{ number: number; url: string }> {
    const out = await this.gh(["pr", "create", "-R", `${a.repo.owner}/${a.repo.name}`, "--base", a.base, "--head", a.head, "--title", a.title, "--body-file", "-"], { stdin: a.body });
    const pr = parsePrUrl(out);
    if (!pr) throw new GhError("unknown", "gh pr create did not print the pull request's address");
    return pr;
  }

  async observe(a: { repo: RepoRef; prs: number[]; commits: string[] }): Promise<Observations> {
    const query = buildObserveQuery(a.repo, a.prs, a.commits);
    return parseObserveResponse(await this.gh(["api", "graphql", "--input", "-"], { stdin: JSON.stringify({ query }) }), a.prs, a.commits);
  }

  async merge(a: { repo: RepoRef; number: number; headSha: string; subject: string; body: string }): Promise<void> {
    if (!HEX.test(a.headSha)) throw new GhError("rejected", "refusing to merge without the exact head commit");
    await this.gh(["pr", "merge", String(a.number), "-R", `${a.repo.owner}/${a.repo.name}`, "--merge", "--match-head-commit", a.headSha, "--subject", a.subject, "--body-file", "-"], { stdin: a.body });
  }

  async findComment(a: { repo: RepoRef; number: number; marker: string }): Promise<{ url: string } | undefined> {
    if (/["\\]/.test(a.marker)) throw new GhError("rejected", "invalid comment marker");
    const out = await this.gh(["api", `repos/${a.repo.owner}/${a.repo.name}/issues/${a.number}/comments`, "--paginate", "--jq", `.[] | select(.body | contains("${a.marker}")) | .html_url`]);
    const url = out.split("\n").map((l) => l.trim()).find(Boolean);
    return url ? { url } : undefined;
  }

  async comment(a: { repo: RepoRef; number: number; body: string }): Promise<{ url: string }> {
    const out = await this.gh(["api", "-X", "POST", `repos/${a.repo.owner}/${a.repo.name}/issues/${a.number}/comments`, "--input", "-"], { stdin: JSON.stringify({ body: a.body }) });
    let url: unknown;
    try {
      url = (JSON.parse(out) as { html_url?: unknown }).html_url;
    } catch {
      url = undefined;
    }
    // "Posted" needs the comment's address; without it nothing is recorded.
    if (typeof url !== "string" || !url) throw new GhError("unknown", "GitHub did not return the comment's address");
    return { url };
  }

  async close(a: { repo: RepoRef; number: number; comment: string }): Promise<void> {
    await this.gh(["pr", "close", String(a.number), "-R", `${a.repo.owner}/${a.repo.name}`, "--comment", a.comment]);
  }

  /** The exact invocation: `gh api -X POST repos/<o>/<r>/actions/jobs/<jobId>/rerun`. The id is checked first. */
  async rerunJob(a: { repo: RepoRef; jobId: number }): Promise<void> {
    if (!Number.isInteger(a.jobId) || a.jobId <= 0) throw new GhError("rejected", "refusing to re-run a job without a valid job id");
    if (!NAME.test(a.repo.owner) || !NAME.test(a.repo.name)) throw new GhError("rejected", "invalid repository name");
    await this.gh(["api", "-X", "POST", `repos/${a.repo.owner}/${a.repo.name}/actions/jobs/${a.jobId}/rerun`]);
  }
}

// ---------- simulated ----------

export interface SimPr {
  number: number;
  url: string;
  head: string;
  headSha: string;
  base: string;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  mergeable: string;
  mergeStateStatus: string;
  reviewDecision: string | null;
  labels: string[];
  checks: CheckObs[];
  mergeCommit?: string;
  mergedAt?: string;
  mergedBy?: string;
  closedBy?: string;
  comments: { url: string; body: string }[];
}

const SIM_CHECK: CheckObs = { name: "simulated-check", required: true, status: "COMPLETED", conclusion: "SUCCESS" };

/**
 * An in-memory stand-in used by the fake runtime: nothing is contacted and no process is started.
 * Pull request numbers start at 1000 and addresses read "simulated://pr/1000". Every record made
 * through it is labelled simulated.
 */
export class SimulatedGitHub implements GitHubHost {
  readonly simulated: boolean = true;
  readonly prs = new Map<number, SimPr>();
  protected nextNumber = 1000;
  protected login = "simulated-user";

  parseRemote(_url: string): RepoRef | undefined {
    return { owner: "simulated", name: "repository" };
  }

  protected prUrl(n: number): string {
    return `simulated://pr/${n}`;
  }

  async preflight(_a: { remoteUrl: string; base: string }): Promise<PreflightResult> {
    return {
      ok: true,
      simulated: true,
      repo: "simulated/repository",
      login: this.login,
      requiredChecks: [SIM_CHECK.name],
      autoMergeBlockers: [],
      posture: [{ id: "simulated", status: "unverified", label: "Simulated GitHub", detail: "The fake runtime never contacts GitHub. Pull requests, checks and merges shown here are simulated." }],
    };
  }

  async findPr(a: { repo: RepoRef; head: string; marker: string }): Promise<{ number: number; url: string } | undefined> {
    const p = [...this.prs.values()].find((x) => x.head === a.head && x.body.includes(a.marker));
    return p ? { number: p.number, url: p.url } : undefined;
  }

  async createPr(a: { repo: RepoRef; base: string; head: string; title: string; body: string; headSha?: string }): Promise<{ number: number; url: string }> {
    const number = this.nextNumber++;
    const pr: SimPr = {
      number,
      url: this.prUrl(number),
      head: a.head,
      headSha: a.headSha ?? "",
      base: a.base,
      title: a.title,
      body: a.body,
      state: "OPEN",
      isDraft: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: null,
      labels: [],
      checks: this.initialChecks(),
      comments: [],
    };
    this.prs.set(number, pr);
    return { number, url: pr.url };
  }

  /** The simulated repository's one required check passes at once. */
  protected initialChecks(): CheckObs[] {
    return [{ ...SIM_CHECK }];
  }

  protected headOf(p: SimPr): string {
    return p.headSha;
  }

  protected observation(p: SimPr): PrObservation {
    const headSha = this.headOf(p);
    return {
      number: p.number,
      state: p.state,
      isDraft: p.isDraft,
      crossRepo: false,
      url: p.url,
      headRef: p.head,
      headSha,
      baseRef: p.base,
      mergeable: p.mergeable,
      mergeStateStatus: p.mergeStateStatus,
      reviewDecision: p.reviewDecision,
      labels: [...p.labels],
      checks: p.checks.map((c) => ({ ...c })),
      checksFor: headSha,
      ...(p.mergedAt ? { mergedAt: p.mergedAt } : {}),
      ...(p.mergeCommit ? { mergeCommit: p.mergeCommit } : {}),
      ...(p.mergedBy ? { mergedBy: p.mergedBy } : {}),
      ...(p.closedBy ? { closedBy: p.closedBy } : {}),
    };
  }

  protected commitChecks(_oid: string): CheckObs[] {
    return [{ ...SIM_CHECK }];
  }

  async observe(a: { repo: RepoRef; prs: number[]; commits: string[] }): Promise<Observations> {
    return {
      prs: a.prs.map((n) => this.prs.get(n)).filter((p): p is SimPr => !!p).map((p) => this.observation(p)),
      commits: a.commits.map((oid) => ({ oid, checks: this.commitChecks(oid) })),
      rateRemaining: 5000,
    };
  }

  protected mergeCommitFor(p: SimPr): string {
    return `sim-merge-${p.number}`;
  }

  pushed(a: { repo: RepoRef; number: number; headSha: string }): void {
    const p = this.prs.get(a.number);
    if (p) p.headSha = a.headSha;
  }

  async merge(a: { repo: RepoRef; number: number; headSha: string; subject: string; body: string }): Promise<void> {
    const p = this.prs.get(a.number);
    if (!p) throw new GhError("not-found", `pull request #${a.number} not found`);
    if (p.state !== "OPEN") throw new GhError("rejected", `pull request #${a.number} is ${p.state.toLowerCase()}`);
    if (this.headOf(p) !== a.headSha) throw new GhError("head-mismatch", "head branch was modified; the head commit does not match");
    if (p.mergeable !== "MERGEABLE" || (p.mergeStateStatus !== "CLEAN" && p.mergeStateStatus !== "HAS_HOOKS")) throw new GhError("rejected", `pull request #${a.number} is not mergeable: the base branch policy prohibits the merge`);
    p.mergeCommit = this.mergeCommitFor(p);
    p.state = "MERGED";
    p.mergedAt = new Date().toISOString();
    p.mergedBy = this.login;
  }

  async findComment(a: { repo: RepoRef; number: number; marker: string }): Promise<{ url: string } | undefined> {
    const c = this.prs.get(a.number)?.comments.find((x) => x.body.includes(a.marker));
    return c ? { url: c.url } : undefined;
  }

  async comment(a: { repo: RepoRef; number: number; body: string }): Promise<{ url: string }> {
    const p = this.prs.get(a.number);
    if (!p) throw new GhError("not-found", `pull request #${a.number} not found`);
    const url = `${p.url}#issuecomment-${p.comments.length + 1}`;
    p.comments.push({ url, body: a.body });
    return { url };
  }

  async close(a: { repo: RepoRef; number: number; comment: string }): Promise<void> {
    const p = this.prs.get(a.number);
    if (!p) throw new GhError("not-found", `pull request #${a.number} not found`);
    if (p.state === "OPEN") {
      p.state = "CLOSED";
      p.closedBy = this.login;
      p.comments.push({ url: `${p.url}#issuecomment-${p.comments.length + 1}`, body: a.comment });
    }
  }

  /** The simulated check has no job id and never cancels, so there is never a job to run again. */
  async rerunJob(a: { repo: RepoRef; jobId: number }): Promise<void> {
    for (const p of this.prs.values()) {
      const c = p.checks.find((x) => x.jobId === a.jobId);
      if (!c) continue;
      c.status = "IN_PROGRESS";
      c.conclusion = null;
      return;
    }
    throw new GhError("not-found", `job ${a.jobId} not found`);
  }

  abortAll() {}
}
