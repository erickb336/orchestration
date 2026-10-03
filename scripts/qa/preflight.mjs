// QA journey "preflight": the pre-flight and Start the factory, as the owner sees them, at 1280 and 375 wide.
//
// What it drives, on a fresh service for each width:
// 1. Home: "Start the factory…" opens the pre-flight.
// 2. The pre-flight: the blueprint by focus, what is still open, the tasks, and the two budgets.
// 3. Another tab approves Trip map while the owner reads. The stale banner shows, and the agreement clears.
// 4. The owner chooses Check-in, agrees and starts. The screen says what it recorded. Home shows the factory floor.
// 5. The empty case, on a second service: a new project with nothing approved and no budget. The journey reads the
//    pre-flight, follows its link to Settings › Project › Budgets, sets a building budget, comes back, and starts the
//    factory.
//
// Sample data: the Weekend Trips project in Vision (src/ui/preflight/preflightScene.ts) and a new empty project. Both
// are fixtures built through the real commands. The runtime is the fake one, and no scheduler tick runs.
// The second service uses ORCHESTRATION_TEST_PORT + 2 and + 3.
//
// Run: ORCHESTRATION_TEST_PORT=5960 node --import tsx scripts/qa/preflight.mjs

import { PORT, buildApp, runJourney, startService, text } from "./harness.mjs";
import * as M from "../../src/domain/model.ts";
import { buildSeed } from "../../src/domain/seed.ts";
import { preflightScene } from "../../src/ui/preflight/preflightScene.ts";

/** Errors that the harness or the fixture makes, not the product (see the report): drop them before a page check. */
function dropNoise(page) {
  page.qaErrors = page.qaErrors.filter((e) => !(/localStorage/.test(e) && /sandboxed/.test(e)));
}

const emptyProject = () => M.initProject(buildSeed(Date.now(), { inFlightRuns: false }), { name: "Weekend Trips", repoPath: "/tmp/weekend-trips", vision: "Weekend trips for a small group of friends.", focus: "Plan a trip together" }, new Date().toISOString());

