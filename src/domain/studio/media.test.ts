// ORC-029 pass 3: what the service made of a version after import, as the version records it: a screen's screenshots
// and how each variant of a terminal demo or TUI is shown. Pending until the service reports; recorded once; checked
// against the version; and said in words for the studio (shotsNote, demoNote).

import { describe, expect, it } from "vitest";
import * as M from "../model";
import { buildSeed } from "../seed";
import { addScreen, openRound, sha } from "../testing/studio";
import type { State } from "../types";
import * as S from "./studio";

const T0 = Date.parse("2026-10-02T12:00:00Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const fresh = () => M.initProject(buildSeed(T0, { inFlightRuns: false }), { name: "Trips", repoPath: "/tmp/trips", vision: "Weekend trips.", focus: "" }, at(0));
const TWO = [
  { id: "a", label: "Map first" },
  { id: "b", label: "Day by day" },
];

/** Round 1 with a screen (desktop and mobile), a terminal demo and a contract, each in its first version. */
function studio() {
  const r = openRound(fresh(), "experience", at(1));
  const screen = addScreen(r.state, r.n, at(2), { variants: TWO });
  const demo = addScreen(screen.state, r.n, at(3), { kind: "terminal-demo", title: "trips", devices: [], variants: TWO, files: [{ path: "a/demo.tape", sha256: sha("1") }, { path: "a/demo.js", sha256: sha("2") }, { path: "b/demo.cast", sha256: sha("3") }] });
  const contract = addScreen(demo.state, r.n, at(4), { kind: "contract", title: "Trip API", devices: [], variants: [], files: [{ path: "api.md", sha256: sha("4") }] });
  const pending = [screen.id, demo.id, contract.id].reduce((s, id) => S.startArtifactMedia(s, id, 1), contract.state);
  return { s: pending, screen: screen.id, demo: demo.id, contract: contract.id };
}
const art = (s: State, id: string) => S.getArtifact(s, id, 1);
const lastEvent = (s: State) => s.events.at(-1)!.message;

describe("a version's screenshots and recording", () => {
  it("are pending for a screen on a screen device and for a terminal demo or TUI, and for nothing else", () => {
    const { s, screen, demo, contract } = studio();
    expect(art(s, screen).shots).toEqual({ status: "pending" });
    expect(art(s, demo).demo).toEqual({ status: "pending" });
    expect([art(s, contract).shots, art(s, contract).demo]).toEqual([undefined, undefined]);
    expect(S.pendingMedia(s)).toEqual([
      { artifactId: screen, version: 1, kind: "shots" },
      { artifactId: demo, version: 1, kind: "demo" },
    ]);
    expect([S.shotsNote(art(s, screen)), S.demoNote(art(s, demo), "a")]).toEqual(["Taking screenshots…", "Recording…"]);
  });

  it("records the screenshots taken, with any that failed, once", () => {
    const { s, screen } = studio();
    const taken = S.recordArtifactMedia(s, screen, 1, { shots: { status: "taken", at: at(9), shots: [{ variant: "a", device: "desktop", path: "shots/a-desktop.png" }, { variant: "a", device: "mobile", path: "shots/a-mobile.png" }, { variant: "b", device: "desktop", path: "shots/b-desktop.png" }], failed: [{ variant: "b", device: "mobile", error: "Navigation took longer than 20000 ms" }] } }, at(10));
    expect(art(taken, screen).shots).toEqual({ status: "taken", at: at(10), shots: [{ variant: "a", device: "desktop", path: "shots/a-desktop.png" }, { variant: "a", device: "mobile", path: "shots/a-mobile.png" }, { variant: "b", device: "desktop", path: "shots/b-desktop.png" }], failed: [{ variant: "b", device: "mobile", error: "Navigation took longer than 20000 ms" }] });
    expect(lastEvent(taken)).toBe("Screenshots of Trip plan v1: 3 taken; 1 failed");
    expect(S.shotsNote(art(taken, screen))).toBe("1 of 4 screenshots failed: Navigation took longer than 20000 ms");
    expect(S.pendingMedia(taken)).toHaveLength(1);
    // A late or repeated result changes nothing.
    expect(S.recordArtifactMedia(taken, screen, 1, { shots: { status: "skipped", at: at(11), reason: "no Chrome found" } }, at(11))).toBe(taken);
  });

  it("says why there are no screenshots when they were skipped", () => {
    const { s, screen } = studio();
    const skipped = S.recordArtifactMedia(s, screen, 1, { shots: { status: "skipped", at: at(9), reason: "no Chrome found" } }, at(10));
    expect(art(skipped, screen).shots).toEqual({ status: "skipped", at: at(10), reason: "no Chrome found" });
    expect(S.shotsNote(art(skipped, screen))).toBe("No screenshots: no Chrome found");
    expect(lastEvent(skipped)).toBe("No screenshots of Trip plan v1: no Chrome found");
  });

  it("refuses screenshots of a variant or device the version does not have, or outside shots/", () => {
    const { s, screen } = studio();
    const shot = (x: object) => () => S.recordArtifactMedia(s, screen, 1, { shots: { status: "taken", at: at(9), shots: [{ variant: "a", device: "desktop", path: "shots/a-desktop.png", ...x }], failed: [] } } as S.MediaResult, at(10));
    expect(shot({ variant: "z" })).toThrow("Trip plan has no variant z.");
    expect(shot({ device: "terminal" })).toThrow("Trip plan v1 is not designed for terminal.");
    expect(shot({ path: "a/index.html" })).toThrow('"a/index.html" is not in the version\'s shots/ folder.');
    expect(shot({ path: "shots/../../x.png" })).toThrow(/is not a file path inside the studio workspace/);
    expect(() => S.recordArtifactMedia(s, screen, 1, { shots: { status: "taken", at: at(9), shots: [], failed: [] } }, at(10))).toThrow(/with none, they were skipped/);
  });

  it("records each terminal variant as recorded, hand-written or not recorded, with the reason, and says so", () => {
    const { s, demo } = studio();
    const reason = "recording is not available here: no working sandbox";
    const done = S.recordArtifactMedia(s, demo, 1, { demo: { status: "done", at: at(9), variants: [{ variant: "a", status: "recorded", tape: "a/demo.tape", gif: "recording/a/demo.gif", txt: "recording/a/demo.txt" }, { variant: "b", status: "hand-written", files: ["b/demo.cast"], reason }] } }, at(10));
    expect(art(done, demo).demo).toEqual({ status: "done", at: at(10), variants: [{ variant: "a", status: "recorded", tape: "a/demo.tape", gif: "recording/a/demo.gif", txt: "recording/a/demo.txt" }, { variant: "b", status: "hand-written", files: ["b/demo.cast"], reason }] });
    expect(lastEvent(done)).toBe("trips v1: Map first recorded; Day by day hand-written, not recorded");
    expect([S.demoNote(art(done, demo), "a"), S.demoNote(art(done, demo), "b")]).toEqual([undefined, `Hand-written, not recorded: ${reason}`]);
    const none = S.recordArtifactMedia(s, demo, 1, { demo: { status: "done", at: at(9), variants: [{ variant: "a", status: "not-recorded", reason }, { variant: "b", status: "hand-written", files: ["b/demo.cast"] }] } }, at(10));
    expect([S.demoNote(art(none, demo), "a"), S.demoNote(art(none, demo), "b")]).toEqual([`Not recorded: ${reason}`, "Hand-written, not recorded"]);
  });

  it("refuses a recording outside the variant's recording folder, a hand-written file the version does not have, and a variant left out", () => {
    const { s, demo } = studio();
    const record = (variants: object[]) => () => S.recordArtifactMedia(s, demo, 1, { demo: { status: "done", at: at(9), variants } } as S.MediaResult, at(10));
    const b = { variant: "b", status: "not-recorded", reason: "none" };
    expect(record([{ variant: "a", status: "recorded", tape: "a/demo.tape", gif: "recording/b/demo.gif" }, b])).toThrow(/not in the version's recording\/a\/ folder/);
    expect(record([{ variant: "a", status: "recorded", tape: "a/demo.tape" }, b])).toThrow("A recorded variant names its recording.");
    expect(record([{ variant: "a", status: "hand-written", files: ["a/other.cast"] }, b])).toThrow('"a/other.cast" is not a file of trips v1.');
    expect(record([{ variant: "a", status: "hand-written", files: ["a/demo.js"] }, b])).toThrow("A hand-written variant names its .cast or .ans files.");
    expect(record([b])).toThrow("The recording names each variant of trips v1 once.");
  });
});
