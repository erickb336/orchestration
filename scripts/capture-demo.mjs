#!/usr/bin/env node
// ORC-017 §6: regenerate the README media from the demo.
//
//   node scripts/capture-demo.mjs [--out docs] [--only overview,board] [--no-tour]
//
// It starts the service on the fake runtime in a throwaway data directory (a temporary HOME, so the real
// ~/.orchestration is never touched), drives the installed Google Chrome through playwright-core, and writes
//   <out>/screenshots/<name>.png   every image README.md references (the list is read from its image links),
//   <out>/media/hero.png           scripts/media/hero.html around the Overview screenshot,
//   <out>/media/tour.gif           a short recorded tour (Chrome's screencast frames, then ffmpeg palettegen/paletteuse).
// It needs Google Chrome (or CHROME_PATH pointing at a Chrome/Chromium binary) and ffmpeg; it never downloads a
// browser. The simulation clock is paused and stepped, so each shot shows a known state. On every exit path,
// success, error or Ctrl-C, the service is stopped and the temporary directory removed.

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
const SHOT_WIDTH = 1600;
const HERO_MAX_BYTES = 700_000;
const TOUR_MAX_BYTES = 5_000_000;
const HOLD = { read: 2300, short: 1700 };

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
// Each scene puts one page into the state its README paragraph describes and takes one viewport screenshot.
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

/** Scroll the window so the first element matching `selector` (or the first `tag` whose text starts with `text`) sits `offset` px under the top edge. */
async function scrollTo(page, where, offset = 16) {
  await page.evaluate(
    ({ where, offset }) => {
      let el = null;
      if (where.selector) el = document.querySelector(where.selector);
      else if (where.text) el = [...document.querySelectorAll(where.tag ?? "*")].find((e) => e.children.length < 12 && (e.textContent ?? "").trim().startsWith(where.text)) ?? null;
      if (!el) throw new Error(`Nothing to scroll to: ${JSON.stringify(where)}`);
      window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - offset, behavior: "instant" });
    },
    { where, offset },
  );
  await page.waitForTimeout(250);
}

/** The lead message that carried the demo's steering exchange (design §5, message 2). */
function steeringMessage(state) {
  const set = state.steering.find((s) => s.changes.some((c) => c.kind === "focus"));
  const msg = set && state.conversation.find((m) => m.author === "lead" && m.leadRunId === set.leadRunId);
  if (!msg) throw new Error("The demo's steering exchange was not found in the conversation.");
  return msg;
}