await runJourney(
  "preflight",
  () => preflightScene().s,
  async (j, page, service, width) => {
    const has = async (words) => (await text(page)).includes(words);
    const agreement = page.getByRole("checkbox", { name: /I have reviewed the blueprint/ });
    const start = page.getByRole("button", { name: "Start the factory", exact: true });

    await j.step("Home", async () => {
      await page.goto(`${service.origin}/#/overview`);
      const link = page.getByRole("link", { name: "Start the factory…" }).first();
      await link.waitFor({ timeout: 10_000 });
      j.check((await link.getAttribute("href")) === "#/vision/pre-flight", "Home: Start the factory… opens the pre-flight");
      await j.shot("home");
      await link.click();
    });

    await j.step("The pre-flight", async () => {
      await page.getByRole("heading", { name: "Start the factory?" }).waitFor({ timeout: 10_000 });
      await page.waitForTimeout(400);
      await j.shot("screen");
      dropNoise(page);
      await j.pageChecks("the pre-flight");
      const t = await text(page);
      j.check(["The experience · 2 approved", "Inputs and outputs · 2 approved", "Flows · 1 approved"].every((w) => t.includes(w)), "the blueprint: the approved parts by focus");
      j.check(/Words v1\s*PE: not reviewed/.test(t) && /Trip plan v1\s*PE: agreed/.test(t), "the blueprint: each part shows its PE review (Words: not reviewed)");
      const open = page.getByRole("region", { name: "Still open" }).getByRole("listitem");
      const lines = await open.allInnerTexts();
      j.check(lines.length === 3, "still open: 3 items (vision areas, Trip map, the PE probe)", lines);
      j.check(lines.some((l) => l.includes("Trip map v1: you marked it Change")) && lines.some((l) => l.includes("A PE probe is still running")), "still open: Trip map (marked Change) and the running probe, by name");
      j.check(t.includes("$0.00 spent of $40.00") && t.includes("The factory stops and asks you at $40.00"), "the budgets: building, $40.00, and the stop");
      j.check(t.includes("The budget is $10.00 a month"), "the budgets: maintenance, $10.00 a month");
      j.check(t.includes("2 planned tasks: 1 Feature and 1 Change."), "the tasks: 2 planned tasks");
      j.check((await start.getAttribute("aria-disabled")) === "true", "Start the factory waits for the agreement");
      if (/Packing list v1 \(new; no task builds it yet\)/.test(t) && t.includes("Packing list\nFeature"))
        j.note("What changes says 'Packing list v1 (new; no task builds it yet)' beside a planned task named Packing list: the screen does not say that the task does not cite the part.");
    });

    await j.step("The stale banner", async () => {
      await agreement.check();
      // Another tab: the owner keeps Trip map there (the commands that tab's Keep and Send send).
      const map = service.state().studio.artifacts.find((a) => a.title === "Trip map").id;
      service.command("sendFeedback", { entries: [{ artifactId: map, version: 1, mark: "keep", pins: [], note: "", rows: [] }] });
      service.command("approveArtifact", { artifactId: map, version: 1 });
      const banner = page.getByText("The draft, the vision, the summary or what is open changed while you read.");
      await banner.waitFor({ timeout: 10_000 });
      j.check(!(await agreement.isChecked()), "stale: the banner shows, and the agreement is cleared");
      j.check(!(await has("Trip map v1: you marked it Change")) && (await has("The experience · 3 approved")), "stale: the new pre-flight shows Trip map approved, not open");
      await banner.scrollIntoViewIfNeeded();
      await j.shot("stale", { full: false });
    });

    await j.step("Start the factory", async () => {
      await page.getByRole("radio", { name: "Check-in" }).click();
      j.check(await page.getByRole("checkbox", { name: /Before each task starts/ }).isChecked(), "Check-in ticks Before each task starts");
      const tasks = await page.getByRole("list", { name: "The planned tasks" }).innerText();
      j.check((tasks.match(/Waits for your go-ahead/g) ?? []).length === 2, "Check-in: each planned task waits for your go-ahead", tasks);
      await agreement.check();
      await j.shot("agreed");
      await start.click();
      await page.getByRole("heading", { name: "The factory started." }).waitFor({ timeout: 10_000 });
      await page.waitForTimeout(400);
      await j.shot("started");
      dropNoise(page);
      await j.pageChecks("after the start");
      const t = await text(page);
      j.check(/Started by you, .*, from Lock in 1 and vision r1\./.test(t), "started: by you, from Lock in 1 and vision r1");
      j.check(t.includes("The factory starts on Check-in"), "started: it says Check-in");
      const rec = service.state().project.factoryStarts.at(-1);
      j.check(rec?.settings.autonomy === "checkin" && rec.blueprintRev === 1, "the record: Check-in, blueprint Lock in 1", rec && { autonomy: rec.settings.autonomy, rev: rec.blueprintRev, open: rec.openItems.length });
    });

    await j.step("The factory floor", async () => {
      await page.getByRole("link", { name: "Go to the factory floor" }).click();
      await page.getByRole("heading", { name: "Home", exact: true }).waitFor({ timeout: 10_000 });
      await page.waitForTimeout(600);
      await j.shot("floor");
      dropNoise(page);
      await j.pageChecks("Home after the start");
      const t = await text(page);
      j.check(t.includes("Factory running"), "Home: the header says the factory runs");
      j.check(t.includes("The factory") && t.includes("Packing list") && t.includes("Join by link"), "Home: the factory floor lists the two tasks");
      j.check(t.includes("$0.00 of $40.00 spent"), "Home: the building budget, $0.00 of $40.00");
      j.check(!(await page.getByRole("link", { name: "Start the factory…" }).count()), "Home: no Start the factory… link after the start");
      if (t.includes("The PE estimates it before the factory starts")) j.note("Home after the start: 'The PE estimates it before the factory starts' is false now (backlog B-03).");
    });

    // ---------- the empty case: nothing approved, no budget ----------
    const dist = await buildApp();
    const empty = await startService(emptyProject, { port: PORT + 2, dist });
    try {
      await j.step("The empty pre-flight", async () => {
        await page.goto(`${empty.origin}/#/vision/pre-flight`);
        await page.getByRole("heading", { name: "Start the factory?" }).waitFor({ timeout: 10_000 });
        await page.waitForTimeout(400);
        await j.shot("empty");
        dropNoise(page);
        await j.pageChecks("the empty pre-flight");
        const t = await text(page);
        j.check(t.includes("Nothing is approved yet. The factory builds from the vision text alone."), "empty: the blueprint says nothing is approved");
        j.check(t.includes("The draft approves nothing yet, so nothing goes into force."), "empty: the first Lock in says nothing goes into force");
        j.check(t.includes("No building budget is set, so the factory does not stop for cost."), "empty: it says no building budget is set");
        const budgetLink = page.getByRole("link", { name: "Set the budgets in Settings › Project › Budgets" });
        j.check((await budgetLink.getAttribute("href")) === "#/settings/project/budgets", "empty: beside the budgets, a link to where you set them (Settings › Project › Budgets)");
        j.check(!t.includes("the Lock in only changes the vision text"), "empty: the estimate does not say the Lock in changes the vision text (it changes nothing)");
      });

      await j.step("Set a building budget", async () => {
        await page.getByRole("link", { name: "Set the budgets in Settings › Project › Budgets" }).click();
        const field = page.getByRole("textbox", { name: "Building budget (dollars)" });
        await field.waitFor({ timeout: 10_000 });
        j.check(page.url().endsWith("#/settings/project/budgets"), "the link opens Settings › Project › Budgets", page.url());
        await field.fill("25");
        await page.getByRole("button", { name: "Save", exact: true }).first().click();
        await empty.until("the budget is saved", (s) => s.project.budgets.buildingUsd === 25, 10_000);
        await field.scrollIntoViewIfNeeded();
        await j.shot("empty-budget-set", { full: false });
        await page.goto(`${empty.origin}/#/vision/pre-flight`);
        await page.getByRole("heading", { name: "Start the factory?" }).waitFor({ timeout: 10_000 });
        j.check(await has("It stops at $25.00 and asks you before it spends more."), "empty: the pre-flight shows the new building budget, $25.00");
      });

      await j.step("Start with nothing approved", async () => {
        await agreement.check();
        await start.click();
        await page.getByRole("heading", { name: "The factory started." }).waitFor({ timeout: 10_000 });
        await page.waitForTimeout(400);
        await j.shot("empty-started");
        dropNoise(page);
        await j.pageChecks("the empty start");
        j.check(await has("from the vision alone, since nothing was approved yet,"), "empty: started from the vision alone");
        const rec = empty.state().project.factoryStarts.at(-1);
        j.check(rec && !rec.blueprintRev, "empty: the record has no Lock in", rec && { rev: rec.blueprintRev });
      });
    } finally {
      await empty.stop();
    }
  },
);
