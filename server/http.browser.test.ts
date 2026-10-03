// The app's own pages in a real browser (ORC-029 F2; pass 4 review, finding 2): the real UI, built by Vite, served by
// the real service with its policy (appPagePolicy), in the system Chrome through playwright-core.
//
// - A designer's hostile Mermaid and Markdown, shown in the studio as the owner sees them, load nothing: no request
//   leaves the page, whatever the diagram says. The checks look at the effects (what an outside server and the browser
//   received), not at the app's own record.
// - A control draws the same diagrams with Mermaid in a page without the diagram frame and without the policy, and
//   shows they do reach the outside server, so the checks above can see an escape.
// - Every screen of the demo loads under the policy with no error in the console.
//
// Without Chrome these tests are skipped, with the reason printed.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer, type IncomingMessage, type OutgoingHttpHeaders, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDemo } from "../src/domain/demo";
import type { State } from "../src/domain/types";
import { appPagePolicy, createHttpServer } from "./http";
import { FakeAdapter, defaultFakeConfig } from "./runtimes/fake";
import { Scheduler } from "./scheduler";
import { Store } from "./store";
import { createPrototypeServer, projectStudioDir } from "./studio/serve";
import { launchChrome } from "./studio/shots";
import { close, hostileDocuments, listen, studioSample, writeVersion } from "./studio/testFixtures";

const chrome = await launchChrome();
const browser: Browser | undefined = "browser" in chrome ? chrome.browser : undefined;
if (!browser) process.stderr.write(`Skipping the app's pages in a real browser: ${"missing" in chrome ? chrome.missing : ""}. Install Google Chrome or set CHROME_PATH.\n`);

const REPO = join(import.meta.dirname, "..");
let root: string;
let ext: string;
let outside: Server;
const outsideRequests: string[] = [];
/** The app, served by the real service: its origin, and its store. */
type App = { origin: string; protoPort: number; store: Store; close: () => Promise<void>; bare: string };
let vision: App;
let demo: App;

/** The real service's HTTP server and prototype server over `state`, with each version's files written where the studio keeps them. */
async function serve(name: string, state: State, versions: ReturnType<typeof studioSample>["versions"], dist: string): Promise<App> {
  const dataDir = join(root, name);
  const store = new Store(join(dataDir, "test.db"), () => state);
  const studioDir = projectStudioDir(dataDir, store.read().state.project.id)!;
  for (const v of versions) writeVersion(studioDir, v.id, v.version, v.files, v.meta);
  const config = defaultFakeConfig();
  const scheduler = new Scheduler(store, { claude: new FakeAdapter("claude", config), codex: new FakeAdapter("codex", config) });
  const free = async () => {
    const probe = createServer();
    const port = await listen(probe);
    await close(probe);
    return port;
  };
  const [appPort, barePort] = [await free(), await free()];
  const prototypes = createPrototypeServer({ studioDir: () => studioDir, appOrigins: [`http://127.0.0.1:${appPort}`, `http://127.0.0.1:${barePort}`] });
  const protoPort = await listen(prototypes);
  const options = { store, scheduler, startedAt: new Date().toISOString(), staticDir: dist, dataDir, prototypePort: protoPort, prototypeServer: prototypes };
  const app = createHttpServer({ ...options, allowedHosts: [`127.0.0.1:${appPort}`] });
  // The same service with its pages' policy taken off, to show what the diagram frame does on its own.
  const handle = createHttpServer({ ...options, allowedHosts: [`127.0.0.1:${barePort}`] }).listeners("request")[0] as (req: IncomingMessage, res: ServerResponse) => void;
  const bare = createServer((req, res) => {
    const writeHead = res.writeHead.bind(res) as (status: number, headers?: OutgoingHttpHeaders) => ServerResponse;
    res.writeHead = ((status: number, headers?: OutgoingHttpHeaders) => writeHead(status, Object.fromEntries(Object.entries(headers ?? {}).filter(([k]) => k.toLowerCase() !== "content-security-policy")))) as ServerResponse["writeHead"];
    handle(req, res);
  });
  for (const [server, port] of [[app, appPort], [bare, barePort]] as const) await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  return {
    origin: `http://127.0.0.1:${appPort}`,
    bare: `http://127.0.0.1:${barePort}`,
    protoPort,
    store,
    close: async () => {
      await close(app);
      await close(bare);
      await close(prototypes);
      store.close();
    },
  };
}

