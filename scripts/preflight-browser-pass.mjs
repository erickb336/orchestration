// The browser pass of the pre-flight (ORC-029 pass 6, unit 6a): the seeded Weekend Trips project in Vision
// (src/ui/preflight/preflightScene.ts), served by the real service with its page policy, in the system Chrome at 1280
// and 375 wide. For each width, on a fresh copy of the state, it:
// - opens Home and checks "Start the factory…" leads to #/vision/pre-flight;
// - opens the pre-flight and checks: no horizontal scroll, no console error, no page error;
// - at 1280, approves Trip map in another "tab" (a command to the service) and checks the stale banner;
// - chooses Check-in, ticks the agreement, presses Start the factory, and checks the confirmation and the record.
// It writes screenshots to evidence/ (or $PREFLIGHT_PASS_OUT) and exits 1 when a check fails.
//
// Sample data: the project, its studio and the lead's reply are a fixture built through the real commands. The runtime
// is the fake one, and no scheduler tick runs, so nothing is built after the start.
//
// Run: ORCHESTRATION_TEST_PORT=5920 node --import tsx scripts/preflight-browser-pass.mjs

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
import { preflightScene } from "../src/ui/preflight/preflightScene.ts";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(process.env.PREFLIGHT_PASS_OUT ?? join(ROOT, "evidence"));
const APP_PORT = Number(process.env.ORCHESTRATION_TEST_PORT ?? 5920);
const WIDTHS = [1280, 375];
const log = (m) => console.log(m);

const chrome = await launchChrome();
if (!("browser" in chrome)) {
  console.error(`No browser: ${chrome.missing}. Install Google Chrome or set CHROME_PATH.`);
  process.exit(2);
}
const browser = chrome.browser;
const root = mkdtempSync(join(tmpdir(), "orc-preflight-pass-"));
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
  // A fresh service on a fresh copy of the scene for each width: the pass starts the factory.
  const sc = preflightScene();
  const dataDir = join(root, `data-${width}`);
  const store = new Store(join(dataDir, "test.db"), () => structuredClone(sc.s));
  const config = defaultFakeConfig();
  const scheduler = new Scheduler(store, { claude: new FakeAdapter("claude", config), codex: new FakeAdapter("codex", config) });
  const app = createHttpServer({ store, scheduler, startedAt: new Date().toISOString(), staticDir: dist, dataDir, allowedHosts: [`127.0.0.1:${APP_PORT}`] });
  await new Promise((r) => app.listen(APP_PORT, "127.0.0.1", r));

  const ctx = await browser.newContext({ viewport: { width, height: width < 600 ? 812 : 900 }, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  const errors = [];
  p.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  p.on("pageerror", (e) => errors.push(`page error: ${e.message}`));
  ctx.on("requestfailed", (r) => errors.push(`request failed: ${r.url()} (${r.failure()?.errorText})`));
  const shot = async (name, full = true) => {
    const file = join(OUT, `preflight-${width}-${name}.png`);
    await p.screenshot({ path: file, fullPage: full });
    shots.push(file);
  };
  const noScroll = async (view) => {
    const m = await p.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    if (m.scroll > m.client) fail(`${view}: horizontal scroll (${m.scroll} > ${m.client})`);
    else ok(`${view}: no horizontal scroll (${m.scroll}px in ${m.client}px)`);
  };

  // Home: the way in.
  const response = await p.goto(`${origin}/#/overview`);
  if (!response?.headers()["content-security-policy"]?.includes("default-src 'self'")) fail("Home: the page policy is missing");
  const link = p.getByRole("link", { name: "Start the factory…" }).first();
  await link.waitFor({ timeout: 10_000 });
  const href = await link.getAttribute("href");
  if (href !== "#/vision/pre-flight") fail(`Home: Start the factory… links to ${href}`);
  else ok("Home: Start the factory… links to #/vision/pre-flight");
  await link.click();

  // The pre-flight.
  await p.getByRole("heading", { name: "Start the factory?" }).waitFor({ timeout: 10_000 });
  await p.waitForTimeout(400);
  await noScroll("the pre-flight");
  await shot("screen");
  const start = p.getByRole("button", { name: "Start the factory" });
  if ((await start.getAttribute("aria-disabled")) !== "true") fail("Start the factory does not wait for the agreement");
  else ok("Start the factory waits for the agreement");

  if (width === 1280) {
    // The draft moves while the owner reads (another tab approves Trip map): the screen says so and clears the agreement.
    await p.getByRole("checkbox", { name: /I have reviewed the blueprint/ }).check();
    const map = sc.s.studio.artifacts.find((a) => a.title === "Trip map").id;
    const now = new Date().toISOString();
    store.command("sendFeedback", { entries: [{ artifactId: map, version: 1, mark: null, pins: [], note: "", rows: [] }] }, "pass-mark", now);
    store.command("approveArtifact", { artifactId: map, version: 1 }, "pass-approve", now);
    const banner = p.getByText("The draft, the vision, the summary or what is open changed while you read.");
    await banner.waitFor({ timeout: 10_000 });
    if (await p.getByRole("checkbox", { name: /I have reviewed the blueprint/ }).isChecked()) fail("stale: the agreement was not cleared");
    else ok("stale: the banner shows, and the agreement is cleared");
    await banner.scrollIntoViewIfNeeded();
    await shot("stale", false);
  }

  // Choose Check-in, agree, and start.
  await p.getByRole("radio", { name: "Check-in" }).click();
  const wait = p.getByRole("checkbox", { name: /Before each task starts/ });
  if (!(await wait.isChecked())) fail("Check-in: Before each task starts is not ticked");
  else ok("Check-in ticks Before each task starts");
  await p.getByRole("checkbox", { name: /I have reviewed the blueprint/ }).check();
  await shot("agreed");
  await start.click();
  await p.getByRole("heading", { name: "The factory started." }).waitFor({ timeout: 10_000 });
  await p.waitForTimeout(400);
  await noScroll("after the start");
  await shot("started");
  const recorded = store.read().state.project.factoryStarts.at(-1);
  if (!recorded || recorded.settings.autonomy !== "checkin" || !recorded.settings.pausePoints.startEachTask) fail(`the record: ${JSON.stringify(recorded?.settings)}`);
  else ok(`the start is recorded: Check-in, blueprint r${recorded.blueprintRev}, ${recorded.openItems.length} open items confirmed`);
  const floor = await p.getByRole("link", { name: "Go to the factory floor" }).getAttribute("href");
  if (floor !== "#/overview") fail(`Go to the factory floor links to ${floor}`);

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
