// The "settings" journey (ORC-030 QA): every section and card of Settings, a few changes saved or discarded, and the
// Environment card's "Confirm this dev container", at 1280 and 375 wide.
//
// What it drives, as the owner sees it:
// 1. The demo (fake runtime): #/settings, then each of the five sections from the side menu. Each card of the section
//    shows. Each card's own link (#/settings/<card>) opens its section and brings the card into view.
// 2. Changes: one value in Working style, Project (Budgets), Agents and Quality, each with Save and "Saved". Discard
//    in Run limits. An unsaved change survives a visit to another section. Advanced › Data: Import and Export.
// 3. The Environment card in the demo, then on a second, real-looking service (the harness's `realLooking`: the
//    service says "real", while every run stays simulated). That service has an empty project and a throwaway git
//    repository with a committed .devcontainer/devcontainer.json. The script sets the repository path in the UI,
//    then uses "Confirm this dev container" and Save.
// It checks each view for a horizontal scroll and for errors, and takes a screenshot of each stage.
//
// Sample data: the demo project (src/domain/demo.ts) and an empty project (src/domain/seed.ts). No model runs.
// The script uses ORCHESTRATION_TEST_PORT and the next three ports (the second service).
//
// Run: ORCHESTRATION_TEST_PORT=5994 node --import tsx scripts/qa/settings.mjs

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildDemo } from "../../src/domain/demo.ts";
import { buildEmptyProject } from "../../src/domain/seed.ts";
import { CARD_SECTION, SECTIONS } from "../../src/ui/settings/sections.ts";
import { PORT, buildApp, runJourney, startService, text } from "./harness.mjs";

/** Cards that show only when the service runs real agents. */
const REAL_ONLY = ["new-project", "agent-environment"];
const IMPORT = "| ID | Title | Status |\n| --- | --- | --- |\n| QA-1 | Imported by the QA journey | Todo |";

await runJourney("settings", () => buildDemo(Date.now()), body, { service: { run: true }, ...(process.env.QA_WIDTH ? { widths: [Number(process.env.QA_WIDTH)] } : {}) });

