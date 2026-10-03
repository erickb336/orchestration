// QA journey "lock-in": the draft and Lock in, as the owner sees them, at 1280 and 375 wide.
//
// In Vision, Lock in is not a button of its own: Start the factory, on the pre-flight, is the first Lock in. After the
// start, each later change goes through Lock in (#/vision/lock-in), and a Lock in that touches tasks is a change order.
// So the journey drives both, on a fresh service for each width:
// 1. Vision: the draft bar lists the two approved parts and leads to Start the factory….
// 2. The Lock in summary (#/vision/lock-in) in Vision: what it shows, and its way to the pre-flight.
// 3. The first Lock in: Check-in, the agreement, and Start the factory. The draft clears, the parts are in force,
//    and Results › Design and reality shows Lock in 1.
// 4. The studio goes on (sample data, through commands): Words v2 replaces v1, and the owner drops Trip plan.
// 5. The draft bar, Review and lock in, the summary, a summary that changes while the owner reads it, the agreement,
//    and Lock in. The draft clears, and Design and reality shows Lock in 2.
//
// Sample data: a new Weekend Trips project in Vision, built through the real commands: round 1 (the experience) with
// Trip plan, which the PE agreed on, and round 2 (inputs and outputs) with Words, the word list. Both are approved, as
// the owner would approve them (the studio has no Approve control: see the report). The runtime is the fake one, and
// no scheduler tick runs.
//
// Run: ORCHESTRATION_TEST_PORT=5960 node --import tsx scripts/qa/lock-in.mjs

import { runJourney, text } from "./harness.mjs";
import * as M from "../../src/domain/model.ts";
import { buildSeed } from "../../src/domain/seed.ts";
import { DESIGNER, openRound, peAgrees, run, sha } from "../../src/domain/testing/studio.ts";

const WORDS = [
  { term: "trip", meaning: "A weekend away that a group plans together.", avoid: ["journey"] },
  { term: "friend", meaning: "A person in the group, who joins by link.", avoid: ["member", "user"] },
];

/** Weekend Trips in Vision with two approved parts: Trip plan (round 1, closed) and Words (round 2, open). */
function visionWithDraft() {
  const at = (sec) => new Date(Date.now() - 3_600_000 + sec * 1000).toISOString();
  let s = M.initProject(buildSeed(Date.now(), { inFlightRuns: false }), { name: "Weekend Trips", repoPath: "/tmp/weekend-trips", vision: "Weekend trips for a small group of friends.", focus: "Plan a trip together" }, at(0));
  s = run(s, "setBudgets", { buildingUsd: 40, maintenanceUsdPerMonth: 10 }, at(1)).state;
  s = run(s, "setDomains", { domains: ["screen"] }, at(1)).state;
  let r = openRound(s, "experience", at(10));
  const plan = run(r.state, "addStudioArtifact", { round: r.n, kind: "screen", title: "Trip plan", variants: [{ id: "A", label: "Map first", entry: "trip-plan/index.html" }], files: [{ path: "trip-plan/index.html", sha256: sha("a") }], devices: ["desktop", "mobile"], madeBy: DESIGNER }, at(11));
  s = peAgrees(plan.state, plan.result.artifactId, 1, [], at(12));
  s = run(s, "approveArtifact", { artifactId: plan.result.artifactId, version: 1 }, at(13)).state;
  s = run(s, "closeRound", { round: r.n }, at(14)).state;
  r = openRound(s, "data", at(20));
  const words = run(r.state, "addStudioArtifact", { round: r.n, kind: "dictionary", title: "Words", variants: [{ id: "a", label: "As drafted", entry: "dictionary.json" }], files: [{ path: "dictionary.json", sha256: sha("e") }], devices: [], dictionary: WORDS, madeBy: DESIGNER }, at(21));
  return run(words.state, "approveArtifact", { artifactId: words.result.artifactId, version: 1 }, at(22)).state;
}

/**
 * Errors the harness or the fixture makes, not the product (see the report): the harness's init script reads
 * localStorage inside a sandboxed prototype frame, and the fixture's parts have no files, so their prototypes answer 404.
 */
function dropNoise(page) {
  const fixture = page.qaNotFound.filter((u) => /\.localhost:\d+\/|\/api\/studio\/file/.test(u));
  page.qaNotFound = page.qaNotFound.filter((u) => !fixture.includes(u));
  let n = fixture.length;
  page.qaErrors = page.qaErrors.filter((e) => !(/localStorage/.test(e) && /sandboxed/.test(e)) && !(n > 0 && /status of 404/.test(e) && n--));
}

