// The Results page. Ready to merge first (the verdict line, Merge and Keep for me),
// then New results with one Mark as seen and one Send back… per item. The lists and words come from resultsView.ts;
// the page is rendered through react-dom/server over a fake store, as in home.test.tsx.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ServiceInfo } from "../api";
import * as D from "../domain/delivery";
import { buildDemo } from "../domain/demo";
import { buildSeed } from "../domain/seed";
import * as M from "../domain/model";
import { blueprintScene } from "../domain/testing/blueprintScene";
import { reviewedChange } from "../domain/testing/reviewed";
import type { Landed, State } from "../domain/types";
import { ConfirmProvider } from "./kit";
import { prsNeedingYou } from "./progress";
import { FILTER_TITLE, bulkLabel, designFirst, emptyText, matchesFilter, prLists, resultsHref, reviewsLine, showBulk } from "./resultsView";
import { Review } from "./Review";
import { StoreContext, type ServiceStore } from "./store";

const T0 = Date.parse("2026-09-30T12:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const task = (s: State, id: string) => s.tasks.find((t) => t.id === id)!;

const service = (over: Partial<ServiceInfo> = {}): ServiceInfo => ({
  startedAt: at(0),
  scheduler: "active",
  runtime: "fake",
  sim: { auto: false, ackMode: "normal" },
  dbPath: "/tmp/orchestration-test.db",
  providers: { claude: { label: "Claude", capabilities: {} as never }, codex: { label: "Codex", capabilities: {} as never } },
  ...over,
});

function store(state: State, svc: ServiceInfo = service()): ServiceStore {
  const noop = async () => ({ ok: true as const });
  return {
    state,
    version: 1,
    service: svc,
    status: "online",
    disabled: false,
    loadFailed: false,
    confirmedAt: null,
    retry: () => {},
    send: noop,
    setSim: async () => true,
    refreshHealth: async () => true,
    step: async () => true,
    reset: async () => true,
    postJson: async () => ({ ok: true as const, body: null }),
    uploadVisionDoc: async () => ({ ok: false as const, error: "test" }),
    notice: null,
    setNotice: () => {},
  } as unknown as ServiceStore;
}

const render = (s: State, svc?: ServiceInfo) =>
  renderToStaticMarkup(
    <ConfirmProvider>
      <StoreContext.Provider value={store(s, svc)}>
        <Review />
      </StoreContext.Provider>
    </ConfirmProvider>,
  );
const count = (markup: string, needle: string) => markup.split(needle).length - 1;

// ---------- a pull request ready for you (home.test.tsx's fixture) ----------

const HEAD = "c".repeat(40);
const SHA_A = "a".repeat(40);
/** EX-006 open as PR #12, reviewed clean, its required check passed, held for you. Built relative to `base`. */
function readyPr(base = T0): State {
  const at = (s: number) => new Date(base + s * 1000).toISOString();
  const ms = (s: number) => base + s * 1000;
  let s = D.setDeliveryMode(buildSeed(base, { inFlightRuns: false }), { mode: "pr" }, at(0));
  s.attempts = [];
  for (const t of s.tasks) if (t.lifecycle !== "done" && t.lifecycle !== "cancelled") t.hold = true;
  s = D.reportPreflight(s, { ok: true, repo: "o/r", login: "me", ghVersion: "2.101.0", requiredChecks: ["check"], autoMergeBlockers: [], posture: [] }, at(1));
  s = D.reportBaseFetched(s, SHA_A, at(2));
  s = reviewedChange(s, "EX-006", HEAD, at(2));
  task(s, "EX-006").lifecycle = "done";
  task(s, "EX-006").integration = { status: "pending" };
  s = D.reportPrHead(s, "EX-006", { n: 1, sha: HEAD, baseSha: SHA_A, changed: { files: 1, additions: 1, deletions: 0, paths: ["a.txt"], protectedHits: [], workflowHits: [] } }, at(3));
  const op = D.nextPrOp(s, ms(10))!;
  const begun = D.beginPrOp(s, op, at(10));
  const open = D.reportPrOp(begun.state, { op, published: { number: 12, url: "https://github.com/o/r/pull/12" } }, at(11));
  const obs: D.PrObservation = {
    number: 12,
    state: "OPEN",
    isDraft: false,
    crossRepo: false,
    url: "https://github.com/o/r/pull/12",
    headRef: "orchestration/sample/pr/EX-006-1",
    headSha: HEAD,
    baseRef: "main",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: null,
    labels: [],
    checks: [{ name: "check", required: true, status: "COMPLETED", conclusion: "SUCCESS" }],
    checksFor: HEAD,
  };
  return D.reportObservations(open, { prs: [obs], commits: [], rateRemaining: 5000 }, at(20));
}

describe("the pull requests of the Results page", () => {
  it("splits what waits for you from what is on its way, and agrees with the Results badge", () => {
    const now = Date.now();
    const s = readyPr(now - 30_000);
    const lists = prLists(s, now);
    expect(lists.ready.map((t) => t.id)).toEqual(["EX-006"]);
    expect(lists.problems).toEqual([]);
    expect([...lists.problems, ...lists.ready]).toEqual(prsNeedingYou(s, now));
    // A problem nobody is fixing needs your decision; it is not "ready to merge".
    const stuck = structuredClone(s);
    task(stuck, "EX-006").integration!.pr!.attention = { code: "remote-diverged", message: "The branch on GitHub moved", since: at(0) };
    expect(prLists(stuck, now)).toMatchObject({ problems: [{ id: "EX-006" }], ready: [] });
    // The demo's pull request is still being built at the start: on its way, nothing waits for you.
    const demo = prLists(buildDemo(T0), T0);
    expect(demo.onTheirWay.map((t) => t.id)).toEqual(["WT-005"]);
    expect([...demo.problems, ...demo.ready, ...demo.closed]).toEqual([]);
  });
});

describe("landed items", () => {
  const base: Landed = { at: at(0), via: "pr", target: "o/r main", commit: HEAD, by: "app", flags: [], status: "unreviewed", notes: [], followUps: [] };

  it("filters New, All and Sent back, with a title that never calls a seen item new", () => {
    expect(matchesFilter(base, "new")).toBe(true);
    expect(matchesFilter({ ...base, status: "reviewed" }, "new")).toBe(false);
    expect(matchesFilter({ ...base, status: "reviewed" }, "all")).toBe(true);
    expect(matchesFilter({ ...base, status: "sent-back" }, "sent-back")).toBe(true);
    expect(matchesFilter({ ...base, status: "reviewed", followUps: [{ taskId: "T-9", kind: "fix" }] }, "sent-back")).toBe(true);
    expect(matchesFilter(base, "sent-back")).toBe(false);
    expect(FILTER_TITLE).toEqual({ new: "New results", all: "Everything that landed", "sent-back": "Sent back" });
  });

  it("offers Mark all as seen only past three new items", () => {
    expect([1, 2, 3].map(showBulk)).toEqual([false, false, false]);
    expect(showBulk(4)).toBe(true);
    expect(bulkLabel(5)).toBe("Mark all 5 as seen");
    expect(bulkLabel(150)).toBe("Mark the first 100 as seen");
  });

  it("says the agent reviews in one line, the last round of each role speaking for it", () => {
    const demo = buildDemo(T0);
    expect(reviewsLine(D.landedReviews(demo, task(demo, "WT-004.1")))).toBe("Code review by Codex: no open findings · Security review by Claude: no open findings");
    expect(reviewsLine([])).toBe("No agent review ran on this task.");
    const r = { role: "code_reviewer" as const, purpose: "Code review", openFindings: 2, provider: "claude" as const, editedByUser: false };
    expect(reviewsLine([r, { ...r, purpose: "Code review (iteration 2)", openFindings: 1 }])).toBe("Code review by Claude: 1 open finding");
    expect(reviewsLine([{ ...r, editedByUser: true, openFindings: 0 }])).toBe("Code review (edited by you): no open findings");
  });

  it("says plainly why the list is empty", () => {
    const demo = buildDemo(T0);
    expect(emptyText(demo, "new", "fake")).toEqual({ title: "No new results.", text: "You have seen everything that landed." });
    expect(emptyText(demo, "sent-back", "fake").title).toBe("Nothing has been sent back.");
    const none = buildSeed(T0);
    expect(emptyText(none, "new", "fake").text).toContain("simulated pull requests");
    expect(emptyText(D.setDeliveryMode(none, { mode: "pr" }, at(0)), "new", "real").text).toContain("after its pull request merges into");
  });
});

describe("the Results page", () => {
  it("shows New results with one Mark as seen and one Send back… per item, and details in place", () => {
    const demo = buildDemo(T0);
    const fresh = D.landedTasks(demo).filter((t) => t.integration!.landed!.status === "unreviewed");
    expect(fresh.length).toBe(2);
    const markup = render(demo);
    expect(markup).toContain(">New results<");
    expect(count(markup, ">Mark as seen<")).toBe(fresh.length);
    expect(count(markup, ">Send back…<")).toBe(fresh.length);
    expect(markup).toContain('role="radiogroup" aria-label="Show"');
    for (const f of [">New<", ">All<", ">Sent back<"]) expect(markup).toContain(f);
    expect(markup).toContain("Code review by Claude: no open findings · Security review by Claude: no open findings");
    expect(markup).toContain(">Details<");
    // Two items: no bulk button; the old words are gone.
    for (const gone of ["Mark all", "Show details", "Mark reviewed", ">Landed</h2>", "Pull requests here are simulated"]) expect(markup).not.toContain(gone);
    // The demo's pull request is still being built: it is listed last, and nothing is ready to merge yet.
    expect(markup).toContain(">Ready to merge<");
    expect(markup).toContain("No pull request is waiting for you.");
    expect(markup.indexOf(">Ready to merge<")).toBeLessThan(markup.indexOf(">New results<"));
    expect(markup.indexOf(">New results<")).toBeLessThan(markup.indexOf(">Other pull requests<"));
  });

  it("offers Mark all as seen when more than three results are new", () => {
    const demo = buildDemo(T0);
    for (const t of D.landedTasks(demo)) t.integration!.landed!.status = "unreviewed";
    const markup = render(demo);
    expect(markup).toContain("Mark all 6 as seen"); // every landed task of the demo
  });

  it("puts a ready pull request under Ready to merge with its verdict line, Merge, Keep for me and Why it's ready", () => {
    const now = Date.now();
    const s = readyPr(now - 30_000);
    const markup = render(s);
    const ready = markup.slice(markup.indexOf(">Ready to merge<"));
    expect(ready).toContain("Pull request #12");
    expect(ready).toContain("Code ✓");
    expect(ready).toContain(">Merge<");
    expect(ready).toContain(">Keep for me<");
    expect(ready).toContain("Why it&#x27;s ready");
    expect(markup).not.toContain("GitHub delivery is stopped");
    expect(markup).not.toContain("Paused: watching GitHub only");
  });

  it("shows the GitHub and pause banners only when they apply", () => {
    const now = Date.now();
    const s = readyPr(now - 30_000);
    s.project.github!.problem = { code: "auth", message: "gh is not signed in.", since: at(0) };
    s.project.hold = true;
    const markup = render(s);
    expect(markup).toContain("GitHub delivery is stopped.");
    expect(markup).toContain(">Check again<");
    expect(markup).toContain("Paused: watching GitHub only");
    // Without pull-request delivery or a tracked pull request, neither appears.
    const local = buildSeed(T0);
    local.project.hold = true;
    expect(render(local)).not.toContain("Paused: watching GitHub only");
  });
});

describe("the order of Results' two tabs (ORC-030 a-results-order)", () => {
  const tabs = (markup: string) => [...markup.matchAll(/role="tab"[^>]*>([^<]+)</g)].map((m) => m[1]);

  it("Design and reality is first once anything is locked in; before that Delivered work is first; #/results stays the delivered work", () => {
    const fresh = M.initProject(buildSeed(T0, { inFlightRuns: false }), { name: "New", repoPath: "/tmp/new", vision: "", focus: "" }, at(0));
    expect(designFirst(fresh)).toBe(false);
    expect(resultsHref(fresh)).toBe("#/results");
    expect(tabs(render(fresh))).toEqual(["Delivered work", "Design and reality"]);
    const locked = blueprintScene().s;
    expect(designFirst(locked)).toBe(true);
    expect(resultsHref(locked)).toBe("#/results/design");
    expect(tabs(render(locked))).toEqual(["Design and reality", "Delivered work"]);
    // The delivered work keeps its address, and its tab stays selected there.
    expect(render(locked)).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>Delivered work</);
  });
});
