// The task page's structure, rendered statically (there is no DOM test environment in this
// repository) over the demo's tasks: the order of its parts, each decision once at the top, the ids and the
// model pickers out of the main view, and the done task's result once.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildDemo } from "../../domain/demo";
import * as M from "../../domain/model";
import { buildSeed } from "../../domain/seed";
import { runCommand } from "../../domain/commands";
import { blueprintScene } from "../../domain/testing/blueprintScene";
import type { State } from "../../domain/types";
import type { ServiceInfo } from "../../api";
import { decisionState } from "../Findings";
import { StoreContext, type ServiceStore } from "../store";
import { TaskDetail } from "../TaskDetail";
import { DetailsCard, type DetailsSectionId } from "./Details";
import { ModelsSection } from "./Models";
import { OutputsSection } from "./Outputs";
import { openCleanPr } from "./needsYouItems.test";
import { outputLine } from "./Result";
import { controlFailureWords } from "./Banners";

// The page reads the clock (Date.now()) for what is ready and how old things are, so the demo is built at the clock too.
const T0 = Date.now();
const task = (s: State, id: string) => s.tasks.find((t) => t.id === id)!;

const service: ServiceInfo = {
  startedAt: new Date(T0).toISOString(),
  scheduler: "active",
  runtime: "fake",
  sim: { auto: false, ackMode: "immediate" as ServiceInfo["sim"]["ackMode"] },
  dbPath: "",
  providers: {} as ServiceInfo["providers"],
};

/** The store as the page sees it, over a given state, with every command accepted and never sent. */
function render(state: State, node: React.ReactElement): string {
  const store = { state, service, version: 1, status: "online", disabled: false, send: async () => ({ ok: true }), notice: null } as unknown as ServiceStore;
  return renderToStaticMarkup(<StoreContext.Provider value={store}>{node}</StoreContext.Provider>);
}
const page = (state: State, id: string) => render(state, <TaskDetail id={id} />);
const unescape = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const text = (html: string) => unescape(html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));
const count = (html: string, needle: string) => html.split(needle).length - 1;
const headings = (html: string) => [...html.matchAll(/<h[12][^>]*>(.*?)<\/h[12]>/g)].map((m) => unescape(m[1].replace(/<[^>]+>/g, "")).replace(/\d+$/, "").trim());

