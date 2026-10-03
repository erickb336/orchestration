// The shell and Home. There is no DOM test environment in this repository, so the screens are rendered through
// react-dom/server over a fake store, and the decisions Home takes in place are checked through the pure helpers in
// progress.ts (needsYouItems, mergeVerdict).

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ServiceInfo } from "../api";
import { runCommand } from "../domain/commands";
import * as D from "../domain/delivery";
import * as M from "../domain/model";
import { buildDemo } from "../domain/demo";
import { buildSeed } from "../domain/seed";
import { clockTime, runWords } from "../domain/needsYou";
import { reportSubagent } from "../domain/subagents";
import { answerChangeOrder, changeOrdered, fullAnswer } from "../domain/testing/changeOrders";
import { inVision } from "../domain/testing/factory";
import { reviewedChange } from "../domain/testing/reviewed";
import type { PrDelivery, State, SteeringChange } from "../domain/types";
import { LeadButton, ProjectMenu, ResultsBadge, SimBanner, TABS } from "./App";
import { floorScene } from "./floor/floorScene";
import { reverseCommand } from "./floor/floorView";
import { ConfirmProvider } from "./kit";
import { Overview, focusProvenance } from "./Overview";
import { landedVerdict, mergeVerdict, needsYouItems, optionsLine, prsNeedingYou } from "./progress";
import { StoreContext, type ServiceStore } from "./store";
import { visible } from "./testStore";

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

