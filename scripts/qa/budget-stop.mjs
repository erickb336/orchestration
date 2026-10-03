// QA journey "budget-stop" (ORC-030): the building budget stops the factory, the owner sees it, and continues past it.
//
// What it drives, at 1280 and 375 wide:
// 1. Settings › Budgets: the owner sets a building budget $1 above the spend and saves it. Nothing stops.
// 2. Message the lead: one simulated lead run, a known $0 (Q-23). The spend stays as it was, and nothing stops.
// 3. Settings › Budgets: the owner lowers the budget below the spend. The factory stops. Home, the Factory pill and
//    Needs you say so, and Needs you names no internal run id.
// 4. At the stop, the owner starts a task that waits for the go-ahead; nothing starts.
// 5. Settings › Budgets: Continue past the budget, confirm. The task runs.
// 6. The demo (a second service): the owner sets a $50 budget. The factory must not stop at $0.00 spent (Q-12).
// 7. The floor fixture as it is (a third service): its two runs in flight are lost at the start. Each counts at an
//    estimate, and the factory does not stop far below its $40 budget (Q-15).
//
// Why the owner lowers the budget: every simulated run (a task's, the lead's, Vision's) is a known $0, so in a
// simulated service only the fixture's recorded costs count, and no run can reach a budget above them.
//
// Sample data: the factory floor fixture (src/ui/floor/floorScene.ts), built through the real commands, where each
// finished run records $1.10; its two runs in flight are completed with that cost too, so none is lost at the start.
// Step 6 uses the demo project (Weekend Trips), whose sample runs are simulated. Everything is simulated.
//
// Run: ORCHESTRATION_TEST_PORT=5972 node --import tsx scripts/qa/budget-stop.mjs   (uses the port up to +5;
// QA_ONLY=1280 runs one width)

import { PORT, buildApp, openPage, runJourney, sleep, startService } from "./harness.mjs";
import { buildDemo } from "../../src/domain/demo.ts";
import * as M from "../../src/domain/model.ts";
import { budgetStop, buildingSpend, countedSpend } from "../../src/domain/spend.ts";
import { floorScene } from "../../src/ui/floor/floorScene.ts";

const GO_AHEAD = "Offline maps";

/** The floor fixture, with its runs in flight completed at the fixture's $1.10 a run. */
function makeState() {
  let s = floorScene().s;
  const now = new Date().toISOString();
  for (const a of M.activeAttempts(s)) {
    const st = s.tasks.find((t) => t.id === a.taskId).steps.find((x) => x.id === a.stepId);
    const outputs = st.outputs.map((o) => (o.kind === "review-findings" ? { name: o.name, summary: "Review: nothing found.", findings: [], openFindings: 0 } : { name: o.name, summary: `${o.name} done` }));
    s = M.reportCompletion(s, a.id, [], now, outputs, { usage: { costUsd: 1.1 } });
  }
  return s;
}

/** What the budget stop counts now: the recorded spend, and each cost with no full record at its estimate. */
const counted = (s) => countedSpend(buildingSpend(s));
/** An internal run id ("lead-1127", "run-12", "studio-3"): never shown to the owner. */
const RUN_ID = /\b(?:lead|run|studio)-\d+\b/;

async function waitFor(what, fn, ms) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`timed out after ${ms / 1000}s waiting for: ${what}`);
    await sleep(150);
  }
}
const flat = (t) => t.replace(/\s*\n+\s*/g, " · ");

