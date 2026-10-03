// QA journey "pause-resume" (ORC-030): pause and resume a running task, then the whole project, as the owner sees it.
//
// What it drives, at 1280 and 375 wide, each on a fresh service:
// 1. Home: its menu item says the factory runs (ORC-030: each place's state is in its menu item; no row of pills).
//    Tasks: open a running task.
// 2. The task page: Pause. The state says "Pausing" until the runtime confirms the stop, then "Paused". Resume, and
//    the task runs again on a fresh run.
// 3. The project's menu (named by the project): Pause project. Home's item says pausing until every run has stopped,
//    then paused; the menu and the task agree. Resume project, and the work runs again.
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
  async (j, page, sv, width) => {
    const active = (id) => M.activeAttempts(sv.state(), id);
    const pill = () => page.locator(".t-head__title").innerText();
    /** Home's menu item as the owner reads it: "Home · factory running · 3 agents" wide, "Home running" on a phone. */
    const home = async () => (await page.getByRole("navigation", { name: "Main" }).getByRole("link").first().innerText()).replace(/\s+/g, " ");
    /** Running, with a count of agents where there is room for it (a phone says "running" only). */
    const RUNNING = width < 600 ? /\brunning\b/ : /factory running · \d+ agents?/;
    /** Open the project's menu, and check that it opens inside the window (`when` names the moment). */
    const openProjectMenu = async (when) => {
      await page.locator(".project-menu > summary").click();
      const box = await page.getByRole("group", { name: "Project" }).boundingBox();
      const vw = page.viewportSize().width;
      j.check(box && box.x >= 0 && box.x + box.width <= vw, `the Project menu opens inside the window (${when})`, { left: Math.round(box?.x ?? NaN), right: Math.round((box?.x ?? NaN) + (box?.width ?? 0)), window: vw });
    };
    let id;

    await j.step("Home: the factory runs; open a running task from Tasks", async () => {
      await page.goto(`${sv.origin}/#/overview`);
      await waitFor("Home's item to say the factory runs", async () => RUNNING.test(await home()), 10_000);
      j.check(true, `Home's menu item says the factory runs${width < 600 ? "" : ", with a count of agents"}`, await home());
      j.check((await page.getByRole("banner").locator(".k-pill").count()) === 0, "the header has no row of pills");
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
    });

    await j.step("Pause project: Pausing…, then Paused", async () => {
      await openProjectMenu("running");
      await j.shot("06a-project-menu", { full: false });
      await page.getByRole("button", { name: "Pause project" }).click();
      await waitFor("pausing in Home's item", async () => /pausing/.test(await home()), 2_000);
      const stopping = M.activeAttempts(sv.state()).filter((a) => a.outcome === "stopping").length;
      j.check(stopping > 0, "Home's item says pausing while runs are stopping", { stopping, home: await home() });
      j.check(/Pausing/.test(await pill()), "the task page says Pausing too", await pill());
      j.check(!/paused/.test(await home()), "Home's item does not say paused while runs are still stopping", await home());
      await j.shot("06-project-pausing");
      await waitFor("paused in Home's item", async () => /paused/.test(await home()) && !/pausing/.test(await home()), 15_000);
      j.check(M.activeAttempts(sv.state()).length === 0, "paused shows once every run has stopped (the record agrees)", await home());
      j.check(/Paused/.test(await pill()), "the task says Paused", await pill());
      await openProjectMenu("paused");
      const menu = page.getByRole("group", { name: "Project" });
      j.check(/Project paused/.test(await menu.innerText()), "the project's menu says Project paused", await menu.innerText());
      j.check(await menu.getByRole("button", { name: "Resume project" }).isVisible(), "the project's menu offers Resume project", await menu.innerText());
      await j.shot("07-project-paused", { full: false });
      await j.pageChecks("the project, paused");
    });

    await j.step("Resume project: the work runs again", async () => {
      await page.getByRole("button", { name: "Resume project" }).click();
      await waitFor("Home's item to leave the pause", async () => !/paus/.test(await home()), 5_000);
      await waitFor("the task to run again", async () => /Running/.test(await pill()), 20_000);
      j.check(active(id).length > 0, "after Resume project, the task says Running", await pill());
      await waitFor("Home's item to say running", async () => RUNNING.test(await home()), 10_000);
      j.check(true, "Home's item says the factory runs again", await home());
      await j.shot("08-project-resumed");
      await j.pageChecks("the project, resumed");
    });
  },
  { service: { run: true, tickMs: 500, progressPerTick: 2 }, ...(process.env.QA_ONLY ? { widths: [Number(process.env.QA_ONLY)] } : {}) },
);
