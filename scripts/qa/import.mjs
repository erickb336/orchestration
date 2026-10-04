// QA journey "import" (ORC-032): the import of an existing repository, in its five steps, at 1280 and 375 wide.
//
// What it drives, on a fresh demo service for each width (the fake runtime: no agent runs, nothing leaves this computer):
// 1. Start: Settings › Project › "Try the import on a sample repository (tally)". The Start screen reads tally, prefills
//    the kinds, the devices and how it runs with their reasons, and shows the estimate beside the budget. Start the
//    import, confirm, and the service records the new project, its environment, its test command and the import.
// 2. Reading: Vision shows the steps in order, the spend against the import budget, and Pause.
// 3. Review: round 0, As it is today. The journey answers 4 of the 5 questions as the prototype's example does (the
//    code for CSV, the README for currency, Confirm for rounding, Correct for refunds). For refunds it reads what
//    "the reader misread it" does, then sends "tally should do something else": a misreading waits for a designer's
//    fix, which is unit 2's run (the unit tests cover the wait).
// 4. Baseline: the facts follow the answers. Another tab changes the summary: the screen says so and clears the
//    agreement. The journey agrees and locks in the baseline through the service.
// 5. After: Design and reality shows each part's status and each rule's evidence; Home says "Nothing to build".
//
// Stubs until unit 2 (the server) lands, each named in the check it feeds:
// - POST /api/import/demo is unit 2's route. The page's request is answered with TALLY_START_INFO
//   (src/ui/import/importScene.ts, in that route's shape), through the browser's request routing; the service is not
//   changed.
// - The import's progress is unit 2's scheduler. After Start, the journey puts tally's import at the next stage into the
//   store (the state builders, src/domain/testing/import.ts: "parts" for Reading, "review" for Review), as the service
//   will reach it. The owner's own commands (Start, the answers, the Lock in) go through the real service.
// - The state builders' parts name files that are not on disk (unit 2's fake designer writes them), so the studio's file
//   route answers 404 for them. Those 404s, and only those, are left out of the page checks (`dropStubNoise`).
//
// Run: ORCHESTRATION_TEST_PORT=7900 node --import tsx scripts/qa/import.mjs

import { runJourney, text } from "./harness.mjs";
import { buildDemo } from "../../src/domain/demo.ts";
import { TALLY_COMMIT, tallyImport } from "../../src/domain/testing/import.ts";
import { TALLY_START_INFO } from "../../src/ui/import/importScene.ts";

/** The builder's stage, as the store's next state: the service reaches it with its own runs once unit 2 lands. */
const putStage = (service, stage) => service.store.update(() => tallyImport(stage).s, new Date().toISOString());
const flat = (t) => t.replace(/\s+/g, " ");

/**
 * The builders' parts have no files on disk: drop the 404s of the studio's file route for them, and the console's
 * "Failed to load resource" lines that go with them, when every 404 is one of those. Any other 404 or error stays.
 */
function dropStubNoise(page) {
  const stub = page.qaNotFound.filter((u) => u.includes("/api/studio/file?artifact="));
  if (!stub.length || stub.length !== page.qaNotFound.length) return;
  page.qaNotFound.splice(0);
  let n = stub.length;
  page.qaErrors = page.qaErrors.filter((e) => !(n > 0 && /Failed to load resource: .* 404/.test(e) && n--));
}

