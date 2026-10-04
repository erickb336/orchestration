// QA journey "task-delivery" (ORC-030): one task from New task to a merged result, as the owner sees it.
//
// What it drives, at 1280 and 375 wide, each on a fresh service:
// 1. Tasks › New task › Write the spec yourself: the owner writes a Change task and keeps "Wait for my go-ahead".
// 2. The task page: Start. Then the steps run: Implement, the checks, the code review and the security review side by
//    side, a repair round (the first review always finds one auto-fix finding), round 2, the final checks, the lead's
//    verification, and Done. A finding that comes to the owner is answered from the page ("Fix it").
// 3. Results: the pull request waits under "Ready to merge"; Merge, confirm, and the result lands under New results.
//
// How it moves: the simulated clock is frozen (the harness's `freeze`). The script steps it (the Simulation menu's
// Step) until the next stage, then looks at the page. Each check reads what the page shows; the store only confirms a record.
//
// Sample data: the demo project (Weekend Trips) with its open tasks paused before the service starts, so only the new
// task runs. The runtime, the checks and GitHub are simulated: no agent runs, nothing is pushed.
//
// Run: ORCHESTRATION_TEST_PORT=5970 node --import tsx scripts/qa/task-delivery.mjs   (QA_ONLY=1280 runs one width)

import { runJourney, text } from "./harness.mjs";
import { buildDemo } from "../../src/domain/demo.ts";
import * as M from "../../src/domain/model.ts";

const TITLE = "Show the trip length on the trip card";
const open = (t) => t.lifecycle !== "done" && t.lifecycle !== "cancelled";

/** The demo with every open task paused, as the owner would pause them first. */
function makeState() {
  let s = buildDemo(Date.now());
  const now = new Date().toISOString();
  for (const t of s.tasks) if (open(t) && !t.hold) s = M.pauseTask(s, t.id, now);
  return s;
}

/** The task page's steps, one line each: "Implement · Claude · claude-sample-large · Running". */
async function steps(page, id) {
  const rows = await page.getByRole("list", { name: `Steps of ${id}` }).locator(":scope > li").allInnerTexts();
  return rows.map((r) => r.replace(/\s*\n+\s*/g, " · ").trim());
}
const row = (rows, name, nth = 0) => rows.filter((r) => r.includes(name))[nth] ?? "";
/**
 * Step the simulated clock until the owner sees `locator`, for at most `ms`. GitHub (simulated) is read on its own
 * real-time cadence (every 30 s while a pull request is new or a merge is asked for), so this waits in real time.
 */
async function stepUntilShown(sv, locator, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await locator.count()) return;
    sv.step();
    await new Promise((r) => setTimeout(r, 250));
  }
  await locator.first().waitFor({ timeout: 1_000 });
}
/** The task header's text: the title and the state pill. */
const header = (page) => page.locator(".t-head__title").innerText();

