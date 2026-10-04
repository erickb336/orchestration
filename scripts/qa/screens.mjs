// The screen inventory for the UI audit (ORC-030, step 3): every route of the app, at 1280 and 375 wide, with a
// full-page screenshot of each and a list of what each shows.
//
// The routes come from src/ui/route.ts (the router), src/ui/App.tsx (the main navigation: Home, Vision, Tasks,
// Results, Settings), src/ui/settings/sections.ts (the five Settings sections) and #/kit (the component kit, not in
// the navigation). The lead drawer and the two header menus are not routes; they are captured as overlays on Home.
//
// The state is the sample project, Weekend Trips (src/domain/demo.ts), in the factory: its Vision has three rounds,
// its start is recorded, and it has one change order, answered (ORC-030 C5); its studio files are on disk, as the fake
// service writes them. Two states the sample does not show are captured a second time on a fixture scene built through
// the real commands: the pre-flight before the start (src/ui/preflight/preflightScene.ts: in Vision, with a draft) and
// an open change order (src/ui/floor/floorScene.ts). Every row says which state it shows. The scenes write no studio
// files, so their prototype frames show "Not found"; those errors (the 404s, and the page error Chrome logs for a
// sandboxed frame's error page) are listed in index.json, not failed.
// The scheduler dispatches once and then its simulated clock stays paused: nothing moves while the screens are taken.
//
// Output: evidence/qa/screens/<route>-<width>.png and evidence/qa/screens/index.json (route, state, title, headings,
// main controls, horizontal scroll, errors). Exits 1 when a page scrolls sideways or logs an error, when the header
// shows a pill or is not one row on a desktop and two on a phone, or when the phone's lead drawer (on a touch screen)
// shows a keyboard hint (ORC-030 pass C2).
//
// Run: ORCHESTRATION_TEST_PORT=5950 node --import tsx scripts/qa/screens.mjs

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildDemo } from "../../src/domain/demo.ts";
import { floorScene } from "../../src/ui/floor/floorScene.ts";
import { preflightScene } from "../../src/ui/preflight/preflightScene.ts";
import { EVIDENCE, WIDTHS, buildApp, chrome, horizontalScroll, openPage, removeApp, startService, widest } from "./harness.mjs";

const OUT = join(EVIDENCE, "screens");
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const SAMPLE_TASKS = ["WT-002", "WT-004", "WT-004.3", "WT-005", "WT-007", "WT-011", "WT-012", "WT-013", "WT-014", "WT-015", "T-019"];
const SAMPLE = [
  "#/overview",
  "#/overview?history=1",
  "#/vision",
  "#/vision/lock-in",
  "#/vision/pre-flight",
  "#/tasks",
  "#/activity",
  "#/results",
  "#/results/design",
  "#/settings/working-style",
  "#/settings/project",
  "#/settings/agents",
  "#/settings/quality",
  "#/settings/advanced",
  "#/kit",
  "#/tasks/change-order/2",
  ...SAMPLE_TASKS.map((id) => `#/task/${id}`),
  "#/task/WT-999",
  // The overlays on Home.
  "overlay:lead-drawer",
  "overlay:project-menu",
  "overlay:simulation-menu",
  "board-view:#/tasks",
];
const SCENES = [
  { name: "preflight-scene", state: () => preflightScene().s, routes: ["#/overview", "#/vision", "#/vision/lock-in", "#/vision/pre-flight", "#/tasks"] },
  { name: "floor-scene", state: () => floorScene().s, routes: ["#/overview", "#/tasks/change-order/2", "#/vision"] },
];

