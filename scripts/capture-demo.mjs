#!/usr/bin/env node
// Regenerate the README media from the demo.
//
//   node scripts/capture-demo.mjs [--out docs] [--only home,results] [--no-tour]
//
// It starts the service on the fake runtime in a throwaway data directory (a temporary HOME, so the real
// ~/.orchestration is never touched), drives the installed Google Chrome through playwright-core, and writes
//   <out>/screenshots/<name>.png   every image README.md references (the list is read from its image links),
//   <out>/media/hero.png           scripts/media/hero.html around the Home screenshot,
//   <out>/media/tour.gif           the demo's own first-run tour, recorded stop by stop (Chrome's screencast
//                                  frames, then ffmpeg palettegen/paletteuse).
// Everything is captured in the app's one dark theme. Stills have no tour popover and no cursor. It needs Google
// Chrome (or CHROME_PATH pointing at a Chrome/Chromium binary) and ffmpeg; it never downloads a browser. The
// simulation clock is paused and stepped for the stills, so each shows a known state, and runs during the tour.
// On every exit path, success, error or Ctrl-C, the service is stopped and the temporary directory removed.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const README = join(ROOT, "README.md");
const HERO_HTML = join(ROOT, "scripts", "media", "hero.html");
const VIEWPORT = { width: 1440, height: 900 };
/** A still that is clipped to its content is never taller than this (CSS px). */
const MAX_SHOT_HEIGHT = 1400;
/** Space kept under the element a still is clipped to: less than the gap to the next card, so none of it shows. */
const CLIP_MARGIN = 12;
const SHOT_WIDTH = 1600;
const HERO_MAX_BYTES = 700_000;
const TOUR_MAX_BYTES = 5_000_000;
/** How long the tour holds a stop: enough to read it, from its length. */
const READ = { base: 1300, perWord: 55, last: 1800 };