await runJourney(
  "task-delivery",
  makeState,
  async (j, page, sv) => {
    const task = (id) => sv.state().tasks.find((t) => t.id === id);
    const step = (id, sid) => task(id).steps.find((s) => s.id === sid);
    const until = (what, pred, ms = 30_000) => sv.until(what, pred, ms, { stepping: true });
    let id;

    await j.step("write a task in Tasks › New task", async () => {
      await page.goto(`${sv.origin}/#/tasks`);
      await page.getByRole("heading", { name: "Tasks", exact: true }).waitFor();
      await page.getByRole("button", { name: "New task" }).click();
      await page.getByRole("button", { name: "Write the spec yourself" }).click();
      await page.getByLabel("Title").fill(TITLE);
      await page.getByLabel("Outcome (what should be true when done)").fill("Each trip card shows the trip's length in days.");
      await page.getByLabel("Approach").fill("Add the length to the trip card, from the start and end dates.");
      await page.getByLabel("Acceptance checks (one per line, optional)").fill("A Saturday-to-Sunday trip shows 2 days");
      await page.getByLabel("Area (optional)").fill("Trips");
      await page.getByLabel("Flow").selectOption("change");
      j.check(await page.getByRole("checkbox", { name: /Wait for my go-ahead/ }).isChecked(), "New task: Wait for my go-ahead is on by default");
      await j.shot("01-new-task");
      await j.pageChecks("New task");
      await page.getByRole("button", { name: "Create task" }).click();
      await page.waitForURL(/#\/task\//, { timeout: 10_000 });
      id = decodeURIComponent(page.url().split("#/task/")[1]);
      await page.getByRole("heading", { level: 1, name: TITLE }).waitFor();
      const h = await header(page);
      const needs = page.getByRole("region", { name: /^Needs you/ });
      j.check(!/Running/.test(h) && (await needs.getByRole("button", { name: "Start", exact: true }).count()) === 1, "the new task opens on its page, not running, with Start under Needs you", h);
      j.check(task(id)?.flow.id === "change" && task(id).holdBeforeStart, "the record: a Change task that waits for the go-ahead", { flow: task(id)?.flow.id });
      // ORC-030 C2: the words of a task you wrote and held.
      j.check(/Waits for you/.test(h) && !/Proposed/.test(h), "the state says Waits for you, not Proposed", h);
      j.check((await page.getByRole("button", { name: "Pause", exact: true }).count()) === 0, "no Pause before the task starts");
      const purpose = await page.getByRole("region", { name: "What it's for" }).innerText();
      j.check(/Your spec\./.test(purpose) && !/as the lead recommended/.test(purpose), "What it's for says Your spec", purpose.replace(/\s+/g, " "));
      j.check((await page.getByRole("region", { name: "Steps" }).getByText("Change flow").count()) === 0, "the Steps card has no Change flow chip");
      await j.shot("02-created");
    });
    if (!id) return;

    await j.step("Start, then Implement runs", async () => {
      await page.getByRole("button", { name: "Start", exact: true }).click();
      await until("S1 running", () => M.activeAttempts(sv.state(), id).some((a) => a.stepId === "S1"));
      await page.getByText("Running", { exact: true }).first().waitFor({ timeout: 5_000 });
      const r = row(await steps(page, id), "Implement");
      j.check(/Running/.test(r) && /Claude|Codex/.test(r), "Implement: Running, and says which agent works on it", r);
      await j.shot("03-implement");
    });

    await j.step("the service runs the checks; the simulated first run fails one", async () => {
      await until("C1 done", () => step(id, "C1").state === "done");
      await page.waitForTimeout(400);
      const r = row(await steps(page, id), "Run the project's checks");
      j.check(/Done: 1 of 2 checks failed/.test(r) && /the service/.test(r), "Checks: run by the service, and says 1 of 2 checks failed", r);
      await j.shot("04-checks");
    });

    await j.step("the code review and the security review run side by side", async () => {
      await until("S2 and SR1 running", () => ["S2", "SR1"].every((s) => M.activeAttempts(sv.state(), id).some((a) => a.stepId === s)));
      await page.waitForTimeout(400);
      const rows = await steps(page, id);
      j.check(/Running/.test(row(rows, "Code review")) && /Running/.test(row(rows, "Security review")), "both reviews: Running at the same time", [row(rows, "Code review"), row(rows, "Security review")]);
      const h = await header(page);
      j.check(h.includes("In review"), "the state pill says In review", h);
      await j.shot("05-reviews");
    });

    await j.step("a review finds something, and the coder repairs it", async () => {
      await until("S3 running", () => M.activeAttempts(sv.state(), id).some((a) => a.stepId === "S3"));
      await page.waitForTimeout(400);
      const rows = await steps(page, id);
      j.check(/finding/.test(row(rows, "Code review")) || /finding/.test(row(rows, "Security review")), "a review says what it found (Done: 1 finding)", [row(rows, "Code review"), row(rows, "Security review")]);
      j.check(/Running/.test(row(rows, "Repair")), "Repair review findings: Running", row(rows, "Repair"));
      const mine = sv.state().decisions.filter((d) => d.taskId === id && d.status === "open" && d.routedTo === "user");
      if (!mine.length) j.note("No finding came to the owner: the simulated reviews only report auto-fix findings, so Needs you stays empty on this task.");
      await j.shot("06-repair");
    });

    await j.step("round 2 is clean, and the task is Done", async () => {
      await until("task done", () => {
        // A finding that waits for the owner is answered on the page, as the owner would.
        if (sv.state().decisions.some((d) => d.taskId === id && d.status === "open" && d.routedTo === "user")) return true;
        return task(id).lifecycle === "done";
      }, 60_000);
      if (task(id).lifecycle !== "done") {
        await page.getByRole("button", { name: /^(Fix|Add a fix round)/ }).first().click();
        j.check(true, "a finding came to the owner, answered Fix from the task page");
        await until("task done after the answer", () => task(id).lifecycle === "done", 60_000);
      }
      await page.waitForTimeout(500);
      const h = await header(page);
      j.check(/Done/.test(h), "the state pill says Done", h);
      const rows = await steps(page, id);
      j.check(/round 2/.test(row(rows, "Code review", 1)) && /no findings/.test(row(rows, "Code review", 1)), "round 2: the code review finds nothing", row(rows, "Code review", 1));
      j.check(/Passed/.test(row(rows, "Run the project's checks", 1)), "round 2: the checks pass", row(rows, "Run the project's checks", 1));
      j.check(/Skipped: nothing to fix/.test(row(rows, "Repair", 1)), "round 2: the repair is skipped, nothing to fix", row(rows, "Repair", 1));
      j.check(/Passed/.test(row(rows, "Final checks")), "Final checks: Passed", row(rows, "Final checks"));
      j.check(rows.every((r) => !/Running|Waiting/.test(r)), "no step still says Running or Waiting", rows);
      const main = (await page.locator("main").innerText()).replace(/\s+/g, " ");
      j.check(!/Verified: Verified/.test(main), "the result says each thing once (no 'Verified: Verified')", main.match(/.{40}Verified.{60}/)?.[0]);
      await j.shot("07-done");
      await j.pageChecks("the task page, Done");
    });

    await j.step("Results: the pull request waits for Merge", async () => {
      await until("PR open", () => task(id).integration?.pr?.phase === "open");
      await page.goto(`${sv.origin}/#/results`);
      const ready = page.getByRole("region", { name: /^Ready to merge/ });
      // The simulated GitHub reports the new pull request on a later cycle: step until the page shows it as ready.
      await stepUntilShown(sv, ready.getByText(TITLE), 75_000);
      j.check(true, `Results: "${TITLE}" is under Ready to merge`);
      const badge = await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: /Results/ }).innerText();
      j.check(/\d/.test(badge), "the Results tab shows a count of pull requests waiting", badge);
      await j.shot("08-ready-to-merge");
      await j.pageChecks("Results, ready to merge");
      const mine = ready.locator("li", { hasText: TITLE });
      const line = (await mine.innerText()).replace(/\s*\n+\s*/g, " · ");
      j.check(/Code ✓/.test(line) && /Security ✓/.test(line) && /Checks ✓/.test(line), "its line says the code review, the security review and the checks passed", line);
      await mine.getByRole("button", { name: "Merge", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor({ timeout: 5_000 });
      j.check(/commit \S{6,}/.test(await dialog.innerText()), "Merge asks to confirm, and names the commit", (await dialog.innerText()).slice(0, 200));
      await j.shot("09-merge-confirm", { full: false });
      await dialog.getByRole("button", { name: "Merge", exact: true }).click();
      const results = page.getByRole("region", { name: /^New results/ });
      await stepUntilShown(sv, results.getByText(TITLE), 75_000);
      j.check(task(id).integration?.pr?.phase === "merged", "the record: the pull request is merged", task(id).integration?.pr?.phase);
      const item = (await results.locator("li", { hasText: TITLE }).first().innerText()).replace(/\s*\n+\s*/g, " · ");
      j.check(/Landed/.test(item), "after Merge, the result is under New results and says Landed", item);
      j.check(!(await ready.getByText(TITLE).count()), "it left Ready to merge");
      await j.shot("10-landed");
      await j.pageChecks("Results, after Merge");
    });

    // Home lists the new result too.
    await page.goto(`${sv.origin}/#/overview`);
    await page.waitForTimeout(800);
    j.check((await text(page)).includes(TITLE), "Home lists the new result", null);
    await j.shot("11-home");
  },
  { service: { freeze: true, progressPerTick: 25 }, ...(process.env.QA_ONLY ? { widths: [Number(process.env.QA_ONLY)] } : {}) },
);
