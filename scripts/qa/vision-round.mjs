// QA journey "vision-round": a Vision round with PE review, as the owner sees it, at 1280 and 375 wide.
//
// What it drives, on a fresh service for each width, with the scheduler running:
// 1. Vision with no round: the vision text at the top, then an empty draft whose main button is Ask the lead for a
//    round (ORC-030 a-vision-empty). The owner presses it, and asks the lead for a round in the lead panel.
// 2. The lead opens round 1. The designer hands in its part. The PE asks for a change, the designer revises it, and
//    the PE agrees. The journey waits for each stage on the screen and takes a screenshot.
// 3. The owner marks the part Change, picks a variant, writes a note and sends it to the lead, all in one bar under
//    the part (ORC-030 a-vision-actions); the right column has only what the lead and the PE said.
//    The journey reads the lead's reply and waits for a revision.
// 4. The owner marks the part Keep. Before Send, the feedback says that Keep puts it in the draft; Send does it, and the
//    draft bar lists it (ORC-030 Q-01: Keep is the approval, as the owner's pass 1 screens showed).
// 5. The owner marks the part Drop. Before Send, the feedback says that Drop takes it out of the draft; Send does it,
//    and the draft bar no longer lists it.
//
// Sample data: a new Weekend Trips project in Vision, made with the real commands (the kind of product, "screen
// product", is set by a command as the tests do). The runtime is the fake one: the lead, the designer and the PE are
// simulated, and nothing leaves this computer.
//
// Run: ORCHESTRATION_TEST_PORT=5960 node --import tsx scripts/qa/vision-round.mjs

import { runJourney, text } from "./harness.mjs";
import * as M from "../../src/domain/model.ts";
import { runCommand } from "../../src/domain/commands.ts";
import { buildSeed } from "../../src/domain/seed.ts";

const ASK = "Please open a round on the experience: the main screen of a trip.";
const PART = "Trip plan (simulated sample)";
const NOTE = "Show the stops as a list too.";

function visionProject() {
  const now = new Date().toISOString();
  const s = M.initProject(buildSeed(Date.now(), { inFlightRuns: false }), { name: "Weekend Trips", repoPath: "/tmp/weekend-trips", vision: "Weekend trips for a small group of friends.", focus: "Plan a trip together" }, now);
  return runCommand(s, "setDomains", { domains: ["screen"] }, now).state;
}

/** Whether the prototype frame shows the designer's page (its heading) within 8 s. */
async function frameShows(page) {
  return page.frameLocator("iframe.st-viewport__frame").first().getByText("Lake weekend").waitFor({ timeout: 8_000 }).then(() => true, () => false);
}

/** The harness's init script reads localStorage inside the sandboxed prototype frame: drop that error (see the report). */
function dropNoise(page) {
  page.qaErrors = page.qaErrors.filter((e) => !(/localStorage/.test(e) && /sandboxed/.test(e)));
}

