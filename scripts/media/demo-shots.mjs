#!/usr/bin/env node
// Render the demo's screenshots (run again when src/domain/demoVision.ts changes a screen):
//
//   node --import tsx scripts/media/demo-shots.mjs
//
// It writes into server/demo-shots/:
//   <screen>-v<n>-<variant>-<device>.png  each screen version's design, as the studio's own screenshots show it;
//   <screen>-built-<device>.png            what the demo's factory "built", for its simulated captures of evidence.
// A built page carries a band that says it is a simulated screenshot. Then it writes src/domain/demoShots.ts, the
// size and SHA-256 of each built screenshot, which the demo's evidence records name. It drives the installed Google
// Chrome through playwright-core (or CHROME_PATH), with no network, and downloads nothing.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { DEMO_VERSIONS, SAMPLE_BAND, builtShotFile, demoVersion, designShotFile } from "../../src/domain/demoVision.ts";
import { DEMO_SHOTS_DIR } from "../../server/demoFiles.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const DEVICES = {
  desktop: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, isMobile: false },
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true },
};
/** The band on a built page: the demo built nothing, so the screenshot is simulated. */
const BUILT_BAND = "Simulated screenshot: the demo's factory built nothing; this stands in for a capture of the built app.";
/** What the demo's factory "built": the trip page as designed, and the packing list without who brings each item (the UX review's difference). */
const BUILT = [
  { title: "Trip page", from: ["Trip page", 1], variant: "A", edit: (html) => html },
  { title: "Packing list", from: ["Packing list", 2], variant: "A", edit: (html) => html.replace(/<span class="muted">(Ana|Ben|Nobody yet)<\/span>/g, '<span class="muted"></span>') },
];

const tmp = mkdtempSync(join(tmpdir(), "orc-demo-shots-"));
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }) });
try {
  mkdirSync(DEMO_SHOTS_DIR, { recursive: true });
  const write = (dir, files) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
  };
  const shoot = async (file, device, out) => {
    const ctx = await browser.newContext({ ...DEVICES[device], offline: true, colorScheme: "light", reducedMotion: "reduce" });
    const page = await ctx.newPage();
    await page.goto(pathToFileURL(file).href, { waitUntil: "load" });
    const raw = `${out}.raw.png`;
    await page.screenshot({ path: raw, animations: "disabled" });
    await ctx.close();
    // An 8-bit palette keeps the repository small; flat sample pages lose nothing visible.
    const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", raw, "-vf", "split[a][b];[a]palettegen=max_colors=96:stats_mode=full[p];[b][p]paletteuse=dither=none", out], { encoding: "utf8" });
    rmSync(raw, { force: true });
    if (r.status !== 0) throw new Error(`ffmpeg failed on ${out}: ${r.stderr}`);
  };
  for (const v of DEMO_VERSIONS.filter((x) => x.kind === "screen")) {
    const dir = join(tmp, `${v.title}-v${v.version}`);
    write(dir, v.files);
    for (const variant of v.variants) for (const device of v.devices) await shoot(join(dir, variant.entry), device, join(DEMO_SHOTS_DIR, designShotFile(v.title, v.version, variant.id, device)));
  }
  const built = {};
  for (const b of BUILT) {
    const v = demoVersion(...b.from);
    const dir = join(tmp, `${b.title}-built`);
    const entry = v.variants.find((x) => x.id === b.variant).entry;
    write(dir, { ...v.files, [entry]: b.edit(v.files[entry].replace(SAMPLE_BAND, BUILT_BAND).replace('class="sim"', 'class="sim" style="background:#ffd9d2;color:#6b1d0f"')) });
    for (const device of ["desktop", "mobile"]) {
      const name = builtShotFile(b.title, device);
      await shoot(join(dir, entry), device, join(DEMO_SHOTS_DIR, name));
      const data = readFileSync(join(DEMO_SHOTS_DIR, name));
      built[name] = { bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") };
    }
  }
  const ts = `// Written by scripts/media/demo-shots.mjs: the size and SHA-256 of each simulated "built" screenshot in
// server/demo-shots/, which the demo's captures of evidence name (src/domain/demo.ts). Do not edit by hand.

export const DEMO_BUILT_SHOTS: Readonly<Record<string, { bytes: number; sha256: string }>> = ${JSON.stringify(built, null, 2)};
`;
  writeFileSync(join(ROOT, "src", "domain", "demoShots.ts"), ts);
  console.log(`demo-shots: wrote ${DEMO_SHOTS_DIR.replace(`${ROOT}/`, "")} and src/domain/demoShots.ts`);
} finally {
  await browser.close();
  rmSync(tmp, { recursive: true, force: true });
}
