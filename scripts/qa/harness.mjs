// The QA harness (ORC-030, step 1): what every journey script in scripts/qa/ shares. It follows the three browser
// passes (scripts/preflight-browser-pass.mjs, floor-browser-pass.mjs, reality-browser-pass.mjs): the real service
// (server/http.ts) with the fake runtime, a fixture state built through the real commands, and the system Chrome
// through `launchChrome`, at 1280 and 375 wide.
//
// It gives a journey:
// - `buildApp()`: the built UI, once per `npm run qa` (QA_DIST names a build made earlier);
// - `startService(state, o)`: the service as server/app.ts wires it in fake mode, on 127.0.0.1:ORCHESTRATION_TEST_PORT,
//   with its own data directory under the system temp directory (never ~/.orchestration). `o.run` starts the scheduler
//   (the simulated agents then work); `o.realLooking` makes the service say "real" while every run stays simulated;
//
// - `openPage(browser, width)`: a page that collects console errors, page errors and failed requests;
// - `journey(name)`: the checks, the screenshots (evidence/qa/<journey>/<width>-<step>.png) and the exit code.
//
// No paid model run, no Docker: the studio's terminal recordings are "not available" here, as on a computer without
// Docker. Run a journey: ORCHESTRATION_TEST_PORT=5950 node --import tsx scripts/qa/<journey>.mjs

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "vite";
import { builtInCatalog } from "../../src/domain/flows.ts";
import { setFlows } from "../../src/domain/model.ts";
import { setSubagentProviders } from "../../src/domain/subagents.ts";
import { createHttpServer } from "../../server/http.ts";
import { FakeAdapter, defaultFakeConfig } from "../../server/runtimes/fake.ts";
import { Scheduler } from "../../server/scheduler.ts";
import { Store } from "../../server/store.ts";
import { systemMedia } from "../../server/studio/media.ts";
import { createPrototypeServer, projectStudioDir } from "../../server/studio/serve.ts";
import { launchChrome } from "../../server/studio/shots.ts";
import { close } from "../../server/studio/testFixtures.ts";
import { VisionDocStore } from "../../server/visiondocs.ts";
import { WorkspaceManager } from "../../server/workspaces.ts";

export const ROOT = resolve(import.meta.dirname, "..", "..");
export const EVIDENCE = resolve(process.env.QA_OUT ?? join(ROOT, "evidence", "qa"));
export const WIDTHS = [1280, 375];
export const PORT = Number(process.env.ORCHESTRATION_TEST_PORT ?? 5950);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(m);

// ---------- the built UI ----------

/** The built UI: QA_DIST when the runner built it once, else a fresh production build in a temp folder. */
let madeDist;
export async function buildApp() {
  if (process.env.QA_DIST && existsSync(join(process.env.QA_DIST, "index.html"))) return process.env.QA_DIST;
  if (madeDist) return madeDist;
  const dist = mkdtempSync(join(tmpdir(), "orc-qa-dist-"));
  madeDist = dist;
  process.env.NODE_ENV = "production";
  await build({ root: ROOT, configFile: join(ROOT, "vite.config.ts"), mode: "production", logLevel: "silent", build: { outDir: dist, emptyOutDir: true } });
  return dist;
}

/** Remove the build buildApp made (not QA_DIST's). */
export function removeApp() {
  if (madeDist) rmSync(madeDist, { recursive: true, force: true });
  madeDist = undefined;
}

// ---------- the service ----------

/**
 * A runtime that says it is not the fake one, so the service and the UI behave as in real mode (the first-run
 * checklist, Settings › Start a new project), while every run stays the fake runtime's (nothing leaves this computer).
 */
class RealLooking {
  constructor(inner) {
    this.inner = inner;
    this.provider = inner.provider;
    this.label = `${inner.provider === "claude" ? "Claude" : "Codex"} (QA stand-in: simulated)`;
    this.capabilities = inner.capabilities;
  }
}
for (const key of Object.getOwnPropertyNames(FakeAdapter.prototype)) {
  if (key === "constructor") continue;
  RealLooking.prototype[key] = function (...args) {
    return this.inner[key](...args);
  };
}

