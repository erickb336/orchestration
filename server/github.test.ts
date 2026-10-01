// The gh adapter's contract, against a fake `gh` script that records each invocation:
// its arguments, stdin, working directory and environment. Nothing here contacts GitHub.

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GhCliHost, GhError, assertAllowedGh, buildObserveQuery, classifyGhError, parseApiCall, parseChecks, parseGitHubRemote, parseObserveResponse, parsePrUrl, shortError } from "./github";

const FAKE_GH = resolve(__dirname, "testing/fake-gh.mjs");
const REPO = { owner: "octo", name: "app" };
const SHA = "a".repeat(40);
const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

interface Call {
  argv: string[];
  stdin: string;
  cwd: string;
  env: Record<string, string>;
}
interface Rule {
  match: string;
  stdout?: string;
  stderr?: string;
  code?: number;
  sleepMs?: number;
}

let dir: string;
let log: string;
let script: string;
let cwd: string;
const saved: Record<string, string | undefined> = {};
const setEnv = (k: string, v: string | undefined) => {
  if (!(k in saved)) saved[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
};
const rules = (r: Rule[]) => writeFileSync(script, JSON.stringify(r));
const calls = (): Call[] =>
  readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Call);
const host = (timeoutMs = 10_000) => new GhCliHost({ ghBin: FAKE_GH, cwd, timeoutMs });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orch-gh-"));
  log = join(dir, "gh.log");
  script = join(dir, "script.json");
  cwd = join(dir, "gh-neutral");
  writeFileSync(log, "");
  rules([]);
  setEnv("FAKE_GH_LOG", log);
  setEnv("FAKE_GH_SCRIPT", script);
  // Things a user's shell might carry: none of it may reach gh, except a token, which passes unread.
  setEnv("GH_DEBUG", "api");
  setEnv("GH_REPO", "someone/else");
  setEnv("GH_HOST", "ghe.example.com");
  setEnv("GIT_TRACE", "1");
  setEnv("GIT_CURL_VERBOSE", "1");
  setEnv("GIT_DIR", "/tmp/not-this");
  setEnv("GH_TOKEN", TOKEN);
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

/** Canned answers for a repository with one required check and an admin bypass. */
const PREFLIGHT: Rule[] = [
  { match: "--version", stdout: "gh version 2.101.0 (2026-09-15)\nhttps://github.com/cli/cli/releases/tag/v2.101.0\n" },
  { match: "api user", stdout: "octocat\n" },
  { match: "rules/branches/main", stdout: JSON.stringify([{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "check" }] } }, { type: "pull_request", parameters: { required_approving_review_count: 0, require_extra_approval_for_unattributed_changes: true } }]) },
  { match: "protection/required_status_checks", stderr: "gh: Not Found (HTTP 404)\n", code: 1 },
  { match: "protection/required_pull_request_reviews", stderr: "gh: Not Found (HTTP 404)\n", code: 1 },
  { match: "rulesets/24227602", stdout: JSON.stringify({ name: "Protect main", enforcement: "active", current_user_can_bypass: "always" }) },
  { match: "rulesets", stdout: "24227602\n" },
  { match: "api repos/octo/app", stdout: JSON.stringify({ push: true, admin: true, archived: false, mergeCommit: true, autoMerge: false, deleteOnMerge: true, private: false }) },
];