// ---------- arguments ----------

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? (args.splice(i, 1), true) : false;
}
function option(name, fallback) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const v = args[i + 1];
  if (v === undefined) fail(`${name} needs a value`);
  args.splice(i, 2);
  return v;
}
const noTour = flag("--no-tour");
const outDir = resolve(ROOT, option("--out", "docs"));
const only = option("--only", "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (args.length) fail(`Unknown argument ${args[0]}. Usage: node scripts/capture-demo.mjs [--out docs] [--only a,b] [--no-tour]`);

function fail(message) {
  console.error(`capture-demo: ${message}`);
  process.exit(1);
}
const log = (m) => console.log(`capture-demo: ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kb = (bytes) => `${(bytes / 1024).toFixed(0)} KB`;

// ---------- preflight: Chrome, ffmpeg, the built UI, playwright-core ----------

const ffmpeg = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
if (ffmpeg.error || ffmpeg.status !== 0) fail("ffmpeg is not installed or not on PATH. Install it (for example `brew install ffmpeg`) and run again.");
const sips = process.platform === "darwin" && spawnSync("sips", ["--help"], { encoding: "utf8" }).status === 0;

const chromePath = process.env.CHROME_PATH;
if (chromePath && !existsSync(chromePath)) fail(`CHROME_PATH points at ${chromePath}, which does not exist.`);

let chromium;
try {
  ({ chromium } = await import("playwright-core"));
} catch {
  fail("playwright-core is not installed. Run `npm ci` (it is a dev dependency) and run again.");
}

if (!existsSync(join(ROOT, "dist", "index.html"))) {
  log("dist/ is missing; running `npm run build` first.");
  const b = spawnSync("npm", ["run", "build"], { cwd: ROOT, stdio: "inherit" });
  if (b.status !== 0) fail("the build failed.");
}

// ---------- the README's image list ----------

const readme = readFileSync(README, "utf8");
const wanted = [...readme.matchAll(/!\[[^\]]*\]\(docs\/screenshots\/([a-z0-9-]+)\.png\)/g)].map((m) => m[1]);
if (!wanted.length) fail("README.md references no docs/screenshots/*.png image.");

// ---------- scenes ----------
// Each scene puts one page into the state its README caption describes. It may return `clipTo`, a selector: the
// still then ends just under that element (on a page taller than the window, it reaches below the fold).
// `open` reloads the page at a hash and waits for a marker, so a stale route never leaks into the next shot.

async function open(page, api, hash, ready) {
  // A goto that changes only the hash is a same-document navigation; the reload makes every shot a fresh render.
  await page.goto(`${api.base}/${hash}`, { waitUntil: "domcontentloaded" });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("header.top", { timeout: 20_000 });
  if (ready.selector) await page.waitForSelector(ready.selector, { timeout: 20_000 });
  if (ready.text) await page.waitForFunction((t) => document.body.innerText.includes(t), ready.text, { timeout: 20_000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(350);
}

/** The line about using your own repository is for someone exploring the demo; the README says it in words. */
async function hideTryLine(page) {
  const hide = page.locator(".try-shaping button", { hasText: "Hide" });
  if (await hide.count()) {
    await hide.first().click();
    await page.waitForTimeout(250);
  }
}

/** The demo's exchange with the lead: your message and the reply that changed the focus and sent the note. */
function steeringExchange(state) {
  const set = state.steering.find((s) => s.changes.some((c) => c.kind === "focus") && s.changes.some((c) => c.kind === "note"));
  const reply = set && state.conversation.find((m) => m.author === "lead" && m.leadRunId === set.leadRunId);
  const asked = set && state.conversation.find((m) => m.id === set.messageIds[0]);
  if (!reply || !asked) throw new Error("The demo's exchange with the lead (a focus change and a note) was not found in the conversation.");
  return { asked, reply };
}

const SCENES = {
  // Home at the start of the demo: three agents working, the clock paused. The hero is made from this capture.
  home: async ({ page, api }) => {
    await open(page, api, "#/overview", { selector: '[data-tour="progress"]', text: "Needs you" });
    await hideTryLine(page);
    return { clipTo: ".home .k-grid-2" };
  },
  // The board shows every column in one window (the stills' browser prefers the board view).
  tasks: async ({ page, api }) => open(page, api, "#/tasks", { selector: ".board" }),
  // A task that needs you: WT-007's finding to decide, and its steps in plain words.
  task: async ({ page, api }) => {
    await open(page, api, "#/task/WT-007", { selector: '[data-tour="steps"]', text: "Decide a finding" });
    return { clipTo: '[data-tour="steps"]' };
  },
  results: async ({ page, api }) => {
    await open(page, api, "#/results", { text: "Ready to merge" });
    return { clipTo: ".r-page" };
  },
  // The lead conversation, open on Home, with the reply's changes unfolded: the focus, the deferral and the note, delivered.
  lead: async ({ page, api }) => {
    const { asked, reply } = steeringExchange(await api.state());
    await open(page, api, "#/overview", { selector: '[data-tour="progress"]' });
    await hideTryLine(page);
    await page.click("button.lead-btn");
    await page.waitForSelector(`aside.lead-drawer #msg-${reply.id} .fold-toggle`);
    await page.click(`aside.lead-drawer #msg-${reply.id} .fold-toggle`);
    await page.waitForFunction((id) => document.getElementById(`msg-${id}`)?.querySelector(".fold-body:not([hidden])")?.textContent?.includes("Delivered"), reply.id);
    await page.evaluate((id) => document.getElementById(`msg-${id}`)?.scrollIntoView({ block: "start" }), asked.id);
    await page.evaluate(() => window.scrollTo(0, 0));
    // The message box keeps focus when the drawer opens; a still shows no focus ring or caret.
    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    await page.waitForTimeout(300);
  },
};

const unknown = wanted.filter((n) => !SCENES[n]);
if (unknown.length) fail(`README.md references images this script has no scene for: ${unknown.join(", ")}. Add a scene or remove the image.`);
for (const n of only) if (!SCENES[n]) fail(`--only names an unknown scene: ${n}`);
const selected = (only.length ? only : wanted).filter((n, i, a) => a.indexOf(n) === i);
const extra = Object.keys(SCENES).filter((n) => !wanted.includes(n));
if (extra.length && !only.length) log(`scenes the README does not use (skipped): ${extra.join(", ")}`);

// ---------- the throwaway service ----------

async function freePort() {
  for (let port = 5391; port <= 5399; port++) {
    const free = await new Promise((done) => {
      const srv = createServer();
      srv.once("error", () => done(false));
      srv.listen(port, "127.0.0.1", () => srv.close(() => done(true)));
    });
    if (free) return port;
  }
  throw new Error("No free port between 5391 and 5399.");
}

