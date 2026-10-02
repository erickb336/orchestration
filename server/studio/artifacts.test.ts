// ORC-029 pass 3a: what a designer run hands in. Its studio.json is checked at the boundary (kinds, file types, sizes,
// paths inside the folder, no links, entries among the files), and each artifact is recorded and copied into the
// immutable version folder the prototype server reads, with manifest.json in the agreed layout.

import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCommand } from "../../src/domain/commands";
import * as M from "../../src/domain/model";
import { buildSeed } from "../../src/domain/seed";
import * as R from "../../src/domain/studio/runs";
import * as S from "../../src/domain/studio/studio";
import { DESIGNER_KINDS } from "../../src/domain/studio/types";
import { ControlError, type State } from "../../src/domain/types";
import { ManifestError, readStaged, studioRoot, versionDir, writeVersion } from "./artifacts";
import { importDesignerRun } from "./runs";

const T0 = Date.parse("2026-10-02T09:00:00Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

let dir: string;
let staging: string;
let outside: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orc029-artifacts-"));
  staging = join(dir, "studio", "p-1", "staging", "studio-3");
  outside = join(dir, "outside");
  mkdirSync(staging, { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "not yours\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const PAGES: Record<string, string> = {
  "a/index.html": "<!doctype html><title>A</title><link rel=stylesheet href=style.css><h1>Map first</h1>",
  "a/style.css": "h1 { color: teal; }",
  "b/index.html": "<!doctype html><title>B</title><link rel=stylesheet href=style.css><h1>Day by day</h1>",
  "b/style.css": "h1 { color: navy; }",
};
const TRIP_PLAN = {
  kind: "screen",
  title: "Trip plan",
  devices: ["desktop", "mobile"],
  variants: [
    { id: "a", label: "A · Map first", entry: "a/index.html" },
    { id: "b", label: "B · Day by day", entry: "b/index.html" },
  ],
  files: Object.keys(PAGES),
};
function stage(manifest: unknown = { artifacts: [TRIP_PLAN] }, files: Record<string, string> = PAGES) {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(staging, p)), { recursive: true });
    writeFileSync(join(staging, p), text);
  }
  if (manifest !== null) writeFileSync(join(staging, "studio.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
}
const refusal = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ManifestError);
    return (e as Error).message;
  }
  throw new Error("expected the manifest to be refused");
};
const read = () => readStaged(staging, DESIGNER_KINDS);

/** A project in Vision with round 1 open and a designer run running in it (revising `artifactId` when given). */
function withRun(artifactId?: string, base?: State): { s: State; runId: string } {
  let s = base ?? runCommand(M.initProject(buildSeed(T0, { inFlightRuns: false }), { name: "Trips", repoPath: "/tmp/trips", vision: "Weekend trips.", focus: "" }, at(0)), "openRound", { focus: "experience" }, at(1)).state;
  const asked = runCommand(s, "startStudioRun", { kind: "designer", round: 1, brief: "Make the trip plan.", ...(artifactId ? { artifactId } : {}) }, at(2));
  const runId = (asked.result as { runId: string }).runId;
  s = R.dispatchStudioRuns(asked.state, at(3)).state;
  return { s, runId };
}

