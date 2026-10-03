// The "notes" journey (ORC-030 QA): a note to a running agent, sent two ways, at 1280 and 375 wide.
//
// What it drives, as the owner sees it:
// 1. The task page of a task whose coder runs. It sends a note with "Send a note". The note shows "Sending", then
//    "Delivered" once the simulated runtime acknowledges it (after two ticks). The record must say "delivered".
// 2. The lead panel. It asks the lead to tell the coder on that task something. The simulated lead answers, passes the
//    note on, and the reply's change list shows the note with "Delivered". The record must say "delivered", from the lead.
// It also checks for a horizontal scroll and for console errors on each view, and takes a screenshot of each stage.
//
// Sample data: the demo project (src/domain/demo.ts, "Weekend Trips (sample)"). The runtime is the fake one: no model
// runs, and every run and reply is simulated. The scheduler runs (one tick a second, one percent a tick), so a step
// stays running long enough to take a note.
//
// Run: ORCHESTRATION_TEST_PORT=5994 node --import tsx scripts/qa/notes.mjs

import { buildDemo } from "../../src/domain/demo.ts";
import { runJourney, text } from "./harness.mjs";

const DIRECT = "Keep the download size above the button, so people see it before they tap.";
const VIA_LEAD = "show the size of each download in megabytes";

/** The first open task with a running coder step: its id and step id (the fixture's knowledge, to choose the page). */
function runningCoder(s) {
  for (const a of s.attempts) {
    if (a.outcome !== "running") continue;
    const t = s.tasks.find((x) => x.id === a.taskId);
    const st = t?.steps.find((x) => x.id === a.stepId);
    if (t && st?.role === "coder" && !["done", "cancelled"].includes(t.lifecycle)) return { taskId: t.id, stepId: st.id, attemptId: a.id };
  }
  return undefined;
}

/**
 * A helper of this script (the fake runtime has no knob for it): hold one simulated run below half done, so it still
 * runs when a note arrives. A simulated lead run takes about as long as a whole step, so without it the lead's note
 * often reaches a coder that has just finished. Returns the function that lets the run go on.
 */
function holdRunning(service, attemptId) {
  const timer = setInterval(() => {
    for (const a of Object.values(service.adapters)) {
      const p = (a.inner ?? a).procs?.get(attemptId);
      if (p && p.progress > 40) p.progress = 40;
    }
  }, 100);
  return () => clearInterval(timer);
}

/** Wait until the page's text matches `re`, or fail after `ms`. */
async function waitText(page, re, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) {
    if (re.test(await text(page))) return true;
    if (Date.now() > end) return false;
    await page.waitForTimeout(300);
  }
}

