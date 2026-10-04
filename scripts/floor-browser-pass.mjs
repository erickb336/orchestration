// The browser pass of the factory floor (ORC-029 pass 6, unit 6b): Home after the start, on the seeded floor
// (src/ui/floor/floorScene.ts: work in four areas, an open change order, the budgets with the PE's estimate, and one PE
// call), served by the real service with its page policy, in the system Chrome at 1280 and 375 wide. For each width, on
// a fresh copy of the state, it:
// - opens Home and checks: the page policy, the floor's parts, no horizontal scroll, no console error, no page error;
// - opens "See the reasons" and Reverse on the PE's call, gives a reason, and checks that the decision comes back to
//   Needs you and the record says so.
// It writes screenshots to evidence/ (or $FLOOR_PASS_OUT) and exits 1 when a check fails.
//
// Sample data: the project, its tasks, runs and the PE's call are a fixture built through the real commands. The
// runtime is the fake one, and no scheduler tick runs, so nothing moves while the pass looks.
//
// Run: ORCHESTRATION_TEST_PORT=5980 node --import tsx scripts/floor-browser-pass.mjs

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "vite";
import { createHttpServer } from "../server/http.ts";
import { FakeAdapter, defaultFakeConfig } from "../server/runtimes/fake.ts";
import { Scheduler } from "../server/scheduler.ts";
import { Store } from "../server/store.ts";
import { launchChrome } from "../server/studio/shots.ts";
import { close } from "../server/studio/testFixtures.ts";
import { floorScene } from "../src/ui/floor/floorScene.ts";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(process.env.FLOOR_PASS_OUT ?? join(ROOT, "evidence"));
const APP_PORT = Number(process.env.ORCHESTRATION_TEST_PORT ?? 5980);
const WIDTHS = [1280, 375];
const log = (m) => console.log(m);

const chrome = await launchChrome();
if (!("browser" in chrome)) {
  console.error(`No browser: ${chrome.missing}. Install Google Chrome or set CHROME_PATH.`);
  process.exit(2);
}
const browser = chrome.browser;
const root = mkdtempSync(join(tmpdir(), "orc-floor-pass-"));
const failures = [];
const fail = (m) => {
  failures.push(m);
  log(`  ✗ ${m}`);
};
const ok = (m) => log(`  ✓ ${m}`);

const dist = join(root, "dist");
process.env.NODE_ENV = "production";
await build({ root: ROOT, configFile: join(ROOT, "vite.config.ts"), mode: "production", logLevel: "silent", build: { outDir: dist, emptyOutDir: true } });
mkdirSync(OUT, { recursive: true });
const shots = [];
const origin = `http://127.0.0.1:${APP_PORT}`;