/**
 * The service on a state, as server/app.ts wires it in fake mode: the store, the fake adapters (with the catalog and
 * the board), the vision documents, the scheduler (screenshots with Chrome, no recordings), the prototype server and
 * the HTTP server with its page policy. The flows are refreshed from flows/ as at start.
 *
 * o.run: start the scheduler's timer (o.tickMs, default 1000 ms), so the simulated agents work. Without it, nothing moves.
 * o.progressPerTick: how fast a simulated run goes (the service's default is 5, about 20 ticks a step).
 * o.realLooking: the service says "real"; a repository for the repository check is made under the data directory.
 */
export async function startService(state, o = {}) {
  const port = o.port ?? PORT;
  const dataDir = mkdtempSync(join(tmpdir(), "orc-qa-data-"));
  const logs = [];
  const slog = (m) => logs.push(`${new Date().toISOString()} ${m}`);
  const store = new Store(join(dataDir, "orchestration.db"), () => structuredClone(typeof state === "function" ? state() : state));
  const fakeConfig = { ...defaultFakeConfig(), ...(o.progressPerTick ? { progressPerTick: o.progressPerTick } : {}) };
  const catalog = store.read().state.project.catalog;
  const board = () => store.read().state;
  let adapters = { claude: new FakeAdapter("claude", fakeConfig, catalog.claude, board), codex: new FakeAdapter("codex", fakeConfig, catalog.codex, board) };
  let workspaces;
  let repo;
  if (o.realLooking) {
    adapters = { claude: new RealLooking(adapters.claude), codex: new RealLooking(adapters.codex) };
    workspaces = new WorkspaceManager(join(dataDir, "worktrees"));
    repo = join(dataDir, "repo");
    mkdirSync(repo);
    const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "README.md"), "# Weekend trips\n\nA small app to plan weekend trips with friends.\n");
    git("add", "-A");
    git("-c", "user.name=QA", "-c", "user.email=qa@localhost", "commit", "-q", "-m", "Initial commit");
  }
  const visionDocs = new VisionDocStore(join(dataDir, "vision-docs"));
  {
    const now = new Date().toISOString();
    store.update((s) => setFlows(s, builtInCatalog(), now), now);
    store.update((s) => setSubagentProviders(s, ["claude"], now), now);
  }
  const media = { shots: systemMedia(slog).shots, record: async () => ({ sandbox: null, reason: "unavailable", error: "Not recorded: the QA harness runs no Docker." }) };
  const scheduler = new Scheduler(store, adapters, { log: slog, visionDocs, dataDir, studioMedia: media, ...(workspaces ? { workspaces } : {}) });
  const origin = `http://127.0.0.1:${port}`;
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  const prototypePort = port + 1;
  const prototypes = createPrototypeServer({ studioDir: () => projectStudioDir(dataDir, store.read().state.project.id), appOrigins: allowedHosts.map((h) => `http://${h}`), log: slog });
  await new Promise((r) => prototypes.listen(prototypePort, "127.0.0.1", r));
  const app = createHttpServer({
    store,
    scheduler,
    fakeConfig: o.realLooking ? undefined : fakeConfig,
    workspaces,
    visionDocs,
    dataDir,
    startedAt: new Date().toISOString(),
    allowedHosts,
    staticDir: o.dist,
    prototypePort,
    prototypeServer: prototypes,
    log: slog,
  });
  await new Promise((r) => app.listen(port, "127.0.0.1", r));
  if (o.run) scheduler.start(o.tickMs ?? 1000);
  let n = 0;
  const service = {
    store,
    scheduler,
    adapters,
    origin,
    dataDir,
    repo,
    logs,
    state: () => store.read().state,
    /** A command as the UI sends it (the store's own path), for the fixture and for "another tab". */
    command: (name, args = {}) => store.command(name, args, `qa-${Date.now()}-${n++}`, new Date().toISOString()),
    /** Fake mode only: advance the simulated clock once (the Simulation menu's Step). */
    step: () => scheduler.step(Date.now()),
    /** Wait until `pred(state)` is true; the scheduler's timer must run (o.run) or `stepping` must be set. */
    until: async (what, pred, timeoutMs = 60_000, { stepping = false } = {}) => {
      const start = Date.now();
      for (;;) {
        const v = pred(store.read().state);
        if (v) return v;
        if (Date.now() - start > timeoutMs) throw new Error(`timed out after ${timeoutMs / 1000}s waiting for: ${what}`);
        if (stepping) scheduler.step(Date.now());
        await sleep(stepping ? 50 : 250);
      }
    },
    stop: async () => {
      await scheduler.stop();
      await close(app);
      await close(prototypes);
      store.close();
      if (!process.env.QA_KEEP_DATA) rmSync(dataDir, { recursive: true, force: true });
    },
  };
  return service;
}

