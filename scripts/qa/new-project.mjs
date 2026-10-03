// QA journey "new-project" (ORC-030, step 1): a first real user starts a project, at 1280 and 375 wide.
//
// The service starts on an empty project, as `npm start` does with real agents the first time. The harness's
// `realLooking` option makes the service and the page behave as in real mode (the LIVE banner, the first-run
// checklist, Settings › Start a new project), while every run stays simulated: no agent runs and nothing leaves this
// computer. The repository is a throwaway git repository the harness makes under its data directory.
//
// The journey:
// 1. The first screen: the address `npm start` opens (no page named). It should say where to begin.
// 2. Home: the first-run checklist, and its way to the repository.
// 3. Settings › Project: the "Start a new project" form, open because no repository is set. Name the project, give the
//    repository and a vision, Start project, and confirm.
// 4. The page says the project started and opens Vision; the header names the project; in Settings the repository
//    is ready; Home's checklist moves on.
// 5. Vision opens: the studio, in Vision, with the way to ask the lead for a first round.
//
// Run: ORCHESTRATION_TEST_PORT=5950 node --import tsx scripts/qa/new-project.mjs

import { buildEmptyProject } from "../../src/domain/seed.ts";
import { runJourney, text } from "./harness.mjs";

const NAME = "Weekend Trips";
const VISION = "Plan weekend trips with a small group of friends: who comes, where we go, what we pack.";