for (const width of WIDTHS) {
  log(`\nAt ${width} wide:`);
  const sc = floorScene();
  const dataDir = join(root, `data-${width}`);
  const store = new Store(join(dataDir, "test.db"), () => structuredClone(sc.s));
  const config = defaultFakeConfig();
  const scheduler = new Scheduler(store, { claude: new FakeAdapter("claude", config), codex: new FakeAdapter("codex", config) });
  const app = createHttpServer({ store, scheduler, startedAt: new Date().toISOString(), staticDir: dist, dataDir, allowedHosts: [`127.0.0.1:${APP_PORT}`] });
  await new Promise((r) => app.listen(APP_PORT, "127.0.0.1", r));

  const ctx = await browser.newContext({ viewport: { width, height: width < 600 ? 812 : 900 }, deviceScaleFactor: 1 });
  // The demo's first-run tour is not part of this pass.
  await ctx.addInitScript(() => localStorage.setItem("orc.tour.v1", "done"));
  const p = await ctx.newPage();
  const errors = [];
  p.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  p.on("pageerror", (e) => errors.push(`page error: ${e.message}`));
  ctx.on("requestfailed", (r) => errors.push(`request failed: ${r.url()} (${r.failure()?.errorText})`));
  const shot = async (name, full = true) => {
    const file = join(OUT, `floor-${width}-${name}.png`);
    await p.screenshot({ path: file, fullPage: full });
    shots.push(file);
  };
  const noScroll = async (view) => {
    const m = await p.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    if (m.scroll > m.client) fail(`${view}: horizontal scroll (${m.scroll} > ${m.client})`);
    else ok(`${view}: no horizontal scroll (${m.scroll}px in ${m.client}px)`);
  };

  // Home: the factory floor.
  const response = await p.goto(`${origin}/#/overview`);
  if (!response?.headers()["content-security-policy"]?.includes("default-src 'self'")) fail("Home: the page policy is missing");
  else ok("Home: the page policy is set");
  await p.getByRole("heading", { name: "The factory", exact: true }).waitFor({ timeout: 10_000 });
  await p.waitForTimeout(400);
  // ORC-030 pass C2: one Budgets card (two lines, each a figure and a bar), the focus in Latest from the lead (no
  // Focus card), and on a phone one row per area.
  for (const name of ["Needs you", "Budgets", "Decided by the PE", "Latest from the lead"]) {
    // A card's count is part of its heading's name: "Needs you 3".
    if (!(await p.getByRole("heading", { name: new RegExp(`^${name}( \\d+)?$`) }).count())) fail(`Home: no "${name}"`);
  }
  for (const gone of ["Building budget", "Maintenance budget, estimated", "Focus"]) {
    if (await p.getByRole("heading", { name: gone, exact: true }).count()) fail(`Home: "${gone}" is still a card of its own`);
  }
  for (const words of ["Building · $8.10 of $40 · about $9–$16 more (the PE)", "Maintenance · about $35 a month of $50", "Change order 2 · from Lock in 2"]) {
    if (!(await p.getByText(words).count())) fail(`Home: no "${words}"`);
  }
  const bars = await p.getByRole("region", { name: "Budgets" }).locator(".k-meter").count();
  if (bars !== 2) fail(`Home: ${bars} budget bars, not 2`);
  const lines = await p.locator(".ff-line").count();
  if (lines !== 5) fail(`Home: ${lines} lines, not 5`);
  else ok("Home: the floor shows Needs you, the Budgets card with two bars, 5 lines, the change order and the PE's call");
  // On a phone each line is one row that opens its area's tasks; on a desktop each line shows its tasks.
  const rows = await p.locator(".ff-line__row:visible").count();
  const belts = await p.locator(".ff-belt:visible").count();
  if (width < 600 ? rows !== 5 || belts !== 0 : rows !== 0 || belts !== 5) fail(`Home at ${width}: ${rows} area rows and ${belts} belts`);
  else ok(width < 600 ? "Home on a phone: one row per area, no belts" : "Home on a desktop: each area's tasks on its line");
  const co = await p.getByRole("link", { name: "Open the change order" }).getAttribute("href");
  if (co !== "#/tasks/change-order/2") fail(`the change order links to ${co}`);
  else ok("the change order links to #/tasks/change-order/2");
  await noScroll("the factory floor");
  await shot("floor");

  // The PE's call: its reasons, then Reverse with a reason.
  await p.getByText("See the reasons").click();
  await p.getByText("The PE: “The link is private to the group").waitFor({ timeout: 5_000 });
  await p.getByRole("button", { name: "Reverse", exact: true }).click();
  const reason = p.getByLabel("Why do you reverse it? (kept in the decision record)");
  await reason.fill("Expiry matters for a group chat.");
  await p.waitForTimeout(200);
  await noScroll("Reverse, open");
  await p.locator(".ff-reasons").scrollIntoViewIfNeeded();
  await shot("reverse", false);
  await p.getByRole("button", { name: "Reverse the call" }).click();
  await p.getByText("Decide a finding:").waitFor({ timeout: 10_000 });
  const d = store.read().state.decisions.find((x) => x.id === sc.decisionId);
  if (d?.status !== "open" || d.routedTo !== "user" || d.why !== "Expiry matters for a group chat.") fail(`Reverse: the record is ${JSON.stringify({ status: d?.status, routedTo: d?.routedTo, why: d?.why })}`);
  else ok("Reverse: the decision is open again, with you, and your reason is recorded");
  if (await p.getByRole("heading", { name: /^Decided by the PE/ }).count()) fail("Reverse: the call is still listed as the PE's");
  await p.waitForTimeout(300);
  await noScroll("after Reverse");
  await shot("reversed", false);

  for (const e of errors) fail(`${width}: ${e}`);
  if (!errors.length) ok("no console error, no page error, no failed request");
  await ctx.close();
  await close(app);
  store.close();
}

await browser.close();
rmSync(root, { recursive: true, force: true });
log(`\nScreenshots (${shots.length}):\n${shots.map((s) => `  ${s}`).join("\n")}`);
if (failures.length) {
  console.error(`\n${failures.length} check${failures.length === 1 ? "" : "s"} failed.`);
  process.exit(1);
}
log("\nAll checks passed.");