await runJourney(
  "vision-round",
  visionProject,
  async (j, page, service, width) => {
    const narrow = width < 600;
    const has = async (words) => (await text(page)).includes(words);
    const marks = page.getByRole("group", { name: "Your mark" });
    const sendFeedback = page.getByRole("button", { name: "Send to the lead" });
    // The draft bar with a draft (the empty bar has its own class, st-draftbar--empty).
    const draftBar = page.locator(".st-draftbar:not(.st-draftbar--empty)");
    const closeLead = async () => {
      const close = page.getByRole("button", { name: "Close the lead panel" });
      if (await close.count()) await close.click();
    };
    const artifact = () => service.state().studio.artifacts.filter((a) => a.title === PART).at(-1);

    await j.step("Vision, no round", async () => {
      await page.goto(`${service.origin}/#/vision`);
      await page.getByRole("heading", { name: "Vision", exact: true }).waitFor({ timeout: 10_000 });
      j.check(await has("No rounds yet."), "Vision: it says there is no round yet");
      j.check(await has("Nothing is in the draft yet."), "Vision: it says the draft is empty");
      // The vision text lives in Vision, at the top (ORC-030 C1).
      const top = page.getByRole("region", { name: "The vision" });
      j.check((await top.innerText()).includes("Weekend trips for a small group of friends."), "Vision: the vision text is at the top");
      // Until a part is in the draft, the main button is Ask the lead for a round; Start the factory is a quiet link.
      const ask = page.getByRole("button", { name: "Ask the lead for a round" });
      j.check((await ask.getAttribute("class"))?.includes("k-btn--primary"), "Vision: the main button is Ask the lead for a round");
      const start = page.getByRole("main").getByRole("link", { name: "Start the factory…" });
      j.check((await start.getAttribute("class"))?.includes("k-btn--quiet"), "Vision: Start the factory… is a quiet link");
      j.check((await page.getByRole("main").getByRole("textbox", { name: "Message the lead" }).count()) === 0, "Vision has no message box of its own");
      await j.shot("empty");
      await j.pageChecks("Vision, no round");
    });

    await j.step("Ask the lead for a round", async () => {
      await page.getByRole("button", { name: "Ask the lead for a round" }).click();
      const box = page.getByRole("textbox", { name: "Message to the lead" });
      await box.waitFor({ timeout: 10_000 });
      j.check(/^Ask for a round:/.test((await box.getAttribute("placeholder")) ?? ""), "the lead panel's box says what to ask for", await box.getAttribute("placeholder"));
      j.check(!narrow || (await page.getByRole("dialog", { name: "Lead" }).count()) === 1, "the lead panel opens (a dialog at 375)");
      await box.fill(ASK);
      await page.getByRole("button", { name: "Send", exact: true }).click();
      const convo = page.getByRole("list", { name: "Conversation with the lead" });
      await convo.getByText(ASK).first().waitFor({ timeout: 10_000 });
      j.check(true, "the owner's message shows in the conversation");
      await page.getByText("I opened a round on the experience").first().waitFor({ timeout: 30_000 });
      j.check(true, "the lead replies that it opened a round on the experience");
      await j.shot("lead-reply", { full: false });
      await closeLead();
    });

    await j.step("The round opens", async () => {
      const rounds = page.getByRole("list", { name: "Rounds" });
      await rounds.getByText("1 · The experience").waitFor({ timeout: 15_000 });
      j.check((await rounds.innerText()).includes("open"), "the round list shows round 1, the experience, open");
      j.check(await has("The experience (simulated): the main screen, in two takes."), "the round says what it is for");
      j.check(await has("Is anything missing from this round? (simulated)"), "the lead's question shows beside the round");
      await j.shot("round-open");
    });

    let peLine = "";
    await j.step("The designer's part, then the PE", async () => {
      const item = page.getByRole("list", { name: "Artifacts of round 1" }).getByRole("button", { name: new RegExp(PART.replace(/[()]/g, "\\$&")) });
      await item.waitFor({ timeout: 30_000 });
      j.check(true, "the designer's part arrives in the round");
      if ((await item.innerText()).includes("with the PE")) {
        const keep = marks.getByRole("button", { name: "Keep" });
        j.check((await keep.isDisabled()) || (await keep.getAttribute("aria-disabled")) === "true", "while the PE reviews, the marks wait");
        await j.shot("designer-part");
      }
      // Watch the run lines while the PE works, and wait for its verdict.
      for (let i = 0; i < 120 && !(await has("The PE agreed on pass 2")); i++) {
        const runs = page.getByRole("list", { name: "Runs of round 1" });
        if ((await runs.count()) && /PE · .*working/.test(await runs.innerText())) peLine ||= await runs.innerText();
        await page.waitForTimeout(500);
      }
      j.check(await has("The PE agreed on pass 2"), "the PE agrees on pass 2, after the designer's revision");
      if (peLine) j.check(!peLine.includes("The designer is making"), "the PE's run line says what the PE does", peLine.replace(/\s+/g, " "));
      const t = await text(page);
      j.check(/A · Map first\s*Feasible/.test(t) && /B · Day by day\s*Feasible/.test(t), "PE review: a verdict on each variant");
      j.check(/v1\s*asked for changes/.test(t) && /v2\s*agreed/.test(t), "the versions: v1 asked for changes, v2 agreed");
      j.check(t.includes("Mark it Keep, Change or Drop, and pick a variant."), "PE review says what the owner does next");
      j.check(await frameShows(page), "the prototype shows the designer's page");
      await j.shot("pe-verdict");
      await j.shot("prototype", { locator: page.locator(".st-stage").first() });
      dropNoise(page);
      await j.pageChecks("Vision with the PE's verdict");
    });

    await j.step("Mark Change and send", async () => {
      await marks.getByRole("button", { name: "Change" }).click();
      await page.getByRole("button", { name: "Pick this variant" }).click();
      await page.getByRole("textbox", { name: `Note on ${PART}` }).fill(NOTE);
      const summary = await page.getByRole("list", { name: "Not sent yet" }).innerText();
      j.check(summary.includes("v2: Change, picked A · Map first, a note"), "your feedback lists the mark, the pick and the note before you send", summary);
      // One bar under the part: the marks, the note and Send together; the right column has none of them.
      const bar = page.getByRole("region", { name: "Your answer" });
      j.check((await bar.getByRole("group", { name: "Your mark" }).count()) === 1 && (await bar.getByRole("textbox", { name: `Note on ${PART}` }).count()) === 1 && (await bar.getByRole("button", { name: "Send to the lead" }).count()) === 1, "one bar under the part holds Keep, Change, Drop, the note and Send");
      const right = page.getByRole("complementary", { name: "What the lead and the PE said" });
      j.check((await right.getByRole("textbox", { name: /Note on|Message the lead/ }).count()) === 0, "the right column has no note and no message box (only the answers to the lead's questions)");
      j.check((await right.getByRole("button", { name: /^(Keep|Send to the lead)$/ }).count()) === 0, "the right column has no mark and no Send");
      const marksBox = await marks.boundingBox();
      const sendBox = await sendFeedback.boundingBox();
      j.check(!!marksBox && !!sendBox && Math.abs(sendBox.y - marksBox.y) < (narrow ? 160 : 40), "Send is beside the marks (one row at 1280, a few lines below at 375)", marksBox && sendBox && { marks: Math.round(marksBox.y), send: Math.round(sendBox.y) });
      await j.shot("marked-change");
      await sendFeedback.click();
      await page.getByText("Sent to the lead as one message.").waitFor({ timeout: 10_000 });
      j.check(true, "after Send, it says the feedback went to the lead as one message");
      const fb = service.state().studio.feedback.at(-1);
      j.check(fb?.mark === "change" && fb.pickedVariant === "a" && fb.note === NOTE, "the record: Change, variant A and the note", fb && { mark: fb.mark, pick: fb.pickedVariant, note: fb.note });
    });

    await j.step("What the lead does with a Change", async () => {
      await service.until("the lead's reply to the feedback", (s) => s.leadRuns.filter((r) => r.trigger === "message").length >= 2 && !M.activeLeadRun(s), 30_000);
      await page.getByRole("button", { name: /^Message the lead/ }).first().click();
      const replies = page.getByRole("list", { name: "Conversation with the lead" });
      await replies.waitFor({ timeout: 10_000 });
      const all = await replies.innerText();
      const reply = all.slice(all.lastIndexOf("My feedback, recorded on each version"));
      j.check(!/drafted a vision|Here is what I understand: Trip plan/.test(reply), "the lead's reply answers the feedback; it does not redraft the vision from it", reply.replace(/\s+/g, " ").slice(0, 300));
      await j.shot("lead-after-change", { full: false });
      await closeLead();
      let revised = false;
      for (let i = 0; i < 30 && !revised; i++) {
        revised = (await has("v3")) || /Designer · .*(queued|working)/.test(await text(page));
        await page.waitForTimeout(500);
      }
      j.check(revised, "a Change leads to a revision: a designer run or a v3 shows within 15 s");
      await j.shot("after-change");
    });

    const notSent = page.getByRole("list", { name: "Not sent yet" });
    const partItem = () => page.getByRole("list", { name: "Artifacts of round 1" }).getByRole("button", { name: new RegExp(PART.replace(/[()]/g, "\\$&")) });
    await j.step("Keep, Send, and the draft", async () => {
      // The newest version of the part, once it is yours to mark. The Change brings a revision (v3): wait for it, so the
      // part you keep is the one the studio shows (the PE may still review it: Keep waits for that below).
      await service.until("the designer's revision after the Change", () => (artifact()?.version ?? 0) >= 3, 30_000);
      await partItem().click();
      const keep = marks.getByRole("button", { name: "Keep" });
      for (let i = 0; i < 60 && ((await keep.isDisabled()) || (await keep.getAttribute("aria-disabled")) === "true"); i++) await page.waitForTimeout(500);
      await keep.click();
      if ((await page.getByRole("button", { name: "Pick this variant" }).count()) && !(await page.getByRole("button", { name: "Picked" }).count())) await page.getByRole("button", { name: "Pick this variant" }).click();
      const v = artifact().version;
      const before = await notSent.innerText();
      j.check(before.includes(`Keep puts ${PART} v${v} (A · Map first) in the draft.`), "before Send, your feedback says that Keep puts the part in the draft", before.replace(/\s+/g, " "));
      j.check((await page.getByRole("button", { name: /^Approve/ }).count()) === 0, "there is no separate Approve button: Keep and Send approve");
      await page.waitForTimeout(400); // the marks fade in their colours (0.15 s): let them settle before the screenshot
      await j.shot("keep-before-send");
      await sendFeedback.click();
      await page.getByText("Sent to the lead as one message.").waitFor({ timeout: 10_000 });
      const after = await page.getByRole("list", { name: "The draft after Send" }).innerText();
      j.check(after.includes(`${PART} v${v} (A · Map first) is in the draft.`), "after Send, it says the part is in the draft", after);
      await draftBar.waitFor({ timeout: 10_000 });
      const line = (await draftBar.innerText()).replace(/\s+/g, " ");
      j.check(line === "Draft · 1 change Show Start the factory…", 'the draft bar is one line: "Draft · 1 change", Show and Start the factory…', line);
      await draftBar.getByRole("button", { name: "Show" }).click();
      const bar = await draftBar.innerText();
      j.check(new RegExp(`Added\\s*Trip plan \\(simulated sample\\) v${v}`).test(bar), "Show lists the kept part as Added", bar.replace(/\s+/g, " "));
      j.check(bar.includes("Start the factory…"), "in Vision, the draft bar leads to Start the factory…");
      j.check((await page.getByRole("button", { name: "Ask the lead for a round" }).count()) === 0, "with a part in the draft, Ask the lead for a round is no longer the main button");
      j.check((await page.getByRole("list", { name: "Artifacts of round 1" }).innerText()).includes("in the draft"), "the part says in the draft");
      const item = service.state().blueprint.draft.items.find((i) => i.title === PART);
      j.check(item?.status === "approved" && item.version === v && item.variant === "a", "the record: the draft holds the part, with the pick", item && { status: item.status, version: item.version, variant: item.variant });
      j.check(await frameShows(page), "in the draft, the prototype still shows the designer's page");
      await j.shot("draft");
      dropNoise(page);
      await j.pageChecks("Vision with a draft");
    });

    await j.step("Drop the approved part", async () => {
      const drop = marks.getByRole("button", { name: "Drop" });
      if ((await drop.isDisabled()) || (await drop.getAttribute("aria-disabled")) === "true") {
        j.check(false, "the owner can mark an approved part Drop", await page.getByRole("region", { name: "The artifact" }).innerText().catch(() => ""));
        return;
      }
      await drop.click();
      const before = await notSent.innerText();
      j.check(before.includes(`Drop takes ${PART} v${artifact().version} out of the draft.`), "before Send, your feedback says that Drop takes the part out of the draft", before.replace(/\s+/g, " "));
      await sendFeedback.click();
      await page.getByText("Sent to the lead as one message.").waitFor({ timeout: 10_000 });
      await page.waitForTimeout(1500);
      const bar = (await draftBar.count()) ? await draftBar.innerText() : "";
      j.check(!/Added\s*Trip plan/.test(bar), "a Drop removes the part from the draft (the draft bar no longer lists it as Added)", bar.replace(/\s+/g, " "));
      const item = service.state().blueprint.draft.items.find((i) => i.title === PART);
      j.check(item?.status === "dropped", "the record: the draft item is dropped", item && { status: item.status });
      const chips = await partItem().innerText();
      j.check(/drop/.test(chips) && !chips.includes("in the draft"), "the part says drop, and no longer in the draft (the screen agrees)", chips.replace(/\s+/g, " "));
      await j.shot("dropped");
      dropNoise(page);
      await j.pageChecks("Vision after Drop");
    });
  },
  { service: { run: true, progressPerTick: 25, tickMs: 400 } },
);