describe("the task page", () => {
  it("runs header → Needs you → What it's for → Steps → Details, with the decision once at the top and the internals under Details", () => {
    const s = buildDemo(T0);
    const html = page(s, "WT-007");
    expect(headings(html)).toEqual(["Make the trail map readable with VoiceOver", "Needs you", "What it's for", "Steps", "Details"]);
    const t = text(html);
    // The finding, once, with its buttons.
    expect(count(t, "Read distances in miles or kilometres?")).toBe(1);
    expect(count(html, ">Fix<")).toBe(1);
    expect(count(html, ">Accept as is<")).toBe(1);
    expect(t).toContain("Decide a finding:");
    // The lead's reasoning once; the outcome once.
    const outcome = M.currentSpec(task(s, "WT-007")).content.outcome;
    expect(count(t, outcome)).toBe(1);
    expect(t).toContain("Chosen by the lead");
    // The steps in words, with no model picker, run id or graph notation in the main view.
    expect(t).toContain("UX review");
    expect(t).toContain("Needs you: 1 finding");
    expect(t).toContain("Waits for your decision");
    expect(html).not.toContain("<select");
    expect(t).not.toMatch(/run-\d+/);
    expect(t).not.toContain("· produces ");
    expect(t).not.toContain("pipeline r1");
    // The controls in one place: Pause, Message the lead, More.
    expect(html).toContain(">Pause<");
    expect(html).toContain("Message the lead about this task");
    expect(html).toContain('aria-haspopup="menu"');
    // Details' sections are closed, so the page carries their names and counts only.
    expect(t).toMatch(/Spec and options.*Outputs.*Runs.*Activity.*Revisions.*Models/);
  });

  it("an output's finding that is decided above says so instead of repeating the buttons; the lead's finding keeps Send to me", () => {
    const s = buildDemo(T0);
    const outputs = render(s, <OutputsSection state={s} task={task(s, "WT-007")} decideAbove={() => {}} />);
    expect(count(outputs, "Read distances in miles or kilometres?")).toBe(1);
    expect(outputs).toContain("Decide above");
    expect(outputs).not.toContain(">Accept as is<");
    const moved = structuredClone(s);
    moved.decisions.find((d) => d.taskId === "WT-007" && d.status === "open")!.routedTo = "lead";
    const theirs = render(moved, <OutputsSection state={moved} task={task(moved, "WT-007")} decideAbove={() => {}} />);
    expect(theirs).toContain(">Send to me<");
    expect(theirs).not.toContain("Decide above");
    expect(text(page(moved, "WT-007"))).toContain("The lead is deciding 1 finding on this task");
  });

  it("a finding on the PE's route says the PE decides, through the lead's runs for now; a PE call past a budget says why it is yours (ORC-029 2d)", () => {
    const s = buildDemo(T0);
    const pe = structuredClone(s);
    const d = pe.decisions.find((x) => x.taskId === "WT-007" && x.status === "open")!;
    d.routedTo = "pe";
    const outputs = text(render(pe, <OutputsSection state={pe} task={task(pe, "WT-007")} decideAbove={() => {}} />));
    expect(outputs).toContain("The PE decides, within budget (the lead's decision runs decide for it, with the PE's brief)");
    expect(outputs).toContain("Send to me");
    expect(text(page(pe, "WT-007"))).toContain("The PE is deciding 1 finding (through the lead's decision runs, with the PE's brief) on this task");
    const past = structuredClone(s);
    const p = past.decisions.find((x) => x.taskId === "WT-007" && x.status === "open")!;
    // As the domain records it: the call, and the lead run that made it with the PE's brief.
    p.pe = { decision: "fix", why: "Store both units.", cost: { buildUsd: [6, 9], basis: "Similar work" }, by: "lead-run", leadRunId: "lead-9", at: new Date(T0).toISOString(), pastBudget: "up to $9.00 more would take the building spend to $9.00, past the $5.00 budget ($0.00 spent)" };
    p.leadRunId = "lead-9";
    const mine = text(render(past, <OutputsSection state={past} task={task(past, "WT-007")} decideAbove={() => {}} />));
    expect(mine).toContain("Needs you: decide. The PE would fix, but up to $9.00 more would take the building spend to $9.00, past the $5.00 budget ($0.00 spent)");
  });

  it("an earlier PE call kept on the record is not shown as the current one: after a reopen, or under the lead's suggestion (review finding 9)", () => {
    const s = buildDemo(T0);
    const d = structuredClone(s.decisions.find((x) => x.taskId === "WT-007" && x.status === "open")!);
    d.pe = { decision: "fix", why: "Store both units.", by: "lead-run", leadRunId: "lead-9", at: new Date(T0).toISOString(), pastBudget: "up to $9.00 more would take the building spend to $9.00, past the $5.00 budget ($0.00 spent)" };
    // You reopened the decision the PE's call had sent you: the call stays on the record, and the decision is yours.
    d.routedTo = "user";
    delete d.leadRunId;
    expect(decisionState(d)).toBe("Needs you: decide");
    // The lead's later run suggests a fix: the suggestion is the lead's.
    d.suggestion = { decision: "fix", why: "Convert at the edge.", leadRunId: "lead-12", at: new Date(T0).toISOString() };
    expect(decisionState(d)).toBe("The lead suggests: fix — Convert at the edge.");
    d.suggestion.leadRunId = "lead-9";
    expect(decisionState(d)).toBe("The PE suggests: fix — Convert at the edge.");
  });

  it("a task waiting for the go-ahead with two options asks for the choice, then Start, once; the spec's table says so", () => {
    const s = buildDemo(T0);
    const html = page(s, "WT-004.3");
    expect(headings(html)).toEqual(["Join a trip without an account", "Needs you", "What it's for", "Steps", "Details"]);
    const t = text(html);
    expect(t).toContain("Choose an approach, then start:");
    expect(count(html, ">Start<")).toBe(1);
    expect(html).toContain(">Choose B<");
    expect(html).not.toContain(">Choose A<");
    expect(t).toContain("Compare the tradeoffs");
    // The flow is named once, in the line above the title; the Steps card has no "Change flow" chip (More has it).
    expect(t).toContain("WT-004.3 Change · Trip sharing");
    expect(t).not.toContain("Change flow");
  });

  it("a done task with a pull request that waits for you shows it once, under Needs you, with Merge and Keep for me and the checklist behind Why it's ready", () => {
    const s = openCleanPr(buildDemo(T0), T0);
    const html = page(s, "WT-005");
    expect(headings(html)).toEqual(["Suggest a packing list from trail length and weather", "Needs you", "What it's for", "Steps", "Result", "Details"]);
    expect(count(html, ">Merge<")).toBe(1);
    expect(count(html, ">Keep for me<")).toBe(1);
    const t = text(html);
    expect(t).toContain("Ready to merge:");
    expect(t).toContain("Pull request #1000");
    expect(t).toMatch(/Code ✓.*Security ✓.*Checks ✓/);
    expect(t).toContain("6 files, +167 −12");
    expect(count(html, "k-chip--sim")).toBe(1);
    expect(t).toContain("Why it's ready");
    expect(t).toContain("The pull request waits for you under Needs you");
    expect(html).toContain("<details");
  });

  it("a landed task's result shows what landed with the reviews in one line, Mark as seen and Send back, once each", () => {
    const s = buildDemo(T0);
    const html = page(s, "WT-001");
    expect(headings(html)).toEqual(["Cache trail map tiles for offline use", "What it's for", "Steps", "Result", "Details"]);
    expect(count(html, ">Mark as seen<")).toBe(1);
    expect(count(html, ">Send back…<")).toBe(1);
    const t = text(html);
    expect(t).toMatch(/Landed .* by Orchestrator, pull request #991/);
    expect(t).toMatch(/Code ✓.*Security ✓/);
    expect(count(t, M.currentSpec(task(s, "WT-001")).content.outcome)).toBe(1);
    expect(t).toContain("round 2");
    expect(t).not.toContain("(iteration 2)");
    expect(html).toContain(">Create follow-up<");
    expect(html).not.toContain(">Pause<");
  });

  it("a finished design has nothing to merge and shows the lead's brief as its result", () => {
    const s = buildDemo(T0);
    const t = text(page(s, "WT-013"));
    expect(t).toContain("Nothing to merge: no code changed.");
    expect(t).toContain("The brief:");
    expect(t).toContain("Build the invite sheet as designed");
  });

  it("a goal lists its child tasks with their states", () => {
    const s = buildDemo(T0);
    const html = page(s, "WT-004");
    expect(headings(html)).toEqual(["Share a trip plan with friends", "What it's for", "Steps", "Child tasks", "Details"]);
    const t = text(html);
    expect(t).toContain("Waiting for 2 child tasks");
    for (const id of ["WT-004.1", "WT-004.2", "WT-004.3"]) expect(t).toContain(id);
  });

  it("Activity shows the newest events in the Activity page's words and links to all of them there", () => {
    const s = buildDemo(T0);
    const t = task(s, "WT-001");
    const open = { spec: false, outputs: false, runs: false, activity: true, revisions: false, models: false } satisfies Record<DetailsSectionId, boolean>;
    const html = render(s, <DetailsCard state={s} task={t} open={open} onToggle={() => {}} chooseAtTop={false} decideAbove={() => {}} />);
    expect(html).toContain('href="#/activity?task=WT-001"');
    expect(text(html)).toContain("All activity for this task");
    // Who acted, as the Activity page says it; no role ids in snake case.
    expect(text(html)).not.toMatch(/\b(system|runtime)\b \d|code_reviewer|security_reviewer/);
  });

  it("Models links to where the defaults and the checks are set, not to Settings in general", () => {
    const s = structuredClone(buildDemo(T0));
    s.project.checks.enabled = false; // a Checks step then says it is skipped, and where checks are switched on
    const t = s.tasks.find((x) => x.lifecycle !== "done" && x.lifecycle !== "cancelled" && x.steps.some((st) => st.role === "checks"))!;
    const html = render(s, <ModelsSection state={s} task={t} />);
    expect(html).toContain('href="#/settings/agents/models"');
    expect(html).toContain('href="#/settings/quality/checks"');
    expect(text(html)).toContain("checks are off");
    expect(html).not.toContain('href="#/settings"');
  });

  it("a running step keeps Send a note; a missing task says so", () => {
    const s = buildSeed(T0);
    const t = s.tasks.find((x) => M.activeAttempts(s, x.id).some((a) => a.outcome === "running" && x.steps.find((st) => st.id === a.stepId)?.role !== "checks"))!;
    const html = page(s, t.id);
    expect(html).toContain(">Send a note<");
    expect(text(html)).toContain("Running");
    expect(text(page(s, "NOPE"))).toContain("No task NOPE.");
  });
});

describe("the task page's words (ORC-030 pass C2)", () => {
  const written = () => {
    const r = runCommand(buildDemo(T0), "createTask", { title: "Show the trip length", area: "Trips", outcome: "Each trip card shows its length.", benefit: "", whyNow: "", approach: "Count the days from the dates.", acceptance: ["2 days"], priority: 3, holdBeforeStart: true, flowId: "change" }, new Date(T0).toISOString());
    return { s: r.state, id: (r.result as { newId: string }).newId };
  };

  it("a task you wrote and held with Wait for my go-ahead: Waits for you, not Proposed; no Pause before it starts; Your spec", () => {
    const { s, id } = written();
    expect(M.stateLabel(s, task(s, id))).toBe("Waits for you");
    const html = page(s, id);
    const t = text(html);
    expect(t).toContain("Waits for you");
    expect(t).not.toContain("Proposed");
    expect(html).not.toContain(">Pause<");
    expect(t).toContain("Approach: Count the days from the dates. Your spec.");
    expect(t).not.toContain("as the lead recommended");
    // Its own approach is "your spec" under Needs you too: the lead recommended nothing.
    expect(t).toContain("A: As described your spec selected");
    expect(t).not.toContain("recommended by the lead");
    // A started task can be paused (WT-007 runs its review); a ready one that has not started cannot.
    expect(page(s, "WT-007")).toContain(">Pause<");
    expect(task(s, "WT-003").lifecycle).not.toBe("active");
    expect(page(s, "WT-003")).not.toContain(">Pause<");
  });

  it("a stop the runtime did not confirm names the step, never the run's id (a-words-ids)", () => {
    const s = buildSeed(T0);
    const a = M.activeAttempts(s)[0];
    const t = task(s, a.taskId);
    const timedOut = M.reportStopTimeout(M.pauseTask(s, t.id, new Date(T0 + 1000).toISOString()), a.id, new Date(T0 + 2000).toISOString());
    expect(task(timedOut, t.id).controlFailure?.message).toContain(a.id); // the record keeps the id
    const banner = text(page(timedOut, t.id));
    expect(banner).toContain(`Control failure. ${t.id} ${a.stepId} did not confirm the stop. Nothing merges until it does; the agent may still be working.`);
    expect(banner).not.toContain(a.id);
    expect(controlFailureWords(t, [])).toBe("The run did not confirm the stop. Nothing merges until it does; the agent may still be working.");
  });

  it("an output says each thing once: no 'Verified: Verified …' on any finished task", () => {
    expect(outputLine("verification", "Verified against the acceptance criteria (simulated)")).toEqual({ text: "Verified against the acceptance criteria (simulated)" });
    expect(outputLine("brief", "Build the invite sheet as designed")).toEqual({ label: "The brief", text: "Build the invite sheet as designed" });
    const s = buildDemo(T0);
    for (const t of s.tasks.filter((x) => x.lifecycle === "done")) expect(text(page(s, t.id))).not.toMatch(/Verified: Verified|The brief: Brief/);
  });
});

describe("a task the building budget holds (ORC-030 Q-24)", () => {
  it("says the budget holds it, why, and links to Budgets; within the budget it is Ready", () => {
    const { s, tasks, at } = blueprintScene();
    // You give the go-ahead (Start): within the budget the task is ready to start.
    const go = runCommand(s, "setHoldBeforeStart", { taskId: tasks.reminders, value: false }, at(400)).state;
    expect(M.stateLabel(go, task(go, tasks.reminders))).toBe("Ready");
    expect(text(page(go, tasks.reminders))).not.toContain("building budget holds");
    // The budget is below what was spent: the factory stops, and nothing new starts on this task.
    const held = runCommand(go, "setBudgets", { buildingUsd: 5, maintenanceUsdPerMonth: 10 }, at(401)).state;
    expect(M.dispatchEligible(held, at(402)).tasks.find((t) => t.id === tasks.reminders)!.lifecycle).toBe(task(held, tasks.reminders).lifecycle);
    expect(M.stateLabel(held, task(held, tasks.reminders))).toBe("Held at the building budget");
    const html = page(held, tasks.reminders);
    expect(text(html)).toContain("The building budget holds it. The building budget is reached: $9.90 of $5.00. Nothing new starts until you raise the budget or continue past it. Budgets");
    expect(html).toContain('href="#/settings/project/budgets"');
  });
});
