// QA journey "pause-resume" (ORC-030): pause and resume a running task, then the whole project, as the owner sees it.
//
// What it drives, at 1280 and 375 wide, each on a fresh service:
// 1. Home: the Factory pill says the factory runs. Tasks: open a running task.
// 2. The task page: Pause. The state says "Pausing" until the runtime confirms the stop, then "Paused". Resume, and
//    the task runs again on a fresh run that starts from the paused run's changes (ORC-030 C4); its run line under
//    Details › Runs says so.
// 3. The Project menu: Pause project. The header says "Pausing…" until every run has stopped, then "Paused"; the
//    Factory pill and the task agree. Resume project, and the work runs again.
//
// How it moves: the scheduler's timer runs (one tick every 500 ms), so the fake runtime's stop acknowledgment
// (FakeRuntimeConfig.ackDelayMs, 2500 ms) is a real delay. A simulated step takes about 25 s, long enough to pause it.
//
// Sample data: the demo project (Weekend Trips) as the service seeds it; its runs are simulated, no agent runs.
//
// Run: ORCHESTRATION_TEST_PORT=5976 node --import tsx scripts/qa/pause-resume.mjs   (QA_ONLY=1280 runs one width)

import { runJourney, sleep } from "./harness.mjs";
import { buildDemo } from "../../src/domain/demo.ts";
import * as M from "../../src/domain/model.ts";

/** The demo task the journey pauses: it runs from the first tick (src/domain/demo.ts). */
const TITLE = "Show a clear offline state on the map";
const ACK_MS = 2500;

/** Poll `fn` until it returns a truthy value; the elapsed time, or a thrown error naming `what`. */
async function waitFor(what, fn, ms) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return { v, ms: Date.now() - start };
    if (Date.now() - start > ms) throw new Error(`timed out after ${ms / 1000}s waiting for: ${what}`);
    await sleep(100);
  }
}