describe("reading studio.json", () => {
  it("reads every listed file once, with its hash and size", () => {
    stage();
    const [a] = read();
    expect({ ...a, files: a.files.map(({ data, ...f }) => ({ ...f, text: data.toString("utf8") })) }).toEqual({
      kind: "screen",
      title: "Trip plan",
      devices: ["desktop", "mobile"],
      variants: TRIP_PLAN.variants,
      files: Object.entries(PAGES).map(([path, text]) => ({ path, sha256: sha(text), bytes: Buffer.byteLength(text), text })),
    });
  });

  it("takes a terminal demo's tape, its script, and hand-written .cast and .ans files", () => {
    const files = { "a/demo.tape": "Output demo.gif\nSet Columns 80\nSet Rows 24\n", "a/demo.js": "console.log('trips')", "b/demo.cast": '{"version": 3, "term": {"cols": 80, "rows": 24}}\n', "b/plan.ans": "Trips\n" };
    stage({ artifacts: [{ kind: "terminal-demo", title: "trips", variants: [{ id: "a", label: "Recorded", entry: "a/demo.tape" }, { id: "b", label: "Hand-written", entry: "b/demo.cast" }], files: Object.keys(files) }] }, files);
    expect(read()[0].files.map((f) => f.path)).toEqual(Object.keys(files));
  });

  it("refuses a missing or broken studio.json, and kinds this run does not make", () => {
    stage(null);
    expect(refusal(read)).toBe("the run wrote no studio.json.");
    stage("{ not json");
    expect(refusal(read)).toBe("studio.json is not valid JSON.");
    stage({ screens: [] });
    expect(refusal(read)).toBe('studio.json has no "artifacts" list.');
    stage({ artifacts: [{ ...TRIP_PLAN, kind: "material" }] });
    expect(refusal(read)).toBe('artifact 1: the kind "material" is not one this run makes (screen, terminal-demo, tui, contract, flow).');
  });

  it("refuses file types outside the allowlist, paths outside the folder, the service's own manifest, and entries that are not files", () => {
    const tryFiles = (files: string[], extra: Record<string, string> = {}) => {
      stage({ artifacts: [{ ...TRIP_PLAN, files: [...TRIP_PLAN.files, ...files] }] }, { ...PAGES, ...extra });
      return refusal(read);
    };
    expect(tryFiles(["run.sh"], { "run.sh": "curl evil" })).toBe('artifact 1: "run.sh" is not an allowed file type (html, css, js, svg, png, jpg, jpeg, webp, woff2, json, txt, md, mmd, tape, cast, ans).');
    expect(tryFiles(["a/Index.HTML"], { "a/Index.HTML": "<p>" })).toMatch(/"a\/Index.HTML" is not an allowed file type/);
    expect(tryFiles(["/etc/hosts.txt"])).toBe('artifact 1: "/etc/hosts.txt" is not a relative path inside the run\'s folder (no absolute paths, no "..").');
    expect(tryFiles(["../outside/secret.txt"])).toMatch(/"\.\.\/outside\/secret\.txt" is not a relative path inside the run's folder/);
    expect(tryFiles(["a/../../x.txt"])).toMatch(/is not a relative path inside the run's folder/);
    expect(tryFiles(["manifest.json"], { "manifest.json": "{}" })).toBe('artifact 1: "manifest.json" is reserved for the service.');
    expect(tryFiles(["MANIFEST.json"], { "MANIFEST.json": "{}" })).toBe('artifact 1: "MANIFEST.json" is reserved for the service.');
    // The service's own folders of a version: the pin script's path, the screenshots and the recordings.
    const reserved = "is in a folder reserved for the service (__orchestrator/, shots/, recording/).";
    expect(tryFiles(["__orchestrator/pin.js"], { "__orchestrator/pin.js": "1" })).toBe(`artifact 1: "__orchestrator/pin.js" ${reserved}`);
    expect(tryFiles(["shots/a-desktop.png"], { "shots/a-desktop.png": "png" })).toBe(`artifact 1: "shots/a-desktop.png" ${reserved}`);
    expect(tryFiles(["Shots/a-mobile.png"], { "Shots/a-mobile.png": "png" })).toBe(`artifact 1: "Shots/a-mobile.png" ${reserved}`);
    expect(tryFiles(["recording/a/demo.gif.txt"], { "recording/a/demo.gif.txt": "x" })).toBe(`artifact 1: "recording/a/demo.gif.txt" ${reserved}`);
    // Only at the top of the version: a variant may have a folder of that name.
    stage({ artifacts: [{ ...TRIP_PLAN, files: [...TRIP_PLAN.files, "a/shots/hero.png", "shots.txt"] }] }, { ...PAGES, "a/shots/hero.png": "png", "shots.txt": "notes" });
    expect(read()[0].files.map((f) => f.path)).toContain("a/shots/hero.png");
    expect(tryFiles(["A/style.css"], { "A/style.css": "h1 {}" })).toBe("artifact 1 lists a file twice (paths that differ only in case are one file on this disk).");
    expect(tryFiles(["a/missing.css"])).toBe('"a/missing.css" is listed but is not in the run\'s folder.');
    stage({ artifacts: [{ ...TRIP_PLAN, variants: [{ id: "a", label: "A", entry: "a/home.html" }] }] });
    expect(refusal(read)).toBe('artifact 1: the entry "a/home.html" of variant "a" is not one of its files.');
  });

  it("refuses symbolic links, to a file or through a folder, and hard links: nothing outside the folder is read", () => {
    const withLink = (make: () => void, file: string) => {
      rmSync(staging, { recursive: true, force: true });
      mkdirSync(staging, { recursive: true });
      stage({ artifacts: [{ ...TRIP_PLAN, files: [...TRIP_PLAN.files, file] }] });
      make();
      return refusal(read);
    };
    expect(withLink(() => symlinkSync(join(outside, "secret.txt"), join(staging, "a", "notes.txt")), "a/notes.txt")).toBe('"a/notes.txt": it is a symbolic link; links are not imported.');
    expect(withLink(() => symlinkSync(outside, join(staging, "linked")), "linked/secret.txt")).toBe('"linked/secret.txt": the folder "linked" is a symbolic link; links are not imported.');
    expect(withLink(() => linkSync(join(outside, "secret.txt"), join(staging, "a", "copy.txt")), "a/copy.txt")).toBe('"a/copy.txt" is a hard link; links are not imported.');
  });

  it("refuses a page with an ES module script, in any HTML file, and takes plain and inline scripts", () => {
    const why = "plain scripts only (no ES modules): a module needs a CORS header that would let other websites read local prototypes.";
    for (const tag of ['<script type="module" src="app.js"></script>', "<SCRIPT defer type = 'module'>import './x.js'</SCRIPT>", "<script type=module>1</script>"]) {
      stage({ artifacts: [TRIP_PLAN] }, { ...PAGES, "b/index.html": `<!doctype html><h1>B</h1>${tag}` });
      expect(refusal(read)).toBe(`artifact 1: "b/index.html" has a <script type="module">: ${why}`);
    }
    // A page that is not an entry is checked too: an entry can link to it.
    stage({ artifacts: [{ ...TRIP_PLAN, files: [...TRIP_PLAN.files, "a/more.html"] }] }, { ...PAGES, "a/more.html": '<script type="module" src="m.js"></script>' });
    expect(refusal(read)).toBe(`artifact 1: "a/more.html" has a <script type="module">: ${why}`);
    // Plain scripts, inline or from a file, and inline styles are fine.
    const plain = '<!doctype html><style>h1 { color: teal; }</style><h1 style="margin: 0">A</h1><script>document.title = "A";</script><script src="app.js"></script><script type="text/javascript">1</script>';
    stage({ artifacts: [TRIP_PLAN] }, { ...PAGES, "a/index.html": plain });
    expect(read()[0].files.find((f) => f.path === "a/index.html")!.data.toString()).toBe(plain);
  });

  it("refuses a file over 2 MB and an artifact over 20 MB", () => {
    const big = "x".repeat(2 * 1024 * 1024 + 1);
    stage({ artifacts: [{ ...TRIP_PLAN, files: [...TRIP_PLAN.files, "a/big.txt"] }] }, { ...PAGES, "a/big.txt": big });
    expect(refusal(read)).toBe('"a/big.txt" is 2.0 MB, over the 2.0 MB limit.');
    const chunk = "y".repeat(1.9 * 1024 * 1024);
    const many = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`assets/part-${i}.txt`, chunk]));
    stage({ artifacts: [{ ...TRIP_PLAN, files: [...TRIP_PLAN.files, ...Object.keys(many)] }] }, { ...PAGES, ...many });
    expect(refusal(read)).toBe("artifact 1 is over the 20.0 MB limit for an artifact.");
  });
});