await runJourney(
  "new-project",
  () => buildEmptyProject(Date.now()),
  async (j, page, service, width) => {
    // 1. The first screen.
    await j.step("the first screen", async () => {
      await page.goto(`${service.origin}/`);
      await page.getByRole("navigation", { name: "Main" }).waitFor();
      await page.waitForTimeout(500);
      await j.shot("1-first-screen");
      const words = await text(page);
      j.check(words.includes("LIVE EXECUTION"), "the first screen: the banner says agents run for real");
      const current = await page.getByRole("navigation", { name: "Main" }).locator("[aria-current=page]").innerText();
      j.check(/Get started/.test(words), "the first screen shows where to begin (the Get started checklist)", `it opens ${current.trim()}: "${words.split("\n").filter(Boolean).slice(5, 9).join(" / ")}"`);
      await j.pageChecks("the first screen");
    });

    // 2. Home: the checklist.
    await j.step("Home's checklist", async () => {
      await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Home" }).click();
      await page.getByText("Get started").waitFor();
      const words = await text(page);
      j.check(/1 of 5 done/.test(words), "Home: Get started shows 1 of 5 done (the providers are ready)", words.match(/\d of \d done/)?.[0]);
      j.check(words.includes("Connect your repository"), "Home: the checklist asks for the repository first");
      await j.shot("2-home-checklist");
      await j.pageChecks("Home");
      await page.getByRole("link", { name: "Open Settings" }).click();
    });

    // 3. Settings › Project: the new project form.
    await j.step("the new project form", async () => {
      await page.getByRole("heading", { name: "Start a new project" }).waitFor();
      const repoCard = await page.locator("#repository, [id*=repository]").first().innerText().catch(() => "");
      j.check(!/This is the sample project/.test(await text(page)), "Settings › Project: an empty project is not called the sample project", "Environment says: This is the sample project; start a project of your own to read its repository.");
      j.note(`Repository card before: ${repoCard.split("\n").slice(0, 4).join(" / ")}`);
      const name = page.getByLabel("Name", { exact: true });
      j.check(await name.isVisible(), "the form is open, because no repository is set");
      await page.getByRole("heading", { name: "Start a new project" }).scrollIntoViewIfNeeded();
      await j.shot("3-settings-before", { full: false });
      await name.fill(NAME);
      await page.getByLabel("Repository path (absolute)").fill(service.repo);
      await page.getByLabel("Vision (optional)").fill(VISION);
      await page.getByLabel("Current focus").fill("Plan a first trip together");
      await j.shot("3-form-filled", { full: false });
      await page.getByRole("button", { name: "Start project" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      j.check((await dialog.innerText()).includes(`Start a new project "${NAME}"?`), "the confirmation names the project");
      await j.shot("3-confirm", { full: false });
      await dialog.getByRole("button", { name: "Start project" }).click();
    });

    // 4. The project is there.
    await j.step("the new project", async () => {
      await page.locator(".project-menu .menu__label", { hasText: NAME }).waitFor({ timeout: 10_000 });
      j.check(true, `the header names the project "${NAME}" (its menu)`);
      const s = service.state();
      j.check(s.project.name === NAME && s.project.stage === "shaping" && s.project.repoPath === service.repo, "the record: the project is in Vision, with its repository");
      await page.waitForTimeout(800);
      const where = page.url().replace(service.origin, "");
      const toast = (await page.locator(".k-toast-region").innerText().catch(() => "")).trim();
      j.check(/#\/vision$/.test(where) && toast.includes(NAME) && /Vision/.test(toast), "after Start project, the page says it started and opens Vision, where it begins", { where, toast });
      await j.shot("4-after-start-top", { full: false });
      // Settings › Project: the repository and the form.
      await page.goto(`${service.origin}/#/settings/project`);
      await page.getByRole("heading", { name: "Start a new project" }).waitFor();
      const words = await text(page);
      j.check(/Ready/.test(await page.getByText(/^Ready|^Not usable/).first().innerText().catch(() => "")), "Settings: the repository shows Ready", words.match(/(Ready[^\n]*|Not usable[^\n]*)/)?.[0]);
      j.check(!/New project form/.test(words) || !(await page.getByLabel("Name", { exact: true }).isVisible()), "the new project form closes once the repository is ready");
      await j.shot("4-after-start");
      await j.pageChecks("Settings after Start project");
      await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Home" }).click();
      await page.getByText("Get started").waitFor();
      const home = await text(page);
      const repoItem = page.locator("li, [class*=step]", { hasText: "Connect your repository" }).first();
      j.check(/\(done\)|✓/.test(await repoItem.innerText().catch(() => "")) || /\b3 of 6 done/.test(home), "Home: the checklist counts the repository as done", home.match(/\d of \d done/)?.[0]);
      j.check(home.includes(VISION.slice(0, 40)), "Home: the vision you wrote shows");
      await j.shot("4-home-after");
    });

    // 5. Vision opens.
    await j.step("Vision", async () => {
      await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Vision" }).click();
      await page.getByRole("heading", { name: "Vision", exact: true }).waitFor();
      await page.waitForTimeout(500);
      const words = await text(page);
      j.check(page.url().endsWith("#/vision"), "Vision opens at #/vision");
      j.check(/Kind of product|kind of product/.test(words), "Vision asks for the kind of product first (the designer's work follows it)");
      j.check(/Message the lead|Ask the lead|Start the studio/.test(words), "Vision offers a way to ask the lead for a first round");
      const homeItem = (await page.getByRole("navigation", { name: "Main" }).getByRole("link").first().innerText()).replace(/\s+/g, " ");
      j.check((width < 600 ? /not started/ : /factory not started/).test(homeItem), "Home's menu item says the factory has not started", homeItem);
      await j.shot("5-vision");
      await j.pageChecks("Vision");
      // The kind of product: choose Screen product and see the choice kept.
      const screen = page.getByRole("checkbox", { name: /Screen product/ }).or(page.getByRole("button", { name: /Screen product/ })).first();
      if (await screen.count()) {
        await screen.click();
        const save = page.getByRole("button", { name: /^(Save|Use these|Choose|Continue)/ }).first();
        if (await save.count()) await save.click();
        await service.until("the kind of product is saved", (st) => st.project.domains.includes("screen"), 5_000).then(
          () => j.check(true, "Vision: the kind of product is saved"),
          (e) => j.check(false, "Vision: the kind of product is saved", e.message),
        );
        await page.waitForTimeout(500);
        await j.shot("5-vision-kind-chosen");
        await j.pageChecks("Vision, kind chosen");
      } else j.check(false, "Vision: a control to choose the kind of product", "none found by role");
    });
  },
  { service: { realLooking: true, run: true } },
);
