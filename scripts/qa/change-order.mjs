// The "change-order" journey (ORC-030 QA): a new design while the factory runs, its Lock in, and the change order the
// lead answers, with Undo, at 1280 and 375 wide.
//
// What it drives, as the owner sees it:
// 1. Vision: the owner marks the new design Keep (Trip plan v2 and Packing list, round 2) and Reminders Drop (round 1).
//    Before Send the feedback says what each does to the draft; Send does it (ORC-030 Q-01: Keep is the approval).
// 2. The draft bar: one line ("Draft · 3 changes"), and Show lists the three changes.
// 3. Lock in…: what changes, the tasks it touches and what happens to each, the new work and the budgets.
//    Then the agreement and Lock in, which makes change order 2.
// 4. The change order (#/tasks/change-order/2): the simulated lead's updates, one row each. Undo on the retired task,
//    and Undo on the new task (with its confirmation). Then the Tasks page.
// It checks each view for a horizontal scroll and for errors, and takes a screenshot of each stage.
//
// Sample data: a fixture built through the real commands (after src/domain/testing/changeOrders.ts). The factory runs
// from blueprint r1 (Trip plan, Trip list, Reminders). Four tasks cite it: one runs, one waits, one builds only
// Reminders, and one has finished. In round 2 the designer made Trip plan v2 and a new Packing list, and the PE agreed.
// The runtime is the fake one, and the scheduler runs, so the simulated lead answers the change order.
//
// Run: ORCHESTRATION_TEST_PORT=5996 node --import tsx scripts/qa/change-order.mjs

import { resolve } from "node:path";
import * as M from "../../src/domain/model.ts";
import { buildSeed } from "../../src/domain/seed.ts";
import * as B from "../../src/domain/studio/blueprint.ts";
import { waitingForYourMark } from "../../src/ui/studio/studioView.ts";
import { at, leadTaskCiting, startTask, taskCiting } from "../../src/domain/testing/changeOrders.ts";
import { startFactoryAsOwner } from "../../src/domain/testing/factory.ts";
import { addScreen, feedback, openRound, pePass, run } from "../../src/domain/testing/studio.ts";

const MANUAL = { autonomy: "manual", delivery: { mode: "off", merge: "user" }, pausePoints: { tradeoffs: "user", changeOrders: "lead", startEachTask: false } };

/** A screen of one take in the round, which the PE agreed to. */
function screen(s, round, title, sec, over = {}) {
  const a = addScreen(s, round, at(sec), { title, variants: [], ...over });
  return { s: pePass(a.state, a.id, a.version, [{ verdict: "feasible" }], at(sec)), id: a.id };
}

/** The fixture: the factory runs from r1, and round 2 holds Trip plan v2 and Packing list, ready for the owner. */
export function scene() {
  let s = M.initProject(buildSeed(Date.parse(at(0)), { inFlightRuns: false }), { name: "Trips", repoPath: "/tmp/trips", vision: "Weekend trips for a small group of friends.", focus: "" }, at(0));
  s = run(s, "setDomains", { domains: ["screen"] }, at(0)).state;
  s = openRound(s, "experience", at(1)).state;
  const plan = screen(s, 1, "Trip plan", 2);
  const list = screen(plan.s, 1, "Trip list", 3);
  const remind = screen(list.s, 1, "Reminders", 4);
  s = startFactoryAsOwner(run(remind.s, "approveRound", { round: 1 }, at(5)).state, at(6), MANUAL);
  const item = (artifactId) => B.blueprintItems(s).find((i) => i.artifactId === artifactId).id;
  const ids = { plan: item(plan.id), list: item(list.id), remind: item(remind.id) };
  const running = taskCiting(s, [ids.plan], "Trip plan screen", 7);
  const queued = taskCiting(running.s, [ids.plan, ids.list], "Trip list screen", 8);
  const retiring = leadTaskCiting(queued.s, [ids.remind], "Outing reminders", 9);
  const early = taskCiting(retiring.s, [ids.plan], "Early trip plan", 10);
  s = structuredClone(startTask(early.s, running.id, 11));
  s.tasks.find((t) => t.id === early.id).lifecycle = "done";
  // Round 2: the owner's note on Trip plan v1, then the designer's v2 and a new Packing list, both agreed by the PE.
  s = feedback(s, plan.id, 1, { mark: "change", note: "Day list first, the map below it." }, at(12));
  s = openRound(run(s, "closeRound", { round: 1 }, at(12)).state, "experience", at(12)).state;
  const v2 = addScreen(s, 2, at(13), { artifactId: plan.id, title: "Trip plan", variants: [] });
  s = pePass(v2.state, plan.id, 2, [{ verdict: "feasible" }], at(13));
  const packing = screen(s, 2, "Packing list", 14);
  return { s: packing.s, art: { plan: plan.id, packing: packing.id }, ids, tasks: { running: running.id, queued: queued.id, retiring: retiring.id, early: early.id } };
}