describe("what the app never runs", () => {
  it("the guard refuses bypass, native auto-merge, force, branch deletion, merge endpoints and token access before anything is spawned", async () => {
    for (const args of [
      ["pr", "merge", "5", "-R", "octo/app", "--merge", "--match-head-commit", SHA, "--admin"],
      ["pr", "merge", "5", "-R", "octo/app", "--merge", "--match-head-commit", SHA, "--auto"],
      ["pr", "merge", "5", "-R", "octo/app", "--merge", "--match-head-commit", SHA, "-d"],
      ["pr", "merge", "5", "-R", "octo/app", "--merge", "--match-head-commit", SHA, "--delete-branch"],
      ["pr", "merge", "5", "-R", "octo/app", "--squash", "--match-head-commit", SHA],
      ["pr", "merge", "5", "-R", "octo/app", "--merge"], // no head binding
      ["pr", "merge", "5", "-R", "octo/app", "--match-head-commit", SHA], // no merge method
      ["pr", "close", "5", "-R", "octo/app", "--delete-branch"],
      ["api", "-X", "PUT", "repos/octo/app/pulls/5/merge"],
      ["api", "repos/octo/app/pulls/5/merge"],
      ["api", "-X", "DELETE", "repos/octo/app/git/refs/heads/main"],
      ["api", "-X", "PATCH", "repos/octo/app/git/refs/heads/main", "--force"],
      ["auth", "token"],
      ["auth", "status", "--show-token"],
    ]) {
      expect(() => assertAllowedGh(args), args.join(" ")).toThrow(GhError);
      await expect(host().gh(args), args.join(" ")).rejects.toThrow(/refusing/);
    }
    expect(() => assertAllowedGh(["api", "graphql", "--input", "-"], JSON.stringify({ query: "mutation{mergePullRequest(input:{pullRequestId:\"x\"}){clientMutationId}}" }))).toThrow(/refusing/);
    expect(() => assertAllowedGh(["api", "graphql", "--input", "-"], "mutation{enablePullRequestAutoMerge(input:{}){clientMutationId}}")).toThrow(/refusing/);
    expect(calls()).toEqual([]); // nothing was spawned
  });

  it("no invocation of any operation contains a forbidden flag or a merge endpoint; each names its repository, runs from the neutral directory and sends bodies on stdin", async () => {
    rules([
      ...PREFLIGHT.slice(0, 2),
      { match: "pr list", stdout: "[]" },
      { match: "pr create", stdout: "https://github.com/octo/app/pull/12\n" },
      { match: "graphql", stdout: JSON.stringify({ data: { repository: {}, rateLimit: { remaining: 4990, resetAt: "2026-09-30T13:00:00Z" } } }) },
      { match: "-X POST", stdout: JSON.stringify({ html_url: "https://github.com/octo/app/pull/12#issuecomment-1" }) },
      { match: "--paginate", stdout: "" },
      ...PREFLIGHT.slice(2),
    ]);
    const h = host();
    await h.preflight({ remoteUrl: "git@github.com:octo/app.git", base: "main" });
    expect(await h.findPr({ repo: REPO, head: "orchestration/p1/pr/T-1-1", marker: "<!-- m -->" })).toBeUndefined();
    expect(await h.createPr({ repo: REPO, base: "main", head: "orchestration/p1/pr/T-1-1", title: "T-1: A title", body: "The body\n\n<!-- m -->" })).toEqual({ number: 12, url: "https://github.com/octo/app/pull/12" });
    await h.observe({ repo: REPO, prs: [12], commits: [SHA] });
    await h.merge({ repo: REPO, number: 12, headSha: SHA, subject: "T-1: A title (#12)", body: "Merge body" });
    expect(await h.findComment({ repo: REPO, number: 12, marker: "<!-- orchestration:note:p1/note-3 -->" })).toBeUndefined();
    expect(await h.comment({ repo: REPO, number: 12, body: "A note\n\n<!-- orchestration:note:p1/note-3 -->" })).toEqual({ url: "https://github.com/octo/app/pull/12#issuecomment-1" });
    await h.close({ repo: REPO, number: 12, comment: "Closed from Orchestrator." });

    const all = calls();
    expect(all.length).toBeGreaterThanOrEqual(13);
    for (const c of all) {
      const line = c.argv.join(" ");
      for (const bad of ["--admin", "--auto", "-d", "--delete-branch", "--force", "--show-token", "--squash", "--rebase"]) expect(c.argv, line).not.toContain(bad);
      expect(line).not.toMatch(/\/pulls\/\d+\/merge/);
      expect(c.stdin).not.toMatch(/mergePullRequest|enablePullRequestAutoMerge/);
      expect(c.argv[0]).not.toBe("auth");
      // An explicit repository: -R, a repos/<o>/<r> path, or the owner and name inside the query.
      const explicit = c.argv.includes("-R") || /repos\/octo\/app(\/|\s|$)/.test(line) || c.stdin.includes('repository(owner:\\"octo\\",name:\\"app\\")') || line === "--version" || line === "api user --jq .login";
      expect(explicit, line).toBe(true);
      if (c.argv.includes("-R")) expect(c.argv[c.argv.indexOf("-R") + 1]).toBe("octo/app");
      // The neutral directory: empty, owned by the service, and not a repository.
      expect(resolve(c.cwd).endsWith("gh-neutral")).toBe(true);
      // Prompts off; nothing that could print credentials or redirect the call.
      expect(c.env).toMatchObject({ GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_SPINNER_DISABLED: "1", NO_COLOR: "1", GIT_TERMINAL_PROMPT: "0" });
      for (const gone of ["GH_DEBUG", "GH_REPO", "GH_HOST", "GIT_TRACE", "GIT_CURL_VERBOSE", "GIT_DIR"]) expect(c.env[gone], `${gone} in ${line}`).toBeUndefined();
    }
    expect(readdirSync(cwd)).toEqual([]);

    // The exact command lines.
    const find = (s: string) => all.find((c) => c.argv.join(" ").includes(s))!;
    expect(find("pr list").argv).toEqual(["pr", "list", "-R", "octo/app", "--head", "orchestration/p1/pr/T-1-1", "--state", "all", "--json", "number,url,state,body,isCrossRepository", "--limit", "10"]);
    expect(find("pr create").argv).toEqual(["pr", "create", "-R", "octo/app", "--base", "main", "--head", "orchestration/p1/pr/T-1-1", "--title", "T-1: A title", "--body-file", "-"]);
    expect(find("pr create").stdin).toBe("The body\n\n<!-- m -->");
    expect(find("pr merge").argv).toEqual(["pr", "merge", "12", "-R", "octo/app", "--merge", "--match-head-commit", SHA, "--subject", "T-1: A title (#12)", "--body-file", "-"]);
    expect(find("pr merge").stdin).toBe("Merge body");
    expect(find("graphql").argv).toEqual(["api", "graphql", "--input", "-"]);
    expect(JSON.parse(find("graphql").stdin).query).toBe(buildObserveQuery(REPO, [12], [SHA]));
    expect(find("--paginate").argv).toEqual(["api", "repos/octo/app/issues/12/comments", "--paginate", "--jq", '.[] | select(.body | contains("<!-- orchestration:note:p1/note-3 -->")) | .html_url']);
    expect(find("-X POST").argv).toEqual(["api", "-X", "POST", "repos/octo/app/issues/12/comments", "--input", "-"]);
    expect(JSON.parse(find("-X POST").stdin)).toEqual({ body: "A note\n\n<!-- orchestration:note:p1/note-3 -->" });
    expect(find("pr close").argv).toEqual(["pr", "close", "12", "-R", "octo/app", "--comment", "Closed from Orchestrator."]);
    expect(all.some((c) => c.argv.join(" ").includes("edit-last"))).toBe(false);
  });
});