async function body(j, page, service, width) {
  const section = (id) => page.locator(`section[data-section="${id}"]`);
  const status = (id) => section(id).getByRole("group", { name: /^Save / }).getByRole("status");
  const open = async (id, label) => {
    await page.getByRole("navigation", { name: "Settings sections" }).getByRole("link", { name: new RegExp(`^${label}`) }).click();
    await section(id).getByRole("heading", { level: 2, name: label }).waitFor({ timeout: 5_000 });
  };
  const save = async (id) => {
    await section(id).getByRole("button", { name: "Save", exact: true }).click();
    await status(id).filter({ hasText: /^Saved$/ }).waitFor({ timeout: 10_000 }).catch(() => {});
    return (await status(id).innerText()).trim();
  };

  // ---------- 1. Every section and card ----------
  await j.step("open Settings", async () => {
    await page.goto(`${service.origin}/#/settings`);
    await page.getByRole("heading", { level: 1, name: "Settings" }).waitFor({ timeout: 15_000 });
    j.check(await section("working-style").isVisible(), "#/settings opens Working style first");
  });
  for (const s of SECTIONS) {
    await j.step(`section ${s.label}`, async () => {
      await open(s.id, s.label);
      j.check(page.url().endsWith(`#/settings/${s.id}`), `${s.label}: its address is #/settings/${s.id}`, page.url());
      const cards = Object.entries(CARD_SECTION).filter(([, sec]) => sec === s.id).map(([c]) => c);
      const missing = [];
      for (const c of cards) if (!(await section(s.id).locator(`[id="${c}"]`).isVisible())) missing.push(c);
      // Real-mode cards: the demo has none (the real-looking service checks them below).
      const expected = missing.filter((c) => !REAL_ONLY.includes(c));
      j.check(!expected.length, `${s.label}: every card shows (${cards.length - missing.length} of ${cards.length})`, expected);
      j.check((await status(s.id).innerText()).trim() === "No unsaved changes", `${s.label}: the Save bar says "No unsaved changes"`);
      await j.pageChecks(`Settings › ${s.label}`);
      await j.shot(`1-${s.id}`);
    });
  }
  await j.step("each card's own link", async () => {
    const wrong = [];
    for (const [card, sec] of Object.entries(CARD_SECTION)) {
      if (REAL_ONLY.includes(card)) continue;
      await page.evaluate((c) => (location.hash = `#/settings/${c}`), card);
      await page.waitForTimeout(150);
      const box = await section(sec).locator(`[id="${card}"]`).boundingBox({ timeout: 2_000 }).catch(() => null);
      const vh = page.viewportSize().height;
      if (!(await section(sec).isVisible()) || !box || box.y < -2 || box.y > vh - 40) wrong.push(`${card} (top ${box ? Math.round(box.y) : "none"})`);
    }
    j.check(!wrong.length, "each #/settings/<card> link opens its section with the card in view", wrong);
  });

  // ---------- 2. Change, Save, Discard ----------
  await j.step("Working style: Only suggest, Save", async () => {
    await page.goto(`${service.origin}/#/settings/working-style/steering`);
    await page.getByRole("radio", { name: /^Only suggest/ }).check();
    j.check((await status("working-style").innerText()).trim() === "Unsaved changes", 'the Save bar says "Unsaved changes"');
    const marked = await page.getByRole("link", { name: /Working style \(unsaved changes\)/ }).waitFor({ timeout: 3_000 }).then(() => true, () => false);
    j.check(marked, "the side menu marks Working style as unsaved");
    await j.shot("2-working-style-dirty", { full: false });
    j.check((await save("working-style")) === "Saved", 'Save: the bar says "Saved"');
    j.check(service.state().project.steeringMode === "suggest", "the record: the lead only suggests", service.state().project.steeringMode);
  });
  await j.step("Project › Budgets: a building budget, Save", async () => {
    await open("project", "Project");
    await page.getByLabel("Building budget (dollars)").fill("40");
    j.check((await save("project")) === "Saved", 'Save: the bar says "Saved"');
    j.check(service.state().project.budgets.buildingUsd === 40, "the record: the building budget is $40", service.state().project.budgets);
    await page.locator('[id="budgets"]').scrollIntoViewIfNeeded();
    await j.shot("3-budgets-saved", { full: false });
  });
  await j.step("Agents › Agents at once, Save", async () => {
    await open("agents", "Agents");
    const before = service.state().project.workerLimit;
    const next = before === 4 ? 5 : 4;
    await page.getByLabel("All agents", { exact: true }).fill(String(next));
    j.check((await save("agents")) === "Saved", 'Save: the bar says "Saved"');
    j.check(service.state().project.workerLimit === next, `the record: ${next} agents at once`, service.state().project.workerLimit);
  });
  await j.step("Agents › Run limits: Discard", async () => {
    const field = page.getByLabel("Turns at most");
    const before = await field.inputValue();
    await field.fill("7");
    await section("agents").getByRole("button", { name: "Discard" }).click();
    j.check((await field.inputValue()) === before && (await status("agents").innerText()).trim() === "No unsaved changes", "Discard puts the value back and clears the Save bar", await field.inputValue());
    j.check(service.state().project.runLimits.maxTurns === Number(before), "the record: the turns are unchanged");
  });
  await j.step("Quality: an unsaved change survives another section", async () => {
    await open("quality", "Quality");
    const select = page.getByLabel("Default flow");
    const before = await select.inputValue();
    await select.selectOption({ label: "Bug fix" });
    await open("advanced", "Advanced");
    j.check(await page.getByRole("link", { name: /Quality \(unsaved changes\)/ }).count(), "the side menu marks Quality as unsaved while you are in Advanced");
    await open("quality", "Quality");
    j.check((await select.inputValue()) !== before, "back in Quality, the change is still there");
    j.check((await save("quality")) === "Saved" && service.state().project.defaultFlowId === (await select.inputValue()), "Save: Saved, and the record has the new default flow", service.state().project.defaultFlowId);
  });
  await j.step("Advanced › Data: Import and Export", async () => {
    await open("advanced", "Advanced");
    const data = page.locator('[id="data"]');
    await data.getByLabel("Markdown task table").fill(IMPORT);
    await data.getByRole("button", { name: "Import", exact: true }).click();
    const said = await data.getByRole("status").filter({ hasText: /Imported/ }).innerText({ timeout: 10_000 }).catch(() => "");
    j.check(/Imported 1, skipped 0/.test(said) && service.state().tasks.some((t) => t.id === "QA-1"), "Import: it says Imported 1, and the board has QA-1", said);
    const href = await data.getByRole("link", { name: "Download board (Markdown)" }).getAttribute("href");
    const r = await page.request.get(new URL(href, service.origin).toString());
    j.check(r.ok() && (await r.text()).includes("WT-001"), "Export: the download link returns the board as Markdown", r.status());
    await data.scrollIntoViewIfNeeded();
    await j.pageChecks("Settings after the changes");
    await j.shot("4-data", { full: false });
  });

  // ---------- 3. The Environment card ----------
  await j.step("Environment in the demo", async () => {
    await page.goto(`${service.origin}/#/settings/project/environment`);
    const card = page.locator('[id="environment"]');
    await card.waitFor({ timeout: 5_000 });
    const words = await card.innerText();
    j.note(`Demo: the Environment card says "${words.split("\n").filter(Boolean).slice(2, 4).join(" / ")}"`);
    j.check(!(await card.getByRole("button", { name: "Confirm this dev container" }).count()), "the demo offers no dev container to confirm (it reads no repository)");
    await j.shot("5-environment-demo", { locator: card });
  });
  const real = await startService(() => buildEmptyProject(Date.now()), { dist: await buildApp(), realLooking: true, port: PORT + 2 });
  try {
    mkdirSync(join(real.repo, ".devcontainer"));
    writeFileSync(join(real.repo, ".devcontainer", "devcontainer.json"), JSON.stringify({ name: "Trips", image: "node:22-bookworm" }, null, 2));
    const git = (...a) => execFileSync("git", ["-C", real.repo, ...a], { encoding: "utf8" });
    git("add", "-A");
    git("-c", "user.name=QA", "-c", "user.email=qa@localhost", "commit", "-q", "-m", "Add a dev container");
    const card = page.locator('[id="environment"]');
    await j.step("Environment before a repository", async () => {
      await page.goto(`${real.origin}/#/settings/project/environment`);
      await card.waitFor({ timeout: 15_000 });
      await page.waitForTimeout(800);
      const words = await card.innerText();
      j.check(!/This is the sample project/.test(words), "with no repository yet, the card does not call a new project the sample project", words.split("\n").find((l) => /sample|repository/i.test(l)));
      await j.shot("6-environment-no-repo", { locator: card });
    });
    await j.step("set the repository path", async () => {
      await page.getByLabel("Repository path", { exact: true }).fill(real.repo);
      j.check((await save("project")) === "Saved", 'Save: the bar says "Saved"');
      j.check(real.state().project.repoPath === real.repo, "the record: the repository path is set");
      await page.getByText(/^Ready/).first().waitFor({ timeout: 10_000 }).catch(() => {});
      j.check(/Ready/.test(await page.locator('[id="repository"]').innerText()), 'the Repository card says "Ready"');
    });
    await j.step("Confirm this dev container", async () => {
      const button = card.getByRole("button", { name: "Confirm this dev container" });
      await button.waitFor({ timeout: 10_000 });
      const words = await card.innerText();
      j.check(/Dev container not confirmed/.test(words) && /\.devcontainer\/devcontainer\.json/.test(words), "the card finds .devcontainer/devcontainer.json, not confirmed yet", words.slice(0, 300));
      await card.scrollIntoViewIfNeeded();
      await j.shot("7-environment-found", { locator: card });
      await button.click();
      j.check((await status("project").innerText()).trim() === "Unsaved changes", 'the confirmation waits for Save ("Unsaved changes")');
      j.check(!(await button.count()), "the button goes once the form holds this dev container");
      j.check((await save("project")) === "Saved", 'Save: the bar says "Saved"');
      await card.getByText("Dev container", { exact: true }).waitFor({ timeout: 10_000 }).catch(() => {});
      const after = await card.innerText();
      j.check(/confirmed by you/.test(after), 'the card says the dev container is "confirmed by you"', after.slice(0, 300));
      const dc = real.state().project.environment?.devcontainer;
      j.check(dc?.file === ".devcontainer/devcontainer.json" && /^[0-9a-f]{64}$/.test(dc?.sha256 ?? ""), "the record: the dev container is confirmed by its digest", dc);
      await j.pageChecks("Environment, confirmed");
      await j.shot("8-environment-confirmed", { locator: card });
    });
    await j.step("the real-mode cards", async () => {
      for (const [card, sec] of REAL_ONLY.map((c) => [c, CARD_SECTION[c]])) {
        await page.evaluate((c) => (location.hash = `#/settings/${c}`), card);
        j.check(await section(sec).locator(`[id="${card}"]`).isVisible(), `with real agents, the ${card} card shows`);
      }
      await j.pageChecks("the real-mode cards");
    });
  } finally {
    await real.stop();
  }
}
