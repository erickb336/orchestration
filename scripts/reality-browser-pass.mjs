// The browser pass of "Design and reality" (ORC-029 pass 5, unit 5e-1): the seeded Weekend Trips state with evidence
// (src/domain/testing/realityScene.ts), served by the real service with its page policy, in the system Chrome at 1280
// and 375 wide. For each width it opens #/results/design, then the detail of each part, and checks:
// - no horizontal scroll;
// - no console error and no page error (a request the policy blocks is a console error);
// - every image of the evidence and of the design loads.
// It writes one screenshot per view to evidence/ (or $REALITY_PASS_OUT) and exits 1 when a check fails.
//
// Sample data: the screenshots and the recording are rendered from sample pages by this script, not captured from a
// built product. The capture itself (server/studio/evidence.ts) is not exercised here.
//
// Run: ORCHESTRATION_TEST_PORT=5880 node --import tsx scripts/reality-browser-pass.mjs

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { build } from "vite";
import { recordArtifactMedia, startArtifactMedia } from "../src/domain/studio/studio.ts";
import { realityScene } from "../src/domain/testing/realityScene.ts";
import { createHttpServer } from "../server/http.ts";
import { FakeAdapter, defaultFakeConfig } from "../server/runtimes/fake.ts";
import { Scheduler } from "../server/scheduler.ts";
import { Store } from "../server/store.ts";
import { evidenceDir } from "../server/studio/evidence.ts";
import { createPrototypeServer, projectStudioDir } from "../server/studio/serve.ts";
import { launchChrome } from "../server/studio/shots.ts";
import { close, writeVersion } from "../server/studio/testFixtures.ts";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(process.env.REALITY_PASS_OUT ?? join(ROOT, "evidence"));
const APP_PORT = Number(process.env.ORCHESTRATION_TEST_PORT ?? 5880);
const PROTO_PORT = Number(process.env.ORCHESTRATION_PROTOTYPE_PORT ?? APP_PORT + 1);
const WIDTHS = [1280, 375];
const log = (m) => console.log(m);

const chrome = await launchChrome();
if (!("browser" in chrome)) {
  console.error(`No browser: ${chrome.missing}. Install Google Chrome or set CHROME_PATH.`);
  process.exit(2);
}
const browser = chrome.browser;
const root = mkdtempSync(join(tmpdir(), "orc-reality-pass-"));
const failures = [];
const fail = (m) => {
  failures.push(m);
  log(`  ✗ ${m}`);
};

// ---------- sample pages and the images rendered from them ----------