// ---------- the browser ----------

export async function chrome() {
  const c = await launchChrome();
  if (!("browser" in c)) {
    console.error(`No browser: ${c.missing}. Install Google Chrome or set CHROME_PATH.`);
    process.exit(2);
  }
  return c.browser;
}

/**
 * A page at `width` (812 high at 375, 900 at 1280) that collects console errors, page errors and failed requests in
 * `page.qaErrors`. The demo's first-run tour is marked done unless o.tour.
 */
export async function openPage(browser, width, o = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: width < 600 ? 812 : 900 }, deviceScaleFactor: 1 });
  if (!o.tour) await ctx.addInitScript(() => localStorage.setItem("orc.tour.v1", "done"));
  const page = await ctx.newPage();
  page.qaErrors = [];
  page.on("console", (m) => m.type() === "error" && page.qaErrors.push(`console: ${m.text()}`));
  page.on("pageerror", (e) => page.qaErrors.push(`page error: ${e.message}`));
  ctx.on("requestfailed", (r) => {
    const why = r.failure()?.errorText ?? "";
    // A live stream the page closes on navigation is not a failure.
    if (r.url().includes("/api/stream") && why.includes("ERR_ABORTED")) return;
    page.qaErrors.push(`request failed: ${r.url()} (${why})`);
  });
  // The addresses that answered 404: a console line "Failed to load resource" does not name them.
  page.qaNotFound = [];
  page.on("response", (r) => {
    if (r.status() >= 500) page.qaErrors.push(`server error ${r.status()}: ${r.url()}`);
    if (r.status() === 404) page.qaNotFound.push(r.url());
  });
  page.qaContext = ctx;
  return page;
}

/** The page's width against the window's: more is a horizontal scroll. */
export async function horizontalScroll(page) {
  return page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
}

/** The elements wider than the window (at most 5), to say what makes a horizontal scroll. */
export async function widest(page) {
  return page.evaluate(() => {
    const w = document.documentElement.clientWidth;
    const out = [];
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      if (r.right > w + 1 && r.width > 0 && getComputedStyle(el).position !== "fixed") {
        const name = `${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : ""}`;
        out.push(`${name} (right ${Math.round(r.right)}px)`);
      }
    }
    // The innermost ones say most.
    return out.slice(-5);
  });
}

/** The page's visible text, for a check by words. */
export const text = (page) => page.evaluate(() => document.body.innerText);

// ---------- a journey: checks, screenshots and the exit code ----------

/**
 * A journey's record. `check(ok, what, detail)` records a check; `step(name, fn)` runs a step and turns a thrown error
 * (a selector that never came) into a failed check with a screenshot; `shot(step)` saves
 * evidence/qa/<journey>/<width>-<step>.png; `pageChecks(view)` checks the horizontal scroll and the errors collected so far.
 */