await runJourney("lock-in", visionWithDraft, async (j, page, service) => {
  const has = async (words) => (await text(page)).includes(words);
  const flat = (t) => t.replace(/\s+/g, " ");
  const draftBar = page.locator(".st-draftbar");
  const vision = async () => {
    await page.goto(`${service.origin}/#/vision`);
    await page.getByRole("heading", { name: "Vision", exact: true }).waitFor({ timeout: 10_000 });
    await page.waitForTimeout(500);
  };
  const reality = async (rev, parts) => {
    await page.goto(`${service.origin}/#/results/design`);
    await page.getByText(/Lock in \d+ · \d+ part/).first().waitFor({ timeout: 10_000 });
    j.check(await has(`Lock in ${rev} · ${parts}`), `Design and reality shows Lock in ${rev} · ${parts}`, flat((await text(page)).slice(0, 300)));
  };

  await j.step("The draft bar in Vision", async () => {
    await vision();
    const bar = flat(await draftBar.innerText());
    j.check(bar.includes("Draft · 2 changes"), "the draft bar: 2 changes", bar);
    j.check(/Added Trip plan v1/.test(bar) && /Added Words v1/.test(bar), "the draft bar lists Trip plan and Words as Added");
    const go = draftBar.getByRole("link", { name: "Start the factory…" });
    j.check((await go.getAttribute("href")) === "#/vision/pre-flight", "in Vision, the draft bar leads to Start the factory… (the first Lock in)");
    j.check((await draftBar.getByRole("link", { name: "Review and lock in" }).count()) === 0, "in Vision, there is no separate Review and lock in");
    await j.shot("draft-bar");
    dropNoise(page);
    await j.pageChecks("Vision with a draft");
  });

  await j.step("The Lock in summary in Vision", async () => {
    await page.goto(`${service.origin}/#/vision/lock-in`);
    await page.getByRole("heading", { name: "Lock in 1 · the summary" }).waitFor({ timeout: 10_000 });
    const t = await text(page);
    j.check(t.includes("2 changes go into force"), "the summary: 2 changes go into force");
    j.check(t.includes("Building: $0.00 spent of $40.00"), "the summary: the building budget");
    j.check(t.includes("In Vision, Start the factory is your first Lock in."), "the summary says Start the factory is the first Lock in");
    await j.shot("summary-vision");
    dropNoise(page);
    await j.pageChecks("the Lock in summary in Vision");
    await page.getByRole("main").getByRole("link", { name: "Start the factory…" }).click();
    await page.getByRole("heading", { name: "Start the factory?" }).waitFor({ timeout: 10_000 });
    j.check(true, "its Start the factory… opens the pre-flight");
  });

  await j.step("The first Lock in: Start the factory", async () => {
    await page.getByRole("radio", { name: "Check-in" }).click();
    await page.getByRole("checkbox", { name: /I have reviewed the blueprint/ }).check();
    await page.getByRole("button", { name: "Start the factory", exact: true }).click();
    await page.getByRole("heading", { name: "The factory started." }).waitFor({ timeout: 10_000 });
    j.check(await has("from Lock in 1 and vision r1"), "started: from Lock in 1");
    await vision();
    j.check((await draftBar.count()) === 0, "after the start, the draft bar is gone");
    j.check(await has("The factory has started. Vision stays open"), "Vision says the factory has started and Vision stays open");
    j.check((await page.getByRole("list", { name: /^Artifacts of round/ }).innerText()).includes("in force"), "the parts say in force");
    await j.shot("in-force");
    dropNoise(page);
    await j.pageChecks("Vision after the start");
    j.check(service.state().blueprint.revisions.at(-1)?.rev === 1, "the record: the blueprint is at Lock in 1");
    await reality(1, "2 parts");
    await j.shot("reality-1");
  });

  await j.step("The studio goes on: a new draft", async () => {
    // Sample data, as the designer and the owner would make it: Words v2 replaces v1; the owner drops Trip plan.
    const st = service.state();
    const words = st.studio.artifacts.find((a) => a.title === "Words");
    const v2 = service.command("addStudioArtifact", { round: words.round, artifactId: words.id, kind: "dictionary", title: "Words", variants: [{ id: "a", label: "As drafted", entry: "dictionary.json" }], files: [{ path: "dictionary.json", sha256: sha("f") }], devices: [], dictionary: [...WORDS, { term: "cost each", meaning: "What the trip costs, divided by the friends who go.", avoid: ["price per person"] }], madeBy: DESIGNER });
    service.command("approveArtifact", { artifactId: words.id, version: v2.result.version });
    service.command("dropBlueprintItem", { itemId: st.blueprint.draft.items.find((i) => i.title === "Trip plan").id });
    await vision();
    const frames = await page.evaluate(() => [...document.querySelectorAll("iframe")].map((f) => f.src));
    if (frames.some((u) => u.includes("trip-plan"))) j.note(`Vision loads the dropped Trip plan's prototype in a frame: ${frames.join(", ")}`);
    const bar = flat(await draftBar.innerText());
    j.check(bar.includes("Since Lock in 1"), "the draft bar says what it changes since: Lock in 1", bar);
    j.check(/Changed Words v2 \(replaces v1\)/.test(bar) && /Dropped Trip plan v1/.test(bar), "the draft bar: Words v2 Changed, Trip plan Dropped");
    j.check((await draftBar.getByRole("link", { name: "Review and lock in" }).count()) === 1, "after the start, the draft bar offers Review and lock in");
    // Words v2 shows beside v1, the version in force: each pane keeps its own table and controls.
    const over = await page.evaluate(() => {
      const pane = document.querySelector('section[aria-label$=", in the draft"]')?.getBoundingClientRect();
      return pane ? [...document.querySelectorAll('section[aria-label$=", in the draft"] :is(button, table)')].filter((e) => e.getBoundingClientRect().right > pane.right + 1).map((e) => e.textContent.trim().slice(0, 20)) : [];
    });
    j.check(over.length === 0, "beside: the draft's word table fits its pane (nothing runs under the version in force)", over);
    await j.shot("draft-bar-2");
    dropNoise(page);
    await j.pageChecks("Vision with a new draft");
  });

  await j.step("Lock in 2", async () => {
    await draftBar.getByRole("link", { name: "Review and lock in" }).click();
    await page.getByRole("heading", { name: "Lock in 2 · the summary" }).waitFor({ timeout: 10_000 });
    const t = await text(page);
    j.check(t.includes("2 changes go into force"), "the summary: 2 changes go into force");
    j.check(/Changed\s*Words v2/.test(t) && /Dropped\s*Trip plan v1/.test(t), "the summary: what changes, by name");
    j.check(t.includes("No task cites what changes."), "the summary: no task is touched");
    const who = t.slice(t.indexOf("Who acts next"));
    j.check(!who.includes("New tasks wait for PE review, then start."), "who acts next agrees with Check-in (new tasks wait for your go-ahead)", flat(who).slice(0, 200));
    const agree = page.getByRole("checkbox", { name: /I read the summary/ });
    const lockIn = page.getByRole("button", { name: /^Lock in 2 changes/ });
    j.check((await lockIn.isDisabled()) || (await lockIn.getAttribute("aria-disabled")) === "true", "Lock in waits for the agreement");
    await agree.check();
    // Another tab changes the building budget while the owner reads: the summary changes, and the agreement clears.
    service.command("setBudgets", { buildingUsd: 50, maintenanceUsdPerMonth: 10 });
    await page.getByText("The summary changed while you read it.").waitFor({ timeout: 10_000 });
    j.check(!(await agree.isChecked()), "stale: the banner shows, and the agreement is cleared");
    j.check(await has("Building: $0.00 spent of $50.00"), "stale: the new summary shows the new budget");
    await j.shot("summary-factory");
    dropNoise(page);
    await j.pageChecks("the Lock in summary");
    await agree.check();
    await lockIn.click();
    await page.getByRole("heading", { name: "Lock in 2", exact: true }).waitFor({ timeout: 10_000 });
    const done = flat(await text(page));
    j.check(done.includes("Locked in, as Lock in 2.") && done.includes("The factory now builds from Lock in 2."), "done: locked in as Lock in 2", done.slice(0, 400));
    await j.shot("locked-in");
    await vision();
    j.check((await draftBar.count()) === 0, "after Lock in, the draft bar is gone");
    const marksBadge = page.locator(`.tab-badge[aria-label*="waiting for your mark"]`);
    const badge = (await marksBadge.count()) ? await marksBadge.first().getAttribute("aria-label") : null;
    j.check(!badge, "the Vision tab asks for no mark on parts that are in force or dropped", badge);
    const b = service.state().blueprint;
    j.check(b.revisions.at(-1)?.rev === 2 && b.revisions.at(-1).lockIn, "the record: the blueprint is at Lock in 2, with the owner's Lock in");
    await reality(2, "1 part");
    await j.shot("reality-2");
    dropNoise(page);
    await j.pageChecks("Design and reality after Lock in 2");
  });
});