const SCENES = {
  // The start of the demo: three agents working, the clock paused.
  overview: async ({ page, api }) => {
    await open(page, api, "#/overview", { selector: '[data-tour="progress"]' });
    // The line about using your own repository is for someone exploring the demo; the README says it in words.
    const hide = page.locator(".try-shaping button", { hasText: "Hide" });
    if (await hide.count()) {
      await hide.first().click();
      await page.waitForTimeout(250);
    }
  },
  board: async ({ page, api }) => open(page, api, "#/tasks", { selector: ".board" }),
  steering: async ({ page, api }) => {
    await open(page, api, "#/tasks", { selector: ".board" });
    const msg = steeringMessage(await api.state());
    await page.click("button.lead-btn");
    await page.waitForSelector(`aside.lead-drawer #msg-${msg.id}`);
    await page.evaluate((id) => document.getElementById(`msg-${id}`)?.scrollIntoView({ block: "start" }), msg.id);
    await page.waitForTimeout(300);
  },
  review: async ({ page, api }) => open(page, api, "#/review", { text: "Needs you" }),
  landed: async ({ page, api }) => {
    await open(page, api, "#/review", { text: "Landed" });
    await page.getByRole("button", { name: "Show details" }).first().click();
    await page.waitForSelector("text=Hide details");
    await scrollTo(page, { tag: "h2", text: "Landed" });
  },
  "goal-task": async ({ page, api }) => open(page, api, "#/task/WT-004", { selector: "#children-h" }),
  // A pipeline whose security review found something, repaired and reviewed again (ORC-021).
  pipeline: async ({ page, api }) => {
    await open(page, api, "#/task/WT-004.1", { selector: "#steps-h" });
    await scrollTo(page, { selector: 'section[aria-labelledby="steps-h"]' });
  },
  artifacts: async ({ page, api }) => {
    await open(page, api, "#/task/WT-011", { selector: "#arts-h" });
    await scrollTo(page, { selector: 'section[aria-labelledby="outcome-h"]' });
  },
  findings: async ({ page, api }) => {
    await open(page, api, "#/task/WT-001", { selector: "#arts-h" });
    await page.evaluate(() => {
      const row = [...document.querySelectorAll(".artifact-row")].find((r) => (r.querySelector(".mono")?.textContent ?? "").trim().startsWith("S2.findings"));
      if (!row) throw new Error("WT-001's S2.findings artifact was not found.");
      window.scrollTo({ top: row.getBoundingClientRect().top + window.scrollY - 16, behavior: "instant" });
    });
    await page.waitForTimeout(250);
  },
  settings: async ({ page, api }) => open(page, api, "#/settings", { selector: "#inv-h" }),
  "checks-settings": async ({ page, api }) => {
    await open(page, api, "#/settings", { selector: "#checks-h" });
    await scrollTo(page, { selector: 'section[aria-labelledby="checks-h"]' }, 72); // the Flows card beside it starts a little higher
  },
  "delivery-settings": async ({ page, api }) => {
    await open(page, api, "#/settings", { selector: "#delivery" });
    await scrollTo(page, { selector: "#delivery" });
  },
  // ORC-021: Settings → Flows.
  flows: async ({ page, api }) => {
    await open(page, api, "#/settings", { selector: "#flows-h" });
    await scrollTo(page, { selector: 'section[aria-labelledby="flows-h"]' });
  },
  // Later in the demo: WT-006 finished and its pull request waits on a failed check (see the pr group below).
  "pr-checks": async ({ page, api }) => open(page, api, "#/task/WT-006", { selector: "#delivery-h", text: "Needs you" }),
  // The shaping stage, after a message to the lead.
  shaping: async ({ page, api }) => {
    await open(page, api, "#/overview", { selector: "#shape-h", text: "The lead asks" });
    await scrollTo(page, { selector: 'section[aria-labelledby="shape-h"]' });
  },
  "vision-docs": async ({ page, api }) => {
    await open(page, api, "#/overview", { selector: "#shape-h", text: "The lead asks" });
    await scrollTo(page, { tag: "h3", text: "Vision documents" });
  },
};
const GROUPS = {
  start: ["overview", "board", "steering", "review", "landed", "goal-task", "pipeline", "artifacts", "findings", "settings", "checks-settings", "delivery-settings", "flows"],
  pr: ["pr-checks"],
  shaping: ["shaping", "vision-docs"],
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
  let n = 0;
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
    command: (name, args = {}) => post("/api/commands", { name, args, idempotencyKey: `capture-${process.pid}-${++n}-${name}` }),
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
     * request seen on the simulated GitHub, so it is held for you (design §5). A few ticks do both.
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
 * The tour: a GIF at 12 fps and 1200 px, or the fallbacks of design §8 (10 fps, 1000 px, then WebP) until it
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

// ---------- the tour recording (design §6) ----------

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

async function recordTour(browser, api, tmp) {
  await api.sim({ auto: true });
  const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, colorScheme: "light" });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem("orchestration.view", "board");
    } catch {}
  });
  const page = await ctx.newPage();
  /** Run the paused-clock stepper while the real clock also runs, so the Overview changes while it is on screen. */
  async function hold(ms, steps = 0) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (steps > 0) {
        await api.step(1);
        steps--;
      }
      await sleep(steps > 0 ? Math.max(40, ms / 60) : Math.min(200, end - Date.now()));
    }
  }

  // 1. A first visit: the bare address lands on the Overview and the tour's first stop shows. Recording starts
  //    once the document exists; every later navigation changes only the hash, so the screencast continues.
  await page.goto(`${api.base}/`, { waitUntil: "domcontentloaded" });
  const cast = await startScreencast(page, join(tmp, "frames"));
  await page.waitForSelector(".driver-popover", { timeout: 20_000 });
  await hold(HOLD.read);
  await page.keyboard.press("Escape");
  await page.waitForSelector(".driver-popover", { state: "detached" });
  await page.waitForSelector('[data-tour="progress"]');
  await hold(HOLD.read + 600, 20);

  // 2. The lead, from the same page: "Focus on offline maps", then the change list.
  await page.click("button.lead-btn");
  await page.waitForTimeout(400);
  await page.keyboard.type("Focus on offline maps", { delay: 30 });
  await page.waitForTimeout(300);
  const before = (await api.state()).conversation.length;
  await page.click("#lead-inline button[type=submit]");
  await page.waitForTimeout(500);
  await api.stepUntil("the lead's reply", (s) => s.conversation.length > before && s.conversation.at(-1).author === "lead" && !s.leadRuns.some((r) => !r.endedAt), 120, 2);
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const list = document.querySelector("#lead-inline ol.convo");
    if (list) list.scrollTop = list.scrollHeight;
  });
  await hold(HOLD.read + 300);

  // 3. The board.
  await page.goto(`${api.base}/#/tasks`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".board");
  await hold(HOLD.short + 300);

  // 4. WT-002 and its pipeline: provider and model per step.
  await api.stepUntil("an agent working on WT-002", (s) => s.attempts.some((a) => a.taskId === "WT-002" && !a.endedAt && a.outcome === "running" && !/^C\d/.test(a.stepId)), 200, 2);
  await page.click('.task-row[aria-label^="WT-002 "]');
  await page.waitForSelector("#steps-h");
  await page.waitForTimeout(400);
  await scrollTo(page, { selector: 'section[aria-labelledby="steps-h"]' });
  await hold(HOLD.read);

  // 5. Pause, until the runtime acknowledges and the task shows Paused.
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "Pause", exact: true }).first().click();
  const paused = (s) => {
    const t = s.tasks.find((x) => x.id === "WT-002");
    return !!t?.hold && !s.attempts.some((a) => a.taskId === "WT-002" && !a.endedAt);
  };
  for (let i = 0; i < 60 && !paused(await api.state()); i++) await sleep(250);
  await page.waitForFunction(() => document.body.innerText.includes("Paused"), undefined, { timeout: 15_000 });
  await hold(HOLD.short);

  // 6. Resume.
  await page.getByRole("button", { name: "Resume", exact: true }).first().click();
  for (let i = 0; i < 60 && !(await api.state()).attempts.some((a) => a.taskId === "WT-002" && !a.endedAt); i++) await sleep(250);
  await hold(HOLD.short - 200);

  // 7. Review.
  await page.goto(`${api.base}/#/review`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.body.innerText.includes("Needs you"));
  await hold(HOLD.read);

  const rec = await cast.stop(1.0);
  await ctx.close();
  await api.sim({ auto: false });
  return rec;
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
  const stills = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme: "light", reducedMotion: "reduce" });
  await stills.addInitScript(() => {
    try {
      localStorage.setItem("orc.tour.v1", "done");
      localStorage.setItem("orchestration.view", "board");
    } catch {}
  });
  const page = await stills.newPage();
  const written = [];
  const raw = {};

  async function shoot(name) {
    log(`screenshot ${name}`);
    await SCENES[name]({ page, api });
    raw[name] = join(tmp, "shots", `${name}@2x.png`);
    await page.screenshot({ path: raw[name], animations: "disabled", caret: "hide" });
    const out = join(outDir, "screenshots", `${name}.png`);
    downscale(raw[name], out, SHOT_WIDTH);
    written.push(out);
  }

  const inGroup = (g) => selected.filter((n) => GROUPS[g].includes(n));
  for (const name of inGroup("start")) await shoot(name);

  if (inGroup("pr").length) {
    // A pull request waiting on a failed check. The simulated checks fail `test` once per task tree, on its first
    // check run; so WT-006 runs with checks off (its check steps are skipped), and checks are turned back on once
    // its pull request is open. The service then runs its merge checks on that change, and the first one fails.
    log("pr-checks: WT-006 runs with checks off; checks are turned on once its pull request is open");
    const cfg = (await api.state()).project.checks;
    const config = (enabled) => ({ ...cfg, enabled, rev: undefined });
    await api.command("setChecks", { config: config(false) });
    await api.stepUntil("WT-006's pull request open", (s) => s.tasks.find((t) => t.id === "WT-006")?.integration?.pr?.phase === "open", 1500, 5);
    await api.command("setChecks", { config: config(true) });
    await api.stepUntil(
      "WT-006's pull request waiting on a failed check",
      // Once the service's own check fails, the pull request waits for you.
      (s) => s.tasks.find((t) => t.id === "WT-006")?.integration?.pr?.attention?.code === "service-checks",
      300,
      2,
    );
    // The simulated GitHub is read on the service's own schedule (every 30 s while a pull request is new), in real
    // time; wait for that first read so the card shows what GitHub says rather than "not read yet".
    const readBy = Date.now() + 60_000;
    while (!(await api.state()).tasks.find((t) => t.id === "WT-006")?.integration?.pr?.observed) {
      if (Date.now() > readBy) throw new Error("WT-006's pull request was not read from the simulated GitHub within 60 s.");
      await api.step(1);
      await new Promise((r) => setTimeout(r, 1000));
    }
    for (const name of inGroup("pr")) await shoot(name);
    await api.restart();
  }

  if (inGroup("shaping").length) {
    log("shaping: back to the shaping stage, a message to the lead, and its questions");
    await api.command("startShaping");
    const before = (await api.state()).conversation.length;
    await api.command("postMessage", { text: "Weekend Trips is a small app for planning weekend hikes with friends. Most trailheads have no signal, so the map has to work offline." });
    await api.stepUntil("the lead's shaping reply", (s) => s.conversation.length > before && s.conversation.at(-1).author === "lead" && !s.leadRuns.some((r) => !r.endedAt), 200, 2);
    for (const name of inGroup("shaping")) await shoot(name);
    await api.restart();
  }

  // The hero: scripts/media/hero.html around the full-resolution Overview capture.
  if (!only.length || only.includes("overview")) {
    log("hero");
    if (!raw.overview) await shoot("overview");
    const heroPage = await browser.newPage({ viewport: { width: 2400, height: 1350 }, deviceScaleFactor: 1, colorScheme: "light" });
    await heroPage.goto(`${pathToFileURL(HERO_HTML).href}?shot=${encodeURIComponent(pathToFileURL(raw.overview).href)}`);
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

  await page.close();

  if (!noTour && !only.length) {
    log("tour: recording");
    await api.restart();
    const rec = await recordTour(browser, api, tmp);
    const mediaDir = join(outDir, "media");
    mkdirSync(mediaDir, { recursive: true });
    const tour = convertTour(rec.list, mediaDir);
    written.push(tour.out);
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