describe("preflight (read-only)", () => {
  it("reads the tools, the sign-in, the repository and its rules, and reports the posture truthfully", async () => {
    rules(PREFLIGHT);
    const r = await host().preflight({ remoteUrl: "https://github.com/octo/app.git", base: "main" });
    expect(r).toMatchObject({ ok: true, repo: "octo/app", login: "octocat", ghVersion: "2.101.0", requiredChecks: ["check"], autoMergeBlockers: [] });
    const p = Object.fromEntries(r.posture.map((x) => [x.id, x]));
    expect(p["required-checks"]).toMatchObject({ status: "ok", label: "Required checks: check" });
    expect(p["pull-request"].status).toBe("ok");
    expect(p.bypass).toMatchObject({ status: "warn" });
    expect(p.bypass.detail).toContain("You can bypass these rules (Protect main (always)). The app never does");
    expect(p["auto-merge"].label).toBe("Repository auto-merge is off");
    expect(p.unattributed).toMatchObject({ status: "unverified" });
    expect(p.public.detail).toContain("public");
    expect(p["merge-commits"].status).toBe("ok");
    // Every call was a read.
    for (const c of calls()) {
      expect(c.argv).not.toContain("-X");
      expect(c.argv).not.toContain("--method");
      expect(["--version", "api"]).toContain(c.argv[0]);
      expect(c.stdin).toBe("");
    }
    expect(calls().map((c) => c.argv[1]).filter(Boolean)).toEqual(["user", "repos/octo/app", "repos/octo/app/rules/branches/main", "repos/octo/app/branches/main/protection/required_status_checks", "repos/octo/app/branches/main/protection/required_pull_request_reviews", "repos/octo/app/rulesets", "repos/octo/app/rulesets/24227602"]);
  });

  it("no required check, a merge queue and required approvals are reported as reasons automatic merging is unavailable", async () => {
    rules([
      { match: "rules/branches/main", stdout: JSON.stringify([{ type: "merge_queue", parameters: {} }, { type: "pull_request", parameters: { required_approving_review_count: 2 } }]) },
      { match: "protection/required_status_checks", stderr: "gh: Not Found (HTTP 404)\n", code: 1 },
  { match: "protection/required_pull_request_reviews", stderr: "gh: Not Found (HTTP 404)\n", code: 1 },
      { match: "rulesets", stdout: "" },
      { match: "api repos/octo/app", stdout: JSON.stringify({ push: true, archived: false, mergeCommit: false, autoMerge: true, deleteOnMerge: false, private: true }) },
      ...PREFLIGHT.slice(0, 2),
    ]);
    const r = await host().preflight({ remoteUrl: "https://github.com/octo/app", base: "main" });
    expect(r.ok).toBe(true);
    expect(r.requiredChecks).toEqual([]);
    expect(r.autoMergeBlockers).toEqual(["no required check", "a merge queue is required", "merge commits are not allowed", "2 approving review(s) required"]);
    expect(r.posture.find((x) => x.id === "required-checks")).toMatchObject({ status: "fail" });
    // Kept as facts, so the gate can refuse a merge for the user's path too (gh would enqueue it).
    expect(r).toMatchObject({ mergeQueue: true, mergeCommitsAllowed: false });
    expect(r.posture.find((x) => x.id === "merge-queue")!.detail).toMatch(/would enqueue the pull request or switch on GitHub's own auto-merge/);
    rules(PREFLIGHT);
    const plain = await host().preflight({ remoteUrl: "https://github.com/octo/app", base: "main" });
    expect(plain.mergeQueue).toBeUndefined();
    expect(plain.mergeCommitsAllowed).toBeUndefined();
  });

  it("a ruleset that cannot be read does not hide the others, and approvals required by classic protection count", async () => {
    rules([
      { match: "protection/required_pull_request_reviews", stdout: "2\n" },
      { match: "rulesets/111", stderr: "gh: Not Found (HTTP 404)\n", code: 1 },
      { match: "rulesets/24227602", stdout: JSON.stringify({ name: "Protect main", enforcement: "active", current_user_can_bypass: "always" }) },
      { match: "rulesets", stdout: "111\n24227602\n" },
      ...PREFLIGHT,
    ]);
    const r = await host().preflight({ remoteUrl: "https://github.com/octo/app.git", base: "main" });
    expect(r.ok).toBe(true);
    // The first ruleset answered 404; the second was still read.
    expect(calls().map((c) => c.argv[1]).filter((a) => a?.includes("rulesets/"))).toEqual(["repos/octo/app/rulesets/111", "repos/octo/app/rulesets/24227602"]);
    expect(r.posture.find((x) => x.id === "bypass")).toMatchObject({ status: "warn" });
    expect(r.autoMergeBlockers).toEqual(["2 approving review(s) required"]);
    expect(r.posture.find((x) => x.id === "approvals")).toMatchObject({ status: "warn" });
  });

  it("stops with an actionable problem: gh missing or too old, not signed in, not GitHub, no push permission", async () => {
    expect(await new GhCliHost({ ghBin: join(dir, "no-such-gh"), cwd }).preflight({ remoteUrl: "git@github.com:octo/app.git", base: "main" })).toMatchObject({ ok: false, problem: { code: "gh-missing" } });

    rules([{ match: "--version", stdout: "gh version 2.12.1 (2022-07-01)\n" }]);
    expect(await host().preflight({ remoteUrl: "git@github.com:octo/app.git", base: "main" })).toMatchObject({ ok: false, problem: { code: "gh-old" }, ghVersion: "2.12.1" });

    rules([PREFLIGHT[0]]);
    const old = mkdtempSync(join(tmpdir(), "orch-oldgit-"));
    const oldGit = join(old, "git");
    writeFileSync(oldGit, "#!/bin/sh\necho 'git version 2.39.5'\n", { mode: 0o755 });
    expect(await new GhCliHost({ ghBin: FAKE_GH, gitBin: oldGit, cwd }).preflight({ remoteUrl: "git@github.com:octo/app.git", base: "main" })).toMatchObject({ ok: false, problem: { code: "git-old" } });
    rmSync(old, { recursive: true, force: true });

    for (const notGitHub of ["/tmp/origin.git", "https://gitlab.com/octo/app.git", "https://ghe.example.com/octo/app.git", "https://github.com.evil.example/octo/app"]) {
      expect(await host().preflight({ remoteUrl: notGitHub, base: "main" }), notGitHub).toMatchObject({ ok: false, problem: { code: "remote" } });
    }

    rules([PREFLIGHT[0], { match: "api user", stderr: "gh: To get started with GitHub CLI, please run:  gh auth login\n", code: 4 }]);
    const auth = await host().preflight({ remoteUrl: "git@github.com:octo/app.git", base: "main" });
    expect(auth).toMatchObject({ ok: false, problem: { code: "auth" } });
    expect(auth.problem!.message).toContain("gh auth login");

    rules([...PREFLIGHT.slice(0, 2), { match: "api repos/octo/app", stdout: JSON.stringify({ push: false, archived: false }) }]);
    expect(await host().preflight({ remoteUrl: "git@github.com:octo/app.git", base: "main" })).toMatchObject({ ok: false, problem: { code: "permission" }, login: "octocat" });
  });
});

describe("parsing", () => {
  it("a github.com remote in its https, ssh and scp-like forms; nothing else", () => {
    for (const url of ["https://github.com/octo/app.git", "https://github.com/octo/app", "git@github.com:octo/app.git", "ssh://git@github.com/octo/app.git", "https://x-access@github.com/octo/app.git"]) expect(parseGitHubRemote(url), url).toEqual(REPO);
    for (const url of ["", "/local/path.git", "https://gitlab.com/octo/app", "https://github.com/octo", "https://github.com/octo/app/extra", "git@github.com.evil.example:octo/app.git"]) expect(parseGitHubRemote(url), url).toBeUndefined();
  });

  it("the pull request number from the address gh prints", () => {
    expect(parsePrUrl("Creating pull request…\nhttps://github.com/octo/app/pull/345\n")).toEqual({ number: 345, url: "https://github.com/octo/app/pull/345" });
    expect(parsePrUrl("nothing useful")).toBeUndefined();
  });

  it("the batched read: one alias per pull request and commit, checks with isRequired, and no checks reported as pending", async () => {
    const q = buildObserveQuery(REPO, [12, 13], [SHA]);
    expect(q).toContain('repository(owner:"octo",name:"app")');
    expect(q).toContain("p12:pullRequest(number:12)");
    expect(q).toContain("isRequired(pullRequestNumber:13)");
    expect(q).toContain(`c0:object(oid:"${SHA}")`);
    expect(q).toContain("rateLimit{remaining resetAt}");
    expect(q).not.toMatch(/mutation/);
    // Numbers and commit ids are validated before they are placed in the query.
    expect(() => buildObserveQuery(REPO, [1.5], [])).toThrow();
    expect(() => buildObserveQuery(REPO, [], ['"){evil}'])).toThrow();
    expect(() => buildObserveQuery({ owner: 'o"', name: "app" }, [], [])).toThrow();

    const response = {
      data: {
        repository: {
          p12: {
            number: 12,
            state: "OPEN",
            isDraft: false,
            isCrossRepository: false,
            url: "https://github.com/octo/app/pull/12",
            mergedAt: null,
            mergedBy: null,
            mergeCommit: null,
            headRefName: "orchestration/p1/pr/T-1-1",
            headRefOid: SHA,
            baseRefName: "main",
            mergeable: "MERGEABLE",
            mergeStateStatus: "BLOCKED",
            reviewDecision: "REVIEW_REQUIRED",
            labels: { nodes: [{ name: "orchestration:hold" }] },
            timelineItems: { nodes: [] },
            commits: {
              nodes: [
                {
                  commit: {
                    oid: SHA,
                    statusCheckRollup: {
                      contexts: {
                        nodes: [
                          { __typename: "CheckRun", name: "check", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://github.com/octo/app/actions/runs/1", isRequired: true },
                          { __typename: "CheckRun", name: "lint", status: "IN_PROGRESS", conclusion: null, isRequired: false },
                          { __typename: "StatusContext", context: "ci/legacy", state: "FAILURE", targetUrl: "https://ci.example/1", isRequired: false },
                          { __typename: "StatusContext", context: "ci/pending", state: "PENDING", isRequired: true },
                        ],
                      },
                    },
                  },
                },
              ],
            },
          },
          p13: {
            number: 13,
            state: "MERGED",
            isDraft: false,
            isCrossRepository: false,
            url: "https://github.com/octo/app/pull/13",
            mergedAt: "2026-09-30T12:00:00Z",
            mergedBy: { login: "octocat" },
            mergeCommit: { oid: "b".repeat(40) },
            headRefName: "orchestration/p1/pr/T-2-1",
            headRefOid: "c".repeat(40),
            baseRefName: "main",
            mergeable: "UNKNOWN",
            mergeStateStatus: "UNKNOWN",
            reviewDecision: null,
            labels: { nodes: [] },
            timelineItems: { nodes: [] },
            commits: { nodes: [{ commit: { oid: "c".repeat(40), statusCheckRollup: null } }] },
          },
          c0: { oid: SHA, statusCheckRollup: null },
        },
        rateLimit: { remaining: 4321, resetAt: "2026-09-30T13:00:00Z" },
      },
    };
    rules([{ match: "graphql", stdout: JSON.stringify(response) }]);
    const o = await host().observe({ repo: REPO, prs: [12, 13], commits: [SHA] });
    expect(o.rateRemaining).toBe(4321);
    expect(o.prs[0]).toMatchObject({ number: 12, state: "OPEN", headSha: SHA, checksFor: SHA, mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED", labels: ["orchestration:hold"], crossRepo: false });
    expect(o.prs[0].checks).toEqual([
      { name: "check", required: true, status: "COMPLETED", conclusion: "SUCCESS", url: "https://github.com/octo/app/actions/runs/1", kind: "run" },
      { name: "lint", required: false, status: "IN_PROGRESS", conclusion: null, kind: "run" },
      { name: "ci/legacy", required: false, status: "COMPLETED", conclusion: "FAILURE", url: "https://ci.example/1", kind: "status" },
      { name: "ci/pending", required: true, status: "PENDING", conclusion: null, kind: "status" },
    ]);
    expect(o.prs[1]).toMatchObject({ number: 13, state: "MERGED", mergeCommit: "b".repeat(40), mergedBy: "octocat", checks: [] });
    expect(o.commits).toEqual([{ oid: SHA, checks: [] }]); // nothing reported: pending, never a pass
    expect(parseChecks(null)).toEqual([]);
    expect(parseObserveResponse(JSON.stringify({ data: { repository: { p12: null } } }), [12], [])).toEqual({ prs: [], commits: [] });
    expect(() => parseObserveResponse("not json", [12], [])).toThrow(GhError);
  });

  it("adopts only the app's own pull request: by its marker, and never one from another repository", async () => {
    rules([
      {
        match: "pr list",
        stdout: JSON.stringify([
          { number: 3, url: "https://github.com/octo/app/pull/3", state: "OPEN", body: "someone else's", isCrossRepository: false },
          { number: 4, url: "https://github.com/octo/app/pull/4", state: "OPEN", body: "x <!-- m --> y", isCrossRepository: true },
          { number: 5, url: "https://github.com/octo/app/pull/5", state: "CLOSED", body: "mine <!-- m -->", isCrossRepository: false },
        ]),
      },
    ]);
    expect(await host().findPr({ repo: REPO, head: "b", marker: "<!-- m -->" })).toEqual({ number: 5, url: "https://github.com/octo/app/pull/5" });
    rules([{ match: "--paginate", stdout: "https://github.com/octo/app/pull/5#issuecomment-9\n" }]);
    expect(await host().findComment({ repo: REPO, number: 5, marker: "<!-- n -->" })).toEqual({ url: "https://github.com/octo/app/pull/5#issuecomment-9" });
    // A comment is "posted" only with its address.
    rules([{ match: "-X POST", stdout: "{}" }]);
    await expect(host().comment({ repo: REPO, number: 5, body: "x" })).rejects.toThrow(/did not return the comment's address/);
  });
});

describe("adapter edge cases", () => {
  it("when a check name reports more than once, anything that is not a success wins over a success", () => {
    const run = (name: string, conclusion: string | null, isRequired = false) => ({ __typename: "CheckRun", name, status: conclusion ? "COMPLETED" : "IN_PROGRESS", conclusion, isRequired });
    const one = (nodes: unknown[]) => parseChecks({ contexts: { nodes: nodes as never } }).find((c) => c.name === "check")!;
    expect(one([run("check", "FAILURE", true), run("check", "SUCCESS")])).toMatchObject({ conclusion: "FAILURE", required: true });
    expect(one([run("check", "SUCCESS", true), run("check", "FAILURE")])).toMatchObject({ conclusion: "FAILURE", required: true });
    expect(one([run("check", "SUCCESS"), run("check", null)])).toMatchObject({ conclusion: null });
    expect(one([run("check", null), run("check", "SUCCESS")])).toMatchObject({ conclusion: null });
    expect(one([run("check", "SKIPPED"), run("check", "SUCCESS"), run("check", "SUCCESS")])).toMatchObject({ conclusion: "SKIPPED" });
    expect(one([run("check", "SUCCESS"), run("check", "SUCCESS")])).toMatchObject({ conclusion: "SUCCESS" });
    // A status context and a check run of the same name are the same check.
    expect(one([{ __typename: "StatusContext", context: "check", state: "FAILURE" }, run("check", "SUCCESS")])).toMatchObject({ conclusion: "FAILURE" });
  });

  it("only the endpoint and the query are scanned, so a note that names a mutation can be posted, and a mutation in a query still cannot", async () => {
    const note = "Please do not use mergePullRequest or enablePullRequestAutoMerge here; see /pulls/5/merge and deleteRef.";
    expect(() => assertAllowedGh(["api", "-X", "POST", "repos/octo/app/issues/5/comments", "--input", "-"], JSON.stringify({ body: note }))).not.toThrow();
    rules([{ match: "-X POST", stdout: JSON.stringify({ html_url: "https://github.com/octo/app/pull/5#issuecomment-9" }) }]);
    expect(await host().comment({ repo: REPO, number: 5, body: note })).toEqual({ url: "https://github.com/octo/app/pull/5#issuecomment-9" });
    expect(calls().at(-1)!.stdin).toContain("mergePullRequest");
    // The endpoint is still scanned, and so is what GitHub would execute.
    expect(() => assertAllowedGh(["api", "-X", "POST", "repos/octo/app/pulls/5/merge", "--input", "-"], "{}")).toThrow(/merge endpoint/);
    expect(() => assertAllowedGh(["api", "graphql", "--input", "-"], JSON.stringify({ query: "mutation{mergePullRequest(input:{pullRequestId:\"x\"}){clientMutationId}}" }))).toThrow(/refusing/);
    expect(() => assertAllowedGh(["api", "graphql", "--input", "-"], "mutation{enablePullRequestAutoMerge(input:{}){clientMutationId}}")).toThrow(/refusing/);
    // Data next to a clean query is data.
    expect(() => assertAllowedGh(["api", "graphql", "--input", "-"], JSON.stringify({ query: "query{viewer{login}}", variables: { text: "mergePullRequest" } }))).not.toThrow();
  });

  it("gh's hints about --auto and --admin are never shown as the problem", () => {
    const stderr = "X Pull request octo/app#5 is not mergeable: the base branch policy prohibits the merge.\nTo have the pull request merged after all the requirements have been met, add the `--auto` flag.\nTo use administrator privileges to immediately merge the pull request, add the `--admin` flag.\n";
    const msg = shortError(stderr);
    expect(msg).toBe("X Pull request octo/app#5 is not mergeable: the base branch policy prohibits the merge.");
    expect(classifyGhError(1, stderr)).toMatchObject({ code: "rejected", message: msg });
    expect(shortError("add the `--admin` flag.\n")).toBe("GitHub refused the request.");
    expect(shortError("")).toBe("");
  });

  it("the fake gh honours the repository argument, and every per-pull-request call names its repository", async () => {
    setEnv("FAKE_GH_REPO", "octo/app");
    rules([
      { match: "pr list", stdout: "[]" },
      { match: "api graphql", stdout: JSON.stringify({ data: { repository: {}, rateLimit: { remaining: 4999 } } }) },
    ]);
    const other = { owner: "octo", name: "other" };
    await expect(host().merge({ repo: other, number: 5, headSha: SHA, subject: "s", body: "b" })).rejects.toMatchObject({ code: "not-found" });
    await expect(host().close({ repo: other, number: 5, comment: "c" })).rejects.toMatchObject({ code: "not-found" });
    await expect(host().comment({ repo: other, number: 5, body: "x" })).rejects.toMatchObject({ code: "not-found" });
    await expect(host().findComment({ repo: other, number: 5, marker: "m" })).rejects.toMatchObject({ code: "not-found" });
    await expect(host().findPr({ repo: other, head: "h", marker: "m" })).rejects.toMatchObject({ code: "not-found" });
    await expect(host().observe({ repo: other, prs: [5], commits: [] })).rejects.toMatchObject({ code: "not-found" });
    // The same calls for the repository the fake serves go through.
    await host().merge({ repo: REPO, number: 5, headSha: SHA, subject: "s", body: "b" });
    await host().close({ repo: REPO, number: 5, comment: "c" });
    expect(await host().findPr({ repo: REPO, head: "h", marker: "m" })).toBeUndefined();
    expect((await host().observe({ repo: REPO, prs: [5], commits: [] })).prs).toEqual([]);
    setEnv("FAKE_GH_REPO", undefined);
  });
});

describe("errors", () => {
  it("classifies exits: sign-in, rate limit, head mismatch, refusal, not found, network", () => {
    expect(classifyGhError(4, "gh auth login").code).toBe("auth");
    expect(classifyGhError(1, "HTTP 401: Bad credentials").code).toBe("auth");
    expect(classifyGhError(1, "API rate limit exceeded for user ID 1. (HTTP 403)").code).toBe("rate-limit");
    expect(classifyGhError(1, "You have exceeded a secondary rate limit").code).toBe("rate-limit");
    expect(classifyGhError(1, "GraphQL: Head branch was modified. Review and try the merge again.").code).toBe("head-mismatch");
    expect(classifyGhError(1, "Pull request is not mergeable: the base branch policy prohibits the merge.").code).toBe("rejected");
    expect(classifyGhError(1, "gh: Not Found (HTTP 404)").code).toBe("not-found");
    expect(classifyGhError(1, "dial tcp: lookup api.github.com: no such host\ncould not resolve host").code).toBe("network");
    expect(classifyGhError(1, "something else").code).toBe("unknown");
  });

  it("a token echoed by gh never reaches the error: it is redacted, and messages stay short", async () => {
    rules([{ match: "pr close", stderr: `first line\nremote: invalid credentials for $GH_TOKEN and github_pat_11ABCDEFG0abcdefghij_xyz ${"x".repeat(600)}\n`, code: 1 }]);
    const err = (await host()
      .close({ repo: REPO, number: 1, comment: "c" })
      .catch((e: unknown) => e)) as GhError;
    expect(err).toBeInstanceOf(GhError);
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).not.toContain("github_pat_");
    expect(err.message).toContain("***");
    expect(err.message.length).toBeLessThanOrEqual(300);
    expect(shortError(`a\nb\nc ${TOKEN}`)).toBe("b c ***");
    // The token was available to gh itself (the user's own sign-in), and the app never asked for it.
    expect(calls().every((c) => c.argv[0] !== "auth")).toBe(true);
  });

  it("exit 4 is a sign-in problem; rate-limit text is a rate limit", async () => {
    rules([{ match: "pr list", stderr: "gh: To get started with GitHub CLI, please run:  gh auth login\n", code: 4 }]);
    await expect(host().findPr({ repo: REPO, head: "b", marker: "m" })).rejects.toMatchObject({ code: "auth" });
    rules([{ match: "graphql", stderr: "gh: API rate limit exceeded (HTTP 403)\n", code: 1 }]);
    await expect(host().observe({ repo: REPO, prs: [1], commits: [] })).rejects.toMatchObject({ code: "rate-limit" });
  });

  it("a gh that hangs is killed at the timeout", async () => {
    rules([{ match: "pr close", sleepMs: 30_000 }]);
    const started = Date.now();
    await expect(host(300).close({ repo: REPO, number: 1, comment: "c" })).rejects.toMatchObject({ code: "timeout" });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("abortAll stops a call in flight", async () => {
    rules([{ match: "pr close", sleepMs: 30_000 }]);
    const h = host(20_000);
    const p = h.close({ repo: REPO, number: 1, comment: "c" }).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 300));
    h.abortAll();
    expect(await p).toMatchObject({ code: "timeout" });
  });

  it("the neutral directory is created by the host and stays empty", () => {
    const d = join(dir, "fresh", "gh-neutral");
    new GhCliHost({ ghBin: FAKE_GH, cwd: d });
    expect(readdirSync(d)).toEqual([]);
    mkdirSync(d, { recursive: true });
  });
});

describe("CI triage in the adapter", () => {
  const T = (s: string) => `2026-09-30T12:${s}Z`;
  /** The observation's own time: every dated run below started before it unless a test says otherwise. */
  const NOW = Date.parse("2026-09-30T13:00:00Z");
  const run = (name: string, conclusion: string | null, o: { startedAt?: string | null; completedAt?: string; id?: number; app?: string; status?: string; isRequired?: boolean; workflowId?: number | null; workflowName?: string | null; event?: string | null } = {}) => ({
    __typename: "CheckRun",
    name,
    status: o.status ?? (conclusion ? "COMPLETED" : "IN_PROGRESS"),
    conclusion,
    databaseId: o.id ?? 1,
    startedAt: o.startedAt === undefined ? null : o.startedAt,
    ...(o.completedAt ? { completedAt: o.completedAt } : {}),
    checkSuite: { app: { slug: o.app ?? "github-actions" }, workflowRun: { databaseId: 77, event: o.event === undefined ? "pull_request" : o.event, workflow: { databaseId: o.workflowId === undefined ? 5 : o.workflowId, name: o.workflowName === undefined ? "CI" : o.workflowName } } },
    isRequired: o.isRequired ?? false,
  });
  const one = (nodes: unknown[], name = "check", nowMs = NOW) => parseChecks({ contexts: { nodes: nodes as never } }, nowMs).find((c) => c.name === name)!;

  it("parseChecks: a newer run wins only over a completed, dated CANCELLED run of the same app, workflow and job name that started strictly before it and not in the future (mutation check: the strict 'before')", () => {
    // Cancelled, then a later success: green, carrying the winning run's ids.
    expect(one([run("check", "CANCELLED", { startedAt: T("00:00"), id: 1, isRequired: true }), run("check", "SUCCESS", { startedAt: T("05:00"), id: 2 })])).toMatchObject({ conclusion: "SUCCESS", jobId: 2, runId: 77, workflowId: 5, workflowName: "CI", event: "pull_request", required: true, startedAt: T("05:00") });
    // Only a cancelled run is superseded: a failure, a skipped or a stale run next to a later success stays.
    for (const older of ["FAILURE", "TIMED_OUT", "SKIPPED", "STALE", "NEUTRAL", "ACTION_REQUIRED"]) expect(one([run("check", older, { startedAt: T("00:00"), id: 1 }), run("check", "SUCCESS", { startedAt: T("05:00"), id: 2 })]).conclusion, older).toBe(older);
    // The same workflow, by id; or by name and event when the id is missing; never across workflows or apps.
    expect(one([run("check", "CANCELLED", { startedAt: T("00:00"), id: 1, workflowId: 6 }), run("check", "SUCCESS", { startedAt: T("05:00"), id: 2, workflowId: 5 })])).toMatchObject({ conclusion: "CANCELLED", jobId: 1 });
    expect(one([run("check", "CANCELLED", { startedAt: T("00:00"), id: 1, workflowId: null }), run("check", "SUCCESS", { startedAt: T("05:00"), id: 2, workflowId: null })])).toMatchObject({ conclusion: "SUCCESS" }); // name "CI" + event agree
    expect(one([run("check", "CANCELLED", { startedAt: T("00:00"), id: 1, workflowId: null, event: "push" }), run("check", "SUCCESS", { startedAt: T("05:00"), id: 2, workflowId: null })])).toMatchObject({ conclusion: "CANCELLED" });
    expect(one([run("check", "CANCELLED", { startedAt: T("00:00"), id: 1, workflowId: null, workflowName: "Nightly" }), run("check", "SUCCESS", { startedAt: T("05:00"), id: 2, workflowId: null })])).toMatchObject({ conclusion: "CANCELLED" });
    expect(one([run("check", "CANCELLED", { startedAt: T("00:00"), id: 1, workflowId: null, workflowName: null, event: null }), run("check", "SUCCESS", { startedAt: T("05:00"), id: 2, workflowId: null, workflowName: null, event: null })])).toMatchObject({ conclusion: "CANCELLED" }); // nothing known: fail closed
    expect(one([run("check", "CANCELLED", { startedAt: T("00:00"), id: 1, app: "circleci" }), run("check", "SUCCESS", { startedAt: T("05:00"), id: 2 })])).toMatchObject({ conclusion: "CANCELLED" });
    expect(one([run("check", "CANCELLED", { startedAt: T("00:00"), id: 1 }), { ...run("check", "SUCCESS", { startedAt: T("05:00"), id: 2 }), checkSuite: { app: null, workflowRun: null } }])).toMatchObject({ conclusion: "CANCELLED" });
    // A success dated in the future (after the observation) supersedes nothing (mutation check).
    expect(one([run("check", "CANCELLED", { startedAt: T("00:00"), id: 1 }), run("check", "SUCCESS", { startedAt: T("05:00"), id: 2 })], "check", Date.parse(T("04:59")))).toMatchObject({ conclusion: "CANCELLED" });
    expect(one([run("check", "CANCELLED", { startedAt: T("00:00"), id: 1 }), run("check", "SUCCESS", { startedAt: T("05:00"), id: 2 })], "check", Date.parse(T("05:00")))).toMatchObject({ conclusion: "SUCCESS" });
    // completedAt is carried for the timing rule.
    expect(one([run("check", "CANCELLED", { startedAt: T("00:00"), completedAt: T("30:00"), id: 1 })])).toMatchObject({ conclusion: "CANCELLED", startedAt: T("00:00"), completedAt: T("30:00") });
    // A success, then a later cancel: red (the cancel is newer).
    expect(one([run("check", "SUCCESS", { startedAt: T("00:00"), id: 1 }), run("check", "CANCELLED", { startedAt: T("05:00"), id: 2 })])).toMatchObject({ conclusion: "CANCELLED", jobId: 2 });
    // A tie at whole-second resolution, or an undated run: the worst wins (fail closed).
    expect(one([run("check", "CANCELLED", { startedAt: T("05:00"), id: 1 }), run("check", "SUCCESS", { startedAt: T("05:00"), id: 2 })])).toMatchObject({ conclusion: "CANCELLED" });
    expect(one([run("check", "SUCCESS", { startedAt: T("05:00"), id: 2 }), run("check", "CANCELLED", { startedAt: T("05:00"), id: 1 })])).toMatchObject({ conclusion: "CANCELLED" }); // whichever GitHub lists first
    expect(one([run("check", null, { startedAt: T("05:00"), id: 2 }), run("check", "CANCELLED", { startedAt: T("05:00"), id: 1 })])).toMatchObject({ conclusion: "CANCELLED" });
    expect(one([run("check", "CANCELLED", { startedAt: null, id: 1 }), run("check", "SUCCESS", { startedAt: T("05:00"), id: 2 })])).toMatchObject({ conclusion: "CANCELLED" });
    expect(one([run("check", "CANCELLED", { startedAt: T("00:00"), id: 1 }), run("check", "SUCCESS", { startedAt: null, id: 2 })])).toMatchObject({ conclusion: "CANCELLED" });
    // Sub-second or non-UTC timestamps are not trusted for supersession.
    expect(one([run("check", "CANCELLED", { startedAt: "2026-09-30T12:00:00.500Z", id: 1 }), run("check", "SUCCESS", { startedAt: "2026-09-30T12:00:01.000Z", id: 2 })])).toMatchObject({ conclusion: "CANCELLED" });
    // A pending run keeps the name pending, even next to a newer success.
    expect(one([run("check", null, { startedAt: T("00:00"), id: 1 }), run("check", "SUCCESS", { startedAt: T("05:00"), id: 2 })])).toMatchObject({ conclusion: null });
    // A re-run still going, started strictly after the cancelled run, keeps the name pending (not red), carrying the new run's id.
    expect(one([run("check", "CANCELLED", { startedAt: T("00:00"), id: 1 }), run("check", null, { startedAt: T("05:00"), id: 2 })])).toMatchObject({ conclusion: null, jobId: 2 });
    // A newer failure is never hidden by anything, and an undated pending run does not supersede a failure.
    expect(one([run("check", "SUCCESS", { startedAt: T("00:00"), id: 1 }), run("check", "FAILURE", { startedAt: T("05:00"), id: 2 })])).toMatchObject({ conclusion: "FAILURE" });
    expect(one([run("check", "CANCELLED", { startedAt: T("00:00"), id: 1 }), run("check", null, { startedAt: null, id: 2 })])).toMatchObject({ conclusion: "CANCELLED" });
    // A failure that is not completed (GitHub's status says so) does not count as superseded.
    expect(one([run("check", "FAILURE", { startedAt: T("00:00"), id: 1, status: "IN_PROGRESS" }), run("check", "SUCCESS", { startedAt: T("05:00"), id: 2 })])).toMatchObject({ conclusion: "FAILURE" });
    // SKIPPED and NEUTRAL are never green, and a later success does not supersede them (only a cancelled run is superseded).
    expect(one([run("check", "SKIPPED", { startedAt: T("00:00"), id: 1 })])).toMatchObject({ conclusion: "SKIPPED" });
    expect(one([run("check", "SKIPPED", { startedAt: T("00:00"), id: 1 }), run("check", "SUCCESS", { startedAt: T("05:00"), id: 2 })])).toMatchObject({ conclusion: "SKIPPED" });
    // Status contexts are never superseded: one state per context.
    expect(one([{ __typename: "StatusContext", context: "check", state: "FAILURE", creator: { login: "ci-bot[bot]" } }, run("check", "SUCCESS", { startedAt: T("05:00"), id: 2 })])).toMatchObject({ conclusion: "FAILURE", kind: "status", app: "ci-bot" });
    // Among equal failures the newer run is kept (the one a re-run would target).
    expect(one([run("check", "CANCELLED", { startedAt: T("00:00"), id: 1 }), run("check", "CANCELLED", { startedAt: T("05:00"), id: 2 })])).toMatchObject({ jobId: 2 });
    // Ids are validated: a non-integer or non-positive databaseId is dropped, and the app slug comes through.
    expect(one([run("check", "CANCELLED", { id: 0 })]).jobId).toBeUndefined();
    expect(one([{ ...run("check", "CANCELLED"), databaseId: "12" }]).jobId).toBeUndefined();
    expect(one([run("check", "FAILURE", { app: "coderabbitai", id: 9 })])).toMatchObject({ app: "coderabbitai", jobId: 9, kind: "run" });
  });

  it("the observe query asks for the fields triage needs; parseObserveResponse carries them", async () => {
    const q = buildObserveQuery(REPO, [12], []);
    expect(q).toContain("databaseId startedAt completedAt checkSuite{app{slug} workflowRun{databaseId event workflow{databaseId name}}}");
    expect(q).toContain("creator{login}");
    const o = parseObserveResponse(
      JSON.stringify({ data: { repository: { p12: { number: 12, state: "OPEN", headRefOid: SHA, commits: { nodes: [{ commit: { oid: SHA, statusCheckRollup: { contexts: { nodes: [run("build", "CANCELLED", { startedAt: T("00:00"), completedAt: T("01:00"), id: 4242, isRequired: true })] } } } }] } } } } }),
      [12],
      [],
      NOW,
    );
    expect(o.prs[0].checks).toEqual([{ name: "build", required: true, status: "COMPLETED", conclusion: "CANCELLED", kind: "run", app: "github-actions", jobId: 4242, runId: 77, workflowId: 5, workflowName: "CI", event: "pull_request", startedAt: T("00:00"), completedAt: T("01:00") }]);
  });

  it("gh is allow-listed by subcommand; a gh api write goes only to comments, job re-runs and the scanned graphql, whatever way the method or body is spelled", () => {
    // The app's own invocations.
    for (const args of [
      ["--version"],
      ["api", "user", "--jq", ".login"],
      ["api", "repos/octo/app/rules/branches/main"],
      ["api", "repos/octo/app/issues/5/comments", "--paginate", "--jq", ".[] | .html_url"],
      ["api", "-X", "POST", "repos/octo/app/issues/5/comments", "--input", "-"],
      ["api", "-X", "POST", "repos/octo/app/actions/jobs/123/rerun"],
      ["api", "graphql", "--input", "-"],
      ["pr", "list", "-R", "octo/app", "--head", "x", "--state", "all", "--json", "number", "--limit", "10"],
      ["pr", "create", "-R", "octo/app", "--base", "main", "--head", "x", "--title", "t", "--body-file", "-"],
      ["pr", "merge", "5", "-R", "octo/app", "--merge", "--match-head-commit", SHA, "--subject", "s", "--body-file", "-"],
      ["pr", "close", "5", "-R", "octo/app", "--comment", "c"],
    ]) {
      expect(() => assertAllowedGh(args, args.includes("graphql") ? JSON.stringify({ query: "query{viewer{login}}" }) : "{}"), args.join(" ")).not.toThrow();
    }
    // Subcommands the app never runs.
    for (const args of [["pr", "review", "5", "--approve"], ["run", "rerun", "1"], ["workflow", "run", "ci.yml"], ["pr", "edit", "5"], ["pr", "ready", "5"], ["repo", "delete"], ["release", "create"], ["gist", "create"], ["pr"], []]) {
      expect(() => assertAllowedGh(args), args.join(" ")).toThrow(/refusing to run gh/);
    }
    // The bypasses the reviewer probed: every spelling of a write, to an endpoint the app never writes to.
    for (const args of [
      ["api", "repos/o/r/pulls/1/reviews", "-f", "event=APPROVE"],
      ["api", "repos/o/r/pulls/1/reviews", "--input", "-"],
      ["api", "-XPOST", "repos/o/r/pulls/1/reviews"],
      ["api", "--method=POST", "repos/o/r/pulls/1/reviews"],
      ["api", "-XDELETE", "repos/o/r/git/refs/heads/main"],
      ["api", "--method=PATCH", "repos/o/r/pulls/1"],
      ["api", "-X", "GET", "-X", "POST", "repos/o/r/pulls/1/reviews"],
      ["api", "-X", "POST", "-X", "GET", "repos/o/r/pulls/1/reviews", "-f", "event=APPROVE"], // a body is a write whatever the method says
      ["api", "repos/o/r/pulls/1/reviews", "-F", "event=APPROVE"],
      ["api", "repos/o/r/pulls/1/reviews", "--field", "event=APPROVE"],
      ["api", "repos/o/r/pulls/1/reviews", "--field=event=APPROVE"],
      ["api", "repos/o/r/pulls/1/reviews", "--raw-field", "body=x"],
      ["api", "repos/o/r/pulls/1/reviews", "-fevent=APPROVE"],
      ["api", "--input=/tmp/body.json", "repos/o/r/issues/1/comments"], // a body from a file is never sent
      ["api", "-X", "PUT", "repos/o/r/actions/jobs/1/rerun"],
      ["api", "-X", "POST", "repos/o/r/actions/runs/1/rerun"],
      ["api", "-X", "POST", "--paginate", "repos/o/r/pulls/1/reviews"],
      ["api", "-H", "Accept: x", "-X", "POST", "repos/o/r/pulls/1/reviews"],
    ]) {
      expect(() => assertAllowedGh(args), args.join(" ")).toThrow(GhError);
    }
    // GraphQL: the app sends no mutation at all; a query is fine, and a mutation named only in a variable is data.
    expect(() => assertAllowedGh(["api", "graphql", "--input", "-"], JSON.stringify({ query: "query{viewer{login}}" }))).not.toThrow();
    expect(() => assertAllowedGh(["api", "graphql", "--input", "-"], JSON.stringify({ query: "mutation{addComment(input:{}){clientMutationId}}" }))).toThrow(/refusing to send a GraphQL mutation/);
    expect(() => assertAllowedGh(["api", "graphql", "--input", "-"], "mutation { x }")).toThrow(/mutation/);
    expect(() => assertAllowedGh(["api", "graphql", "-f", "query=mutation{addComment(input:{}){clientMutationId}}"])).toThrow(/mutation/);
    expect(() => assertAllowedGh(["api", "-X", "POST", "graphql", "-f", "query=query{viewer{login}}"])).not.toThrow();
    expect(() => assertAllowedGh(["api", "graphql", "--input", "-"], JSON.stringify({ query: "query{viewer{login}}", variables: { text: "mutation mergePullRequest" } }))).not.toThrow();
    // How the guard reads an invocation.
    expect(parseApiCall(["api", "repos/o/r", "--jq", ".x"])).toEqual({ method: "GET", hasBody: false, endpoint: "repos/o/r" });
    expect(parseApiCall(["api", "-X", "GET", "-X", "POST", "repos/o/r"])).toMatchObject({ method: "POST", endpoint: "repos/o/r" });
    expect(parseApiCall(["api", "-XDELETE", "repos/o/r"])).toMatchObject({ method: "DELETE" });
    expect(parseApiCall(["api", "--method=patch", "repos/o/r"])).toMatchObject({ method: "PATCH" });
    expect(parseApiCall(["api", "repos/o/r", "-f", "a=b"])).toMatchObject({ method: "POST", hasBody: true, endpoint: "repos/o/r" });
    expect(parseApiCall(["api", "--input", "-", "graphql"])).toMatchObject({ method: "POST", hasBody: true, endpoint: "graphql", input: "-" });
    expect(parseApiCall(["api", "-H", "Accept: x", "-q", ".y", "repos/o/r"])).toMatchObject({ endpoint: "repos/o/r" });
  });

  it("rerunJob sends exactly `api -X POST repos/o/r/actions/jobs/<id>/rerun`, checks the id first, and the guard allows nothing else to be POSTed", async () => {
    rules([{ match: "actions/jobs/123/rerun", stdout: "" }]);
    await host().rerunJob({ repo: REPO, jobId: 123 });
    expect(calls().map((c) => c.argv)).toEqual([["api", "-X", "POST", "repos/octo/app/actions/jobs/123/rerun"]]);
    expect(calls()[0].stdin).toBe("");
    for (const bad of [0, -1, 1.5, Number.NaN, "123" as unknown as number]) {
      await expect(host().rerunJob({ repo: REPO, jobId: bad })).rejects.toThrow(/valid job id/);
    }
    await expect(host().rerunJob({ repo: { owner: "o\"", name: "r" }, jobId: 1 })).rejects.toThrow(/invalid repository/);
    expect(calls()).toHaveLength(1); // nothing else was spawned
    // A POST goes only to a pull request's comments or a job re-run; every other write stays refused.
    expect(() => assertAllowedGh(["api", "-X", "POST", "repos/octo/app/actions/jobs/123/rerun"])).not.toThrow();
    expect(() => assertAllowedGh(["api", "-X", "POST", "repos/octo/app/issues/5/comments", "--input", "-"], "{}")).not.toThrow();
    for (const args of [
      ["api", "-X", "POST", "repos/octo/app/actions/runs/1/rerun"],
      ["api", "-X", "POST", "repos/octo/app/actions/jobs/123/rerun/extra"],
      ["api", "-X", "POST", "repos/octo/app/actions/workflows/ci.yml/dispatches"],
      ["api", "-X", "POST", "repos/octo/app/pulls/5/reviews"],
      ["api", "-X", "POST", "repos/octo/app/pulls/5/merge"],
      ["api", "--method", "POST", "repos/octo/app/git/refs"],
      ["api", "-X", "POST", "user/repos"],
      ["api", "-X", "POST", "--input", "-", "repos/octo/app/dispatches"],
      ["api", "-X", "PUT", "repos/octo/app/actions/jobs/123/rerun"],
      ["api", "-X", "DELETE", "repos/octo/app/actions/jobs/123"],
      ["pr", "merge", "5", "-R", "octo/app", "--merge", "--match-head-commit", SHA, "--admin"],
      ["pr", "merge", "5", "-R", "octo/app", "--merge", "--match-head-commit", SHA, "--auto"],
      ["pr", "merge", "5", "-R", "octo/app", "--merge", "--match-head-commit", SHA, "--force"],
      ["pr", "merge", "5", "-R", "octo/app", "--merge", "--match-head-commit", SHA, "-d"],
      ["auth", "token"],
    ]) {
      expect(() => assertAllowedGh(args), args.join(" ")).toThrow(GhError);
    }
    expect(() => assertAllowedGh(["api", "graphql", "--input", "-"], JSON.stringify({ query: "mutation{updateRef(input:{}){clientMutationId}}" }))).toThrow(/refusing/);
    expect(calls()).toHaveLength(1);
  });
});