const page = (title, body, extra = "") => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>
body{margin:0;font:15px/1.4 system-ui,sans-serif;background:#f6f3ec;color:#23211c}
main{max-width:860px;margin:0 auto;padding:20px;display:grid;gap:12px}
h1{font-size:22px;margin:0}
.day{display:flex;justify-content:space-between;padding:12px 14px;border:1px solid #d9d3c5;border-radius:10px;background:#fff}
.tl{color:#5d6a61}
.map{height:180px;border-radius:12px;background:linear-gradient(135deg,#cfe3ef,#e9e0cc);position:relative}
.map::after{content:"map";position:absolute;right:10px;bottom:8px;color:#5d6a61}
.who{display:flex;gap:6px}.who span{padding:3px 9px;border-radius:99px;background:#e6efe6}
${extra}</style></head><body><main>${body}</main></body></html>`;
const days = `<div class="day"><span>Fri · Drive, check in</span><span class="tl">3 stops</span></div><div class="day"><span>Sat · Cliff walk, market</span><span class="tl">4 stops</span></div><div class="day"><span>Sun · Brunch, home</span><span class="tl">2 stops</span></div>`;
const PAGES = {
  planV1: page("Trip plan", `<h1>Coast weekend</h1><div class="map"></div>${days}`),
  planV2: page("Trip plan", `<h1>Coast weekend</h1>${days}<div class="map"></div>`),
  // As built: the map still comes first (the UX review's difference).
  planBuilt: page("Trip plan", `<h1>Coast weekend</h1><div class="map"></div>${days}`),
  packing: page("Packing list", `<h1>Packing list · shared</h1><div class="day"><span>Tent</span><span class="tl">Ana</span></div><div class="day"><span>Stove</span><span class="tl">Kai</span></div><div class="day"><span>First aid</span><span class="tl">nobody yet</span></div>`),
  summary: page("Trip summary", `<h1>Coast weekend</h1><div class="day"><span>3 days · 9 stops</span><span class="tl">4 friends</span></div><div class="who"><span>Ana</span><span>Kai</span><span>Lu</span><span>Mo</span></div>`),
  generic: (title) => page(title, `<h1>${title}</h1><p>A sample page.</p>`),
};
const terminal = (lines) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:#15171a;color:#d8dccf;font:15px/1.5 ui-monospace,Menlo,monospace}pre{margin:0;padding:16px}.g{color:#8fc98f}.y{color:#e3c46b}.d{color:#7a8178}</style></head><body><pre>${lines.join("\n")}</pre></body></html>`;
const CLI_DESIGN = ["<span class=g>$</span> trips plan coast", "Fri  Drive, check in", "Sat  Cliff walk, market", "Sun  Brunch, home", "<span class=y>Cost each: $142</span>"];
const CLI_BUILT = ["<span class=g>$</span> trips plan coast", "Fri  Drive, check in", "Sat  Cliff walk, market", "Sun  Brunch, home", "<span class=y>Cost each: $142</span>"];
const plainText = (lines) => `${lines.map((l) => l.replace(/<[^>]+>/g, "")).join("\n")}\n`;

const DEVICE = { desktop: { width: 1280, height: 800, deviceScaleFactor: 1, isMobile: false }, mobile: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true } };

/** A page rendered by Chrome at a device's size, as a PNG. */
async function shot(html, device) {
  const d = DEVICE[device];
  const ctx = await browser.newContext({ viewport: { width: d.width, height: d.height }, deviceScaleFactor: d.deviceScaleFactor, isMobile: d.isMobile });
  const p = await ctx.newPage();
  await p.setContent(html);
  const png = await p.screenshot();
  await ctx.close();
  return png;
}

/** A terminal screen rendered by Chrome, made a GIF by ffmpeg. */
async function gif(lines) {
  const ctx = await browser.newContext({ viewport: { width: 640, height: 200 } });
  const p = await ctx.newPage();
  await p.setContent(terminal(lines));
  const png = join(root, `t-${Math.random().toString(16).slice(2)}.png`);
  writeFileSync(png, await p.screenshot());
  await ctx.close();
  const out = `${png}.gif`;
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", png, out]);
  return (await import("node:fs")).readFileSync(out);
}

// ---------- the seeded state, its studio files and its evidence files ----------

const sc = realityScene();
let state = sc.s;
const at = sc.at(730);
const art = (id, version) => state.studio.artifacts.find((a) => a.id === id && a.version === version);

// The studio's own screenshots of the screens and the recording of the demo, as the service records them after import.
for (const a of state.studio.artifacts.filter((x) => x.kind === "screen")) {
  state = startArtifactMedia(state, a.id, a.version);
  const shots = a.variants.flatMap((v) => a.devices.map((device) => ({ variant: v.id, device, path: `shots/${v.id}-${device}.png` })));
  state = recordArtifactMedia(state, a.id, a.version, { shots: { status: "taken", at, shots, failed: [] } }, at);
}
const cliArt = art(sc.artifacts.cli, 1);
state = startArtifactMedia(state, cliArt.id, 1);
state = recordArtifactMedia(state, cliArt.id, 1, { demo: { status: "done", at, variants: [{ variant: "A", status: "recorded", tape: "trips-cli/demo.tape", gif: "recording/A/demo.gif", txt: "recording/A/demo.txt" }] } }, at);

const dataDir = join(root, "data");
const studioDir = projectStudioDir(dataDir, state.project.id);
const designOf = (a) => (a.id === sc.artifacts.plan ? (a.version === 1 ? PAGES.planV1 : PAGES.planV2) : a.id === sc.artifacts.packing ? PAGES.packing : a.title === "Trip summary" ? PAGES.summary : PAGES.generic(a.title));
for (const a of state.studio.artifacts) {
  const files = {};
  for (const f of a.files) {
    const ext = f.path.split(".").pop();
    files[f.path] = ext === "html" ? designOf(a) : ext === "json" ? JSON.stringify(a.dictionary ?? a.rules?.[0] ?? {}, null, 2) : ext === "md" ? `# ${a.title}\n\nA sample document of the design.\n` : ext === "ans" ? plainText(CLI_DESIGN) : `# ${a.title}\n`;
  }
  if (a.shots?.status === "taken") for (const s of a.shots.shots) files[s.path] = await shot(designOf(a), s.device);
  if (a.demo?.status === "done") {
    files["recording/A/demo.gif"] = await gif(CLI_DESIGN);
    files["recording/A/demo.txt"] = plainText(CLI_DESIGN);
  }
  writeVersion(studioDir, a.id, a.version, files, { kind: a.kind, title: a.title, devices: a.devices.length ? a.devices : ["desktop"], variants: a.variants });
}

// What the factory captured, where the service keeps it: <dataDir>/evidence/<project>/<run>/<item>/<file>.
const builtPage = { [sc.items.plan]: PAGES.planBuilt, [sc.items.packing]: PAGES.packing };
for (const a of state.artifacts.filter((x) => x.kind === "evidence")) {
  const dir = evidenceDir(dataDir, state.project.id, a.attemptId);
  for (const item of a.evidence.items) {
    if (item.status !== "captured") continue;
    for (const f of item.files) {
      const target = join(dir, f.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, f.type === "png" ? await shot(builtPage[item.itemId] ?? PAGES.generic(item.title), f.device) : f.type === "gif" ? await gif(CLI_BUILT) : plainText(CLI_BUILT));
    }
  }
}

// ---------- the real service ----------

const dist = join(root, "dist");
process.env.NODE_ENV = "production";
await build({ root: ROOT, configFile: join(ROOT, "vite.config.ts"), mode: "production", logLevel: "silent", build: { outDir: dist, emptyOutDir: true } });
const store = new Store(join(dataDir, "test.db"), () => state);
const config = defaultFakeConfig();
const scheduler = new Scheduler(store, { claude: new FakeAdapter("claude", config), codex: new FakeAdapter("codex", config) });
const origin = `http://127.0.0.1:${APP_PORT}`;
const prototypes = createPrototypeServer({ studioDir: () => studioDir, appOrigins: [origin] });
await new Promise((r) => prototypes.listen(PROTO_PORT, "127.0.0.1", r));
const app = createHttpServer({ store, scheduler, startedAt: new Date().toISOString(), staticDir: dist, dataDir, prototypePort: PROTO_PORT, prototypeServer: prototypes, allowedHosts: [`127.0.0.1:${APP_PORT}`] });
await new Promise((r) => app.listen(APP_PORT, "127.0.0.1", r));
log(`Serving the seeded state at ${origin}/#/results/design (prototypes on ${PROTO_PORT}).`);

// ---------- the pass ----------

const PARTS = ["Trip plan", "Packing list", "trips CLI", "Trip summary", "Join flow", "Trip data"];
const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-");
mkdirSync(OUT, { recursive: true });
const shots = [];

for (const width of WIDTHS) {
  log(`\nAt ${width} wide:`);
  const ctx = await browser.newContext({ viewport: { width, height: width < 600 ? 812 : 900 }, deviceScaleFactor: 1 });
  // The demo's first-run tour (on Home) is not part of this pass.
  await ctx.addInitScript(() => {
    try {
      if (window === window.top) localStorage.setItem("orc.tour.v1", "done");
    } catch {
      // A sandboxed frame has no storage.
    }
  });
  const p = await ctx.newPage();
  const errors = [];
  p.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  p.on("pageerror", (e) => errors.push(`page error: ${e.message}`));
  ctx.on("requestfailed", (r) => errors.push(`request failed: ${r.url()} (${r.failure()?.errorText})`));
  // ORC-030 a-results-order: the header's Results opens Design and reality, the first tab once anything is locked in.
  await p.goto(`${origin}/#/overview`);
  await p.getByRole("navigation", { name: "Main" }).getByRole("link", { name: /^Results/ }).click();
  await p.waitForSelector(".st-reality__list");
  const tabs = await p.getByRole("tab").allInnerTexts();
  if (tabs[0] !== "Design and reality" || !p.url().endsWith("#/results/design")) fail(`${width}: Results opens ${p.url().split("#")[1]} with the tabs ${JSON.stringify(tabs)}`);
  else log(`  Results opens Design and reality, its first tab (${tabs.join(", ")})`);

  const settle = async () => {
    // Every image in the page has loaded (or failed), and the design frames have loaded.
    await p.waitForFunction(() => [...document.images].every((i) => i.complete), null, { timeout: 15_000 });
    await p.waitForTimeout(600);
  };
  const check = async (view) => {
    const m = await p.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
      broken: [...document.images].filter((i) => !i.naturalWidth).map((i) => i.getAttribute("src")),
      images: [...document.images].filter((i) => i.naturalWidth).length,
    }));
    if (m.scroll > m.client) fail(`${width} ${view}: horizontal scroll (${m.scroll} > ${m.client})`);
    for (const b of m.broken) fail(`${width} ${view}: an image did not load: ${b}`);
    return m;
  };

  await settle();
  const listShot = join(OUT, `reality-${width}-list.png`);
  await p.screenshot({ path: listShot, fullPage: true });
  const lm = await check("list");
  shots.push(listShot);
  log(`  list: ${lm.images} images loaded, page ${lm.scroll}px wide in ${lm.client}px`);

  for (const part of PARTS) {
    await p.getByRole("button", { name: new RegExp(`^${part} v\\d`) }).click();
    await p.waitForFunction((t) => document.querySelector(".st-reality__card .k-card__title")?.textContent?.startsWith(t), part, { timeout: 10_000 });
    await settle();
    const m = await check(part);
    const file = join(OUT, `reality-${width}-${slug(part)}.png`);
    if (width < 600) {
      await p.locator(".st-reality__detail").screenshot({ path: file });
    } else {
      await p.screenshot({ path: file, fullPage: true });
    }
    shots.push(file);
    log(`  ${part}: ${m.images} images loaded`);
  }
  for (const e of errors) fail(`${width}: ${e}`);
  if (!errors.length) log("  no console error, no page error, no failed request");
  await ctx.close();
}

await close(app);
await close(prototypes);
store.close();
await browser.close();
rmSync(root, { recursive: true, force: true });
log(`\nScreenshots (${shots.length}):\n${shots.map((s) => `  ${s}`).join("\n")}`);
if (failures.length) {
  console.error(`\n${failures.length} check${failures.length === 1 ? "" : "s"} failed.`);
  process.exit(1);
}
log("\nAll checks passed.");
