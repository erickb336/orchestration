// The files of the demo's story on disk (the fake service only, for the sample project): each studio version's files
// and screenshots, which the prototype server and the app serve, and the screenshots of the demo's captures of
// evidence. The state records them (src/domain/demo.ts, from src/domain/demoVision.ts); this writes what they name,
// once, where the service keeps its own: <dataDir>/studio/<project>/artifacts/<id>/v<n>/ and
// <dataDir>/evidence/<project>/<run>/. A version is written only when every file's hash matches its record, so the
// prototype server serves it as it serves real work. The screenshots are PNGs rendered from the demo's own pages by
// scripts/media/demo-shots.mjs, each labelled simulated in the image.

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DEMO_VERSIONS, fileList, sha256Hex } from "../src/domain/demoVision";
import type { State } from "../src/domain/types";
import { studioRoot, versionDir, writeVersion, VERSION_MANIFEST } from "./studio/artifacts";
import { evidenceDir } from "./studio/evidence";

/** Where the rendered screenshots are kept in this repository. */
export const DEMO_SHOTS_DIR = resolve(import.meta.dirname, "demo-shots");

/** The rendered design screenshot of a version's variant on a device. */
export const designShotFile = (title: string, version: number, variant: string, device: string) => `${slug(title)}-v${version}-${variant}-${device}.png`;
const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-");

/** Write what the sample's records name and is not on disk yet. Returns how many folders it wrote. */
export function writeDemoFiles(dataDir: string, s: State): number {
  if (!s.project.sample) return 0;
  const root = studioRoot(dataDir, s.project.id);
  let written = 0;
  for (const a of s.studio.artifacts) {
    const v = DEMO_VERSIONS.find((x) => x.title === a.title && x.version === a.version);
    if (!v) continue;
    const listed = fileList(v);
    if (listed.length !== a.files.length || !listed.every((f) => a.files.some((r) => r.path === f.path && r.sha256 === f.sha256))) continue;
    const dir = versionDir(root, a.id, a.version);
    if (!existsSync(join(dir, VERSION_MANIFEST))) {
      const files = Object.entries(v.files).map(([path, text]) => {
        const data = Buffer.from(text, "utf8");
        return { path, sha256: sha256Hex(text), bytes: data.length, data };
      });
      writeVersion(root, { artifactId: a.id, version: a.version, kind: a.kind, title: a.title, devices: a.devices, variants: a.variants.map((x) => ({ id: x.id, label: x.label, entry: x.entry ?? "" })), files: files.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })) }, files);
      written++;
    }
    if (a.shots?.status === "taken") for (const shot of a.shots.shots) copyOnce(join(DEMO_SHOTS_DIR, designShotFile(a.title, a.version, shot.variant, shot.device)), join(dir, shot.path));
  }
  for (const art of s.artifacts) {
    if (art.kind !== "evidence" || !art.evidence?.simulated) continue;
    const dir = evidenceDir(dataDir, s.project.id, art.attemptId);
    if (!dir) continue;
    for (const item of art.evidence.items) if (item.status === "captured") for (const f of item.files) if (f.type === "png" && copyOnce(join(DEMO_SHOTS_DIR, builtShotFile(item.title, f.device ?? "desktop")), join(dir, f.path))) written++;
  }
  return written;
}

/** The rendered screenshot of what the demo "built" for a screen, on a device (labelled simulated in the image). */
export const builtShotFile = (title: string, device: string) => `${slug(title)}-built-${device}.png`;

function copyOnce(from: string, to: string): boolean {
  if (existsSync(to) || !existsSync(from)) return false;
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  return true;
}
