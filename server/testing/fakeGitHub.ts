// A scriptable GitHub for end-to-end tests of pull-request delivery. It never contacts GitHub: a local
// bare repository stands in for the remote, and this class stands in for the GitHub API on top of it.
//   - observe() reads the real head of each pull request's branch from the bare repository;
//   - merge() checks the head and makes a real two-parent merge commit on the bare base branch;
//   - tests script checks, states, delays, failures, labels, and what a person does on GitHub.

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type { CheckObs } from "../../src/domain/types";
import { GhError, SimulatedGitHub, type Observations, type PreflightResult, type RepoRef, type SimPr } from "../github";

type Method = "preflight" | "findPr" | "createPr" | "observe" | "merge" | "findComment" | "comment" | "close";

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

  constructor(bare: string, baseBranch = "main") {
    super();
    this.bare = resolve(bare);
    this.baseBranch = baseBranch;
    this.nextNumber = 1;
    this.login = "tester";
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
  /** Report a check on the pull request's current head. `conclusion` null means still running. */
  setCheck(number: number, conclusion: string | null, name = "check") {
    const p = this.pr(number);
    p.checks = [...p.checks.filter((c) => c.name !== name), { name, required: this.requiredChecks.includes(name), status: conclusion ? "COMPLETED" : "IN_PROGRESS", conclusion, url: `https://github.com/test/repo/actions/runs/${number}` }];
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
    return resolve(url) === this.bare ? { owner: "test", name: "repo" } : undefined;
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
      if (!this.parseRemote(a.remoteUrl)) return { ok: false, problem: { code: "remote", message: "The remote is not the test repository." }, requiredChecks: [], autoMergeBlockers: [], posture: [] };
      return { ok: true, repo: "test/repo", login: this.login, ghVersion: "2.101.0", requiredChecks: [...this.requiredChecks], autoMergeBlockers: [], posture: [{ id: "required-checks", status: "ok", label: `Required checks: ${this.requiredChecks.join(", ")}`, detail: "From the fake." }] };
    });
  }
  override findPr(a: { repo: RepoRef; head: string; marker: string }) {
    return this.call("findPr", a, () => super.findPr(a));
  }
  override createPr(a: { repo: RepoRef; base: string; head: string; title: string; body: string; headSha?: string }) {
    return this.call("createPr", a, async () => {
      if (!this.headOf({ head: a.head } as SimPr)) throw new GhError("rejected", `head ${a.head} does not exist on the remote`);
      return super.createPr(a);
    });
  }
  override observe(a: { repo: RepoRef; prs: number[]; commits: string[] }): Promise<Observations> {
    return this.call("observe", a, () => super.observe(a));
  }
  override merge(a: { repo: RepoRef; number: number; headSha: string; subject: string; body: string }) {
    return this.call("merge", a, () => super.merge(a));
  }
  override findComment(a: { repo: RepoRef; number: number; marker: string }) {
    return this.call("findComment", a, () => super.findComment(a));
  }
  override comment(a: { repo: RepoRef; number: number; body: string }) {
    return this.call("comment", a, () => super.comment(a));
  }
  override close(a: { repo: RepoRef; number: number; comment: string }) {
    return this.call("close", a, () => super.close(a));
  }
}