function makeApi(port) {
  const base = `http://127.0.0.1:${port}`;
  async function post(path, body) {
    const r = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", "X-Orchestration-Client": "1" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`${path} answered ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return r.json().catch(() => ({}));
  }
  const api = {
    base,
    async state() {
      const r = await fetch(`${base}/api/state`);
      if (!r.ok) throw new Error(`/api/state answered ${r.status}`);
      return (await r.json()).state;
    },
    sim: (patch) => post("/api/sim", patch),
    async step(count = 1) {
      for (let i = 0; i < count; i++) await post("/api/sim/step", {});
    },
    /** Step the paused clock until `pred(state)` holds, checking every `every` steps. */
    async stepUntil(what, pred, max = 600, every = 4) {
      for (let i = 0; i <= max; i += every) {
        const s = await api.state();
        if (pred(s)) return s;
        await api.step(every);
      }
      throw new Error(`The simulation did not reach "${what}" within ${max} steps.`);
    },
    /**
     * The start of the demo with the clock paused: the three starting runs dispatched and WT-005's pull
     * request seen on the simulated GitHub, so it is ready for you to merge. A few ticks do both.
     */
    async settle() {
      await api.sim({ auto: false });
      await api.stepUntil("three agents working", (s) => s.attempts.filter((a) => !a.endedAt).length >= 3, 20, 1);
      await api.stepUntil(
        "WT-005's pull request seen on GitHub",
        (s) => {
          const pr = s.tasks.find((t) => t.id === "WT-005")?.integration?.pr;
          return !!pr?.observed && !pr.op;
        },
        40,
        1,
      );
      await api.step(1);
    },
    /** Back to the start of the demo. */
    async restart() {
      await post("/api/sim/reset", {});
      await api.settle();
    },
  };
  return api;
}

// ---------- images ----------

function downscale(src, dst, width) {
  mkdirSync(dirname(dst), { recursive: true });
  const r = sips ? spawnSync("sips", ["--resampleWidth", String(width), src, "--out", dst], { encoding: "utf8" }) : spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", src, "-vf", `scale=${width}:-1:flags=lanczos`, dst], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`Downscaling ${src} failed: ${r.stderr || r.stdout}`);
}

const PALETTE = (fps, width) => `fps=${fps},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`;

/**
 * The tour: a GIF at 12 fps and 1200 px, or the fallbacks (10 fps, 1000 px, then WebP) until it
 * fits 5 MB. `frames` is an ffmpeg concat list: one JPEG per repaint with its real duration (Chrome sends a
 * screencast frame only when something changed), which `fps=` resamples to a constant rate.
 */
