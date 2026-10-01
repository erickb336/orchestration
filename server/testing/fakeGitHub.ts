// A scriptable GitHub for end-to-end tests of pull-request delivery. It never contacts GitHub: a local
// bare repository stands in for the remote, and this class stands in for the GitHub API on top of it.
//   - observe() reads the real head of each pull request's branch from the bare repository;
//   - merge() checks the head and makes a real two-parent merge commit on the bare base branch;
//   - tests script checks, states, delays, failures, labels, and what a person does on GitHub.
//   - checks are kept as raw check runs (with job ids, apps and start times) and judged by
//     the real parseChecks, so a re-run appends a new run the way GitHub does.

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type { CheckObs } from "../../src/domain/types";
import { GhError, SimulatedGitHub, parseChecks, type Observations, type PreflightResult, type RepoRef, type RollupNode, type SimPr } from "../github";

type Method = "preflight" | "findPr" | "createPr" | "observe" | "merge" | "findComment" | "comment" | "close" | "rerunJob";

const RUNS_T0 = Date.parse("2026-09-30T12:00:00Z");

export class FakeGitHub extends SimulatedGitHub {
  override readonly simulated = false;
  /** Every call made to this host, in order. */
  calls: { method: Method; args: unknown }[] = [];
  requiredChecks = ["check"];
  /** Set to make the repository check report a problem. */
  preflightProblem: PreflightResult["problem"] | undefined;
  /** While true, every call fails the way an expired sign-in does. */
  authLost = false;
  /** Checks reported for commits on the base branch (the check after a merge). */
  baseChecks = new Map<string, CheckObs[]>();
  private failures = new Map<Method, GhError[]>();
  private gates = new Map<Method, { when: "before" | "after"; wait: Promise<void> }[]>();
  /** Bumped by abortAll(): a call still waiting to act dies, like a killed process. */
  private aborts = 0;
  readonly bare: string;
  readonly baseBranch: string;
  /** Remotes this fake serves (a bare repository path → "owner/name"). */
  private readonly remotes = new Map<string, string>();
  /** The repository each pull request was opened in. */
  private readonly prRepo = new Map<number, string>();
  /** The head each pull request's checks were reported for: a new head starts without checks, like CI does. */
  private readonly checksHead = new Map<number, string>();
  /** The raw check runs on each pull request's current head; `p.checks` is parseChecks over them. */
  private readonly runs = new Map<number, RollupNode[]>();
  private jobSeq = 100;
  private stampSeq = 0;
  /** Per-pull-request calls that named another repository than the one the pull request lives in. */
  wrongRepoCalls: { method: Method; repo: string; number: number }[] = [];

  constructor(bare: string, baseBranch = "main") {
    super();
    this.bare = resolve(bare);
    this.baseBranch = baseBranch;
    this.nextNumber = 1;
    this.login = "tester";
    this.remotes.set(this.bare, "test/repo");
  }

  /** Serve another bare repository as another GitHub repository. */
  addRemote(path: string, slug: string) {
    this.remotes.set(resolve(path), slug);
  }

  /** The repository argument is honoured: a pull request exists only in the repository it was opened in. */
  private inRepo(method: Method, repo: RepoRef, number: number) {
    const slug = `${repo.owner}/${repo.name}`;
    if (this.prRepo.get(number) === slug) return;
    this.wrongRepoCalls.push({ method, repo: slug, number });
    throw new GhError("not-found", `pull request #${number} not found in ${slug}`);
  }

