// QA journey "import" (ORC-032): the import of an existing repository, in its five steps, at 1280 and 375 wide.
//
// It drives the real service, its routes and its scheduler, on a fresh demo service for each width, with the fake
// runtime: no agent runs, nothing leaves this computer, and the scheduler moves only when the journey steps it. The
// demo starts as it does for a user: the sample's agents run (the scheduler dispatched them once).
// Each screen that replaces another (Reading, Baseline) opens at its top, with focus on its heading (UX30-1); Start
// opens in place of its button, with focus on its heading (UX30-2).
// 1. Start: Settings › Project › "Try the import on a sample repository (tally)". The route makes the bundled tally in
//    the service's data folder and reads it: its commit, its files, the kinds, and how it runs (the image from
//    requirements.txt, its prepare, and the test command the README shows). Who reads it: Claude by default; Codex
//    shows its warning. Start the import and confirm: the sample's agents still run, so Start says "Pausing the
//    sample's agents…"; the journey steps the scheduler until they stopped and the service started the import, in one
//    command (the new project, its environment, its test command, who reads it, the import).
// 2. Reading: Vision shows the steps in order, the spend against the import budget, and Pause. The journey steps the
//    scheduler until the parts are in and the recording is next.
// 3. Review: the scheduler records the recording and the lead's review reply (simulated), which is round 0's message.
//    Each part's tile shows the part. Send with no answer leads to the baseline with every question open. Back in the
//    review, the import's spend reaches its budget (a recorded cost, injected: sample data): the review and Home say
//    so; Raise the budget ends the stop. The journey then answers 4 of the 5 questions as the prototype's example does
//    (the code for CSV, the README for currency, Confirm for rounding, Correct for refunds) and sends them.
// 4. Baseline: the facts follow the answers, and the lead's vision draft is there to accept. Your own Accept after
//    your agreement is not "the summary changed while you read it"; another tab's change is, beside the agreement.
//    The journey agrees and locks in the baseline.
// 5. After: Design and reality shows each part's status and each rule's evidence; Vision names round 0 "Lock in 1 · the
//    baseline", its parts take no mark, the changes to design wait beside Ask the lead for a round, and the open
//    question is answered there; Home says "Nothing to build".
// 6. In real mode (a second service that says "real", every run still simulated; ORCHESTRATION_TEST_PORT + 2):
//    Settings › Project › Start a new project › Import an existing repository, the path of a tally repository, and
//    Read the repository: the real route reads it.
//
// Run: ORCHESTRATION_TEST_PORT=7900 node --import tsx scripts/qa/import.mjs   (QA_WIDTH=375 for one width)

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { PORT, buildApp, runJourney, startService, text } from "./harness.mjs";
import { buildDemo } from "../../src/domain/demo.ts";
import * as M from "../../src/domain/model.ts";
import * as I from "../../src/domain/studio/import.ts";
import { tallyRepo } from "../../server/studio/import.ts";

const flat = (t) => t.replace(/\s+/g, " ");
const headOf = (repo) => execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
/** Wait for the state, stepping the scheduler (its clock is paused) every 50 ms. */
const stepUntil = (service, what, pred, ms = 60_000) => service.until(what, pred, ms, { stepping: true });
/** Whether an element is inside the window: the reader sees it without scrolling. */
const onScreen = (locator) => locator.evaluate((el) => {
  const r = el.getBoundingClientRect();
  return r.top >= 0 && r.bottom <= window.innerHeight;
});

/** Where focus is, its text, whether it is inside the window, and how far the page is scrolled. */
const focused = (page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    const r = el?.getBoundingClientRect();
    return { tag: el?.tagName ?? "", text: (el?.textContent ?? "").trim().slice(0, 80), inView: !!r && r.top >= 0 && r.bottom <= window.innerHeight, scrollY: Math.round(window.scrollY) };
  });