beforeAll(async () => {
  if (!browser) return;
  root = mkdtempSync(join(tmpdir(), "orc-app-browser-"));
  const dist = join(root, "dist");
  // The production build, as npm run build makes it (the test runner sets NODE_ENV to "test").
  const env = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    await build({ root: REPO, configFile: join(REPO, "vite.config.ts"), mode: "production", logLevel: "silent", build: { outDir: dist, emptyOutDir: true } });
  } finally {
    process.env.NODE_ENV = env;
  }
  outside = createServer((req, res) => {
    outsideRequests.push(req.url ?? "");
    res.writeHead(200, { "Content-Type": "image/png", "Access-Control-Allow-Origin": "*" });
    res.end();
  });
  ext = `http://127.0.0.1:${await listen(outside)}`;
  const sample = studioSample(Date.now(), { ext });
  vision = await serve("vision", sample.state, sample.versions, dist);
  demo = await serve("demo", buildDemo(Date.now()), [], dist);
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await vision?.close();
  await demo?.close();
  await close(outside);
  if (root) rmSync(root, { recursive: true, force: true });
});

/**
 * A fresh context that records every request the browser makes, with how it ended ("blocked by the policy" when the
 * browser refused it before it left), and the page's console errors (its frames' too).
 */
async function open(): Promise<{ context: BrowserContext; page: Page; seen: string[]; outcomes: Map<string, string>; errors: string[] }> {
  const context = await browser!.newContext({ viewport: { width: 1280, height: 900 } });
  const seen: string[] = [];
  const outcomes = new Map<string, string>();
  context.on("request", (r) => seen.push(r.url()));
  context.on("requestfinished", (r) => outcomes.set(r.url(), "finished"));
  context.on("requestfailed", (r) => outcomes.set(r.url(), ["csp", "net::ERR_BLOCKED_BY_CSP"].includes(r.failure()?.errorText ?? "") ? "blocked by the policy" : `failed: ${r.failure()?.errorText}`));
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(`page error: ${e.message}`));
  return { context, page, seen, outcomes, errors };
}

/** Opens an artifact of the studio by its title, and waits until no diagram is still being drawn. */
async function showArtifact(page: Page, title: string): Promise<void> {
  await page.getByRole("button", { name: new RegExp(`^${title}`) }).click();
  // Functions, not source: waiting on source evaluates a string in the page, which the app's policy refuses.
  const doc = { label: `${title}, a document` };
  await page.waitForFunction((d) => (globalThis as unknown as { document: { querySelector(s: string): unknown } }).document.querySelector(`[aria-label="${d.label}"]`) !== null, doc, { timeout: 10_000 });
  await page.waitForFunction(() => !/Drawing the diagram…|Reading /.test((globalThis as unknown as { document: { body: { innerText: string } } }).document.body.innerText), undefined, { timeout: 45_000 });
}

/** The diagrams on the page: each one's text alternative and drawing (decoded), or the reason it is not drawn. */
const diagrams = (page: Page) =>
  page.evaluate(`[...document.querySelectorAll("figure.st-doc__diagram")].map((f) => {
    const img = f.querySelector("img");
    return img ? { alt: img.alt, svg: decodeURIComponent(img.src.replace(/^data:image\\/svg\\+xml;charset=utf-8,/, "")) } : { error: f.querySelector("p")?.textContent ?? "" };
  })`) as Promise<({ alt: string; svg: string } | { error: string })[]>;