  private git(...args: string[]): string {
    return execFileSync("git", ["--git-dir", this.bare, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  }

  // ---------- scripting ----------

  pr(number: number): SimPr {
    const p = this.prs.get(number);
    if (!p) throw new Error(`no pull request #${number}`);
    return p;
  }
  get open(): SimPr[] {
    return [...this.prs.values()].filter((p) => p.state === "OPEN");
  }
  count(method: Method): number {
    return this.calls.filter((c) => c.method === method).length;
  }
  /** Strictly increasing whole-second start times, so every later run started strictly after every earlier one. */
  private stamp(): string {
    return new Date(RUNS_T0 + ++this.stampSeq * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  }
  private refresh(number: number) {
    // "Now" is after the newest stamp: no run is dated in the future.
    this.pr(number).checks = parseChecks({ contexts: { nodes: this.runs.get(number) ?? [] } }, RUNS_T0 + (this.stampSeq + 1) * 1000);
  }
  /** The raw check runs on the pull request's current head, newest last. */
  runsOf(number: number): RollupNode[] {
    return [...(this.runs.get(number) ?? [])];
  }
  /**
   * Report a check on the pull request's current head. `conclusion` null means still running. A run
   * that is still going completes in place; a completed check reported again is a new run of that
   * name (a re-run), started strictly later, from the same workflow ("ci", on pull_request) and app.
   * `app`: the check suite's app (github-actions by default). `replace`: GitHub replaced the completed
   * check run instead (a person re-ran the job and the rollup shows the new attempt only), so no older
   * run remains next to it.
   */
  setCheck(number: number, conclusion: string | null, name = "check", o: { app?: string; replace?: boolean } = {}) {
    const p = this.pr(number);
    const head = this.headOf(p);
    if (this.checksHead.get(number) !== head) {
      p.checks = [];
      this.runs.set(number, []);
    }
    this.checksHead.set(number, head);
    const runs = this.runs.get(number) ?? [];
    const last = [...runs].reverse().find((r) => r.name === name);
    if (last && (last.status !== "COMPLETED" || o.replace)) {
      last.status = conclusion ? "COMPLETED" : "IN_PROGRESS";
      last.conclusion = conclusion;
      if (o.replace) {
        last.databaseId = ++this.jobSeq;
        last.startedAt = this.stamp();
      }
    } else {
      runs.push({
        __typename: "CheckRun",
        name,
        databaseId: ++this.jobSeq,
        status: conclusion ? "COMPLETED" : "IN_PROGRESS",
        conclusion,
        startedAt: this.stamp(),
        detailsUrl: `https://github.com/test/repo/actions/runs/${number}`,
        isRequired: this.requiredChecks.includes(name),
        checkSuite: { app: { slug: o.app ?? "github-actions" }, workflowRun: { databaseId: number, event: "pull_request", workflow: { databaseId: 1, name: "ci" } } },
      });
    }
    this.runs.set(number, runs);
    this.refresh(number);
  }
  /** The next call of `method` fails with this error. */
  failNext(method: Method, error: GhError) {
    this.failures.set(method, [...(this.failures.get(method) ?? []), error]);
  }
  /** Hold the next call of `method` until the returned function is called: before it acts, or after. */
  hold(method: Method, when: "before" | "after" = "before"): () => void {
    let release = () => {};
    const wait = new Promise<void>((r) => (release = r));
    this.gates.set(method, [...(this.gates.get(method) ?? []), { when, wait }]);
    return release;
  }
  /** A person merges the pull request on GitHub. */
  mergeByPerson(number: number, who = "octocat") {
    const p = this.pr(number);
    p.mergeCommit = this.mergeCommitFor(p);
    p.state = "MERGED";
    p.mergedAt = new Date().toISOString();
    p.mergedBy = who;
  }
  /** A person closes the pull request on GitHub. */
  closeByPerson(number: number, who = "octocat") {
    const p = this.pr(number);
    p.state = "CLOSED";
    p.closedBy = who;
  }

  // ---------- the host ----------

  private async call<T>(method: Method, args: unknown, fn: () => Promise<T>): Promise<T> {
    this.calls.push({ method, args });
    const gate = this.gates.get(method)?.shift();
    const aborts = this.aborts;
    if (gate?.when === "before") await gate.wait;
    if (aborts !== this.aborts) throw new GhError("timeout", "gh was stopped");
    if (this.authLost) throw new GhError("auth", "HTTP 401: Bad credentials (run gh auth login)");
    const failure = this.failures.get(method)?.shift();
    if (failure) throw failure;
    const out = await fn();
    if (gate?.when === "after") await gate.wait;
    return out;
  }

  /** Calls that have not acted yet never will; a call that already acted keeps its effect. */
  override abortAll() {
    this.aborts += 1;
  }

  override parseRemote(url: string): RepoRef | undefined {
    const slug = this.remotes.get(resolve(url));
    if (!slug) return undefined;
    const [owner, name] = slug.split("/");
    return { owner, name };
  }
  /** Checks belong to the head they ran on: after a push, none have reported yet. */
  protected override observation(p: SimPr) {
    const head = this.headOf(p);
    if (p.checks.length && this.checksHead.get(p.number) !== undefined && this.checksHead.get(p.number) !== head) {
      p.checks = [];
      this.runs.set(p.number, []);
    }
    return super.observation(p);
  }
  protected override prUrl(n: number): string {
    return `https://github.com/test/repo/pull/${n}`;
  }
  protected override initialChecks(): CheckObs[] {
    return [];
  }
  protected override headOf(p: SimPr): string {
    try {
      return this.git("rev-parse", "--verify", "--quiet", `refs/heads/${p.head}^{commit}`);
    } catch {
      return "";
    }
  }
  protected override commitChecks(oid: string): CheckObs[] {
    return this.baseChecks.get(oid) ?? [];
  }
  /** A real merge commit on the bare base branch: two parents, the base first. */
  protected override mergeCommitFor(p: SimPr): string {
    const base = this.git("rev-parse", `refs/heads/${p.base}`);
    const head = this.headOf(p);
    const tree = this.git("merge-tree", "--write-tree", base, head).split("\n")[0];
    const commit = this.git("-c", "user.name=GitHub", "-c", "user.email=noreply@github.com", "commit-tree", tree, "-p", base, "-p", head, "-m", `Merge pull request #${p.number} from ${p.head}`);
    this.git("update-ref", `refs/heads/${p.base}`, commit, base);
    return commit;
  }

  override preflight(a: { remoteUrl: string; base: string }): Promise<PreflightResult> {
    return this.call("preflight", a, async () => {
      if (this.preflightProblem) return { ok: false, problem: this.preflightProblem, requiredChecks: [], autoMergeBlockers: [], posture: [] };
      const repo = this.parseRemote(a.remoteUrl);
      if (!repo) return { ok: false, problem: { code: "remote", message: "The remote is not the test repository." }, requiredChecks: [], autoMergeBlockers: [], posture: [] };
      return {
        ok: true,
        repo: `${repo.owner}/${repo.name}`,
        login: this.login,
        ghVersion: "2.101.0",
        requiredChecks: [...this.requiredChecks],
        autoMergeBlockers: this.requiredChecks.length ? [] : ["no required check"],
        posture: [{ id: "required-checks", status: this.requiredChecks.length ? "ok" : "fail", label: this.requiredChecks.length ? `Required checks: ${this.requiredChecks.join(", ")}` : "No required check", detail: "From the fake." }],
      };
    });
  }
  override findPr(a: { repo: RepoRef; head: string; marker: string }) {
    const slug = `${a.repo.owner}/${a.repo.name}`;
    return this.call("findPr", a, async () => {
      const found = await super.findPr(a);
      return found && this.prRepo.get(found.number) === slug ? found : undefined;
    });
  }
  override createPr(a: { repo: RepoRef; base: string; head: string; title: string; body: string; headSha?: string }) {
    return this.call("createPr", a, async () => {
      if (!this.headOf({ head: a.head } as SimPr)) throw new GhError("rejected", `head ${a.head} does not exist on the remote`);
      const made = await super.createPr(a);
      this.prRepo.set(made.number, `${a.repo.owner}/${a.repo.name}`);
      return made;
    });
  }
  override observe(a: { repo: RepoRef; prs: number[]; commits: string[] }): Promise<Observations> {
    // Only pull requests of the repository that was asked about are returned.
    const slug = `${a.repo.owner}/${a.repo.name}`;
    return this.call("observe", a, () => super.observe({ ...a, prs: a.prs.filter((n) => this.prRepo.get(n) === slug) }));
  }
  override merge(a: { repo: RepoRef; number: number; headSha: string; subject: string; body: string }) {
    return this.call("merge", a, async () => {
      this.inRepo("merge", a.repo, a.number);
      return super.merge(a);
    });
  }
  override findComment(a: { repo: RepoRef; number: number; marker: string }) {
    return this.call("findComment", a, async () => {
      this.inRepo("findComment", a.repo, a.number);
      return super.findComment(a);
    });
  }
  override comment(a: { repo: RepoRef; number: number; body: string }) {
    return this.call("comment", a, async () => {
      this.inRepo("comment", a.repo, a.number);
      return super.comment(a);
    });
  }
  override close(a: { repo: RepoRef; number: number; comment: string }) {
    return this.call("close", a, async () => {
      this.inRepo("close", a.repo, a.number);
      return super.close(a);
    });
  }
  /** A re-run appends a new, running run of the same job's name, started strictly later, as GitHub Actions does. */
  override rerunJob(a: { repo: RepoRef; jobId: number }) {
    return this.call("rerunJob", a, async () => {
      for (const [number, runs] of this.runs) {
        const job = runs.find((r) => r.databaseId === a.jobId);
        if (!job) continue;
        this.inRepo("rerunJob", a.repo, number);
        runs.push({ ...job, databaseId: ++this.jobSeq, status: "IN_PROGRESS", conclusion: null, startedAt: this.stamp() });
        this.refresh(number);
        return;
      }
      throw new GhError("not-found", `job ${a.jobId} not found (HTTP 404)`);
    });
  }
}
