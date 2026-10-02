// Screenshots of an artifact version (ORC-029 pass 3, docs/design/ORC-029-pass3-design.md, 3b), for its history
// and for the PE in pass 4. Each variant is captured on each of the version's devices, desktop at 1280×800 and mobile
// at 390×844 and 3×, through playwright-core and the system Chrome (never a downloaded browser), and kept as
// <versionFolder>/shots/<variant>-<device>.png beside the files; the manifest is never changed. The prototype
// server (serve.ts) serves them as PNGs.
//
// The pages load from a private prototype server on a free loopback port, so they carry the same policy the app's
// frames do (no network). The page is the top window here, where that policy does not stop a navigation, so the
// browser is also allowed to load the version's own origin only. Every page has a time limit.

import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { prototypeOrigin } from "../../src/runtime/prototype";
import { SHOT_DEVICES, createPrototypeServer, readManifest, versionDir, type ShotDevice } from "./serve";

const SIZES: Record<ShotDevice, { viewport: { width: number; height: number }; deviceScaleFactor: number; isMobile: boolean; hasTouch: boolean }> = {
  desktop: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
};
const PAGE_TIMEOUT_MS = 20_000;

/**
 * The system Chrome through playwright-core: CHROME_PATH if set, or the installed Google Chrome. Never downloads a
 * browser. Says why there is none instead of throwing.
 */
export async function launchChrome(): Promise<{ browser: Browser } | { missing: string }> {
  let chromium: typeof import("playwright-core").chromium;
  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    return { missing: "playwright-core is not installed" };
  }
  const path = process.env.CHROME_PATH;
  try {
    return { browser: await chromium.launch({ headless: true, ...(path ? { executablePath: path } : { channel: "chrome" }) }) };
  } catch {
    return { missing: "no Chrome found" };
  }
}

export interface Shot {
  variant: string;
  device: ShotDevice;
  /** Relative to the version folder. */
  path: string;
}
export type ShotsOutcome = { skipped: string } | { shots: Shot[]; failed: { variant: string; device: ShotDevice; error: string }[] };

/** Rejects after `ms` with `what` in the message, so one page that never settles cannot hold the rest. */
function within<T>(ms: number, what: string, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms`)), ms)))]).finally(() => clearTimeout(timer));
}

/** The version's shots/ folder, made if needed; it must be a real folder in the real version folder, never a link. */
function shotsFolder(studioDir: string, artifactId: string, version: number): string {
  const dir = versionDir(studioDir, artifactId, version);
  if (realpathSync(dir) !== versionDir(realpathSync(studioDir), artifactId, version)) throw new Error("The version folder is a link.");
  const shots = join(dir, "shots");
  mkdirSync(shots, { recursive: true });
  const st = lstatSync(shots);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("shots/ is not a folder.");
  return shots;
}

/**
 * Captures every variant of one artifact version on each of its devices (desktop and mobile; a terminal artifact
 * has none). For the studio service to call once a version is imported. Never throws: a page that fails or times
 * out is listed in `failed`, and without Chrome nothing is captured (`skipped`).
 */
export async function captureShots(opts: { studioDir: string; artifactId: string; version: number; timeoutMs?: number; log?: (msg: string) => void }): Promise<ShotsOutcome> {
  const { studioDir, artifactId, version } = opts;
  const timeout = opts.timeoutMs ?? PAGE_TIMEOUT_MS;
  const log = opts.log ?? (() => {});
  const manifest = readManifest(studioDir, artifactId, version);
  if (!manifest) return { skipped: `no manifest for ${artifactId} v${version}` };
  const devices = SHOT_DEVICES.filter((d) => manifest.devices.includes(d));
  if (!devices.length || !manifest.variants.length) return { shots: [], failed: [] };

  const chrome = await launchChrome();
  if ("missing" in chrome) return { skipped: chrome.missing };
  const { browser } = chrome;
  const server = createPrototypeServer({ studioDir: () => studioDir, appOrigins: ["'none'"] });
  const out: Extract<ShotsOutcome, { shots: Shot[] }> = { shots: [], failed: [] };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const origin = prototypeOrigin(artifactId, version, (server.address() as { port: number }).port);
    const shots = shotsFolder(studioDir, artifactId, version);
    for (const variant of manifest.variants) {
      for (const device of devices) {
        const context = await browser.newContext({ ...SIZES[device], serviceWorkers: "block", acceptDownloads: false });
        try {
          await context.route("**/*", (route) => (route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort("blockedbyclient")));
          const page = await context.newPage();
          await page.goto(`${origin}/${variant.entry}`, { waitUntil: "load", timeout });
          await within(timeout, "Waiting for fonts", page.evaluate("document.fonts.ready.then(() => undefined)"));
          const png = await page.screenshot({ timeout, animations: "disabled", caret: "hide" });
          // Written whole, then renamed over any older shot: a reader sees the old file or the new one, and a link
          // left at the name is replaced, not followed.
          const name = `${variant.id}-${device}.png`;
          const tmp = join(shots, `.${randomUUID()}.tmp`);
          writeFileSync(tmp, png, { flag: "wx" });
          renameSync(tmp, join(shots, name));
          out.shots.push({ variant: variant.id, device, path: `shots/${name}` });
        } catch (e) {
          const error = (e instanceof Error ? e.message : String(e)).split("\n")[0];
          log(`Screenshot of ${artifactId} v${version} ${variant.id} on ${device} failed: ${error}`);
          out.failed.push({ variant: variant.id, device, error });
        } finally {
          await within(timeout, "Closing the page", context.close()).catch(() => {});
        }
      }
    }
  } catch (e) {
    const error = (e instanceof Error ? e.message : String(e)).split("\n")[0];
    log(`Screenshots of ${artifactId} v${version} failed: ${error}`);
    for (const variant of manifest.variants) for (const device of devices) if (!out.shots.some((s) => s.variant === variant.id && s.device === device)) out.failed.push({ variant: variant.id, device, error });
  } finally {
    await within(timeout, "Closing Chrome", browser.close()).catch(() => {});
    server.closeAllConnections();
    server.close();
  }
  return out;
}