describe.skipIf(!browser)("the app's pages in a real browser", () => {
  it.each(["with the app's policy", "without it: the diagram frame alone"])("a designer's hostile Mermaid and Markdown load nothing, %s: no request leaves the page, and the diagrams are drawn as images", async (how) => {
    const origin = how === "with the app's policy" ? vision.origin : vision.bare;
    const { context, page, seen, outcomes } = await open();
    const start = outsideRequests.length;
    const response = await page.goto(`${origin}/#/vision`);
    expect(response?.headers()["content-security-policy"]).toBe(origin === vision.origin ? appPagePolicy(vision.protoPort) : undefined);
    await showArtifact(page, "Hostile samples");
    const drawn = await diagrams(page);
    await page.waitForTimeout(1000);

    // Nothing reached the outside server. The browser refused, before it left, every request not to the app's own origin.
    expect(outsideRequests.slice(start)).toEqual([]);
    const away = seen.filter((u) => !u.startsWith(`${origin}/`) && !u.startsWith("data:"));
    expect(away.map((u) => [u, outcomes.get(u)]).filter(([, o]) => o !== "blocked by the policy")).toEqual([]);
    // Mermaid ran in the sandboxed frame, never in the page: its own origin is opaque and it has no allow-same-origin.
    expect(await page.evaluate(`[...document.querySelectorAll("iframe.st-diagram-frame")].map((f) => f.getAttribute("sandbox"))`)).toEqual(["allow-scripts"]);
    expect(await page.evaluate("typeof window.mermaid")).toBe("undefined");
    // The locked keys: a directive's or front matter's themeCSS and fonts are dropped, so the drawing names no URL of theirs.
    const byAlt = (path: string) => drawn.find((d) => "alt" in d && d.alt.endsWith(path)) as { alt: string; svg: string } | undefined;
    for (const path of ["bad/theme-css.mmd", "bad/front-matter.mmd"]) {
      expect(byAlt(path)?.svg).toBeDefined();
      expect(byAlt(path)!.svg.includes(ext)).toBe(false);
    }
    // An image shape cannot be drawn without its image, which may not load; the reason shows.
    expect(drawn).toEqual(expect.arrayContaining([{ error: expect.stringContaining("The diagram cannot be drawn") }]));
    // The Markdown: raw HTML as text, the remote images not shown, the links not followed.
    const text = await page.evaluate(`document.querySelector('[aria-label="bad/hostile.md"]').innerText`);
    expect(text).toContain("[Image: remote image, not shown");
    expect(text).toContain(`<img src="${ext}/md-raw-img.png">`);
    await context.close();
  }, 120_000);

  it("a document's Markdown and Mermaid are drawn: the diagram file and the diagram in the Markdown, as images", async () => {
    const { context, page, seen, errors } = await open();
    await page.goto(`${vision.origin}/#/vision`);
    await showArtifact(page, "Trip planner API");
    const drawn = await diagrams(page);
    expect(drawn.map((d) => ("alt" in d ? d.alt : d.error))).toEqual(["A diagram in api/README.md", "The diagram in api/flow.mmd"]);
    for (const d of drawn) expect("svg" in d && d.svg.startsWith("<svg")).toBe(true);
    expect((drawn[1] as { svg: string }).svg).toContain("stops</tspan>");
    expect(seen.filter((u) => !u.startsWith(`${vision.origin}/`) && !u.startsWith("data:"))).toEqual([]);
    expect(errors).toEqual([]);
    await context.close();
  }, 60_000);

  it("Mermaid in the page itself (no frame): without the policy the diagrams reach the outside server (the control); with the app's policy alone, nothing does", async () => {
    const docs = hostileDocuments(ext);
    const files: Record<string, [string, string | Buffer]> = {
      "/": ["text/html", '<!doctype html><meta charset="utf-8"><body><script src="/mermaid.js"></script><script src="/draw.js"></script>'],
      "/mermaid.js": ["text/javascript", readFileSync(createRequire(import.meta.url).resolve("mermaid/dist/mermaid.min.js"))],
      "/draw.js": [
        "text/javascript",
        `(async () => {
          mermaid.initialize({ startOnLoad: false, securityLevel: "strict", htmlLabels: false });
          for (const [i, src] of ${JSON.stringify([docs["bad/theme-css.mmd"], docs["bad/image-shape.mmd"]])}.entries()) await mermaid.render("c" + i, src).catch(() => {});
          window.__done = true;
        })();`,
      ],
    };
    const reached: string[][] = [];
    for (const policy of [undefined, appPagePolicy(vision.protoPort)]) {
      const plain = createServer((req, res) => {
        const [type, body] = files[req.url ?? ""] ?? files["/"];
        res.writeHead(200, { "Content-Type": type, ...(policy ? { "Content-Security-Policy": policy } : {}) });
        res.end(body);
      });
      const port = await listen(plain);
      const { context, page } = await open();
      const start = outsideRequests.length;
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.waitForFunction(() => (globalThis as { __done?: boolean }).__done === true, undefined, { timeout: 30_000 });
      await page.waitForTimeout(1000);
      reached.push([...new Set(outsideRequests.slice(start))].sort());
      await context.close();
      await close(plain);
    }
    expect(reached).toEqual([["/image-shape.png", "/theme-bg", "/theme-fill"], []]);
  }, 60_000);

  it("every screen of the demo loads under the policy, with no error in the console", async () => {
    const tasks = demo.store.read().state.tasks;
    const routes = ["#/overview", "#/vision", "#/vision/lock-in", "#/tasks", "#/results", "#/results/design", "#/activity", "#/settings/working-style", "#/settings/project", "#/settings/agents", "#/settings/quality", "#/settings/advanced", "#/kit", `#/task/${encodeURIComponent(tasks[0].id)}`];
    const failures: Record<string, string[]> = {};
    for (const [origin, list] of [[demo.origin, routes], [vision.origin, ["#/vision", "#/settings/project"]]] as const) {
      for (const route of list) {
        const { context, page, errors } = await open();
        const response = await page.goto(`${origin}/${route}`);
        expect(response?.headers()["content-security-policy"]).toContain("default-src 'self'");
        await page.waitForFunction(() => ((globalThis as unknown as { document: { querySelector(s: string): { children: { length: number } } | null } }).document.querySelector("#root")?.children.length ?? 0) > 0, undefined, { timeout: 10_000 });
        await page.waitForTimeout(700);
        if (errors.length) failures[`${origin === demo.origin ? "demo" : "vision"} ${route}`] = errors;
        await context.close();
      }
    }
    expect(failures).toEqual({});
  }, 180_000);
});