describe("Needs you on Home: the decisions it takes in place", () => {
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

describe("Home", () => {
  const s = buildDemo(T0);
  const markup = render(<Overview />, store(s));

  it("after the start is the factory floor: Needs you, the Budgets card, the factory's lines, then New results, the lead's latest reply and the vision, in that order, and nothing else", () => {
    const order = ["Needs you", "Budgets", "The factory", "New results", "Latest from the lead", "Vision"].map((t) => markup.indexOf(`>${t}<`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const gone of ["Progress by area", "Team now", "Since your last visit", ">Usage<", ">Service<", "lead-inline", "Database", "Scheduler role", "Autopilot", "Shaping", "Start building", ">Focus<", ">Building budget<", "Maintenance budget, estimated"]) expect(markup).not.toContain(gone);
  });

  it("takes the demo's decisions in place with the task page's buttons", () => {
    expect(markup).toContain("Decide a finding:");
    expect(markup).toContain("Read distances in miles or kilometres?");
    for (const label of [">Fix<", ">Accept as is<", ">Message the lead<", ">Choose A<", ">Choose B<"]) expect(markup).toContain(label);
    expect(markup).toContain("Choose an approach:");
  });

  it("the focus is the first line of Latest from the lead, with where it came from and Undo; there is no Focus card (ORC-030 a-home-focus)", () => {
    const latest = visible(markup.slice(markup.indexOf(">Latest from the lead<") + 1));
    expect(latest).toMatch(/^Latest from the lead Open the conversation Focus: Offline maps first: the map must work with no signal\. Set by the lead from your message, \S+ ago · Undo It is still running: Claude is reviewing/);
    expect(count(markup, ">Undo<")).toBe(1);
    // The vision stays behind Vision and history (worker C1 moves it into Vision).
    expect(markup).toContain("Vision and history");
    expect(markup).toContain(">Edit vision<");
    expect(focusProvenance({ rev: 1, at: at(0), author: "user", text: "", focus: "", reason: "" })).toBe("Set by you");
    // With no focus, the reply comes first.
    const none = structuredClone(s);
    none.project.visions[none.project.visions.length - 1].focus = "";
    expect(visible(render(<Overview />, store(none)))).toContain("Latest from the lead Open the conversation It is still running");
  });

  it("shows the lead's latest reply with one simulated chip and a way to open the conversation", () => {
    expect(markup).toContain("It is still running: Claude is reviewing");
    expect(markup).toContain(">Open the conversation<");
    // "Simulated" is the kit's chip, on things that could pass for real (the reply, landed items), never a suffix.
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

describe("The shell", () => {
  it("has no Activity tab; the Activity page stays at #/activity; Vision is in the main navigation, at #/vision", () => {
    expect(TABS.map((t) => t.label)).toEqual(["Home", "Vision", "Tasks", "Results", "Settings"]);
    expect(TABS.find((t) => t.label === "Vision")?.href).toBe("#/vision");
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

  it("the project's menu is named by the project, pauses and resumes, and says Pausing… until every run acknowledged, then Project paused (Home's state says the same: places.test.tsx)", () => {
    const running = buildSeed(T0);
    expect(render(<ProjectMenu />, store(running))).toContain(">Pause project<");
    expect(render(<ProjectMenu />, store(running))).toContain(`<span class="menu__label">${running.project.name}</span>`);
    expect(render(<ProjectMenu />, store(running))).not.toContain("k-pill");
    const pausing = M.pauseProject(running, at(1));
    const mid = render(<ProjectMenu />, store(pausing));
    expect(mid).toContain("Pausing… 2 runs still stopping");
    expect(mid).toContain(">Resume project<");
    expect(mid).not.toContain("Project paused");
    const acknowledged = structuredClone(pausing);
    acknowledged.attempts = [];
    const done = render(<ProjectMenu />, store(acknowledged));
    expect(done).toContain("Project paused");
    expect(done).toContain(">Resume project<");
  });
});

describe("Home's latest reply, in the conversation's words", () => {
  const change = (n: number, kind: SteeringChange["kind"]): SteeringChange => ({ id: `cs-x.${n}`, kind, before: null, after: kind === "note" ? "Skip the README." : "x", why: "", status: "applied", appliedBy: "lead" });

  it("counts a sent note apart from the changes, as the fold line under the reply does", () => {
    const s = structuredClone(buildSeed(T0, { inFlightRuns: false }));
    s.steering.push({ id: "cs-x", leadRunId: "lead-x", messageIds: [], at: at(5), mode: "apply", basedOnVisionRev: 1, reason: "", notes: [], changes: [change(1, "focus"), change(2, "priority"), change(3, "note")] });
    s.conversation.push({ id: "msg-x", at: at(5), author: "lead", text: "Refocused, and passed your note on.", changeSetId: "cs-x" });
    const markup = render(<Overview />, store(s));
    expect(markup).toContain("2 changes, 1 note");
    expect(markup).not.toContain("3 changes");
  });

  it("a message sent while the lead writes a reply is answered right after it, and Home and the header say so in those words", () => {
    let s = M.postMessage(buildSeed(T0, { inFlightRuns: false }), "Focus on offline maps.", at(1));
    s = M.startLeadRun(s, { provider: "claude", model: "m", trigger: "message" }, at(2)).state;
    s = M.postMessage(s, "And keep the README short.", at(3));
    const words = "The lead answers this right after its reply to your earlier message.";
    const home = render(<Overview />, store(s));
    expect(home).toContain(words);
    expect(home).not.toContain("Queued behind the current reply");
    expect(render(<LeadButton open={false} onClick={() => {}} />, store(s))).toContain(words);
  });
});

describe("the shaping panel", () => {
  const shaping = (vision: string) => {
    const s = inVision(buildSeed(T0, { inFlightRuns: false }), at(1));
    s.project.visions[s.project.visions.length - 1].text = vision;
    return s;
  };

  it("leads Home while shaping, on the kit: a card with the vision, its documents, what is clear, the planned tasks and the way to Start the factory", () => {
    const markup = render(<Overview />, store(shaping("Hikers find trails without signal.")));
    expect(markup.indexOf(">The vision<")).toBeLessThan(markup.indexOf(">Needs you<"));
    const start = markup.indexOf('class="k-card v-shape"');
    expect(start).toBeGreaterThan(-1);
    const panel = markup.slice(start, markup.indexOf(">Needs you<"));
    expect(panel).toContain('id="shape"');
    for (const part of [">Vision so far<", "Vision documents (", ">What is clear so far<", "Planned tasks ("]) expect(panel).toContain(part);
    expect(panel).toMatch(/<a href="#\/vision\/pre-flight"[^>]*>Start the factory…<\/a>/);
    expect(panel).not.toContain("Start building");
    expect(panel).not.toContain("style=");
    expect(panel).not.toContain('class="banner');
    expect(panel).not.toContain('class="chip');
  });

  it("Home leads to the pre-flight, and says under the link why the factory cannot start with an empty vision", () => {
    const empty = render(<Overview />, store(shaping("")));
    expect(empty).toMatch(/>Start the factory…<\/a><p class="small muted no-margin">Write or accept a vision first.<\/p>/);
    const ready = render(<Overview />, store(shaping("Hikers find trails without signal.")));
    expect(ready).toMatch(/>Start the factory…<\/a><\/div>/);
    expect(ready).not.toContain("Write or accept a vision first.");
  });
});

describe("Home in Vision", () => {
  it("stays as it was: the shaping panel, Needs you and Progress by area, and no factory floor", () => {
    const s = inVision(floorScene().s, at(100));
    const markup = render(<Overview />, store(s));
    for (const part of [">The vision<", ">Needs you<", ">Progress by area<", ">New results<", ">Latest from the lead<"]) expect(markup).toContain(part);
    for (const gone of [">Building budget<", ">The factory<", ">Decided by the PE<", "Open the change order"]) expect(markup).not.toContain(gone);
  });
});

describe("the factory floor", () => {
  const sc = floorScene();
  const t = sc.tasks;
  const text = (s: State) => visible(render(<Overview />, store(s)));

  it("has one line per area, with each task at its step, a link to it, and a change order or 'needs you' marked on it", () => {
    const markup = render(<Overview />, store(sc.s));
    const v = visible(markup);
    // The areas in the order of their first task; each line counts its tasks.
    const areas = ["Trips 3 tasks", "Sharing 2 tasks · 1 landed", "CLI 1 task", "Offline 1 task"].map((a) => v.indexOf(a));
    expect(areas.every((i) => i >= 0)).toBe(true);
    expect([...areas].sort((a, b) => a - b)).toEqual(areas);
    // Each task: its station, its id and title, and its marks.
    expect(v).toContain(`building ${t.running} Trip plan screen change order`);
    expect(v).toContain(`waiting ${t.queued} Trip list screen change order needs you`);
    expect(v).toContain(`finished ${t.early} Early trip plan change order`);
    expect(v).toContain(`review ${t.invite} Invite sheet`);
    expect(v).toContain(`landed ${t.joined} Join from an invite`);
    expect(v).toContain(`checks ${t.cli} trips plan and share`);
    expect(v).toContain(`waiting ${t.offline} Offline maps needs you`);
    expect(v).not.toContain(`${t.invite} Invite sheet change order`);
    for (const id of Object.values(t)) expect(markup).toContain(`href="#/task/${id}"`);
    expect(markup).toContain('href="#/tasks?area=Sharing"');
    // Work that moves pulses (the Trip plan screen's build, the Invite sheet's review); the rest does not.
    expect(count(markup, "k-pill--pulse")).toBe(2);
  });

  it("an open change order the lead is answering links to its screen; one that waits for you is under Needs you instead", () => {
    const markup = render(<Overview />, store(sc.s));
    expect(visible(markup)).toContain("Change order 2 · from Lock in 2");
    expect(markup).toMatch(/<a href="#\/tasks\/change-order\/2"[^>]*>Open the change order<\/a>/);
    // Under "ask me first", the lead's answer waits for your go-ahead: Needs you holds it, with its own way to the screen.
    const f = changeOrdered("user");
    const waiting = answerChangeOrder(f.s, fullAnswer(f), 30).s;
    const w = render(<Overview />, store(waiting));
    expect(visible(w)).toContain("Change order: blueprint r2");
    expect(w).toContain('href="#/tasks/change-order/2"');
    expect(w).not.toContain("Open the change order");
    expect(visible(w)).toContain(`${f.tasks.queued} Trip list screen change order`);
  });

  it("shows one Budgets card with two lines, each a figure and a bar; the reasons open on click (ORC-030 a-home-budgets)", () => {
    const markup = render(<Overview />, store(sc.s));
    const v = visible(markup);
    expect(v).toContain("Budgets Change Building · $8.10 of $40 · about $9–$16 more (the PE) At $40.00 the factory stops and asks you. The PE's estimate for the rest: $9.00–$16.00 for the 3 approved parts not built yet.");
    expect(v).toContain("Maintenance · about $35 a month of $50 The sum of the PE's estimates for the 3 approved parts, and each trade-off call the PE makes.");
    // Each line is a closed disclosure: the figure and its bar in the summary, the reasons behind it.
    const card = markup.slice(markup.indexOf(">Budgets<"), markup.indexOf(">The factory<"));
    expect(count(card, '<details class="k-disc ff-budget__line">')).toBe(2);
    expect(card).toContain('<span class="k-meter" aria-hidden="true"><span class="k-meter__used k-meter__used--work" style="width:20.25%"></span><span class="k-meter__more" style="width:40%"></span></span>');
    expect(card).toContain('href="#/settings/project/budgets"');
  });

  it("without an estimate it says so, never $0; at the budget it says the factory stopped; with no budget, that it does not stop", () => {
    const none = structuredClone(sc.s);
    for (const v of none.studio.verdicts) delete v.budget;
    const v = text(none);
    expect(v).toContain("Building · $8.10 of $40 · no estimate for the rest yet");
    expect(v).toContain("The PE's estimate for the rest: none for 3 of 3 parts, so it is unknown, never $0.");
    expect(v).toContain("Maintenance · no estimate yet · budget $50 a month The PE gave no monthly estimate for 3 of 3 approved parts. Until it does, it is unknown, never $0.");
    expect(v).not.toMatch(/Maintenance · (about )?\$0/);
    const stopped = M.setBudgets(sc.s, { buildingUsd: 5, maintenanceUsdPerMonth: 50 }, at(40));
    const sv = render(<Overview />, store(stopped));
    expect(visible(sv)).toContain("Building · $8.10 of $5 · about $9–$16 more (the PE) stopped The building budget is reached: $8.10 of $5.00. Nothing new starts until you raise the budget or continue past it.");
    expect(sv).toContain("k-meter__used--you");
    const unset = M.setBudgets(sc.s, { buildingUsd: null, maintenanceUsdPerMonth: null }, at(40));
    const u = render(<Overview />, store(unset));
    expect(visible(u)).toContain("Building · $8.10 spent · no budget · about $9–$16 more (the PE) No building budget is set, so the factory does not stop for cost.");
    expect(visible(u)).toContain("Maintenance · about $35 a month · no budget");
    expect(u).not.toContain("k-meter");
    // Before anything is locked in, the PE has nothing to estimate: no "nothing left to build".
    expect(visible(render(<Overview />, store(buildDemo(T0))))).toContain("Building · $0 spent · no budget No building budget is set, so the factory does not stop for cost. The PE's estimate for the rest: none yet: nothing is locked in, so the PE has no part to estimate.");
  });

  it("on a phone each area is one row: the area, how many build, wait and landed, and needs you; a tap opens its tasks (ORC-030 a-home-phone)", () => {
    const markup = render(<Overview />, store(sc.s));
    const rows = [...markup.matchAll(/<a class="ff-line__row" href="([^"]+)"[^>]*>(.*?)<\/a>/g)].map((m) => [m[1], visible(m[2])]);
    expect(rows).toEqual([
      ["#/tasks?area=Trips", "Trips 1 building · 1 waiting · 1 finished needs you"],
      ["#/tasks?area=Sharing", "Sharing 1 building · 1 landed"],
      ["#/tasks?area=CLI", "CLI 1 building"],
      ["#/tasks?area=Offline", "Offline 1 waiting needs you"],
      ["#/tasks?area=General", "General 1 waiting needs you"],
    ]);
  });

  it("lists the PE's call within budget with Reverse and its reasons; Reverse opens the decision again for you, with your reason", () => {
    const markup = render(<Overview />, store(sc.s));
    const v = visible(markup);
    expect(v).toContain(`Decided by the PE 1 Trade-off calls the PE made within your budget. A call that would go past a budget comes to you. ${t.invite} Invite sheet Accept it as is: Invite links never expire`);
    expect(markup).toMatch(/<button[^>]*>Reverse<\/button>/);
    expect(v).toContain("See the reasons The PE: “The link is private to the group, and expiry needs a renewal flow nobody asked for. A link can be withdrawn by hand.” Cost: build $0.00, maintenance $0.00 a month (Nothing is built or run).");
    // Reverse is the owner's decideFinding "reopen", with the reason.
    const cmd = reverseCommand(sc.decisionId, "Expiry matters for a group chat.");
    const after = runCommand(sc.s, cmd.name, cmd.args, at(50)).state;
    const d = after.decisions.find((x) => x.id === sc.decisionId)!;
    expect(d).toMatchObject({ status: "open", routedTo: "user", why: "Expiry matters for a group chat.", pe: { decision: "accept" } });
    expect(after.events.at(-1)?.message).toContain("reopened (reversing the PE's call: accept): Expiry matters for a group chat.");
    const back = render(<Overview />, store(after));
    expect(back).not.toContain(">Decided by the PE<");
    expect(visible(back)).toContain("Decide a finding: Invite links never expire");
  });
});

describe("no internal run id where the owner reads (ORC-030 a-words-ids)", () => {
  const RUN_ID = /\b(?:lead|run|studio)-\d+\b/;

  it("names a run by what ran: a task's step, the lead's reply and its time, a Vision run by its kind", () => {
    const s = buildDemo(T0);
    const reply = s.conversation.find((m) => m.author === "lead" && m.leadRunId)!;
    expect(runWords(s, reply.leadRunId!)).toBe(`the lead's reply at ${clockTime(reply.at)}`);
    const silent = structuredClone(s);
    silent.conversation = silent.conversation.filter((m) => m.leadRunId !== reply.leadRunId);
    const r = silent.leadRuns.find((x) => x.id === reply.leadRunId)!;
    expect(runWords(silent, r.id)).toBe(`the lead's run at ${clockTime(r.startedAt)}`);
    const a = s.attempts[0];
    expect(runWords(s, a.id)).toBe(`${a.taskId} ${a.stepId}`);
    expect(runWords(s, `${a.id} helper x`)).toBe(`a helper of ${a.taskId} ${a.stepId}`);
    expect(runWords(s, "lead-404")).toBe("a lead run");
    expect(clockTime("2026-10-03T08:05:00")).toBe("08:05");
  });

  it("a lead reply that started a helper is named by its reply on Home's Needs you, not by its id", () => {
    const s = buildDemo(T0);
    const reply = s.conversation.find((m) => m.author === "lead" && m.leadRunId)!;
    const helped = reportSubagent(s, reply.leadRunId!, { phase: "started", id: "x", asked: "Look around", usageInParent: false }, at(10));
    const v = visible(render(<Overview />, store(helped)));
    expect(v).toContain(`The lead's reply at ${clockTime(reply.at)} started a helper agent.`);
    // Home up to the vision's history (worker C1 moves that to Vision; its revision reasons are records).
    expect(v.slice(0, v.indexOf("Vision and history"))).not.toMatch(RUN_ID);
  });
});

/** A PrDelivery shape check for the fixture, so a changed delivery model fails here and not in a screen. */
it("the ready-PR fixture is open, held for you, and seen on GitHub", () => {
  const pr: PrDelivery = task(readyPr(), "EX-006").integration!.pr!;
  expect(pr).toMatchObject({ phase: "open", policy: "hold", number: 12 });
});
