// The demo's files on disk: every studio version the sample records is written once, served by the prototype
// server's own checks (each file's hash), with its screenshots; the captures' screenshots are where the app reads them.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildDemo } from "../src/domain/demo";
import { DEMO_BUILT_SHOTS } from "../src/domain/demoShots";
import { evidenceFileKnown } from "../src/domain/studio/evidence";
import { builtShotFile } from "../src/domain/demoVision";
import { DEMO_SHOTS_DIR, writeDemoFiles } from "./demoFiles";
import { appEvidenceFile } from "./studio/evidence";
import { projectStudioDir, readServedFile } from "./studio/serve";
import { createHash } from "node:crypto";

const T0 = Date.parse("2026-10-01T12:00:00Z");
let dir = "";
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the demo's files", () => {
  it("writes each studio version the sample records, served with its hashes checked, and its screenshots; a second start writes nothing", () => {
    dir = mkdtempSync(join(tmpdir(), "orc-demo-files-"));
    const s = buildDemo(T0);
    expect(writeDemoFiles(dir, s)).toBeGreaterThan(0);
    const studio = projectStudioDir(dir, s.project.id)!;
    for (const a of s.studio.artifacts) {
      for (const f of a.files) expect(readServedFile(studio, a.id, a.version, f.path), `${a.title} v${a.version} ${f.path}`).toBeDefined();
      if (a.kind === "screen") {
        expect(a.shots?.status).toBe("taken");
        if (a.shots?.status === "taken") for (const shot of a.shots.shots) expect(readServedFile(studio, a.id, a.version, shot.path)?.ext, `${a.title} v${a.version} ${shot.path}`).toBe(".png");
      }
    }
    expect(writeDemoFiles(dir, s)).toBe(0);
  });

  it("puts each simulated capture's screenshots where the app serves them, the same bytes its record names", () => {
    dir = mkdtempSync(join(tmpdir(), "orc-demo-files-"));
    const s = buildDemo(T0);
    writeDemoFiles(dir, s);
    const captured = s.artifacts.filter((a) => a.kind === "evidence" && a.evidence?.items.some((i) => i.status === "captured"));
    for (const art of captured) {
      expect(art.evidence?.simulated).toBe(true);
      for (const item of art.evidence!.items) {
        if (item.status !== "captured") continue;
        for (const f of item.files) {
          const r = appEvidenceFile(dir, s.project.id, new URLSearchParams({ evidence: art.attemptId, path: f.path }), (run, path) => evidenceFileKnown(s, run, path));
          expect(r.ok, `${art.taskId} ${f.path}`).toBe(true);
          if (r.ok) expect({ bytes: r.body.length, sha256: createHash("sha256").update(r.body).digest("hex") }).toEqual({ bytes: f.bytes, sha256: f.sha256 });
        }
      }
    }
    // The rendered screenshots in the repository are the ones demoShots.ts names.
    for (const [name, want] of Object.entries(DEMO_BUILT_SHOTS)) {
      const data = readFileSync(join(DEMO_SHOTS_DIR, name));
      expect({ bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") }, name).toEqual(want);
    }
    expect(Object.keys(DEMO_BUILT_SHOTS)).toContain(builtShotFile("Trip page", "desktop"));
  });
});