await runJourney(
  "budget-stop",
  makeState,
  async (j, page, sv, width) => {
    const places = () => page.getByRole("navigation", { name: "Vision and the factory" }).innerText();
    const region = (name) => page.getByRole("region", { name });
    let budget;
    let goId;

    await j.step("Settings › Budgets: set a small building budget", async () => {
      await page.goto(`${sv.origin}/#/overview`);
      await region(/^Building budget/).waitFor();
      j.check(/of \$40\.00/.test(await region(/^Building budget/).innerText()), "Home: the building budget card shows the spend of $40.00", flat(await region(/^Building budget/).innerText()));
      await j.shot("01-home-before");
      await page.goto(`${sv.origin}/#/settings/budgets`);
      const field = page.getByLabel("Building budget (dollars)");
      await field.waitFor();
      budget = Math.ceil(counted(sv.state())) + 1;
      await field.fill(String(budget));
      await page.getByRole("group", { name: "Save Budgets" }).getByRole("button", { name: "Save" }).click();
      await page.getByRole("group", { name: "Save Budgets" }).getByText("Saved").waitFor({ timeout: 5_000 });
      j.check(sv.state().project.budgets.buildingUsd === budget, `the record: the building budget is $${budget}`, sv.state().project.budgets);
      // The card's spend line reads the live state, which the service sends after the save.
      const note = await waitFor("the spend line", async () => ((t) => (t.includes(`of $${budget}.00`) ? t : ""))(await region("Budgets").innerText()), 4_000).catch(() => region("Budgets").innerText());
      j.check(note.includes(`of $${budget}.00`), "the Budgets card says what was spent of the new budget", flat(note).slice(-160));
      j.check(!budgetStop(sv.state()) || /reached/.test(note), "saving the budget does not stop the factory before it is reached", budgetStop(sv.state())?.why);
      await j.shot("02-budget-saved");
      await j.pageChecks("Settings › Budgets");
    });
    if (!budget) return;

    await j.step("a simulated lead run is a known $0: the spend stays, and nothing stops", async () => {
      const before = counted(sv.state());
      const replies = sv.state().leadRuns.filter((r) => r.outcome === "completed").length;
      await page.getByRole("button", { name: /^Message the lead/ }).first().click();
      await page.getByLabel("Message to the lead").fill("What needs me today?");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await sv.until("the lead's reply", (s) => s.leadRuns.filter((r) => r.outcome === "completed").length > replies, 60_000);
      const run = sv.state().leadRuns.filter((r) => r.outcome === "completed").at(-1);
      j.check(run?.simulated === true, "the record: the lead's run is marked simulated", run && { id: run.id, simulated: run.simulated });
      j.check(counted(sv.state()) === before, "the counted spend is what it was before the lead's run", { before, after: counted(sv.state()) });
      j.check(!budgetStop(sv.state()), "the factory does not stop for a simulated lead run", budgetStop(sv.state())?.why);
      await page.getByRole("button", { name: "Close the lead panel" }).click();
      j.check(/Factory running/.test(await places()), "the Factory pill still says it runs", flat(await places()));
    });

    await j.step("the owner lowers the budget below the spend: the factory stops and asks", async () => {
      await page.goto(`${sv.origin}/#/settings/budgets`);
      const field = page.getByLabel("Building budget (dollars)");
      await field.waitFor();
      budget = Math.max(1, Math.floor(counted(sv.state())) - 1);
      await field.fill(String(budget));
      await page.getByRole("group", { name: "Save Budgets" }).getByRole("button", { name: "Save" }).click();
      await page.getByRole("group", { name: "Save Budgets" }).getByText("Saved").waitFor({ timeout: 5_000 });
      await waitFor("the Factory pill to say stopped at the budget", async () => /stopped at the budget/.test(await places()), 10_000);
      j.check(/Factory stopped at the budget · needs you/.test(await places()), "the Factory pill says it stopped at the budget and needs you", flat(await places()));
      await page.goto(`${sv.origin}/#/overview`);
      const card = flat(await region(/^Building budget/).innerText());
      j.check(/Stopped/.test(card) && /budget is reached/.test(card), "Home: the building budget card says Stopped, and why", card);
      const needs = flat(await region(/^Needs you/).innerText());
      j.check(/budget is reached/.test(needs), "Home: Needs you lists the budget stop", needs.slice(0, 300));
      j.check(!RUN_ID.test(needs), "Home: Needs you names no internal run id", needs.match(RUN_ID)?.[0]);
      await j.shot("03-home-stopped");
      await j.pageChecks("Home at the budget");
    });

    await j.step("at the stop, a started task does not run", async () => {
      await page.goto(`${sv.origin}/#/tasks`);
      await page.getByRole("link", { name: GO_AHEAD }).first().click();
      await page.getByRole("heading", { level: 1, name: GO_AHEAD }).waitFor();
      const id = decodeURIComponent(page.url().split("#/task/")[1]);
      await page.getByRole("button", { name: "Start", exact: true }).click();
      const leadsBefore = sv.state().leadRuns.filter((r) => r.trigger !== "message").length;
      await sleep(5_000);
      j.check(M.activeAttempts(sv.state(), id).length === 0, "after Start, no run starts while the budget stop holds");
      const head = flat(await page.locator(".t-head__title").innerText());
      j.check(!/Running/.test(head), "the task does not say Running", head);
      const main = flat(await page.locator("main").innerText());
      j.check(/budget/i.test(main), "the task page says the budget holds it", main.slice(0, 300));
      j.check(sv.state().leadRuns.filter((r) => r.trigger !== "message").length === leadsBefore, "no lead run starts by itself at the stop", sv.state().leadRuns.slice(-3).map((r) => r.trigger));
      await j.shot("04-task-held-by-budget");
      goId = id;
    });

    await j.step("Continue past the budget, and work resumes", async () => {
      await page.goto(`${sv.origin}/#/settings/budgets`);
      const card = region("Budgets");
      await card.getByRole("button", { name: "Continue past the budget" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      j.check(/Continue past the budget\?/.test(await dialog.innerText()), "Continue asks to confirm, and says how it ends", flat(await dialog.innerText()));
      await j.shot("05-continue-confirm", { full: false });
      await dialog.getByRole("button", { name: "Continue past the budget" }).click();
      await waitFor("the stop banner to go", async () => !(await card.getByRole("button", { name: "Continue past the budget" }).count()), 5_000);
      j.check(/You continued past the \$\d+\.00 budget/.test(await card.innerText()), "the Budgets card says you continued past the budget", flat(await card.innerText()).slice(-220));
      await waitFor("the Factory pill to say running", async () => /Factory running/.test(await places()), 10_000);
      j.check(true, "the Factory pill says the factory runs again", flat(await places()));
      await j.shot("06-continued");
      if (goId) {
        await page.goto(`${sv.origin}/#/task/${encodeURIComponent(goId)}`);
        await waitFor("the started task to run", async () => /Running/.test(await page.locator(".t-head__title").innerText()), 20_000);
        j.check(M.activeAttempts(sv.state(), goId).length > 0, "the task started at the stop now runs", flat(await page.locator(".t-head__title").innerText()));
        await j.shot("07-task-runs");
      }
      await j.pageChecks("after Continue past the budget");
    });

    await j.step("the demo: a $50 budget does not stop the factory at $0.00", async () => {
      const port = PORT + 2;
      const demo = await startService(() => buildDemo(Date.now()), { run: true, tickMs: 500, port, dist: await buildApp() });
      const p = await openPage(page.context().browser(), width);
      try {
        await p.goto(`${demo.origin}/#/settings/budgets`);
        await p.getByLabel("Building budget (dollars)").fill("50");
        await p.getByRole("group", { name: "Save Budgets" }).getByRole("button", { name: "Save" }).click();
        await p.getByRole("group", { name: "Save Budgets" }).getByText("Saved").waitFor({ timeout: 5_000 });
        await sleep(800);
        const pill = flat(await p.getByRole("navigation", { name: "Vision and the factory" }).innerText());
        const note = flat(await p.getByRole("region", { name: "Budgets" }).innerText());
        j.check(!/stopped at the budget/.test(pill), "the demo: after a $50 budget, the factory still runs (its simulated runs cost $0.00)", { pill, budgets: note.slice(0, 400) });
        j.check(/\$0\.00 of \$50\.00/.test(note), "the demo: the Budgets card says $0.00 of $50.00 spent", note.slice(0, 400));
        await p.screenshot({ path: `${j.dir}/${width}-08-demo-budget.png`, fullPage: true });
        j.check(p.qaErrors.length === 0, "the demo: no console error, page error or failed request", p.qaErrors.slice(0, 5));
      } finally {
        await p.context().close();
        await demo.stop();
      }
    });

    await j.step("runs lost at a restart count at an estimate: the floor fixture does not stop far below its budget", async () => {
      // Q-15: the fixture as it is ($8.10 spent of $40), its two runs in flight with no process when the service starts.
      const floor = await startService(() => floorScene().s, { run: true, tickMs: 500, port: PORT + 4, dist: await buildApp() });
      const p = await openPage(page.context().browser(), width);
      try {
        await floor.until("the runs in flight to be lost", (s) => s.attempts.some((a) => a.outcome === "lost"), 10_000);
        const s = floor.state();
        const lost = buildingSpend(s).unknown.filter((u) => u.reason === "lost");
        j.check(lost.length > 0 && lost.every((u) => u.countedUsd !== null), "the record: each lost run counts at an estimate (the dearest run on its model)", lost);
        j.check(!budgetStop(s), "the factory does not stop: the spend and the lost runs' estimate stay below the $40.00 budget", { why: budgetStop(s)?.why, counted: counted(s) });
        await p.goto(`${floor.origin}/#/overview`);
        await p.getByRole("region", { name: /^Building budget/ }).waitFor();
        const pill = flat(await p.getByRole("navigation", { name: "Vision and the factory" }).innerText());
        j.check(!/stopped at the budget/.test(pill), "the Factory pill does not say stopped at the budget", pill);
        const card = flat(await p.getByRole("region", { name: /^Building budget/ }).innerText());
        j.check(/lost when the service stopped/.test(card), "Home: the building budget card says what the estimate is for", card.slice(0, 400));
        await p.screenshot({ path: `${j.dir}/${width}-09-floor-lost-runs.png`, fullPage: true });
        j.check(p.qaErrors.length === 0, "the floor fixture: no console error, page error or failed request", p.qaErrors.slice(0, 5));
      } finally {
        await p.context().close();
        await floor.stop();
      }
    });
  },
  { service: { run: true, tickMs: 300, progressPerTick: 10 }, ...(process.env.QA_ONLY ? { widths: [Number(process.env.QA_ONLY)] } : {}) },
);