/** A screen of the import that replaces another opens at its top, with focus on its heading (UX30-1). */
const atTop = async (j, page, heading, where) => {
  await page.waitForTimeout(100);
  const f = await focused(page);
  j.check(f.tag === "H1" && f.text === heading && f.inView && f.scrollY === 0, `${where}: it opens at its top, with focus on its heading "${heading}" (UX30-1)`, JSON.stringify(f));
};

await runJourney(
  "import",
  () => buildDemo(Date.now()),
  async (j, page, service, width) => {
    const tally = join(service.dataDir, "import-demo", "tally");
    let commit = "";

    await j.step("1 Start", async () => {
      const running = M.activeAttempts(service.state()).length;
      j.check(running > 0, "the demo's default state: the sample's agents run", `${running} running`);
      await page.goto(`${service.origin}/#/overview`);
      await page.getByText("This is the sample project.").waitFor({ timeout: 10_000 });
      j.check(true, "Home before the import: This is the sample project (UX26-2)");
      await page.goto(`${service.origin}/#/settings/project/new-project`);
      const tryIt = page.getByRole("button", { name: "Try the import on a sample repository (tally)" });
      await tryIt.waitFor({ timeout: 10_000 });
      await tryIt.focus();
      await page.keyboard.press("Enter");
      await page.waitForTimeout(100);
      // Start opens in place of the button: focus goes to its heading, not to the page (UX30-2).
      const opened = await focused(page);
      j.check(opened.tag === "H3" && opened.text === "Import an existing repository" && opened.inView, "Start: after Enter on the button, focus is on the heading of Start (UX30-2)", JSON.stringify(opened));
      await page.getByText("✓ Found").waitFor({ timeout: 10_000 });
      await page.waitForTimeout(300);
      commit = headOf(tally);
      const t = flat(await text(page));
      j.check(t.includes(`The import reads the last commit, ${commit.slice(0, 7)} on main. Changes you have not committed are left out.`), "Start: it names the commit it reads, and leaves out what is not committed (C7)");
      j.check(t.includes("7 source files and 7 test files") && !/\d+ tests\b/.test(t), "Start: it counts files, not tests (C7)");
      j.check(t.includes("No file in your repository changes") && !t.includes("Nothing is written into the repository"), "Start: No file in your repository changes (C7)");
      j.check(
        /How it runs\s*complete/.test(t) && t.includes("Use the image Python") && t.includes("Found: requirements.txt. It prepares with python3 -m pip install --user -r requirements.txt."),
        "Start: the environment is the image the route proposes from requirements.txt, with its prepare (C1)",
      );
      const testCommand = await page.getByLabel("Test command").inputValue();
      const reportPath = await page.getByLabel("JUnit report path").inputValue();
      j.check(testCommand === "python3 tests/run.py" && reportPath === "reports/junit.xml" && t.includes("Prefilled. The README's Tests section shows a test runner that writes a JUnit report."), "Start: the test command and its report, as the README shows them (C1)", `${testCommand} · ${reportPath}`);
      j.check(t.includes("The estimate: about $0.41–$1.78.") && t.includes("$3.00, the budget"), "Start: the estimate beside the budget");
      const form = page.locator(".imp-start");
      j.check((await form.getByRole("checkbox", { name: /Screen product/ }).isChecked()) && !(await form.getByRole("checkbox", { name: /Infrastructure/ }).isChecked()) && t.includes("Found: tally/__main__.py: a command-line entry"), "Start: the kinds are prefilled with their reasons");
      // Who reads it (CR-5, Q5): Claude by default; Codex only with its warning.
      const claude = form.getByRole("radio", { name: /^Claude/ });
      const codex = form.getByRole("radio", { name: /^Codex/ });
      j.check(t.includes("Who reads it") && (await claude.isChecked()) && !(await codex.isChecked()) && !t.includes("Pick Codex only for a repository you trust"), "Start: who reads it, Claude by default");
      await codex.check();
      const warning = page.getByText("Codex's reads are not confined to the repository: a text in the repository can steer it to read other files on this computer. Pick Codex only for a repository you trust.");
      await warning.waitFor({ timeout: 5_000 });
      await warning.scrollIntoViewIfNeeded();
      await j.shot("1-start-codex", { full: false });
      j.check(true, "Start: Codex shows its warning");
      await claude.check();
      await j.shot("1-start");
      await j.pageChecks("Start");
      // What a missing test command means, then put it back.
      await page.getByLabel("Test command").fill("");
      await page.getByText("Without a test command and its report, the tests do not run").waitFor({ timeout: 5_000 });
      j.check(true, "Start: without a test command, it says the tests do not run and every rule is inferred");
      await page.getByLabel("Test command").fill("python3 tests/run.py");
      await page.getByRole("button", { name: "Start the import" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      j.check((await dialog.innerText()).includes('Start a new project "tally"?'), "Start: the confirmation names the project");
      await dialog.getByRole("button", { name: "Start project" }).click();
      // The sample's agents still run: the start waits for them, and says so (QA-F2).
      await page.getByText("Pausing the sample's agents…").waitFor({ timeout: 10_000 });
      const waiting = flat(await text(page));
      j.check(/\d+ (run is|runs are) stopping\. The import of "tally" starts when they have stopped\./.test(waiting) && waiting.includes("The import is starting: it waits for the sample's agents to stop."), "Start: in the demo's default state, it pauses the sample's agents first and says so (QA-F2)");
      j.check(service.state().project.sample && !service.state().studio.import, "the record: the sample stays until its agents stopped");
      await page.getByText("Pausing the sample's agents…").scrollIntoViewIfNeeded();
      await j.shot("1-start-pausing", { full: false });
      await stepUntil(service, "the import started", (s) => s.studio.import?.commit === commit);
      const s = service.state();
      j.check(s.project.name === "tally" && s.project.repoPath === tally && !s.project.importPending, "the record: a new project on the bundled repository, once the sample's agents stopped");
      j.check(s.studio.import.budgetUsd === 3 && s.studio.import.helpers === null && s.studio.import.readsOn === "claude" && s.studio.rounds[0]?.n === 0, "the record: the import, with its $3 budget, Claude reading, and round 0 open (CR-5)");
      j.check(s.project.checks.testReport === "reports/junit.xml" && s.project.checks.commands[0]?.argv.join(" ") === "python3 tests/run.py" && s.project.environment?.image?.startsWith("python:") && s.project.environment?.prepare?.[0]?.join(" ") === "python3 -m pip install --user -r requirements.txt", "the record: the test command, its report and the environment (C1)");
      j.check(s.project.domains.join() === "screen" && s.project.devices.join() === "terminal", "the record: the kind and the device");
    });

    await j.step("2 Reading", async () => {
      await page.waitForURL(/#\/vision$/, { timeout: 10_000 });
      await page.getByText("Importing").first().waitFor({ timeout: 10_000 });
      // Start project is at the foot of Settings; the reading opens at its top all the same.
      await atTop(j, page, "Vision", "Reading");
      // The scheduler runs the tests (simulated), the rules reader and the words, then the parts; the recording is next.
      await stepUntil(service, "the parts are in", (s) => I.importRuns(s, "parts").some((r) => r.status === "completed") && !s.studio.import.capture);
      await page.getByText("4 of 5 steps done").waitFor({ timeout: 10_000 });
      await page.waitForTimeout(300);
      const t = flat(await text(page));
      j.check(/\$\d+\.\d\d spent of the \$3\.00 import budget\. The estimate: \$0\.41–\$1\.78\./.test(t), "Reading: the spend against the import budget, with the estimate");
      j.check(/The tests[\s\S]*The rules[\s\S]*The parts[\s\S]*The recording[\s\S]*The words/.test(t) && t.includes("recording the parts in the environment") && t.includes("22 read, all pass"), "Reading: the steps in order, each with its state (C2)");
      j.check(await page.getByRole("button", { name: "Pause the import" }).isVisible(), "Reading: Pause the import");
      const nav = flat(await page.getByRole("navigation", { name: "Main" }).innerText());
      j.check((nav.match(/importing/g) ?? []).length >= (width < 600 ? 0 : 2), "the header: Home and Vision say importing", nav);
      await j.shot("2-reading");
      await j.pageChecks("Reading");
    });

    await j.step("3 Review", async () => {
      // The recording (simulated), then the lead's review reply with its vision draft (C10).
      await stepUntil(service, "the lead's review reply", (s) => I.importStatus(s) === "review" && s.leadRuns.some((r) => r.outcome === "completed") && s.visionDrafts.some((d) => d.status === "open"));
      await page.getByText("2 conflicts and 3 guesses need you;").waitFor({ timeout: 10_000 });
      await page.locator(".imp-tile .imp-mini").first().waitFor({ timeout: 10_000 });
      await page.waitForTimeout(500);
      const t = flat(await text(page));
      j.check(t.includes("Round 0 · As it is today") && !t.includes("Round 1"), "Review: round 0, As it is today (C9)");
      j.check(t.includes("12 rules are confirmed.") && t.includes("Recorded from the running CLI"), "Review: parts are listed as recorded or read from the code, not confirmed (C8)");
      const round0 = service.state().studio.rounds.find((r) => r.n === 0)?.lead?.message ?? "";
      const lead = flat(await page.locator(".imp-side").innerText());
      j.check(round0.length > 0 && lead.includes(flat(round0).slice(0, 60)) && !lead.includes("The lead writes the round's message"), "Review: the lead card shows the lead's round-0 message (UX-4)", lead.slice(0, 160));
      const heads = await page.locator("article.imp-q h3").allInnerTexts();
      j.check(heads.join(" | ") === "Currency | CSV reports | Rounding | Refunds | Where the ledger lives", "Review: each question is headed by its title (UX-7)", heads.join(" | "));
      const addTile = flat(await page.locator(".imp-tile", { hasText: "tally add" }).innerText());
      const splitting = flat(await page.locator(".imp-tile", { hasText: "Splitting" }).innerText());
      const words = flat(await page.locator(".imp-tile", { hasText: "dictionary" }).innerText());
      j.check(/tally add — recording/.test(addTile) && /tally add 42 Dinner/.test(addTile) && /divmod/.test(splitting) && /expense/.test(words), "Review: each part's tile shows the part: its recording, its pseudo-code, its words (UX-8)", `${addTile.slice(0, 120)} · ${splitting.slice(0, 80)}`);
      j.check(t.includes("The vision") && (await page.locator("#vision-text").isVisible()), "Review: Vision shows the vision text and the lead's draft (UX-6)");
      await j.shot("3-review");
      await j.pageChecks("Review");

      // A data folder before this one, on the same address, kept a first demo's unsent answers under the same import id
      // (sample data). This review starts empty and forgets them (UX26-1).
      const firstDemo = `orchestration.import.p-first-demo.${service.state().studio.import.id}.review`;
      await page.evaluate((k) => localStorage.setItem(k, JSON.stringify({ draft: { "rule:R15": { option: "confirm" } }, note: "From the first demo." })), firstDemo);
      await page.reload();
      await page.getByText("2 conflicts and 3 guesses need you;").waitFor({ timeout: 10_000 });
      {
        const again = flat(await text(page));
        const notes = await page.locator("textarea").evaluateAll((els) => els.map((e) => e.value).join("|"));
        const kept = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("orchestration.import.")));
        j.check(again.includes("0 of 5 answered.") && !notes.includes("From the first demo.") && kept.length === 0, "Review: a first demo's unsent answers on the same address do not show, and are forgotten (UX26-1)", `${kept.join(", ")} | ${notes.slice(0, 80)}`);
      }

      // Send with no answer (UX-3): open, and it leads on to the baseline with every question open.
      const send = page.getByRole("button", { name: "Send to the lead" });
      j.check((await send.getAttribute("aria-disabled")) !== "true", "Review: with no answer, Send is open (UX-3)");
      await send.click();
      await page.waitForURL(/#\/vision\/baseline$/, { timeout: 10_000 });
      await page.getByRole("heading", { name: "What stays open" }).waitFor({ timeout: 10_000 });
      await atTop(j, page, "Lock in 1 · the baseline", "Baseline, after a send with no answer");
      const open = flat(await page.locator("section[aria-labelledby=imp-b-open]").innerText());
      const rows = open.match(/[A-Z][^:]*: not answered/g) ?? [];
      j.check(service.state().studio.import.sentAt && service.state().studio.import.answers.length === 0 && rows.length === 5 && new Set(rows).size === 5 && open.includes("Where the ledger lives: not answered"), "Baseline: after a send with no answer, What stays open lists the 5 questions once each, by title (UX-3, UX-7)", rows.join(" | "));
      await j.shot("3-send-empty-baseline", { full: false });
      await page.goto(`${service.origin}/#/vision`);
      await page.getByText("You sent the review with every question open.").waitFor({ timeout: 10_000 });

      // The import's spend reaches its budget during the review (QA-F1): sample data, a recorded $3.10 on the parts run.
      service.store.update((st) => {
        const x = structuredClone(st);
        const r = I.importRuns(x, "parts").find((y) => y.status === "completed");
        r.usage = { ...(r.usage ?? {}), costUsd: 3.1 };
        return x;
      }, new Date().toISOString());
      const stop = page.getByText(/The import waits at its budget\. The import budget is reached: \$3\.10 of \$3\.00/);
      await stop.waitFor({ timeout: 10_000 });
      j.check(await page.getByRole("button", { name: "Raise the budget" }).isVisible(), "Review: the import's stop shows, with Raise the budget (QA-F1)");
      await stop.scrollIntoViewIfNeeded();
      await j.shot("3-review-budget-stop", { full: false });
      await page.goto(`${service.origin}/#/vision/baseline`);
      await page.getByText(/The import waits at its budget/).waitFor({ timeout: 10_000 });
      j.check(true, "Baseline: the import's stop shows there too (QA-F1)");
      await page.goto(`${service.origin}/#/overview`);
      await page.getByText("The import budget is reached: $3.10 of $3.00. Raise it in Vision to go on.").first().waitFor({ timeout: 10_000 });
      j.check(true, "Home: it says the import waits at its budget (QA-F1)");
      {
        const home = flat(await text(page));
        j.check(home.includes("This is the import demo: tally is a sample repository. For your own repository, start the service with ORCHESTRATION_RUNTIME=real npm start") && !home.includes("This is the sample project."), "Home after the import: This is the import demo (UX26-2)");
      }
      {
        const nav = flat(await page.getByRole("navigation", { name: "Main" }).innerText());
        const main = flat(await page.locator("main").innerText());
        const card = main.slice(main.indexOf("Needs you 1"));
        j.check(main.includes("Needs you 1 The import's review") && (width < 600 || nav.includes("1 needs you")), "Home: the header and Needs you count the same, and Needs you lists the import's review (UX-R2-1)", `${nav} | ${card.slice(0, 120)}`);
      }
      await j.shot("3-home-budget-stop", { full: false });
      await page.goto(`${service.origin}/#/vision`);
      await page.getByLabel("New import budget (dollars)").fill("6");
      await page.getByRole("button", { name: "Raise the budget" }).click();
      await service.until("the budget is raised", (st) => st.studio.import.budgetUsd === 6, 10_000);
      await page.getByText(/The import waits at its budget/).waitFor({ state: "detached", timeout: 10_000 });
      j.check(!I.importHold(service.state()), "Review: Raise the budget ends the stop (QA-F1)");

      await page.getByRole("button", { name: /^The code: --format csv/ }).click();
      await page.getByRole("button", { name: /^The docs: a currency on each expense/ }).click();
      const q = (title) => page.locator("article.imp-q", { has: page.getByRole("heading", { name: title, exact: true }) });
      await q("Rounding").getByRole("button", { name: "Confirm", exact: true }).click();
      const refunds = q("Refunds");
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
      await j.pageChecks("Review, answered");
      await page.getByRole("button", { name: "Send to the lead" }).click();
      await service.until("the answers are recorded", (s) => s.studio.import?.answers.length === 4, 10_000);
      j.check(true, "Review: Send records the 4 answers");
    });

    await j.step("4 Baseline", async () => {
      await page.waitForURL(/#\/vision\/baseline$/, { timeout: 10_000 });
      await page.getByRole("heading", { name: "Lock in 1 · the baseline" }).waitFor({ timeout: 10_000 });
      // Send to the lead is at the foot of the review; the baseline opens at its top all the same.
      await atTop(j, page, "Lock in 1 · the baseline", "Baseline");
      await page.waitForTimeout(300);
      const t = flat(await text(page));
      j.check(t.includes("13 rules are verified: their tests pass.") && t.includes("4 rules have no test: 2 you confirmed, 1 you want changed, 1 not answered."), "Baseline: the facts follow the answers");
      j.check(t.includes("Change tally add: The docs: a currency on each expense") && t.includes("Change The ledger: A negative amount should stop with an error.") && t.includes("Your 2 changes to design wait"), "Baseline: the changes to design stay out of the baseline (C5)");
      j.check(t.includes("Baseline tally add v1 (terminal demo; tests 5 of 5 pass; recorded)"), "Baseline: each part with its tests and its recording");
      j.check(t.includes("The vision: what tally is today") && t.includes("What the product is today, from the import at commit"), "Baseline: the vision card shows the lead's draft (C10)");
      const lockIn = page.getByRole("button", { name: "Lock in the baseline" });
      j.check((await lockIn.getAttribute("aria-disabled")) === "true" && t.includes("Tick the box first: your agreement is recorded with this summary."), "Baseline: Lock in waits for the agreement, and says why as text (UX-3)");
      const agree = page.getByRole("checkbox", { name: /I have reviewed the baseline/ });
      await agree.check();
      // Your own Accept of the vision, after your agreement: not "the summary changed while you read it" (UX-9).
      const visions = service.state().project.visions.length;
      await page.getByRole("button", { name: "Accept the vision" }).click();
      await service.until("the vision is accepted", (s) => s.project.visions.length > visions, 10_000);
      await page.waitForTimeout(500);
      j.check(!(await page.getByText("The summary changed while you read it.").isVisible()), "Baseline: your own Accept of the vision is not 'the summary changed while you read it' (UX-9)", flat(await page.locator(".imp-agree").innerText()).slice(0, 200));
      if (!(await agree.isChecked())) await agree.check();
      // Another tab: a building budget, which the summary shows.
      await agree.scrollIntoViewIfNeeded();
      service.command("setBudgets", { buildingUsd: 25, maintenanceUsdPerMonth: 5 });
      const changed = page.getByText("The summary changed while you read it.");
      await changed.waitFor({ timeout: 10_000 });
      j.check(!(await agree.isChecked()), "Baseline: a changed summary is shown, and the agreement is cleared");
      await agree.scrollIntoViewIfNeeded();
      j.check(await onScreen(changed), "Baseline: the notice is on screen beside the agreement (UX-9)");
      await j.shot("4-baseline-changed", { full: false });
      await j.shot("4-baseline");
      await j.pageChecks("Baseline");
      await agree.check();
      await lockIn.click();
      await page.getByText("Locked in, as Lock in 1: the baseline.").waitFor({ timeout: 10_000 });
      const rev = service.state().blueprint.revisions[0];
      j.check(rev?.lockIn?.baseline?.commit === commit && service.state().blueprint.revisions.length === 1, "Baseline: Lock in 1 is recorded as the baseline, at the import's commit");
      await j.shot("4-baseline-locked", { full: false });
    });

    await j.step("5 After", async () => {
      await page.goto(`${service.origin}/#/results/design`);
      await page.getByText("Lock in 1, the baseline").waitFor({ timeout: 10_000 });
      await page.waitForTimeout(300);
      const t = flat(await text(page));
      j.check(/tally add v1 terminal demo built and verified from the import Tests: 5 of 5 pass/.test(t) && /tally report v1 terminal demo built, not verified from the import Tests: 2 of 3 pass · 1 no test/.test(t) && !t.includes("terminal-demo"), "After: each part's status from the import, with its tests; terminal demo, not terminal-demo (UX-11)");
      j.check(!t.includes("Planned tasks are held"), "After: with no task, Results does not say planned tasks are held (UX-11)");
      await page.getByRole("button", { name: /^tally add v1/ }).click();
      await page.waitForTimeout(300);
      const demo = flat(await page.locator(".st-reality__detail").innerText());
      j.check(/Recorded at commit/.test(demo) && !/Not recorded/.test(demo), "After: a terminal demo shows its recording from the import's capture, with no \"Not recorded\" (U3-F1)", demo.slice(0, 300));
      j.check(demo.includes("Recorded from the running code in the project's container, with no network (simulated: no code ran).") && !demo.includes("VHS"), "After: an imported demo says it was recorded in the project's container, simulated (INT-F2)");
      await j.shot("5-after-demo");
      await page.getByRole("button", { name: /^The ledger v1/ }).click();
      await page.getByText("The checks do not prove it yet: 2 rules or examples have no test.").waitFor({ timeout: 5_000 });
      const d = flat(await page.locator(".st-reality__detail").innerText());
      j.check(d.includes("R16") && d.includes("a change to design") && d.includes("not confirmed") && d.includes("passes test_money.py::test_whole_cents +1"), "After: each rule's evidence: its test, and your answer", d.slice(0, 300));
      await j.shot("5-after");
      await j.pageChecks("Design and reality");

      // Vision after the baseline (UX-5, CR-9).
      await page.goto(`${service.origin}/#/vision`);
      await page.getByText("0 · Lock in 1 · the baseline").waitFor({ timeout: 10_000 });
      await page.waitForTimeout(300);
      const v = flat(await text(page));
      const marks = await page.getByRole("button", { name: /^(Keep|Change|Drop)$/ }).count();
      j.check(marks === 0 && !v.includes("unmarked") && v.includes("in force and built since Lock in 1. To change it, ask the lead for a round."), "Vision: round 0 is Lock in 1 · the baseline, and its parts take no mark (UX-5)", `${marks} mark buttons`);
      j.check(v.includes("2 changes to design wait for a round: tally add: The docs: a currency on each expense The ledger: A negative amount should stop with an error. Ask the lead for a round"), "Vision: the changes to design wait beside Ask the lead for a round (UX-5)");
      const lead0 = service.state().studio.rounds.find((r) => r.n === 0)?.lead?.message ?? "";
      j.check(lead0.length > 0 && v.includes(flat(lead0).slice(0, 60)) && !v.includes("The lead has written nothing for round 0."), "Vision: the lead's round-0 message shows after the Lock in (UX-4)");
      const card = page.locator("section.k-card", { has: page.getByRole("heading", { name: /The import.s open questions/ }) });
      j.check(flat(await card.innerText()).includes("Where the ledger lives"), "Vision: the import's open question shows, to answer there (CR-9)");
      await card.scrollIntoViewIfNeeded();
      await j.shot("5-vision-after", { full: false });
      await j.shot("5-vision-after-full");
      await card.getByRole("button", { name: "Confirm", exact: true }).click();
      await card.getByRole("button", { name: "Send your answers" }).click();
      await service.until("the open question is answered", (s) => s.studio.import.answers.some((a) => a.on.rule === "R17" && a.option === "confirm"), 10_000);
      await page.getByRole("heading", { name: /The import's open questions/ }).waitFor({ state: "detached", timeout: 10_000 });
      j.check(true, "Vision: Send your answers records it, and the card goes (CR-9)");
      await j.pageChecks("Vision after the baseline");

      await page.goto(`${service.origin}/#/overview`);
      await page.getByText(/Nothing to build/).waitFor({ timeout: 10_000 });
      const home = flat(await text(page));
      j.check(home.includes("Nothing to build yet: 2 changes to design wait."), "Home: Nothing to build, with the changes to design that wait");
      const nav = flat(await page.getByRole("navigation", { name: "Main" }).innerText());
      j.check(/nothing to build/.test(nav) && !/idle/.test(nav) && /2 changes/.test(nav), "the header: Home says nothing to build; Vision, 2 changes to design", nav);
      await j.shot("5-home");
      await j.pageChecks("Home after the baseline");
    });

    await j.step("6 Start in real mode", async () => {
      const real = await startService(() => buildDemo(Date.now()), { port: PORT + 2, dist: await buildApp(), realLooking: true });
      try {
        const repo = tallyRepo(join(real.dataDir, "tally"));
        await page.goto(`${real.origin}/#/settings/project/new-project`);
        await page.getByRole("heading", { name: "Start a new project" }).waitFor({ timeout: 10_000 });
        const form = page.getByText("New project form");
        if (!(await page.getByRole("radio", { name: "Import an existing repository" }).isVisible())) await form.click();
        await page.getByRole("radio", { name: "Import an existing repository" }).click();
        await page.getByLabel("Repository path (absolute)").fill(repo);
        await page.getByRole("button", { name: "Read the repository" }).click();
        await page.getByText("✓ Found").waitFor({ timeout: 10_000 });
        const t = flat(await text(page));
        j.check(t.includes(`The import reads the last commit, ${headOf(repo).slice(0, 7)} on main.`) && !t.includes("Try the import on a sample repository"), "real mode: Start a new project › Import an existing repository reads the path you give");
        j.check((await page.getByLabel("Test command").inputValue()) === "python3 tests/run.py", "real mode: the route proposes the test command the README shows");
        // A refusal shows on Start, and nothing changes (QA-F3): a JUnit report outside the repository.
        const before = real.state().project.name;
        await page.getByLabel("JUnit report path").fill("/tmp/junit.xml");
        await page.getByRole("button", { name: "Start the import" }).click();
        await page.getByRole("dialog").getByRole("button", { name: "Start project" }).click();
        await page.getByText("The import did not start.").waitFor({ timeout: 10_000 });
        const refused = flat(await page.locator(".imp-start").innerText());
        j.check(/not a path inside the repository/.test(refused) && refused.includes(`Nothing changed: "${before}" stays as it was.`) && real.state().project.name === before && !real.state().studio.import, "real mode: a refused start shows its reason on Start, and the project stays as it was (QA-F3)", refused.match(/The import did not start\.[^]*?stays as it was\./)?.[0]);
        await page.getByText("The import did not start.").scrollIntoViewIfNeeded();
        await j.shot("6-start-real-refused", { full: false });
        await page.locator(".imp-start").scrollIntoViewIfNeeded();
        await j.shot("6-start-real", { full: false });
        // The refused command answered 400 on purpose: the browser logs it as a failed resource.
        page.qaErrors = page.qaErrors.filter((e) => !/status of 400/.test(e));
        await j.pageChecks("Start in real mode");
      } finally {
        await real.stop();
      }
    });
  },
  { service: { freeze: true }, ...(process.env.QA_WIDTH ? { widths: [Number(process.env.QA_WIDTH)] } : {}) },
);