await runJourney(
  "import",
  () => buildDemo(Date.now()),
  async (j, page, service, width) => {
    await page.route("**/api/import/demo", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(TALLY_START_INFO) }));

    await j.step("1 Start", async () => {
      await page.goto(`${service.origin}/#/settings/project/new-project`);
      const tryIt = page.getByRole("button", { name: "Try the import on a sample repository (tally)" });
      await tryIt.waitFor({ timeout: 10_000 });
      await tryIt.click();
      await page.getByText("✓ Found").waitFor({ timeout: 10_000 });
      await page.waitForTimeout(300);
      const t = flat(await text(page));
      j.check(t.includes("The import reads the last commit, c0ffee0 on main. Changes you have not committed are left out."), "Start: it names the commit it reads, and leaves out what is not committed (C7)");
      j.check(t.includes("14 source files and 5 test files") && !t.includes("22 tests"), "Start: it counts files, not tests (C7)");
      j.check(t.includes("No file in your repository changes") && !t.includes("Nothing is written into the repository"), "Start: No file in your repository changes (C7)");
      j.check(/How it runs\s*complete/.test(t) && t.includes("Use the image Python 3.12") && (await page.getByLabel("Test command").inputValue()) === "python3 -m pytest --junitxml=reports/junit.xml" && (await page.getByLabel("JUnit report path").inputValue()) === "reports/junit.xml", "Start: how it runs is prefilled, each with its reason (C1)");
      j.check(t.includes("The estimate: about $0.43–$2.07.") && t.includes("$3.00, the budget"), "Start: the estimate beside the budget");
      const form = page.locator(".imp-start");
      j.check(await form.getByRole("checkbox", { name: /Screen product/ }).isChecked() && !(await form.getByRole("checkbox", { name: /Infrastructure/ }).isChecked()) && t.includes("Found: tally/__main__.py: a command-line entry"), "Start: the kinds are prefilled with their reasons");
      await j.shot("1-start");
      await j.pageChecks("Start");
      // What a missing test command means, then put it back.
      await page.getByLabel("Test command").fill("");
      await page.getByText("Without a test command and its report, the tests do not run").waitFor({ timeout: 5_000 });
      j.check(true, "Start: without a test command, it says the tests do not run and every rule is inferred");
      await page.getByLabel("Test command").fill("python3 -m pytest --junitxml=reports/junit.xml");
      await page.getByRole("button", { name: "Start the import" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      j.check((await dialog.innerText()).includes('Start a new project "tally"?'), "Start: the confirmation names the project");
      await dialog.getByRole("button", { name: "Start project" }).click();
      await service.until("the import started", (s) => s.studio.import?.commit === TALLY_COMMIT, 10_000);
      const s = service.state();
      j.check(s.project.name === "tally" && s.project.repoPath === TALLY_START_INFO.path, "the record: a new project on the repository");
      j.check(s.studio.import.budgetUsd === 3 && s.studio.import.helpers === null && s.studio.rounds[0]?.n === 0, "the record: the import, with its $3 budget, and round 0 open");
      j.check(s.project.checks.testReport === "reports/junit.xml" && s.project.checks.commands[0]?.argv.join(" ") === "python3 -m pytest --junitxml=reports/junit.xml" && s.project.environment?.image === TALLY_START_INFO.proposal.image, "the record: the test command, its report and the environment (C1)");
      j.check(s.project.domains.join() === "screen,code" && s.project.devices.join() === "terminal", "the record: the kinds and the device");
    });

    await j.step("2 Reading", async () => {
      await page.waitForURL(/#\/vision$/, { timeout: 10_000 });
      await page.getByText("Importing").first().waitFor({ timeout: 10_000 });
      j.check((await text(page)).includes("running your test command in the environment"), "Reading, as Start left it: the tests run first");
      putStage(service, "parts");
      await page.getByText("4 of 5 steps done").waitFor({ timeout: 10_000 });
      await page.waitForTimeout(300);
      const t = flat(await text(page));
      j.check(t.includes("$0.00 spent of the $3.00 import budget. The estimate: $0.43–$2.07."), "Reading: the spend against the import budget, with the estimate");
      j.check(/The tests[\s\S]*The rules[\s\S]*The parts[\s\S]*The recording[\s\S]*The words/.test(t) && t.includes("recording the parts in the environment"), "Reading: the steps in order, each with its state (C2)");
      j.check(await page.getByRole("button", { name: "Pause the import" }).isVisible(), "Reading: Pause the import");
      const nav = flat(await page.getByRole("navigation", { name: "Main" }).innerText());
      j.check((nav.match(/importing/g) ?? []).length >= (width < 600 ? 0 : 2), "the header: Home and Vision say importing", nav);
      await j.shot("2-reading");
      await j.pageChecks("Reading");
    });

    await j.step("3 Review", async () => {
      putStage(service, "review");
      await page.getByText("2 conflicts and 3 guesses need you;").waitFor({ timeout: 10_000 });
      await page.waitForTimeout(300);
      const t = flat(await text(page));
      j.check(t.includes("Round 0 · As it is today") && !t.includes("Round 1"), "Review: round 0, As it is today (C9)");
      j.check(t.includes("12 rules are confirmed.") && t.includes("Recorded from the running CLI"), "Review: parts are listed as recorded or read from the code, not confirmed (C8)");
      await j.shot("3-review");
      await j.pageChecks("Review");
      await page.getByRole("button", { name: /^The code: --format csv/ }).click();
      await page.getByRole("button", { name: /^The docs: a currency on each expense/ }).click();
      const q = (area, id) => page.locator("article", { has: page.getByRole("heading", { name: area }) }).filter({ hasText: id });
      await q("splitting", "R15").getByRole("button", { name: "Confirm", exact: true }).click();
      const refunds = q("the ledger", "R16");
      await refunds.getByRole("button", { name: "Correct", exact: true }).click();
      await refunds.getByRole("radio", { name: /does something else today/ }).check();
      await refunds.getByLabel("What is right?").fill("A negative amount is an error today; tally add stops.");
      const after4 = flat(await text(page));
      j.check(after4.includes("4 of 5 answered. 1 stays open if you send now."), "Review: the counts follow the answers");
      j.check(after4.includes("Your change becomes a change to design.") && after4.includes("A designer fixes the part from your words"), "Review: each answer says what it does: a change to design (C5), a fix of the reading");
      await refunds.scrollIntoViewIfNeeded();
      await j.shot("3-review-answered", { full: false });
      await refunds.getByRole("radio", { name: /should do something else/ }).check();
      await refunds.getByLabel("What is right?").fill("A negative amount should stop with an error.");
      j.check(flat(await refunds.innerText()).includes("Your answer: tally should do something else. The baseline keeps what tally does today."), "Review: Correct as a change says it is a change to design (C15)");
      dropStubNoise(page);
      await j.pageChecks("Review, answered");
      await page.getByRole("button", { name: "Send to the lead" }).click();
      await service.until("the answers are recorded", (s) => s.studio.import?.answers.length === 4, 10_000);
      j.check(true, "Review: Send records the 4 answers");
    });

    await j.step("4 Baseline", async () => {
      await page.waitForURL(/#\/vision\/baseline$/, { timeout: 10_000 });
      await page.getByRole("heading", { name: "Lock in 1 · the baseline" }).waitFor({ timeout: 10_000 });
      await page.waitForTimeout(300);
      const t = flat(await text(page));
      j.check(t.includes("13 rules are verified: their tests pass.") && t.includes("4 rules have no test: 2 you confirmed, 1 you want changed, 1 not answered."), "Baseline: the facts follow the answers");
      j.check(t.includes("Change tally add: The docs: a currency on each expense") && t.includes("Change The ledger: A negative amount should stop with an error.") && t.includes("Your 2 changes to design wait"), "Baseline: the changes to design stay out of the baseline (C5)");
      j.check(t.includes("Baseline tally add v1 (terminal demo; tests 5 of 5 pass; recorded)"), "Baseline: each part with its tests and its recording");
      j.check(t.includes("The vision: what tally is today"), "Baseline: the vision card (C10)");
      const lockIn = page.getByRole("button", { name: "Lock in the baseline" });
      j.check((await lockIn.getAttribute("aria-disabled")) === "true", "Baseline: Lock in waits for the agreement");
      const agree = page.getByRole("checkbox", { name: /I have reviewed the baseline/ });
      await agree.check();
      // Another tab: a building budget, which the summary shows.
      service.command("setBudgets", { buildingUsd: 25, maintenanceUsdPerMonth: 5 });
      await page.getByText("The summary changed while you read it.").waitFor({ timeout: 10_000 });
      j.check(!(await agree.isChecked()), "Baseline: a changed summary is shown, and the agreement is cleared");
      await j.shot("4-baseline");
      dropStubNoise(page);
      await j.pageChecks("Baseline");
      await agree.check();
      await lockIn.click();
      await page.getByText("Locked in, as Lock in 1: the baseline.").waitFor({ timeout: 10_000 });
      const rev = service.state().blueprint.revisions[0];
      j.check(rev?.lockIn?.baseline?.commit === TALLY_COMMIT && service.state().blueprint.revisions.length === 1, "Baseline: Lock in 1 is recorded as the baseline, at the import's commit");
      await j.shot("4-baseline-locked", { full: false });
    });

    await j.step("5 After", async () => {
      await page.goto(`${service.origin}/#/results/design`);
      await page.getByText("Lock in 1, the baseline").waitFor({ timeout: 10_000 });
      await page.waitForTimeout(300);
      const t = flat(await text(page));
      j.check(/tally add v1 terminal-demo built and verified from the import Tests: 5 of 5 pass/.test(t) && /tally report v1 terminal-demo built, not verified from the import Tests: 2 of 3 pass · 1 no test/.test(t), "After: each part's status from the import, with its tests");
      await page.getByRole("button", { name: /^The ledger v1/ }).click();
      await page.getByText("The checks do not prove it yet: 2 rules or examples have no test.").waitFor({ timeout: 5_000 });
      const d = flat(await page.locator(".st-reality__detail").innerText());
      j.check(d.includes("R16") && d.includes("a change to design") && d.includes("not confirmed") && d.includes("passes test_money.py::test_whole_cents +1"), "After: each rule's evidence: its test, and your answer", d.slice(0, 300));
      await j.shot("5-after");
      dropStubNoise(page);
      await j.pageChecks("Design and reality");
      await page.goto(`${service.origin}/#/overview`);
      await page.getByText(/Nothing to build/).waitFor({ timeout: 10_000 });
      const home = flat(await text(page));
      j.check(home.includes("Nothing to build yet: 2 changes to design wait."), "Home: Nothing to build, with the changes to design that wait");
      const nav = flat(await page.getByRole("navigation", { name: "Main" }).innerText());
      j.check(/nothing to build|idle/.test(nav) && /2 changes/.test(nav), "the header: Home says nothing to build; Vision, 2 changes to design", nav);
      await j.shot("5-home");
      dropStubNoise(page);
      await j.pageChecks("Home after the baseline");
    });
  },
);