describe("importing a designer run", () => {
  it("records each artifact with its files' hashes, relative to its version folder, and writes the folder with manifest.json, read-only", () => {
    stage();
    const { s, runId } = withRun();
    const root = studioRoot(dir, "p-1");
    const r = importDesignerRun(s, runId, read(), root, at(4));
    const art = S.latestArtifacts(r.state)[0];
    expect(art).toEqual({
      id: art.id,
      round: 1,
      version: 1,
      kind: "screen",
      title: "Trip plan",
      variants: [
        { id: "a", label: "A · Map first" },
        { id: "b", label: "B · Day by day" },
      ],
      files: Object.entries(PAGES).map(([path, text]) => ({ path, sha256: sha(text) })),
      devices: ["desktop", "mobile"],
      madeBy: { role: "designer", provider: "claude", model: "claude-sample-large", attemptId: runId },
      at: at(4),
    });
    expect(r.summary).toBe("Trip plan v1 (2 variants)");
    const folder = join(dir, "studio", "p-1", "artifacts", art.id, "v1");
    expect(versionDir(root, art.id, 1)).toBe(folder);
    expect(JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8"))).toEqual({
      artifactId: art.id,
      version: 1,
      kind: "screen",
      title: "Trip plan",
      devices: ["desktop", "mobile"],
      variants: TRIP_PLAN.variants,
      files: Object.entries(PAGES).map(([path, text]) => ({ path, sha256: sha(text), bytes: Buffer.byteLength(text) })),
    });
    for (const [p, text] of Object.entries(PAGES)) {
      expect(readFileSync(join(folder, p), "utf8")).toBe(text);
      expect(statSync(join(folder, p)).mode & 0o222).toBe(0);
    }
    expect(readdirSync(join(dir, "studio", "p-1", "artifacts", art.id))).toEqual(["v1"]);
    // The files are read-only, the folder is not: the service adds the screenshots and recordings beside them.
    for (const media of ["shots", "recording"]) {
      mkdirSync(join(folder, media, "a"), { recursive: true });
      writeFileSync(join(folder, media, "a", "x.png"), "png");
    }
    expect(readdirSync(folder).sort()).toEqual(["a", "b", "manifest.json", "recording", "shots"]);
  });

  it("a revision hands in one artifact, recorded as the next version in its own folder; the earlier folder is untouched", () => {
    stage();
    const first = withRun();
    const root = studioRoot(dir, "p-1");
    const v1 = importDesignerRun(first.s, first.runId, read(), root, at(4));
    const id = S.latestArtifacts(v1.state)[0].id;
    const v1Manifest = readFileSync(join(versionDir(root, id, 1), "manifest.json"), "utf8");
    const second = withRun(id, R.completeStudioRun(v1.state, first.runId, at(5), { summary: v1.summary }));
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    stage({ artifacts: [TRIP_PLAN, { ...TRIP_PLAN, title: "Packing list" }] });
    expect(refusal(() => importDesignerRun(second.s, second.runId, read(), root, at(6)))).toBe("a revision hands in exactly one artifact, the new version of Trip plan; it listed 2.");
    stage({ artifacts: [{ ...TRIP_PLAN, title: "Trip plan, tightened" }] });
    const v2 = importDesignerRun(second.s, second.runId, read(), root, at(6));
    expect(S.versionsOf(v2.state, id).map((a) => [a.version, a.title])).toEqual([
      [1, "Trip plan"],
      [2, "Trip plan, tightened"],
    ]);
    expect(readdirSync(join(root, "artifacts", id)).sort()).toEqual(["v1", "v2"]);
    expect(readFileSync(join(versionDir(root, id, 1), "manifest.json"), "utf8")).toBe(v1Manifest);
  });

  it("when the studio refuses an artifact (a device outside the project's scope), nothing is recorded and no folder is left", () => {
    stage({ artifacts: [TRIP_PLAN, { ...TRIP_PLAN, title: "Terminal plan", devices: ["terminal"] }] });
    const { s, runId } = withRun();
    const root = studioRoot(dir, "p-1");
    let thrown: unknown;
    try {
      importDesignerRun(s, runId, read(), root, at(4));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ControlError);
    expect((thrown as Error).message).toBe("terminal is outside the project's device scope (desktop, mobile).");
    expect(S.latestArtifacts(s)).toEqual([]);
    expect(readdirSync(join(root, "artifacts")).flatMap((a) => readdirSync(join(root, "artifacts", a)))).toEqual([]);
  });

  it("a folder left by an import that did not commit is replaced; the studio folder needs a plain project id", () => {
    stage();
    const [a] = read();
    const root = studioRoot(dir, "p-1");
    mkdirSync(join(versionDir(root, "sa-9", 1), "stale"), { recursive: true });
    writeVersion(root, { artifactId: "sa-9", version: 1, kind: "screen", title: "Trip plan", devices: [], variants: [{ id: "a", label: "A", entry: "a/index.html" }], files: a.files.map(({ data: _d, ...f }) => f) }, a.files);
    expect(readdirSync(versionDir(root, "sa-9", 1)).sort()).toEqual(["a", "b", "manifest.json"]);
    expect(existsSync(join(versionDir(root, "sa-9", 1), "stale"))).toBe(false);
    expect(() => studioRoot(dir, "../escape")).toThrow('"../escape" cannot name a studio folder.');
  });
});