const slug = (route) =>
  route
    .replace(/^#\//, "")
    .replace(/[^a-zA-Z0-9.]+/g, "-")
    .replace(/^-|-$/g, "") || "root";

/** What the page shows: its main heading, its headings and its controls (by role and name). */
const inventory = (page) =>
  page.evaluate(() => {
    const name = (e) => (e.getAttribute("aria-label") || e.innerText || e.value || e.getAttribute("placeholder") || e.getAttribute("title") || "").replace(/\s+/g, " ").trim().slice(0, 80);
    const scope = document.querySelector("aside.lead-drawer") ?? document.querySelector("main") ?? document.body;
    const h1 = scope.querySelector("h1")?.innerText.trim() ?? document.querySelector("main h1")?.innerText.trim() ?? "";
    const headings = [...scope.querySelectorAll("h1, h2, h3")].filter((h) => h.getClientRects().length).map((h) => h.innerText.replace(/\s+/g, " ").trim()).filter(Boolean);
    const seen = new Set();
    const controls = [];
    for (const e of scope.querySelectorAll("button, a[href], input, select, textarea, summary, [role=radio], [role=checkbox], [role=tab]")) {
      if (!e.getClientRects().length) continue;
      const role = e.getAttribute("role") ?? (e.tagName === "A" ? "link" : e.tagName === "INPUT" ? `input:${e.type}` : e.tagName.toLowerCase());
      const label = name(e);
      const key = `${role}:${label}`;
      if (!label || seen.has(key)) continue;
      seen.add(key);
      controls.push(`${role}: ${label}`);
    }
    return { title: h1, headings: headings.slice(0, 30), controls: controls.slice(0, 60), controlCount: controls.length };
  });

const dist = await buildApp();
const browser = await chrome();
const index = [];
let failures = 0;

async function capture(service, state, route, width, strictErrors) {
  // The lead drawer on a phone is opened on a touch screen, where no keyboard hint shows (ORC-030 a-words-phone-hint).
  const touch = route === "overlay:lead-drawer" && width < 600;
  const page = await openPage(browser, width, { touch });
  const file = join(OUT, `${state === "sample" ? "" : `${state}--`}${slug(route.replace(/^(overlay|board-view):/, "$1-"))}-${width}.png`);
  const row = { route, state, width, file };
  try {
    const hash = route.startsWith("overlay:") ? "#/overview" : route.replace(/^board-view:/, "");
    await page.goto(`${service.origin}/${hash}`);
    await page.getByRole("navigation", { name: "Main" }).waitFor({ timeout: 10_000 });
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(700);
    if (route === "overlay:lead-drawer") {
      await page.getByRole("button", { name: /^Message the lead/ }).first().click();
      await page.locator("aside.lead-drawer").waitFor({ timeout: 5_000 });
    } else if (route === "overlay:project-menu") {
      await page.locator(".project-menu summary").click();
    } else if (route === "overlay:simulation-menu") {
      await page.locator(".sim-menu summary").click();
    } else if (route.startsWith("board-view:")) {
      await page.getByRole("radio", { name: "Board", exact: true }).click();
    }
    await page.waitForTimeout(400);
    Object.assign(row, await inventory(page));
    // ORC-030 C2: the header has no row of pills and is one row on a desktop, two on a phone; a touch screen shows no
    // keyboard hint.
    row.header = await page.evaluate(() => {
      const h = document.querySelector("header.top");
      // A row is a run of parts whose boxes overlap vertically; the next row starts below the last one's bottom.
      const boxes = [...h.querySelectorAll(".brand, nav.tabs, .right")].map((e) => e.getBoundingClientRect()).sort((a, b) => a.top - b.top);
      let rows = 0;
      let bottom = -Infinity;
      for (const b of boxes) {
        if (b.top >= bottom - 1) rows++;
        bottom = Math.max(bottom, b.bottom);
      }
      return { pills: h.querySelectorAll(".k-pill, nav.places").length, rows, height: Math.round(h.getBoundingClientRect().height) };
    });
    if (row.header.pills || row.header.rows !== (width < 600 ? 2 : 1)) row.error = `the header: ${JSON.stringify(row.header)}`;
    if (touch) {
      row.keysHint = await page.evaluate(() => [...document.querySelectorAll(".keys-hint")].some((e) => e.getClientRects().length > 0));
      if (row.keysHint) row.error = "a keyboard hint shows on a touch screen";
    }
    const m = await horizontalScroll(page);
    row.horizontalScroll = m.scroll > m.client ? { scroll: m.scroll, client: m.client, wider: await widest(page) } : false;
    await page.screenshot({ path: file, fullPage: !route.startsWith("overlay:") });
  } catch (e) {
    row.error = e instanceof Error ? e.message.split("\n")[0] : String(e);
    await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  }
  // A scene has no studio files: its 404s on studio files and prototypes (and the console lines they cause) are listed, not failed.
  const fixtureOnly = (u) => /\/api\/studio\/file|\.localhost:\d+/.test(u);
  row.errors = page.qaErrors.splice(0);
  row.notFound = page.qaNotFound.splice(0);
  const onlyFixture = row.notFound.length > 0 && row.notFound.every(fixtureOnly);
  const counted = strictErrors || !onlyFixture ? row.errors : row.errors.filter((x) => !/404 \(Not Found\)|document is sandboxed/.test(x));
  const bad = row.error || row.horizontalScroll || counted.length;
  if (bad) failures++;
  console.log(`  ${bad ? "✗" : "✓"} ${state} ${route} at ${width}: ${row.title || "(no h1)"}${row.horizontalScroll ? ` · sideways scroll ${row.horizontalScroll.scroll}px` : ""}${counted.length ? ` · ${counted.length} error(s): ${counted[0]}` : ""}${row.error ? ` · ${row.error}` : ""}`);
  await page.qaContext.close();
  index.push(row);
}

for (const width of WIDTHS) {
  console.log(`\nThe sample project at ${width} wide:`);
  const service = await startService(() => buildDemo(Date.now()), { dist, freeze: true });
  for (const route of SAMPLE) await capture(service, "sample", route, width, true);
  await service.stop();
  for (const scene of SCENES) {
    console.log(`\nThe ${scene.name} at ${width} wide:`);
    const s = await startService(scene.state, { dist, freeze: true });
    for (const route of scene.routes) await capture(s, scene.name, route, width, false);
    await s.stop();
  }
}
await browser.close();
removeApp();
writeFileSync(
  join(OUT, "index.json"),
  JSON.stringify({ at: new Date().toISOString(), note: "Sample data: the sample project and two fixture scenes; no agent ran.", screens: index.map((r) => ({ ...r, file: r.file.replace(`${OUT}/`, "") })) }, null, 2),
);
console.log(`\n${index.length} screens in ${OUT}; ${failures} with a sideways scroll, an error or a capture that failed.`);
if (failures) process.exitCode = 1;
