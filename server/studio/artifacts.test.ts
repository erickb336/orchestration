// ORC-029 pass 3a: what a designer run hands in. Its studio.json is checked at the boundary (kinds, file types, sizes,
// paths inside the folder, no links, entries among the files), and each artifact is recorded and copied into the
// immutable version folder the prototype server reads, with manifest.json in the agreed layout.

import { execFileSync } from "node:child_process";
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
import { handedIn, importDesignerRun } from "./runs";

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

  it("takes a variant's showsError (a demo of an error path) as true or false, keeps it only when true, and writes it in the version's manifest", () => {
    const files = { "a/demo.tape": "Output demo.gif\nSet Columns 80\nSet Rows 24\n", "a/demo.js": "process.exit(1)" };
    const demo = (showsError: unknown) => ({ artifacts: [{ kind: "terminal-demo", title: "trips", variants: [{ id: "a", label: "A", entry: "a/demo.tape", showsError }, { id: "b", label: "B", entry: "a/demo.tape" }], files: Object.keys(files) }] });
    stage(demo(true), files);
    expect(read()[0].variants).toEqual([
      { id: "a", label: "A", entry: "a/demo.tape", showsError: true },
      { id: "b", label: "B", entry: "a/demo.tape" },
    ]);
    const { s, runId } = withRun();
    const root = studioRoot(dir, "p-1");
    const art = S.latestArtifacts(importDesignerRun(s, runId, handedIn(s, runId, read()), root, at(4)).state)[0];
    expect(JSON.parse(readFileSync(join(versionDir(root, art.id, 1), "manifest.json"), "utf8")).variants).toEqual([
      { id: "a", label: "A", entry: "a/demo.tape", showsError: true },
      { id: "b", label: "B", entry: "a/demo.tape" },
    ]);
    stage(demo(false), files);
    expect(read()[0].variants[0]).toEqual({ id: "a", label: "A", entry: "a/demo.tape" });
    stage(demo("yes"), files);
    expect(refusal(read)).toBe('artifact 1: "showsError" of variant "a" is true or false.');
  });

  it("checks terminal files with 3c's validators: each variant's tape as it would record, every .cast and .ans", () => {
    const demo = (files: Record<string, string>, entry = "a/demo.tape") => {
      rmSync(staging, { recursive: true, force: true });
      mkdirSync(staging, { recursive: true });
      stage({ artifacts: [{ kind: "terminal-demo", title: "trips", variants: [{ id: "a", label: "A", entry }], files: Object.keys(files) }] }, files);
    };
    const SIZE = "Set Columns 80\nSet Rows 24\n";
    demo({ "a/demo.tape": `Output demo.gif\n${SIZE}Set Shell fish\n` });
    expect(refusal(read)).toBe('artifact 1: "a/demo.tape" would not record: a/demo.tape:4: Set Shell must be bash or zsh.');
    demo({ "a/demo.tape": `Output ../../demo.gif\n${SIZE}` });
    expect(refusal(read)).toMatch(/^artifact 1: "a\/demo.tape" would not record: a\/demo.tape:1: Output must be one path inside the tape's folder/);
    // Sources are read from the tape's folder, and a sourced tape is not checked alone.
    demo({ "a/demo.tape": `Output demo.gif\n${SIZE}Source intro.tape\n`, "a/intro.tape": 'Type "trips plan"\n' });
    expect(read()[0].files.map((f) => f.path)).toEqual(["a/demo.tape", "a/intro.tape"]);
    demo({ "a/demo.tape": `Output demo.gif\n${SIZE}Source intro.tape\n`, "a/intro.tape": "Set Shell fish\n" });
    expect(refusal(read)).toBe('artifact 1: "a/demo.tape" would not record: intro.tape:1: Set Shell must be bash or zsh.');
    // When the entry is not a tape, the one tape beside it is the one recorded.
    demo({ "a/readme.txt": "trips", "a/demo.tape": `Output demo.gif\n${SIZE}Set Shell fish\n` }, "a/readme.txt");
    expect(refusal(read)).toMatch(/^artifact 1: "a\/demo.tape" would not record/);
    // Hand-written frames, in any artifact.
    demo({ "a/demo.cast": '{"version": 2, "width": 80, "height": 24}\n' }, "a/demo.cast");
    expect(refusal(read)).toBe('artifact 1: "a/demo.cast": the header\'s version is not 3 (asciicast v3).');
    demo({ "a/plan.ans": "\u001b]8;;file:///etc/passwd\u0007open\u001b]8;;\u0007\n" }, "a/plan.ans");
    expect(refusal(read)).toMatch(/^artifact 1: "a\/plan.ans": the escape /);
    stage({ artifacts: [{ ...TRIP_PLAN, files: [...TRIP_PLAN.files, "a/frame.ans"] }] }, { ...PAGES, "a/frame.ans": "x".repeat(121) });
    expect(refusal(read)).toBe('artifact 1: "a/frame.ans": a line is 121 characters wide, more than 120 columns.');
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(join(staging, "a"), { recursive: true });
    writeFileSync(join(staging, "a", "plan.ans"), Buffer.from([0x41, 0xff]));
    writeFileSync(join(staging, "studio.json"), JSON.stringify({ artifacts: [{ kind: "tui", title: "trips", variants: [{ id: "a", label: "A", entry: "a/plan.ans" }], files: ["a/plan.ans"] }] }));
    expect(refusal(read)).toBe('artifact 1: "a/plan.ans" is not UTF-8 text.');
  });

  it("refuses a missing or broken studio.json, and kinds this run does not make", () => {
    stage(null);
    expect(refusal(read)).toBe("the run wrote no studio.json.");
    stage("{ not json");
    expect(refusal(read)).toBe("studio.json is not valid JSON.");
    stage({ screens: [] });
    expect(refusal(read)).toBe('studio.json has no "artifacts" list.');
    stage({ artifacts: [{ ...TRIP_PLAN, kind: "material" }] });
    expect(refusal(read)).toBe('artifact 1: the kind "material" is not one this run makes (screen, terminal-demo, tui, contract, flow, interface, algorithm, topology, dictionary).');
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

  it("allows only ASCII letters, digits, '.', '_', '-' and spaces in each name of a path (review finding 9)", () => {
    const tryFile = (file: string) => {
      stage({ artifacts: [{ ...TRIP_PLAN, files: [...TRIP_PLAN.files, file] }] }, { ...PAGES, [file]: "notes" });
      return () => read();
    };
    const why = 'has a name with a character other than A–Z, a–z, 0–9, ".", "_", "-" or a space.';
    // A lookalike Cyrillic "а", an accent, the same accent decomposed, a full-width letter, an emoji, a colon, a quote.
    for (const file of ["а/notes.txt", "a/café.txt", "a/café.txt", "a/ｎotes.txt", "a/🗺.txt", "a/x:y.txt", 'a/"q".txt', "a/semi;colon.txt"]) {
      expect(refusal(tryFile(file))).toBe(`artifact 1: ${JSON.stringify(file)} ${why}`);
    }
    for (const file of ["a/Day plan 2.txt", "a/day_plan-v2.final.txt", "notes.txt"]) {
      expect(tryFile(file)()[0].files.map((f) => f.path)).toContain(file);
    }
  });

  it("takes a document artifact's Markdown and Mermaid files (md and mmd are on the allowlist)", () => {
    const files = { "api/interface.md": "# Interface\n\n```ts\nplan(trip: Trip): Plan\n```\n", "api/topology.mmd": "graph LR\n  app --> api\n" };
    stage({ artifacts: [{ kind: "contract", title: "Trip API", variants: [{ id: "a", label: "A", entry: "api/interface.md" }], files: Object.keys(files) }] }, files);
    expect(read()[0].files.map((f) => f.path)).toEqual(["api/interface.md", "api/topology.mmd"]);
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
    const r = importDesignerRun(s, runId, handedIn(s, runId, read()), root, at(4));
    const art = S.latestArtifacts(r.state)[0];
    expect(art).toEqual({
      id: art.id,
      round: 1,
      version: 1,
      kind: "screen",
      title: "Trip plan",
      // Each variant keeps the entry the designer named, as manifest.json does.
      variants: TRIP_PLAN.variants,
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
    const v1 = importDesignerRun(first.s, first.runId, handedIn(first.s, first.runId, read()), root, at(4));
    const id = S.latestArtifacts(v1.state)[0].id;
    const v1Manifest = readFileSync(join(versionDir(root, id, 1), "manifest.json"), "utf8");
    const second = withRun(id, R.completeStudioRun(v1.state, first.runId, at(5), { summary: v1.summary }));
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    stage({ artifacts: [TRIP_PLAN, { ...TRIP_PLAN, title: "Packing list" }] });
    expect(refusal(() => importDesignerRun(second.s, second.runId, handedIn(second.s, second.runId, read()), root, at(6)))).toBe("a revision hands in exactly one artifact, the new version of Trip plan; it listed 2.");
    stage({ artifacts: [{ ...TRIP_PLAN, title: "Trip plan, tightened" }] });
    const v2 = importDesignerRun(second.s, second.runId, handedIn(second.s, second.runId, read()), root, at(6));
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
      importDesignerRun(s, runId, handedIn(s, runId, read()), root, at(4));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ControlError);
    expect((thrown as Error).message).toBe("terminal is outside the project's device scope (desktop, mobile).");
    expect(S.latestArtifacts(s)).toEqual([]);
    expect(readdirSync(join(root, "artifacts")).flatMap((a) => readdirSync(join(root, "artifacts", a)))).toEqual([]);
  });

  describe("as it is today (round 0 of an import)", () => {
    let commit = "";
    /** A repository with one existing screen, its import, and the import's designer run reproducing it in round 0. */
    function asIsRun(): { s: State; runId: string } {
      const repo = join(dir, "repo");
      mkdirSync(join(repo, "src"), { recursive: true });
      writeFileSync(join(repo, "README.md"), "# Trips\n");
      writeFileSync(join(repo, "src", "index.html"), "<h1>Trips</h1>");
      writeFileSync(join(repo, "src", "trips.css"), "h1 {}");
      execFileSync("git", ["init", "-q", "-b", "main", repo]);
      execFileSync("git", ["-C", repo, "add", "-A"]);
      execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
      commit = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const base = runCommand(buildSeed(T0, { inFlightRuns: false }), "startImport", { name: "Trips", repoPath: repo, commit, domains: ["screen"], devices: ["desktop", "mobile"], budgetUsd: 3, helpers: null, size: { sourceFiles: 2, testFiles: 0, kb: 1 } }, at(1)).state;
      const asked = runCommand(base, "startStudioRun", { kind: "designer", round: 0, brief: "Reproduce the trip list as it is today.", importStep: "parts" }, at(2));
      const runId = (asked.result as { runId: string }).runId;
      return { s: R.dispatchStudioRuns(asked.state, at(3)).state, runId };
    }
    const ONE = { ...TRIP_PLAN, title: "Trip list (as is)", variants: [TRIP_PLAN.variants[0]], files: ["a/index.html", "a/style.css"] };

    it("reads each artifact's provenance, and refuses one that is not a list of paths from the repository's root", () => {
      stage({ artifacts: [{ ...ONE, provenance: ["src/index.html", "src/trips.css", "src/index.html"] }] });
      expect(read()[0].provenance).toEqual(["src/index.html", "src/trips.css"]);
      for (const provenance of ["src/index.html", [], [1], ["../etc/passwd"], ["/etc/passwd"], ["src/./a.ts"]]) {
        stage({ artifacts: [{ ...ONE, provenance }] });
        expect(refusal(read)).toMatch(/^artifact 1: (the provenance .* is not a path from the repository's root|"provenance" lists 1 to 50 repository files)/);
      }
      // A screen's page is text, and only beside a provenance.
      for (const extra of [{ provenance: ["src/index.html"], page: 3 }, { page: "/" }]) {
        stage({ artifacts: [{ ...ONE, ...extra }] });
        expect(refusal(read)).toBe('artifact 1: "page" is the path of a reproduced screen in the running app, as text, beside its "provenance".');
      }
    });

    it("records the reproduction as is, with the repository files it came from, and its page in the running app, in the version and its manifest.json", () => {
      stage({ artifacts: [{ ...ONE, provenance: ["src/index.html", "src/trips.css"], page: "/" }] });
      const { s, runId } = asIsRun();
      const root = studioRoot(dir, "p-1");
      const r = importDesignerRun(s, runId, handedIn(s, runId, read()), root, at(4));
      const art = S.latestArtifacts(r.state)[0];
      expect(art).toMatchObject({ round: 0, kind: "screen", title: "Trip list (as is)", provenance: { asIs: true, files: ["src/index.html", "src/trips.css"], commit, page: "/" } });
      expect(JSON.parse(readFileSync(join(versionDir(root, art.id, 1), "manifest.json"), "utf8")).provenance).toEqual({ asIs: true, files: ["src/index.html", "src/trips.css"], commit, page: "/" });
    });

    it("the import reads no repository: the provenance is looked up before the store's transaction (review finding 11)", () => {
      stage({ artifacts: [{ ...ONE, provenance: ["src/index.html"] }] });
      const { s, runId } = asIsRun();
      const given = handedIn(s, runId, read());
      expect(given.tracked).toEqual(new Set(["src/index.html"]));
      // The repository is gone by the time the transaction runs: the import still records what was looked up.
      rmSync(s.project.repoPath, { recursive: true, force: true });
      const r = importDesignerRun(s, runId, given, studioRoot(dir, "p-1"), at(4));
      expect(S.latestArtifacts(r.state)[0].provenance).toEqual({ asIs: true, files: ["src/index.html"], commit });
      // Looked up from a repository that cannot be read, the provenance cannot be checked, and nothing is recorded.
      expect(refusal(() => importDesignerRun(s, runId, handedIn(s, runId, read()), studioRoot(dir, "p-1"), at(4)))).toBe('the provenance of "Trip list (as is)" cannot be checked: the repository cannot be read.');
    });

    it("refuses a provenance the repository does not have, and a reproduction without provenance; nothing is recorded", () => {
      const { s, runId } = asIsRun();
      const root = studioRoot(dir, "p-1");
      stage({ artifacts: [{ ...ONE, provenance: ["src/index.html", "src/TripList.tsx"] }] });
      expect(refusal(() => importDesignerRun(s, runId, handedIn(s, runId, read()), root, at(4)))).toBe(`the provenance of "Trip list (as is)" names "src/TripList.tsx", which the repository does not have at the import's commit ${commit.slice(0, 7)}.`);
      stage({ artifacts: [ONE] });
      expect(() => importDesignerRun(s, runId, handedIn(s, runId, read()), root, at(4))).toThrow(/^Round 0 holds what already exists/);
      expect(S.latestArtifacts(s)).toEqual([]);
    });

    it("outside round 0, a provenance the designer lists is not recorded: a later round's artifacts are proposals", () => {
      stage({ artifacts: [{ ...TRIP_PLAN, provenance: ["src/index.html"] }] });
      const { s, runId } = withRun();
      const r = importDesignerRun(s, runId, handedIn(s, runId, read()), studioRoot(dir, "p-1"), at(4));
      expect(S.latestArtifacts(r.state)[0].provenance).toBeUndefined();
    });
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

describe("the project's dictionary and a flow's rules at import (pass 4d)", () => {
  const WORDS = [
    { term: "trip", meaning: "A weekend away that a group plans together.", avoid: ["journey", "outing"] },
    { term: "member", meaning: "A person who said they are in." },
  ];
  const fresh = () => {
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
  };
  const dictionary = (words: unknown, over: Record<string, unknown> = {}) => {
    fresh();
    stage({ artifacts: [{ kind: "dictionary", title: "Words", variants: [{ id: "a", label: "As drafted", entry: "dictionary.json" }], files: ["dictionary.json"], ...over }] }, { "dictionary.json": typeof words === "string" ? words : JSON.stringify(words) });
  };
  const RULES = {
    rules: [
      { id: "R1", text: "When a member says they are in, the app shall show the cost each." },
      { id: "R2", text: "If the trip is full, then the app shall add the member to the waiting list." },
    ],
    examples: [{ id: "E1", text: "Given a full trip, when Sam says he is in, then Sam is on the waiting list." }],
  };
  const flow = (rules: unknown, files: Record<string, string> = { "doc/index.md": "# Saying you are in\n", "doc/rules.json": JSON.stringify(rules) }) => {
    fresh();
    stage({ artifacts: [{ kind: "flow", title: "Saying you are in", variants: [{ id: "a", label: "As drafted", entry: "doc/index.md" }], files: Object.keys(files) }] }, files);
  };

  it("reads a dictionary's terms, and the import records them on the version", () => {
    dictionary(WORDS);
    expect(read()[0].dictionary).toEqual([WORDS[0], { ...WORDS[1], avoid: [] }]);
    const { s, runId } = withRun();
    const out = importDesignerRun(s, runId, handedIn(s, runId, read()), studioRoot(dir, "p-1"), at(4));
    expect(S.latestArtifacts(out.state)[0]).toMatchObject({ kind: "dictionary", title: "Words", devices: [], dictionary: [WORDS[0], { ...WORDS[1], avoid: [] }] });
  });

  it("refuses a dictionary that breaks its rules, listing each problem with its term", () => {
    dictionary([...WORDS, { term: "Trip", meaning: "Again.", avoid: ["member"] }]);
    expect(refusal(read)).toBe('artifact 1: "dictionary.json": term 3 ("Trip") is also term 1: list each term once; term 3 ("Trip"): the avoided word "member" is also a term (term 2); a word is either used or avoided.');
    dictionary("{ not json");
    expect(refusal(read)).toBe('artifact 1: "dictionary.json" is not valid JSON.');
    dictionary(WORDS, { devices: ["desktop"] });
    expect(refusal(read)).toBe("artifact 1: a dictionary has no devices.");
    fresh();
    stage({ artifacts: [{ kind: "dictionary", title: "Words", variants: [{ id: "a", label: "A", entry: "words.md" }], files: ["words.md"] }] }, { "words.md": "# Words\n" });
    expect(refusal(read)).toBe("artifact 1: a dictionary is one file, dictionary.json, and one variant whose entry is dictionary.json.");
  });

  it("reads a flow's rules.json beside its variant's entry, with each rule's pattern", () => {
    flow(RULES);
    expect(read()[0].rules).toEqual([
      {
        variant: "a",
        path: "doc/rules.json",
        rules: [
          { ...RULES.rules[0], pattern: "event" },
          { ...RULES.rules[1], pattern: "unwanted" },
        ],
        examples: RULES.examples,
      },
    ]);
    const { s, runId } = withRun();
    const out = importDesignerRun(s, runId, handedIn(s, runId, read()), studioRoot(dir, "p-1"), at(4));
    expect(S.latestArtifacts(out.state)[0].rules?.[0].rules.map((r) => r.pattern)).toEqual(["event", "unwanted"]);
    // A flow without rules.json is a flow as before.
    flow(undefined, { "doc/index.md": "# Saying you are in\n" });
    expect(read()[0].rules).toBeUndefined();
  });

  it("reads rules.json beside any part's entry, with the tests each rule names (ORC-032 D1), never a dictionary's", () => {
    fresh();
    const rules = { rules: [{ id: "R2", text: 'If the amount is not a number, then the CLI shall stop with "Amount must be a number".', tests: ["test_add.py::test_rejects_text"] }] };
    stage({ artifacts: [{ kind: "algorithm", title: "Splitting", variants: [{ id: "a", label: "As it is today", entry: "split/split.md" }], files: ["split/split.md", "split/rules.json"] }] }, { "split/split.md": "# Splitting\n", "split/rules.json": JSON.stringify(rules) });
    expect(read()[0].rules).toEqual([{ variant: "a", path: "split/rules.json", rules: [{ ...rules.rules[0], pattern: "unwanted" }], examples: [] }]);
  });

  it("refuses a rule outside the patterns with its id and the patterns, so the designer's next run fixes it", () => {
    flow({ rules: [RULES.rules[0], { id: "R2", text: "If the trip is full, the app shall add the member to the waiting list." }], examples: [{ id: "E1", text: "Sam waits." }] });
    expect(refusal(read)).toBe(
      'artifact 1: "doc/rules.json": rule R2 fits no pattern: "If the trip is full, the app shall add the member to the waiting list."; example E1 fits no pattern: "Sam waits."; A rule fits one of: "The <system> shall <response>."; "When <trigger>, the <system> shall <response>."; "While <state>, the <system> shall <response>."; "If <unwanted condition>, then the <system> shall <response>."; "Where <feature is included>, the <system> shall <response>.". An example fits "Given <context>, when <action>, then <result>.".',
    );
    flow(RULES, { "doc/index.md": "# Saying you are in\n", "rules/rules.json": JSON.stringify(RULES) });
    expect(refusal(read)).toBe('artifact 1: "rules/rules.json" is beside no variant\'s entry; put each variant\'s rules.json in the folder of its entry.');
  });
});
