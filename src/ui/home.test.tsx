// ORC-025 pass 2: the shell and Home. There is no DOM test environment in this repository, so the screens are
// rendered through react-dom/server over a fake store, and the decisions Home takes in place are checked
// through the pure helpers in progress.ts (needsYouItems, mergeVerdict).

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ServiceInfo } from "../api";
import * as D from "../domain/delivery";
import * as M from "../domain/model";
import { buildDemo } from "../domain/demo";
import { buildSeed } from "../domain/seed";
import { reviewedChange } from "../domain/testing/reviewed";
import type { PrDelivery, State } from "../domain/types";
import { LeadButton, ProjectMenu, ResultsBadge, SimBanner, TABS } from "./App";
import { ConfirmProvider } from "./kit";
import { Overview, focusProvenance } from "./Overview";
import { landedVerdict, mergeVerdict, needsYouItems, optionsLine, prsNeedingYou } from "./progress";
import { StoreContext, type ServiceStore } from "./store";

const T0 = Date.parse("2026-09-30T12:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const ms = (s: number) => T0 + s * 1000;
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

/** A store as the shell sees it once the service answered: online, with `state` and `service`, and commands that go nowhere. */
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

const render = (node: React.ReactElement, s: ServiceStore) =>
  renderToStaticMarkup(
    <ConfirmProvider>
      <StoreContext.Provider value={s}>{node}</StoreContext.Provider>
    </ConfirmProvider>,
  );
const count = (markup: string, needle: string) => markup.split(needle).length - 1;

// ---------- a pull request ready for you (the delivery tests' fixture, in short) ----------

const HEAD = "c".repeat(40);
const SHA_A = "a".repeat(40);
/** EX-006 open as PR #12, reviewed clean, its required check passed, held for you. Built relative to `base` (the merge gate judges ages from "now"). */
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

describe("Needs you on Home (H3): the decisions it takes in place", () => {
  it("the demo's finding and two-option task act in place; everything else opens the right page", () => {
    const s = buildDemo(T0);
    const items = needsYouItems(s, T0);
    const finding = items.find((i) => i.kind === "finding");
    expect(finding).toMatchObject({ kind: "finding", task: { id: "WT-007" } });
    expect(finding?.kind === "finding" ? finding.decision.finding.title : "").toBe("Read distances in miles or kilometres?");
    const choose = items.find((i) => i.kind === "choose");
    expect(choose).toMatchObject({ kind: "choose", task: { id: "WT-004.3" }, recommendedId: "A" });
    expect(choose?.kind === "choose" ? optionsLine(choose.options) : "").toBe("A, Guest link · B, One-time code");
    // Each decision appears once.
    expect(items.map((i) => i.key)).toEqual([...new Set(items.map((i) => i.key))]);
    // A task with one option or three is not a two-way choice: it opens.
    const three = structuredClone(s);
    M.currentSpec(task(three, "WT-004.3")).content.options.push({ id: "C", name: "Nothing", approach: "", benefit: "", effort: "", risks: "", reversibility: "" });
    expect(needsYouItems(three, T0).find((i) => i.task?.id === "WT-004.3")).toMatchObject({ kind: "open", action: "Open", href: "#/task/WT-004.3" });
  });

  it("a pull request ready for you is a merge row with the verdict line, and the Results badge counts it", () => {
    const s = readyPr();
    expect(D.prReady(s, task(s, "EX-006"), ms(21))).toBe(true);
    const merge = needsYouItems(s, ms(21)).find((i) => i.kind === "merge");
    expect(merge).toMatchObject({ kind: "merge", task: { id: "EX-006" }, simulated: false });
    expect(mergeVerdict(s, task(s, "EX-006"), ms(21))).toEqual([
      { label: "Code", ok: true },
      { label: "Security", ok: true },
      { label: "Checks", ok: true },
    ]);
    expect(prsNeedingYou(s, ms(21)).map((t) => t.id)).toEqual(["EX-006"]);
    // Once the merge is requested for this head nothing is left to decide: the service merges it.
    const requested = D.requestPrMerge(s, "EX-006", HEAD, at(21));
    expect(needsYouItems(requested, ms(22)).find((i) => i.task?.id === "EX-006")).toBeUndefined();
    // The demo's pull request is still being built at the start, so nothing waits under Results yet.
    expect(prsNeedingYou(buildDemo(T0), T0)).toEqual([]);
    // The badge judges from the real clock, so its fixture is built against it (a stale repository check is "waiting").
    expect(render(<ResultsBadge />, store(readyPr(Date.now() - 30_000)))).toContain("1 pull request waiting for you");
    expect(render(<ResultsBadge />, store(buildDemo(T0)))).toBe("");
  });

  it("a landed item's verdict names what passed, and nothing it did not", () => {
    const base: Parameters<typeof landedVerdict>[0] = { at: at(0), via: "pr", target: "o/r main", commit: HEAD, by: "app", flags: [], status: "unreviewed", notes: [], followUps: [] };
    expect(landedVerdict(base)).toEqual([]);
    expect(landedVerdict({ ...base, review: { ok: true, source: "pipeline", reason: "", artifactIds: [] }, checks: [{ name: "check", required: true, status: "COMPLETED", conclusion: "SUCCESS" }] })).toEqual(["Code ✓", "Security ✓", "Checks ✓"]);
    expect(landedVerdict({ ...base, review: { ok: false, source: "none", reason: "", artifactIds: [] }, checks: [{ name: "check", required: true, status: "COMPLETED", conclusion: "FAILURE" }] })).toEqual([]);
  });
});

describe("Home (H1, H2, H4, H5)", () => {
  const s = buildDemo(T0);
  const markup = render(<Overview />, store(s));

  it("shows Needs you, Progress by area, New results, the lead's latest reply and Focus, in that order, and nothing else", () => {
    const order = ["Needs you", "Progress by area", "New results", "Latest from the lead", "Focus"].map((t) => markup.indexOf(`>${t}<`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const gone of ["Team now", "Since your last visit", ">Usage<", ">Service<", "lead-inline", "Database", "Scheduler role", "Autopilot"]) expect(markup).not.toContain(gone);
  });

  it("takes the demo's decisions in place with the task page's buttons", () => {
    expect(markup).toContain("Decide a finding:");
    expect(markup).toContain("Read distances in miles or kilometres?");
    for (const label of [">Fix<", ">Accept as is<", ">Message the lead<", ">Choose A<", ">Choose B<"]) expect(markup).toContain(label);
    expect(markup).toContain("Choose an approach:");
  });

  it("shows the focus first, where it came from, Undo, and the vision behind Vision and history", () => {
    expect(markup).toContain("Offline maps first: the map must work with no signal.");
    expect(markup).toContain("Set by the lead from your message");
    expect(markup).toContain(">Undo<");
    expect(markup).toContain("Vision and history");
    expect(markup).toContain(">Edit vision<");
    expect(markup.indexOf('class="focus-line"')).toBeLessThan(markup.indexOf("Vision and history"));
    expect(focusProvenance({ rev: 1, at: at(0), author: "user", text: "", focus: "", reason: "" })).toBe("Set by you");
  });

  it("shows the lead's latest reply with one simulated chip and a way to open the conversation", () => {
    expect(markup).toContain("It is still running: Claude is reviewing");
    expect(markup).toContain(">Open the conversation<");
    // N6: "simulated" is the kit's chip, on things that could pass for real (the reply, landed items), never a suffix.
    expect(count(markup, 'class="k-chip k-chip--sim"')).toBeGreaterThanOrEqual(1);
    expect(markup).not.toContain("(simulated)");
    expect(markup).not.toContain("Fake runtime");
  });

  it("the demo's welcome is one line with Hide, without Start building now", () => {
    expect(markup).toContain("This is the sample project.");
    expect(markup).toContain(">Hide<");
    expect(markup).not.toContain("Start building now");
  });
});

describe("The shell (N1, N2, N5, N7)", () => {
  it("has no Activity tab; the Activity page stays at #/activity", () => {
    expect(TABS.map((t) => t.label)).toEqual(["Home", "Tasks", "Results", "Settings"]);
  });

  it("the demo bar is one line and its Simulation menu holds the clock, the tour and the reset; the stop-acknowledgment switch is gone", () => {
    const markup = render(<SimBanner />, store(buildDemo(T0)));
    expect(markup).toContain("Simulated: no agents run and nothing leaves this computer.");
    expect(markup.match(/simulated/gi)).toHaveLength(1);
    for (const item of [">Run simulation clock<", ">Step<", ">Tour<", ">Reset sample data<"]) expect(markup).toContain(item);
    expect(markup).not.toContain("ignores stops");
    expect(markup).not.toContain("<select");
  });

  it("Message the lead is the primary button and its badge counts unread replies only", () => {
    const s = buildDemo(T0);
    const replies = s.conversation.filter((m) => m.author === "lead").length;
    expect(replies).toBeGreaterThan(0);
    const markup = render(<LeadButton open={false} onClick={() => {}} />, store(s));
    expect(markup).toContain("k-btn--primary");
    expect(markup).toContain("Message the lead");
    expect(markup).toContain(`${replies} new repl`);
    expect(markup).not.toContain("suggestion");
  });

  it("the Project menu pauses and resumes, and the header says Pausing… until every run acknowledged, then Paused", () => {
    const running = buildSeed(T0);
    expect(render(<ProjectMenu />, store(running))).toContain(">Pause project<");
    expect(render(<ProjectMenu />, store(running))).not.toContain("k-pill");
    const pausing = M.pauseProject(running, at(1));
    const mid = render(<ProjectMenu />, store(pausing));
    expect(mid).toContain("Pausing…");
    expect(mid).toContain("2 runs still stopping");
    expect(mid).toContain(">Resume project<");
    expect(mid).not.toContain(">Paused<");
    const acknowledged = structuredClone(pausing);
    acknowledged.attempts = [];
    const done = render(<ProjectMenu />, store(acknowledged));
    expect(done).toContain(">Paused<");
    expect(done).toContain("Project paused");
    expect(done).toContain(">Resume project<");
  });
});

/** A PrDelivery shape check for the fixture, so a changed delivery model fails here and not in a screen. */
it("the ready-PR fixture is open, held for you, and seen on GitHub", () => {
  const pr: PrDelivery = task(readyPr(), "EX-006").integration!.pr!;
  expect(pr).toMatchObject({ phase: "open", policy: "hold", number: 12 });
});