function convertTour(frames, mediaDir) {
  const tries = [
    { file: "tour.gif", fps: 12, width: 1200 },
    { file: "tour.gif", fps: 10, width: 1200 },
    { file: "tour.gif", fps: 10, width: 1000 },
    { file: "tour.webp", fps: 10, width: 1000 },
  ];
  for (const t of tries) {
    const out = join(mediaDir, t.file);
    const input = ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", frames];
    const argv = t.file.endsWith(".webp") ? [...input, "-vf", `fps=${t.fps},scale=${t.width}:-1:flags=lanczos`, "-c:v", "libwebp", "-lossless", "0", "-q:v", "60", "-loop", "0", out] : [...input, "-vf", PALETTE(t.fps, t.width), "-loop", "0", out];
    const r = spawnSync("ffmpeg", argv, { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
    const bytes = statSync(out).size;
    if (bytes <= TOUR_MAX_BYTES) {
      if (t.file === "tour.gif") rmSync(join(mediaDir, "tour.webp"), { force: true });
      else rmSync(join(mediaDir, "tour.gif"), { force: true });
      return { ...t, bytes, out };
    }
    log(`${t.file} at ${t.fps} fps, ${t.width} px is ${kb(bytes)}, over 5 MB; trying the next fallback.`);
  }
  throw new Error("The tour does not fit 5 MB even as WebP at 10 fps and 1000 px.");
}

// ---------- the tour recording ----------

/**
 * Record the page through Chrome's screencast (what Playwright's own video recorder uses underneath; its
 * recordVideo needs a separately downloaded ffmpeg build, and this script downloads nothing). Every frame
 * Chrome sends is kept as a JPEG with its timestamp; `stop` writes the ffmpeg concat list with durations.
 */
async function startScreencast(page, dir) {
  mkdirSync(dir, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  cdp.on("Page.screencastFrame", (e) => {
    const file = join(dir, `f${String(frames.length).padStart(5, "0")}.jpg`);
    writeFileSync(file, Buffer.from(e.data, "base64"));
    frames.push({ file, t: e.metadata.timestamp });
    cdp.send("Page.screencastFrameAck", { sessionId: e.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 90, maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height, everyNthFrame: 1 });
  return {
    async stop(tailSeconds = 1.5) {
      await cdp.send("Page.stopScreencast").catch(() => {});
      await cdp.detach().catch(() => {});
      if (frames.length < 2) throw new Error("The screencast produced no frames.");
      const lines = [];
      for (let i = 0; i < frames.length; i++) {
        const d = i + 1 < frames.length ? Math.max(0.01, frames[i + 1].t - frames[i].t) : tailSeconds;
        lines.push(`file '${frames[i].file}'`, `duration ${d.toFixed(3)}`);
      }
      lines.push(`file '${frames.at(-1).file}'`); // the concat demuxer applies the last duration only with a trailing entry
      const list = join(dir, "frames.txt");
      writeFileSync(list, lines.join("\n") + "\n");
      return { list, frames: frames.length, seconds: frames.at(-1).t - frames[0].t + tailSeconds };
    },
  };
}

/**
 * The demo's own tour, as a first visit sees it: the bare address opens Home and the tour starts by itself.
 * Each stop is held long enough to read, then Next; stops on other pages open them. The last stop's button
 * goes back to Home. The simulation clock runs throughout, so the work moves while the tour talks.
 */
async function recordTour(browser, api, tmp) {
  const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, colorScheme: "dark" });
  const page = await ctx.newPage();
  await page.goto(`${api.base}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("header.top", { timeout: 20_000 });
  const cast = await startScreencast(page, join(tmp, "frames"));
  await api.sim({ auto: true });
  await page.waitForSelector(".driver-popover", { timeout: 20_000 });
  const progress = () => page.evaluate(() => document.querySelector(".driver-popover-progress-text")?.textContent ?? "");
  const total = Number(/of (\d+)/.exec(await progress())?.[1]);
  if (!total) throw new Error("The tour's first stop shows no progress (\"1 of N\").");
  const stops = [];
  for (let n = 1; n <= total; n++) {
    await page.waitForFunction((n) => document.querySelector(".driver-popover-progress-text")?.textContent?.startsWith(`${n} of`), n, { timeout: 15_000 });
    // Let the highlight finish moving before the reading time starts.
    await page.waitForTimeout(450);
    const title = (await page.textContent(".driver-popover-title"))?.trim() ?? "";
    const words = ((await page.textContent(".driver-popover-description")) ?? "").trim().split(/\s+/).length;
    stops.push(title);
    await sleep(READ.base + READ.perWord * words);
    await page.click(".driver-popover-next-btn");
  }
  await page.waitForSelector(".driver-popover", { state: "detached", timeout: 15_000 });
  await page.waitForFunction(() => location.hash === "#/overview", undefined, { timeout: 15_000 });
  await page.waitForSelector('[data-tour="progress"]');
  await sleep(READ.last);
  const rec = await cast.stop(1.0);
  await ctx.close();
  await api.sim({ auto: false });
  return { ...rec, stops };
}

// ---------- main ----------

const t0 = Date.now();
const tmp = mkdtempSync(join(tmpdir(), "orc-capture-"));
const home = join(tmp, "home");
const dataDir = join(home, ".orchestration");
mkdirSync(join(tmp, "shots"), { recursive: true });

let service;
let browser;
let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try {
    await browser?.close();
  } catch {}
  if (service && service.exitCode === null) {
    service.kill("SIGTERM");
    await Promise.race([new Promise((r) => service.once("exit", r)), sleep(3000)]);
    if (service.exitCode === null) service.kill("SIGKILL");
  }
  rmSync(tmp, { recursive: true, force: true });
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    log(`${sig}: stopping the service and removing ${tmp}.`);
    void cleanup().finally(() => process.exit(130));
  });
}

try {
  const port = await freePort();
  let serviceLog = "";
  service = spawn(process.execPath, ["--import", "tsx", "server/main.ts"], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, ORCHESTRATION_DB: join(dataDir, "orchestration.db"), ORCHESTRATION_RUNTIME: "fake", ORCHESTRATION_STATIC: "dist", ORCHESTRATION_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  service.stdout.on("data", (d) => (serviceLog += d));
  service.stderr.on("data", (d) => (serviceLog += d));
  const api = makeApi(port);
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (service.exitCode !== null) throw new Error(`The service exited early:\n${serviceLog}`);
    try {
      await api.state();
      break;
    } catch {}
    if (Date.now() > deadline) throw new Error(`The service did not answer on port ${port} within 30 s:\n${serviceLog}`);
    await sleep(200);
  }
  log(`service on ${api.base}, data in ${tmp}`);
  await api.settle();

  const launch = { headless: true, ...(chromePath ? { executablePath: chromePath } : { channel: "chrome" }) };
  try {
    browser = await chromium.launch(launch);
  } catch (e) {
    throw new Error(`Google Chrome could not be started (${chromePath ? `CHROME_PATH=${chromePath}` : "the installed Chrome"}). Install Google Chrome or set CHROME_PATH to a Chrome/Chromium binary.\n${e.message.split("\n")[0]}`);
  }
  const written = [];
  const raw = {};

  /**
   * One still, in a browser of its own, so nothing one scene does (opening the lead marks its replies as read,
   * Hide is remembered) shows in the next: twice the pixels, then downscaled; no motion, and the tour marked
   * as seen so no popover shows.
   */
  async function shoot(name) {
    log(`screenshot ${name}`);
    const stills = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme: "dark", reducedMotion: "reduce" });
    await stills.addInitScript(() => {
      try {
        localStorage.setItem("orc.tour.v1", "done");
        localStorage.setItem("orchestration.view", "board");
      } catch {}
    });
    const page = await stills.newPage();
    const r = (await SCENES[name]({ page, api })) ?? {};
    if (await page.locator(".driver-popover").count()) throw new Error(`${name}: a tour popover is showing.`);
    raw[name] = join(tmp, "shots", `${name}@2x.png`);
    let clip;
    if (r.clipTo) {
      const bottom = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) throw new Error(`Nothing to clip to: ${sel}`);
        return el.getBoundingClientRect().bottom + window.scrollY;
      }, r.clipTo);
      clip = { x: 0, y: 0, width: VIEWPORT.width, height: Math.min(MAX_SHOT_HEIGHT, Math.ceil(bottom + CLIP_MARGIN)) };
    }
    await page.screenshot({ path: raw[name], animations: "disabled", caret: "hide", ...(clip ? { clip, fullPage: true } : {}) });
    await stills.close();
    const out = join(outDir, "screenshots", `${name}.png`);
    downscale(raw[name], out, SHOT_WIDTH);
    written.push(out);
  }

  for (const name of selected) await shoot(name);

  // The hero: scripts/media/hero.html around the full-resolution Home capture.
  if (!only.length || only.includes("home")) {
    log("hero");
    if (!raw.home) await shoot("home");
    const heroPage = await browser.newPage({ viewport: { width: 2400, height: 1350 }, deviceScaleFactor: 1, colorScheme: "dark" });
    await heroPage.goto(`${pathToFileURL(HERO_HTML).href}?shot=${encodeURIComponent(pathToFileURL(raw.home).href)}`);
    await heroPage.waitForFunction(() => {
      const img = document.getElementById("shot");
      return img && img.complete && img.naturalWidth > 0;
    });
    const heroRaw = join(tmp, "shots", "hero@1x.png");
    await heroPage.screenshot({ path: heroRaw });
    await heroPage.close();
    const hero = join(outDir, "media", "hero.png");
    let width = SHOT_WIDTH;
    downscale(heroRaw, hero, width);
    while (statSync(hero).size > HERO_MAX_BYTES && width > 1000) {
      width -= 200;
      downscale(heroRaw, hero, width);
    }
    written.push(hero);
    log(`hero.png: ${width} px wide, ${kb(statSync(hero).size)}`);
  }

  if (!noTour && !only.length) {
    log("tour: recording");
    await api.restart();
    const rec = await recordTour(browser, api, tmp);
    const mediaDir = join(outDir, "media");
    mkdirSync(mediaDir, { recursive: true });
    const tour = convertTour(rec.list, mediaDir);
    written.push(tour.out);
    log(`tour stops: ${rec.stops.join(" → ")}`);
    log(`${tour.file}: ${tour.fps} fps, ${tour.width} px wide, ${rec.seconds.toFixed(1)} s from ${rec.frames} screencast frames, ${kb(tour.bytes)}`);
  }

  log(`done in ${((Date.now() - t0) / 1000).toFixed(0)} s:`);
  for (const f of written) console.log(`  ${f.replace(ROOT + "/", "")}  ${kb(statSync(f).size)}`);
} catch (e) {
  process.exitCode = 1;
  console.error(`capture-demo: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  await cleanup();
}