export function journey(name) {
  const dir = join(EVIDENCE, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const results = [];
  const shots = [];
  const notes = [];
  let width = 0;
  let page;
  const j = {
    name,
    dir,
    get width() {
      return width;
    },
    /** The width and page the next checks and screenshots belong to. */
    at(w, p) {
      width = w;
      page = p;
      log(`\n${name} at ${w} wide:`);
    },
    check(ok, what, detail) {
      results.push({ width, ok: !!ok, what, ...(detail !== undefined ? { detail } : {}) });
      log(`  ${ok ? "✓" : "✗"} ${what}${!ok && detail !== undefined ? ` (${typeof detail === "string" ? detail : JSON.stringify(detail)})` : ""}`);
      return !!ok;
    },
    /** Something seen that is not a check: a wording or layout note for the UI audit. */
    note(what) {
      notes.push({ width, what });
      log(`  · ${what}`);
    },
    async shot(step, o = {}) {
      if (!page) return;
      const file = join(dir, `${width}-${step}.png`);
      try {
        if (o.locator) await o.locator.screenshot({ path: file });
        else await page.screenshot({ path: file, fullPage: o.full ?? true });
        shots.push(file);
      } catch (e) {
        log(`  (no screenshot ${step}: ${e instanceof Error ? e.message.split("\n")[0] : e})`);
      }
      return file;
    },
    async step(stepName, fn) {
      try {
        await fn();
        return true;
      } catch (e) {
        const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
        const file = await j.shot(`FAILED-${stepName.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}`);
        j.check(false, `${stepName}: the step did not complete`, `${msg}${file ? ` [${file}]` : ""}`);
        return false;
      }
    },
    /** No horizontal scroll, and no error the page collected since the last call. */
    async pageChecks(view) {
      if (!page) return;
      await page.waitForTimeout(250);
      const m = await horizontalScroll(page);
      if (m.scroll > m.client) j.check(false, `${view}: no horizontal scroll`, { scroll: m.scroll, client: m.client, wider: await widest(page) });
      else j.check(true, `${view}: no horizontal scroll`);
      const errs = page.qaErrors.splice(0);
      const nf = page.qaNotFound.splice(0);
      j.check(errs.length === 0, `${view}: no console error, page error or failed request`, [...errs.slice(0, 5), ...nf.slice(0, 3).map((u) => `404: ${u}`)]);
    },
    /** Print the summary, write result.json, and exit 1 when a check failed. */
    finish(extra = {}) {
      const failed = results.filter((r) => !r.ok);
      const summary = { journey: name, at: new Date().toISOString(), checks: results.length, failed: failed.length, results, notes, shots, ...extra };
      writeFileSync(join(dir, "result.json"), JSON.stringify(summary, null, 2));
      log(`\n${name}: ${results.length - failed.length} of ${results.length} checks passed; ${shots.length} screenshots in ${dir}`);
      if (failed.length) {
        console.error(`${failed.length} check${failed.length === 1 ? "" : "s"} failed:`);
        for (const f of failed) console.error(`  ✗ ${f.width}: ${f.what}`);
        process.exitCode = 1;
      }
      return summary;
    },
  };
  return j;
}

/**
 * Run `body(j, page, service, width)` at each width on a fresh service (state from `makeState()`), then finish.
 * A width that throws is recorded as a failed check; the next width still runs.
 */
export async function runJourney(name, makeState, body, o = {}) {
  const j = journey(name);
  const dist = await buildApp();
  const browser = await chrome();
  for (const width of o.widths ?? WIDTHS) {
    let service;
    let page;
    try {
      service = await startService(makeState, { ...o.service, dist });
      page = await openPage(browser, width, o.page);
      j.at(width, page);
      await body(j, page, service, width);
      // The errors left since the last check.
      const errs = page.qaErrors.splice(0);
      if (errs.length) j.check(false, "the end: no console error, page error or failed request", errs.slice(0, 5));
    } catch (e) {
      const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
      await j.shot("FAILED-abort");
      j.check(false, `the journey stopped`, msg);
    } finally {
      if (page) await page.qaContext.close().catch(() => {});
      if (service) {
        if (process.env.QA_SERVICE_LOG) writeFileSync(join(j.dir, `${width}-service.log`), service.logs.join("\n"));
        await service.stop().catch(() => {});
      }
    }
  }
  await browser.close();
  removeApp();
  return j.finish();
}

// ---------- hold a service open, to look at it by hand ----------
// node --import tsx scripts/qa/harness.mjs serve <demo|empty|preflight|floor> [--run] [--real]

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename) && process.argv[2] === "serve") {
  const which = process.argv[3] ?? "demo";
  const states = {
    demo: async () => (await import("../../src/domain/demo.ts")).buildDemo(Date.now()),
    empty: async () => (await import("../../src/domain/seed.ts")).buildEmptyProject(Date.now()),
    preflight: async () => (await import("../../src/ui/preflight/preflightScene.ts")).preflightScene().s,
    floor: async () => (await import("../../src/ui/floor/floorScene.ts")).floorScene().s,
  };
  const state = await states[which]();
  const dist = await buildApp();
  const service = await startService(state, { dist, run: process.argv.includes("--run"), realLooking: process.argv.includes("--real") });
  log(`Serving ${which} at ${service.origin} (data in ${service.dataDir}). Ctrl-C stops.`);
  process.on("SIGINT", async () => {
    await service.stop();
    process.exit(0);
  });
}