/**
 * Errors from the fixture and the harness, not the product: the fixture's prototype files are not on disk (a 404 in
 * the studio's frame), and the harness's init script reads localStorage inside the sandboxed prototype frame.
 */
const NOISE = [/status of 404/, /localStorage' property from 'Window': The document is sandboxed/];
const quiet = (page) => (page.qaErrors = page.qaErrors.filter((e) => !NOISE.some((r) => r.test(e))));

async function journeyBody(j, page, service) {
  const { text } = await import("./harness.mjs");
  const view = async (name, shot) => {
    quiet(page);
    await j.pageChecks(name);
    if (shot) await j.shot(shot);
  };

  // ---------- 1. Vision: the new design, kept; Reminders, dropped ----------
  const marks = page.getByRole("group", { name: "Your mark", exact: true });
  /** Open a round and one of its parts in the studio. */
  const open = async (round, title) => {
    await page.getByRole("list", { name: "Rounds" }).getByRole("button", { name: new RegExp(`^${round} ·`) }).click();
    await page.getByRole("list", { name: `Artifacts of round ${round}` }).getByRole("button", { name: new RegExp(`^${title}`) }).click();
    await page.getByRole("heading", { name: title, level: 2, exact: true }).waitFor({ timeout: 10_000 });
  };
  await j.step("open Vision", async () => {
    await page.goto(`${service.origin}/#/vision`);
    await page.getByRole("heading", { name: "Vision", level: 1 }).waitFor({ timeout: 15_000 });
    const list = page.getByRole("list", { name: "Artifacts of round 2" });
    const words = await list.innerText();
    j.check(/Packing list/.test(words) && /Trip plan/.test(words), "round 2 lists the new design: Trip plan v2 and Packing list");
    await view("Vision, round 2", "1-studio-new-design");
  });
  await j.step("mark Keep and Drop, and send them to the lead", async () => {
    await open(2, "Packing list");
    await marks.getByRole("button", { name: "Keep" }).click();
    await open(2, "Trip plan");
    await marks.getByRole("button", { name: "Keep" }).click();
    await open(1, "Reminders");
    await marks.getByRole("button", { name: "Drop" }).click();
    const before = (await page.getByRole("list", { name: "Not sent yet" }).innerText()).replace(/\s+/g, " ");
    for (const [what, words] of [
      ["Keep puts Packing list in the draft", "Keep puts Packing list v1 in the draft."],
      ["Keep puts Trip plan v2 in place of v1", "Keep puts Trip plan v2 in the draft, in place of Trip plan v1."],
      ["Drop takes Reminders out", "Drop takes Reminders out of the draft: it leaves the design at your next Lock in."],
    ])
      j.check(before.includes(words), `before Send, your feedback says: ${what}`, before);
    j.check((await page.getByRole("button", { name: /^Approve/ }).count()) === 0, "there is no separate Approve button: Keep and Send approve");
    await page.waitForTimeout(400);
    await j.shot("2-before-send");
    await page.getByRole("button", { name: "Send to the lead" }).click();
    await page.getByText(/Sent to the lead as one message/).waitFor({ timeout: 10_000 });
    const items = B.draftItems(service.state());
    j.check(items.some((i) => i.artifactId === SC.art.packing && i.status === "approved") && items.some((i) => i.artifactId === SC.art.plan && i.version === 2 && i.status === "approved") && items.find((i) => i.id === SC.ids.remind)?.status === "dropped", "the record: Packing list and Trip plan v2 are in the draft, and Reminders is dropped", items.map((i) => `${i.title} v${i.version} ${i.status}`));
    await view("Vision after Send", "2-after-keep");
  });

  // ---------- 2. The draft ----------
  await j.step("the draft bar", async () => {
    // The draft bar with a draft: one line; Show opens its list (ORC-030 a-vision-draft-bar).
    const bar = page.locator(".st-draftbar:not(.st-draftbar--empty)");
    await bar.waitFor({ timeout: 10_000 });
    const line = (await bar.innerText()).replace(/\s+/g, " ");
    j.check(/^Draft · 3 changes( · \d+ open)? Show Lock in…$/.test(line), 'the draft bar is one line: "Draft · 3 changes", Show and Lock in…', line.slice(0, 120));
    await bar.getByRole("button", { name: "Show" }).click();
    const words = await bar.innerText();
    j.check(/Trip plan/.test(words) && /Packing list/.test(words) && /Reminders/.test(words), "Show lists Trip plan, Packing list and Reminders");
    j.check(/Vision · draft, 3 changes/.test(await text(page)), 'the header says "Vision · draft, 3 changes"');
    await view("Vision with a draft", "3-draft-bar");
  });

  // ---------- 3. Lock in: what changes, then put it into force ----------
  await j.step("the Lock in summary", async () => {
    await page.getByRole("link", { name: "Lock in…" }).click();
    await page.getByRole("heading", { name: "Lock in 2 · the summary" }).waitFor({ timeout: 10_000 });
    for (const h of ["What changes", "The tasks it touches", "New work", "The budgets", "What stays open"]) j.check(await page.getByRole("heading", { name: h, exact: true }).count(), `the summary has "${h}"`);
    const tasks = page.getByRole("list", { name: "The tasks it touches" });
    for (const [id, tag] of [[SC.tasks.running, "Finish, then revise"], [SC.tasks.queued, "Update"], [SC.tasks.retiring, "Retire"], [SC.tasks.early, "Revise"]]) {
      const words = await tasks.locator("li").filter({ hasText: id }).first().innerText().catch(() => "");
      j.check(words.includes(tag), `it shows ${id} with "${tag}"`, words.slice(0, 120));
    }
    const all = await text(page);
    j.check(/Packing list v1 has no task yet/.test(all), "New work names Packing list");
    j.check(/Building: \$/.test(all) && /Maintenance:/.test(all), "the budgets show the building spend and maintenance");
    await view("the Lock in summary", "4-lock-in-summary");
  });
  await j.step("Lock in", async () => {
    const done = page.getByText("Locked in, as Lock in 2.");
    for (let i = 0; i < 3 && !(await done.count()); i++) {
      // The factory runs meanwhile; a summary that changes clears the agreement, so tick it again.
      await page.getByRole("checkbox", { name: /I read the summary/ }).check();
      await page.getByRole("button", { name: "Lock in 3 changes" }).click();
      await page.getByText(/Locked in, as Lock in 2\.|The summary changed while you read it\./).first().waitFor({ timeout: 10_000 });
    }
    j.check(await done.count(), 'the screen says "Locked in, as Lock in 2."');
    const co = service.state().blueprint.changeOrders.find((c) => c.rev === 2);
    j.check(co?.status === "open", "the record: change order 2 is open", co && { status: co.status });
    // Trip list is in force with no mark of yours, and Reminders is dropped: neither waits for your mark. (The simulated
    // lead may open a round meanwhile, whose parts do wait: the badge counts exactly what waits.)
    const waiting = waitingForYourMark(service.state()).map((a) => a.title);
    const badge = page.locator(`.tab-badge[aria-label*="waiting for your mark"]`);
    const label = (await badge.count()) ? await badge.first().getAttribute("aria-label") : "";
    j.check(!waiting.includes("Trip list") && !waiting.includes("Reminders") && (waiting.length ? label.startsWith(`${waiting.length} artifact`) : !label), "the Vision tab asks for no mark on parts that are in force or dropped", { waiting, label });
    await view("after Lock in", "5-locked-in");
  });

  // ---------- 4. The change order: the lead's updates, then Undo ----------
  const rows = page.getByRole("list", { name: "The lead's updates" });
  const row = (kind) => rows.locator("li").filter({ has: page.getByText(kind, { exact: true }) });
  await j.step("open the change order", async () => {
    await page.getByRole("link", { name: "Open change order 2" }).click();
    await page.getByRole("heading", { name: "Change order 2 · from Lock in 2" }).waitFor({ timeout: 10_000 });
    j.check(page.url().endsWith("#/tasks/change-order/2"), "it opens at #/tasks/change-order/2", page.url());
    await j.shot("6-change-order-waiting");
    await rows.waitFor({ timeout: 120_000 });
    await page.waitForTimeout(1500);
    const words = await rows.innerText();
    for (const k of ["Updated", "Retired", "New", "Revision"]) j.check((await row(k).count()) > 0, `the lead's answer has a "${k}" line`);
    j.check((await rows.getByRole("button", { name: "Undo" }).count()) >= 4, "each applied line offers Undo", words.slice(0, 300));
    await view("the change order, answered", "7-change-order-answered");
  });
  await j.step("Undo the retirement", async () => {
    await row("Retired").getByRole("button", { name: "Undo" }).click();
    await row("Retired").getByText("Undone", { exact: true }).waitFor({ timeout: 10_000 });
    const t = service.state().tasks.find((x) => x.id === SC.tasks.retiring);
    j.check(t && t.lifecycle !== "cancelled", `the record: ${SC.tasks.retiring} is back (not cancelled)`, t?.lifecycle);
    const words = (await row("Retired").innerText()).replace(/\s+/g, " ");
    j.check(words.includes(`${SC.tasks.retiring} is back, and it builds Reminders v1, which you dropped at Lock in 2.`), `the line says that ${SC.tasks.retiring} is back and builds a part you dropped`, words);
    await view("after Undo of the retirement", "8-undo-retired");
  });
  await j.step("the task that came back", async () => {
    // It builds only Reminders, which this Lock in dropped: the owner should see that before it starts.
    await page.goto(`${service.origin}/#/task/${SC.tasks.retiring}`);
    await page.getByRole("heading", { level: 1 }).first().waitFor({ timeout: 10_000 });
    const words = await text(page);
    j.check(/dropped|leaves the design|left the design|no longer in the design/i.test(words), `${SC.tasks.retiring}'s page says it builds a part you dropped (Reminders)`);
    await view(`${SC.tasks.retiring} after Undo`, "8b-task-back");
    await page.goBack();
    await rows.waitFor({ timeout: 10_000 });
  });
  await j.step("Undo the new task", async () => {
    await row("New").getByRole("button", { name: "Undo" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor({ timeout: 5_000 });
    await j.shot("9-undo-new-confirm", { full: false });
    await dialog.getByRole("button", { name: /^Undo and cancel/ }).click();
    await row("New").getByText("Undone", { exact: true }).waitFor({ timeout: 10_000 });
    const made = service.state().blueprint.changeOrders.find((c) => c.rev === 2).lines.find((l) => l.kind === "new-task")?.madeTaskId;
    const t = service.state().tasks.find((x) => x.id === made);
    j.check(t?.lifecycle === "cancelled", `the record: the new task ${made} is cancelled`, t?.lifecycle);
    await view("after Undo of the new task", "10-undo-new");
  });
  await j.step("the Tasks page names the change order", async () => {
    await page.goto(`${service.origin}/#/tasks`);
    await page.getByRole("heading", { name: "Tasks", level: 1 }).waitFor({ timeout: 10_000 });
    if (service.state().blueprint.changeOrders.find((c) => c.rev === 2).status === "open") j.check(await page.getByText("Change order 2 · from Lock in 2").count(), "the Tasks page shows the open change order");
    else j.note("Change order 2 closed before the Tasks page opened, so it has no banner.");
    await view("Tasks", "11-tasks");
  });
}

const SC = scene();
if (resolve(process.argv[1] ?? "") === resolve(import.meta.filename)) {
  const { runJourney } = await import("./harness.mjs");
  await runJourney("change-order", () => SC.s, journeyBody, { service: { run: true, progressPerTick: 1 }, ...(process.env.QA_WIDTH ? { widths: [Number(process.env.QA_WIDTH)] } : {}) });
}