await runJourney(
  "notes",
  () => buildDemo(Date.now()),
  async (j, page, service, width) => {
    const target = await service.until("a running coder step", runningCoder, 30_000);
    const { taskId, stepId } = target;
    const releaseFirst = holdRunning(service, target.attemptId);
    j.note(`The note goes to ${taskId} ${stepId} (a running coder in the demo).`);

    // ---------- 1. A note to the running step, from the task page ----------
    await j.step("open the task page", async () => {
      await page.goto(`${service.origin}/#/task/${taskId}`);
      await page.getByRole("heading", { level: 1 }).first().waitFor({ timeout: 15_000 });
    });
    const sendButton = page.getByRole("button", { name: `Send a note to ${stepId}` });
    await j.step("open the note form", async () => {
      await sendButton.waitFor({ timeout: 10_000 });
      j.check(true, `the task page offers "Send a note" on the running step ${stepId}`);
      await sendButton.click();
    });
    const box = page.getByRole("textbox", { name: new RegExp(`Note to the coder running ${stepId}`) });
    await j.step("write and send the note", async () => {
      await box.waitFor({ timeout: 5_000 });
      await box.fill(DIRECT);
      const hint = await text(page);
      j.check(/the agent acknowledges after a moment/.test(hint), "the form says the demo's agent acknowledges after a moment");
      await j.pageChecks("the note form");
      await j.shot("1-note-form", { full: false });
      await page.getByRole("button", { name: "Send", exact: true }).click();
    });
    const notesList = page.getByRole("list", { name: `Notes to the agent running ${stepId}` });
    await j.step("the note shows on the step", async () => {
      await notesList.waitFor({ timeout: 10_000 });
      const first = await notesList.innerText();
      j.check(first.includes(DIRECT), "the sent note shows under the running step, with its text");
      j.check(/Sending|Delivered/.test(first), "the note shows a status at once (Sending or Delivered)", first.slice(0, 160));
      j.check(/from you/.test(first), 'the note says "from you"');
      await notesList.scrollIntoViewIfNeeded();
      await j.shot("2-note-sending", { full: false });
    });
    await j.step("the note becomes Delivered", async () => {
      const ok = await waitText(page, new RegExp(`Delivered[\\s\\S]{0,200}${DIRECT.slice(0, 30)}`), 20_000);
      j.check(ok, "the note shows Delivered once the runtime acknowledged it");
      const n = service.state().notes.find((x) => x.text === DIRECT);
      j.check(n?.status === "delivered" && n.from.by === "user", "the record: the note is delivered, from you", n && { status: n.status, by: n.from.by, via: n.via });
      await notesList.scrollIntoViewIfNeeded();
      await j.pageChecks("the task page after the note");
      await j.shot("3-note-delivered", { full: false });
    });

    releaseFirst();

    // ---------- 2. A note through the lead ----------
    // The coder may have finished meanwhile: the message names a coder that runs now.
    const lead = await service.until("a running coder step for the lead's note", runningCoder, 60_000);
    const release = holdRunning(service, lead.attemptId);
    const message = `Tell the coder on ${lead.taskId} to ${VIA_LEAD}.`;
    const panel = page.getByRole(width < 768 ? "dialog" : "complementary", { name: "Lead" });
    const replies = panel.locator("li.msg.lead");
    let before = 0;
    await j.step("open the lead panel", async () => {
      await page.goto(`${service.origin}/#/task/${lead.taskId}`);
      await page.getByRole("button", { name: /^Message the lead(?! about)/ }).first().click();
      await panel.waitFor({ timeout: 5_000 });
      before = await replies.count();
      await j.pageChecks("the lead panel");
      await j.shot("4-lead-panel", { full: false });
    });
    await j.step("message the lead", async () => {
      await panel.getByRole("textbox", { name: "Message to the lead" }).fill(message);
      await panel.getByRole("button", { name: "Send", exact: true }).click();
      j.check(await waitText(page, new RegExp(message.slice(0, 30)), 5_000), "your message shows in the conversation");
      await j.shot("5-message-sent", { full: false });
    });
    await j.step("the lead passes the note on", async () => {
      // The simulated lead answers in a later tick; its reply folds its changes into one line ("1 note").
      await replies.nth(before).waitFor({ timeout: 90_000 });
      const reply = replies.last();
      j.check(/note/i.test(await reply.innerText()), "the lead replies, and the reply says it passes the note on", (await reply.innerText()).slice(0, 200));
      const fold = reply.getByRole("button", { name: /\bnote\b/ });
      j.check((await fold.count()) === 1, 'the reply folds its change into one line, "1 note"');
      if ((await fold.count()) && (await fold.getAttribute("aria-expanded")) === "false") await fold.click();
      const row = new RegExp(`Note to ${lead.taskId} ${lead.stepId}[\\s\\S]{0,400}Delivered`);
      const ok = await (async () => {
        for (let i = 0; i < 60; i++) {
          if (row.test(await reply.innerText())) return true;
          await page.waitForTimeout(500);
        }
        return false;
      })();
      const rows = await reply.innerText();
      j.check(ok, `the reply's change list shows "Note to ${lead.taskId} ${lead.stepId}" with Delivered`, rows.slice(-400));
      j.check(/no Undo: a sent note cannot be unsent/.test(rows), "the note row says a sent note has no Undo");
      const n = service.state().notes.find((x) => x.text.toLowerCase().includes(VIA_LEAD));
      j.check(n?.status === "delivered" && n.from.by === "lead" && n.taskId === lead.taskId, "the record: the lead's note is delivered to that task", n && { status: n.status, by: n.from.by, task: n.taskId, step: n.stepId, reason: n.reason, via: n.via });
      release();
      await reply.scrollIntoViewIfNeeded();
      await j.pageChecks("the conversation after the lead's reply");
      await j.shot("6-lead-note-delivered", { full: false });
    });
    await j.step("the lead's note shows on the task page", async () => {
      await page.getByRole("button", { name: "Close the lead panel" }).click();
      const list = page.getByRole("list", { name: new RegExp(`Notes (to the agent running|waiting for) ${lead.stepId}`) }).first();
      const words = await list.innerText({ timeout: 5_000 }).catch(() => "");
      j.check(new RegExp(VIA_LEAD, "i").test(words) && /from the lead/.test(words), 'the task page lists the lead\'s note, "from the lead"', words.slice(0, 300));
      await list.scrollIntoViewIfNeeded().catch(() => {});
      await j.shot("7-task-lead-note", { full: false });
    });
  },
  { service: { run: true, progressPerTick: 1 }, ...(process.env.QA_WIDTH ? { widths: [Number(process.env.QA_WIDTH)] } : {}) },
);