/** The contrast of a control's label against its own background, as the page draws it now (hover included). */
async function labelContrast(locator) {
  return locator.evaluate((el) => {
    const rgb = (c) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const lum = ([r, g, b]) => [r, g, b].map((v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
    const cs = getComputedStyle(el);
    const [a, b] = [lum(rgb(cs.color)), lum(rgb(cs.backgroundColor))];
    return { ratio: Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 10) / 10, color: cs.color, background: cs.backgroundColor };
  });
}

await runJourney(
  "pause-resume",
  () => buildDemo(Date.now()),
  async (j, page, sv) => {
    const active = (id) => M.activeAttempts(sv.state(), id);
    const pill = () => page.locator(".t-head__title").innerText();
    const banner = () => page.getByRole("banner").innerText();
    const places = () => page.getByRole("navigation", { name: "Vision and the factory" }).innerText();
    /** Open the Project menu, and check that it opens inside the window (`when` names the moment). */
    const openProjectMenu = async (when) => {
      await page.getByRole("banner").locator("summary", { hasText: "Project" }).click();
      const box = await page.getByRole("group", { name: "Project" }).boundingBox();
      const vw = page.viewportSize().width;
      j.check(box && box.x >= 0 && box.x + box.width <= vw, `the Project menu opens inside the window (${when})`, { left: Math.round(box?.x ?? NaN), right: Math.round((box?.x ?? NaN) + (box?.width ?? 0)), window: vw });
    };
    let id;

    await j.step("Home: the factory runs; open a running task from Tasks", async () => {
      await page.goto(`${sv.origin}/#/overview`);
      await waitFor("the Factory pill to count agents", async () => /Factory running · \d+ agents?/.test(await places()), 10_000);
      j.check(true, "Home: the Factory pill says it runs, with a count of agents", await places());
      await j.shot("01-home-running");
      await page.getByRole("link", { name: "Tasks", exact: true }).click();
      await page.getByRole("link", { name: TITLE }).first().click();
      await page.getByRole("heading", { level: 1, name: TITLE }).waitFor();
      id = decodeURIComponent(page.url().split("#/task/")[1]);
      await waitFor("the task to run", async () => /Running/.test(await pill()), 10_000);
      j.check(active(id).length > 0, "the task page says Running, and the record has a run", await pill());
      await j.shot("02-task-running");
      // The task's More menu hangs from its button too; on a phone the button wraps to the left (Q-02).
      await page.getByRole("button", { name: /^More/ }).click();
      const more = await page.getByRole("menu").boundingBox();
      const vw = page.viewportSize().width;
      j.check(more && more.x >= 0 && more.x + more.width <= vw, "the task's More menu opens inside the window", { left: Math.round(more?.x ?? NaN), right: Math.round((more?.x ?? NaN) + (more?.width ?? 0)), window: vw });
      await j.shot("02a-more-menu", { full: false });
      await page.keyboard.press("Escape");
    });
    if (!id) return;

    await j.step("Pause the task: Pausing, then Paused once the runtime confirms", async () => {
      const run = active(id)[0];
      await page.getByRole("button", { name: "Pause", exact: true }).click();
      const pausing = await waitFor("Pausing", async () => /Pausing/.test(await pill()), 2_000);
      j.check(sv.state().attempts.find((a) => a.id === run.id)?.outcome === "stopping", "after Pause, the page says Pausing while the run is stopping", await pill());
      const resume = page.getByRole("button", { name: "Resume", exact: true });
      j.check(await resume.isDisabled(), "Resume waits (disabled) until the agent confirms the stop");
      // The pointer is still where Pause was: the disabled Resume button under it must still show its label.
      await page.waitForTimeout(400); // the button's colour transition ends
      const c = await labelContrast(resume);
      j.check(c.ratio >= 3, "the disabled Resume button's label stays readable under the pointer", c);
      await j.shot("03-task-pausing");
      const paused = await waitFor("Paused", async () => /Paused/.test(await pill()) && !/Pausing/.test(await pill()), 15_000);
      j.check(pausing.ms + paused.ms >= ACK_MS - 600, "Paused shows only after the runtime's stop delay", { afterMs: pausing.ms + paused.ms, ackDelayMs: ACK_MS });
      j.check(sv.state().attempts.find((a) => a.id === run.id)?.outcome === "stopped", "the record: the run is stopped");
      j.check(await resume.isEnabled(), "Resume is enabled once Paused");
      await j.shot("04-task-paused");
      await j.pageChecks("the task page, paused");
      await resume.click();
      await waitFor("Running again", async () => /Running/.test(await pill()), 20_000);
      const fresh = active(id)[0];
      j.check(!!fresh && fresh.id !== run.id, "after Resume, the task says Running on a fresh run", { before: run.id, after: fresh?.id });
      await j.shot("05-task-resumed");
      // ORC-030 C4: the fresh run starts from the paused run's changes (simulated here: no file changes), and its run
      // line under Details › Runs says so.
      const pausedStep = sv.state().tasks.find((t) => t.id === id)?.steps.find((s) => s.id === run.stepId);
      j.check(fresh?.snapshot.startedFrom?.attemptId === run.id && fresh.snapshot.startedFrom.simulated === true, "the record: the fresh run started from the paused run's changes, labelled simulated", { startedFrom: fresh?.snapshot.startedFrom, pausedWork: pausedStep?.pausedWork });
      await page.locator("summary", { hasText: /^Runs/ }).click();
      const line = page.locator("summary", { hasText: "started from the paused run's changes (simulated)" });
      await line.first().waitFor({ timeout: 5_000 });
      const lines = await line.count();
      const text = await line.first().innerText();
      j.check(lines === 1 && text.startsWith(run.stepId), "Details › Runs: the fresh run's line says it started from the paused run's changes, and only that line", { lines, text });
      await line.first().click();
      const inside = await page.getByText(`the changes of the paused run ${run.id}`).first().innerText();
      j.check(/simulated: no file changed/.test(inside), "inside the run: the paused run it started from, labelled simulated", inside);
      await line.first().scrollIntoViewIfNeeded();
      await j.shot("05a-run-line", { full: false });
      await j.pageChecks("the task page, resumed, with its runs open");
      await page.locator("summary", { hasText: /^Runs/ }).click();
    });

    await j.step("Pause project: Pausing…, then Paused", async () => {
      await openProjectMenu("running");
      await j.shot("06a-project-menu", { full: false });
      await page.getByRole("button", { name: "Pause project" }).click();
      await waitFor("Pausing… in the header", async () => /Pausing…/.test(await banner()), 2_000);
      const stopping = M.activeAttempts(sv.state()).filter((a) => a.outcome === "stopping").length;
      j.check(stopping > 0, "the header says Pausing… while runs are stopping", { stopping });
      j.check(/Pausing/.test(await pill()), "the task page says Pausing too", await pill());
      const p = await places();
      j.check(!/paused/i.test(p), "the Factory pill does not say paused while runs are still stopping", p);
      await j.shot("06-project-pausing");
      await waitFor("Paused in the header", async () => !/Pausing…/.test(await banner()) && /Paused/.test(await banner()), 15_000);
      j.check(M.activeAttempts(sv.state()).length === 0, "Paused shows once every run has stopped (the record agrees)");
      j.check(/Factory paused/.test(await places()), "the Factory pill says paused", await places());
      j.check(/Paused/.test(await pill()), "the task says Paused", await pill());
      await openProjectMenu("paused");
      const menu = page.getByRole("group", { name: "Project" });
      j.check(await menu.getByRole("button", { name: "Resume project" }).isVisible(), "the Project menu offers Resume project", await menu.innerText());
      await j.shot("07-project-paused", { full: false });
      await j.pageChecks("the project, paused");
    });

    await j.step("Resume project: the work runs again", async () => {
      await page.getByRole("button", { name: "Resume project" }).click();
      await waitFor("the header pill to clear", async () => !/Paused|Pausing/.test(await banner()), 5_000);
      await waitFor("the task to run again", async () => /Running/.test(await pill()), 20_000);
      j.check(active(id).length > 0, "after Resume project, the task says Running", await pill());
      await waitFor("the Factory pill to say running", async () => /Factory running · \d+ agents?/.test(await places()), 10_000);
      j.check(true, "the Factory pill says it runs again", await places());
      await j.shot("08-project-resumed");
      await j.pageChecks("the project, resumed");
    });
  },
  { service: { run: true, tickMs: 500, progressPerTick: 2 }, ...(process.env.QA_ONLY ? { widths: [Number(process.env.QA_ONLY)] } : {}) },
);
