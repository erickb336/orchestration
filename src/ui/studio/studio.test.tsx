// The studio's artifact viewer (ORC-029 pass 3d), `#/vision`. Rendered through react-dom/server over a fake store,
// as home.test.tsx does (there is no DOM test environment here); what the screen does on a click or a message is
// checked through the functions it calls (studioView.ts), against the real command table.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ServiceInfo } from "../../api";
import { runCommand } from "../../domain/commands";
import * as M from "../../domain/model";
import { buildSeed } from "../../domain/seed";
import * as R from "../../domain/studio/runs";
import * as S from "../../domain/studio/studio";
import { DESIGNER, addScreen, openRound, peAgrees, run, sha } from "../../domain/testing/studio";
import type { State } from "../../domain/types";
import { ConfirmProvider } from "../kit";
import { Overview } from "../Overview";
import { parseRoute } from "../route";
import { StoreContext, type ServiceStore } from "../store";
import { frameSize, readCast, renderAnsi } from "./ansi";
import { TerminalText } from "./Frames";
import { Studio } from "./Studio";
import { addPin, changedDrafts, deviceOptions, draftFrom, draftKey, pinFromMessage, sendBlocker, sendDrafts, serviceFileUrl, variantDemo, variantEntry, type Draft } from "./studioView";

const T0 = Date.parse("2026-10-02T12:00:00Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const PORT = 5320;

const service = (over: Partial<ServiceInfo> = {}): ServiceInfo => ({
  startedAt: at(0),
  scheduler: "active",
  runtime: "fake",
  sim: { auto: false, ackMode: "normal" },
  dbPath: "/tmp/orchestration-test.db",
  providers: { claude: { label: "Claude", capabilities: {} as never }, codex: { label: "Codex", capabilities: {} as never } },
  prototypePort: PORT,
  ...over,
});

function store(state: State, svc: ServiceInfo = service()): ServiceStore {
  const noop = async () => ({ ok: true as const });
  return { state, version: 1, service: svc, status: "online", disabled: false, send: noop, notice: null, setNotice: () => {} } as unknown as ServiceStore;
}

const render = (node: React.ReactElement, state: State, svc?: ServiceInfo) =>
  renderToStaticMarkup(
    <ConfirmProvider>
      <StoreContext.Provider value={store(state, svc)}>{node}</StoreContext.Provider>
    </ConfirmProvider>,
  );

/** A project in Vision (desktop and mobile), as one starts. */
const vision = () => M.initProject(buildSeed(T0, { inFlightRuns: false }), { name: "Weekend Trips", repoPath: "/tmp/trips", vision: "Plan weekend trips with friends.", focus: "" }, at(0));

/** The fake designer's sample as the service imports it: Trip plan in two variants, desktop and mobile, made by a simulated run. */
const SAMPLE_FILES = ["a/index.html", "a/style.css", "b/index.html", "b/style.css"].map((path, i) => ({ path, sha256: sha("abcd"[i]) }));
function withSample(opts: { pe?: boolean } = {}) {
  const r = openRound(vision(), "experience", at(1));
  let s = run<{ runId: string }>(r.state, "startStudioRun", { kind: "designer", round: r.n, brief: "Make the trip plan." }, at(2)).state;
  s = R.dispatchStudioRuns(s, at(3), { simulated: ["claude"] }).state;
  const runId = s.studio.runs[0].id;
  const a = addScreen(s, r.n, at(4), {
    title: "Trip plan (simulated sample)",
    variants: [
      { id: "a", label: "A · Map first", entry: "a/index.html" },
      { id: "b", label: "B · Day by day", entry: "b/index.html" },
    ],
    files: SAMPLE_FILES,
    madeBy: { ...DESIGNER, attemptId: runId },
  });
  s = R.completeStudioRun(a.state, runId, at(5), { summary: "Trip plan (simulated sample) v1 (2 variants)" });
  if (opts.pe !== false) s = peAgrees(s, a.id, 1, ["a", "b"], at(6));
  return { s, id: a.id, n: r.n };
}

const PIN = { type: "orchestrator-pin", x: 0.25, y: 0.5, selector: "main > div.map" };

describe("the route", () => {
  it("#/vision opens the studio", () => {
    expect(parseRoute("#/vision")).toEqual({ page: "vision" });
    expect(parseRoute("#/vision?round=2")).toEqual({ page: "vision" });
  });
});

describe("the viewer's states, in plain words", () => {
  it("no rounds yet", () => {
    const html = render(<Studio />, vision());
    expect(html).toContain("No rounds yet.");
    expect(html).not.toContain("<iframe");
  });

  it("a designer run in progress, and one that is queued with the reason it waits", () => {
    const r = openRound(vision(), "experience", at(1));
    const asked = run(r.state, "startStudioRun", { kind: "designer", round: r.n, brief: "Make the trip plan." }, at(2)).state;
    const paused = M.pauseProject(asked, at(3));
    expect(render(<Studio />, paused)).toContain("It waits until you resume the project.");
    const running = R.dispatchStudioRuns(asked, at(3), { simulated: ["claude"] }).state;
    const html = render(<Studio />, running);
    expect(html).toContain("The designer is working on round 1.");
    expect(html).toContain("working");
    expect(html).toContain("(simulated)");
  });

  it("a failed run, with its reason", () => {
    const r = openRound(vision(), "experience", at(1));
    let s = run(r.state, "startStudioRun", { kind: "designer", round: r.n, brief: "Make the trip plan." }, at(2)).state;
    s = R.dispatchStudioRuns(s, at(3)).state;
    s = R.reportStudioRunFailed(s, s.studio.runs[0].id, "studio.json was refused: artifact 1 lists a file twice.", at(4));
    const html = render(<Studio />, s);
    expect(html).toContain("The designer&#x27;s run failed.");
    expect(html).toContain("studio.json was refused: artifact 1 lists a file twice.");
  });
});

describe("the fake designer's sample in the viewer", () => {
  it("shows the variant's entry sandboxed on its own origin, in a desktop frame, with the variants, the marks, Pin a comment and Send feedback", () => {
    const { s, id } = withSample();
    const html = render(<Studio />, s);
    // The frame: its own origin on the prototype port, scripts only, never same-origin.
    expect(html).toContain(`src="http://p-${id}-v1.localhost:${PORT}/a/index.html"`);
    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).not.toContain("allow-same-origin");
    expect(html).toContain("in a browser window");
    expect(html).toContain(">Desktop<");
    expect(html).toContain(">Mobile<");
    expect(html).toContain("A · Map first");
    expect(html).toContain("B · Day by day");
    for (const label of [">Keep<", ">Change<", ">Drop<", "Pin a comment", "Send feedback"]) expect(html).toContain(label);
    // The fake runtime made it: labelled so.
    expect(html).toContain("simulated");
    // The lead's panel and PE review are pass 4: a labelled placeholder, not made-up content.
    expect(html).toContain("Not built yet: the lead&#x27;s message for this round");
    expect(html).toContain("Nothing marked yet.");
  });

  it("the device switch offers only the project's devices", () => {
    const { s, id } = withSample();
    expect(deviceOptions(s.project.devices, S.getArtifact(s, id, 1))).toEqual(["desktop", "mobile"]);
    const desktopOnly = runCommand(s, "setDevices", { devices: ["desktop"] }, at(10)).state;
    expect(deviceOptions(desktopOnly.project.devices, S.getArtifact(desktopOnly, id, 1))).toEqual(["desktop"]);
    const html = render(<Studio />, desktopOnly);
    expect(html).not.toContain(">Mobile<");
    expect(html).not.toContain('role="radiogroup" aria-label="Device"');
    expect(html).toContain(">Desktop<");
    // And a screen made for desktop only is not offered on mobile, whatever the scope.
    expect(deviceOptions(["desktop", "mobile"], { ...S.getArtifact(s, id, 1), devices: ["desktop"] })).toEqual(["desktop"]);
  });

  it("while the PE has not agreed, you can look but not mark, pin or send, and it says why", () => {
    const { s } = withSample({ pe: false });
    const html = render(<Studio />, s);
    expect(html).toContain("<iframe");
    expect(html).toContain("Waiting for PE review. You can look at it now, and mark it once the PE agrees.");
    expect(html).toContain("with the PE");
    expect(html).toMatch(/<button[^>]*aria-pressed="false"[^>]*aria-disabled="true"[^>]*>Keep</);
  });

  it("without the prototype server it says why, and shows the screenshot the service has, through the app's own service", () => {
    const { s, id } = withSample();
    const html = render(<Studio />, s, service({ prototypePort: undefined }));
    expect(html).not.toContain("<iframe");
    expect(html).toContain("The prototype server is not running");
    expect(html).toContain(`src="/api/studio/file?artifact=${id}&amp;version=1&amp;path=shots%2Fa-desktop.png"`);
  });

  it("Home leads to the studio while the project is in Vision", () => {
    const { s } = withSample();
    const html = render(<Overview />, s);
    expect(html).toContain('href="#/vision"');
    expect(html).toContain("Open the studio");
    expect(html).toContain("Round 1 open: the experience · 1 artifact");
  });
});

describe("pins", () => {
  const frame = { name: "the prototype's window" };
  const other = { name: "another window" };

  it("are taken only in Pin mode, only from the artifact's own frame, and only as a well-formed pin", () => {
    expect(pinFromMessage(false, { source: frame, data: PIN }, frame)).toBeNull();
    expect(pinFromMessage(true, { source: frame, data: PIN }, frame)).toEqual(PIN);
    expect(pinFromMessage(true, { source: other, data: PIN }, frame)).toBeNull();
    expect(pinFromMessage(true, { source: frame, data: { ...PIN, type: "navigate" } }, frame)).toBeNull();
    expect(pinFromMessage(true, { source: frame, data: { ...PIN, x: 2 } }, frame)).toBeNull();
    expect(pinFromMessage(true, { source: frame, data: { ...PIN, extra: 1 } }, frame)).toBeNull();
    expect(pinFromMessage(true, { source: null, data: PIN }, null)).toBeNull();
  });

  it("a pin keeps its place, its element and the variant shown, and waits for a comment before it can be sent", () => {
    const { s, id } = withSample();
    const a = S.getArtifact(s, id, 1);
    const pinned = addPin(draftFrom(undefined), PIN as never, "b");
    expect(pinned.pins).toEqual([{ x: 0.25, y: 0.5, variant: "b", text: "", selector: "main > div.map" }]);
    const changed = changedDrafts(s, { [draftKey(a)]: pinned });
    expect(sendBlocker(changed)).toBe("Write a comment for pin 1 on Trip plan (simulated sample), or remove it.");
  });
});

describe("Send feedback", () => {
  it("sends every changed draft as one sendFeedback, which the domain records on each version", async () => {
    const { s, id } = withSample();
    const a = S.getArtifact(s, id, 1);
    const draft: Draft = { ...addPin(draftFrom(undefined), PIN as never, "a"), mark: "change", pickedVariant: "b" };
    draft.pins[0].text = "Make the map smaller on phones.";
    draft.note = "Prefer B on phones.";
    const calls: { name: string; args: object }[] = [];
    let after = s;
    const send = async (name: "sendFeedback", args: object) => {
      calls.push({ name, args });
      after = runCommand(s, name, args, at(20)).state;
      return { ok: true };
    };
    const sent = await sendDrafts(send, s, { [draftKey(a)]: draft });
    expect(sent).toEqual([draftKey(a)]);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("sendFeedback");
    const f = S.currentFeedback(after, id, 1)!;
    expect(f).toMatchObject({ mark: "change", pickedVariant: "b", note: "Prefer B on phones.", pins: [{ x: 0.25, y: 0.5, variant: "a", text: "Make the map smaller on phones.", selector: "main > div.map" }] });
    // Once recorded, the same draft is no longer a change: nothing is sent twice.
    expect(changedDrafts(after, { [draftKey(a)]: draft })).toEqual([]);
    // The recorded pin names its element, so the list shows it instead of saying it is not recorded.
    const html = render(<Studio />, after);
    expect(html).toContain('<code class="st-selector">main &gt; div.map</code>');
    expect(html).not.toContain("The element is not recorded");
  });

  it("sends nothing while nothing changed or a version is still with the PE, and keeps the drafts when the service refuses", async () => {
    const { s, id } = withSample({ pe: false });
    const a = S.getArtifact(s, id, 1);
    const send = async () => ({ ok: true });
    expect(await sendDrafts(send, s, {})).toBeNull();
    expect(await sendDrafts(send, s, { [draftKey(a)]: { ...draftFrom(undefined), mark: "keep" } })).toBeNull();
    const agreed = peAgrees(s, id, 1, ["a", "b"], at(7));
    expect(await sendDrafts(async () => ({ ok: false }), agreed, { [draftKey(a)]: { ...draftFrom(undefined), mark: "keep" } })).toBeNull();
    expect(sendBlocker(changedDrafts(agreed, {}))).toBe("Mark, pick or pin something first.");
  });
});

describe("where a variant is served from", () => {
  it("its entry: the one the designer named, as the version records it; never guessed", () => {
    const { s, id } = withSample();
    const a = S.getArtifact(s, id, 1);
    expect(variantEntry(a, "a")).toBe("a/index.html");
    expect(variantEntry(a, "b")).toBe("b/index.html");
    // An entry that is not where the files suggest is still the one shown.
    const named = { ...a, variants: [{ id: "a", label: "A", entry: "b/index.html" }] };
    expect(variantEntry(named, "a")).toBe("b/index.html");
    // A variant that names none shows nothing rather than a guess.
    expect(variantEntry({ ...a, variants: [{ id: "x", label: "X" }] }, "x")).toBeUndefined();
    // What the owner brought has no variants: its first page.
    expect(variantEntry({ ...a, variants: [], files: [{ path: "notes.md", sha256: sha("e") }, { path: "sketch.html", sha256: sha("f") }] }, undefined)).toBe("sketch.html");
  });
});

describe("PE review in the right column", () => {
  /** The sample, with a PE run on Codex (simulated) that made one pass with these verdicts. */
  function reviewed(verdicts: object[], opts: { lastPass?: boolean } = {}) {
    const { s: designed, id } = withSample({ pe: false });
    let s = R.askForPeReviews(designed, at(6));
    s = R.dispatchStudioRuns(s, at(7), { simulated: ["codex"] }).state;
    const pe = s.studio.runs.find((r) => r.kind === "pe")!;
    s = S.addPeVerdicts(s, { artifactId: id, version: 1, verdicts: verdicts as S.VerdictInput[], by: { provider: "codex", model: pe.model, runId: pe.id }, lastPass: opts.lastPass ?? true }, at(8)).state;
    return { s: R.completeStudioRun(s, pe.id, at(8), { summary: "pass 1" }), id };
  }
  const BUDGET = { buildUsd: [40, 90] as [number, number], maintenanceUsdPerMonth: [0, 5] as [number, number], basis: "Recorded designer runs of this size." };

  it("once the PE agrees: its verdict on each variant with the change and the budget effect, labelled simulated, and the marks unlocked", () => {
    const { s } = reviewed([
      { variant: "a", verdict: "feasible", reasons: "A static page with a drawn map." },
      { variant: "b", verdict: "feasible-if", reasons: "Long trips need paging.", change: "Page the days after a week.", budget: BUDGET },
    ]);
    const html = render(<Studio />, s);
    expect(html).toContain(">Agreed<");
    expect(html).toContain("The PE agreed on pass 1: every option is feasible, some only with the change it states. It is yours to mark.");
    expect(html).toContain("PE · Codex · codex-sample-large");
    expect(html).toContain("Simulated: the fake runtime&#x27;s PE answered; no agent judged this.");
    expect(html).toMatch(/A · Map first<\/b><span class="k-chip k-chip--done">Feasible</);
    expect(html).toMatch(/B · Day by day<\/b><span class="k-chip k-chip--you">Feasible if changed</);
    expect(html).toContain("The change: Page the days after a week.");
    expect(html).toContain("Budget effect: building $40–$90, maintenance $0–$5 a month. Basis: Recorded designer runs of this size.");
    // The lock is gone: nothing says the PE is still reviewing, and the marks can be pressed.
    expect(html).not.toContain("Waiting for PE review. You can look at it now");
    expect(html).not.toContain("with the PE");
    expect(html).not.toMatch(/aria-disabled="true"[^>]*>Keep</);
    // The lead's panel stays a placeholder until pass 4.
    expect(html).toContain("Not built yet: the lead&#x27;s message for this round and its questions come here in pass 4 of the studio.");
  });

  it("an objection says plainly that it is waiting for you, and you can answer", () => {
    const { s } = reviewed([
      { variant: "a", verdict: "feasible", reasons: "Fine." },
      { variant: "b", verdict: "not-feasible", reasons: "Live prices need a paid API.", change: "A free source of prices." },
    ]);
    const html = render(<Studio />, s);
    expect(html).toContain(">Objects: waiting for you<");
    expect(html).toContain("The PE objects to B · Day by day. This is waiting for you: the designer cannot revise in answer to the PE yet, so mark it Keep, Change or Drop, pick a variant, and say what you decide in your note.");
    expect(html).toMatch(/<span class="k-chip k-chip--fail">Not feasible</);
    expect(html).toContain("What would change the verdict: A free source of prices.");
    expect(html).not.toMatch(/aria-disabled="true"[^>]*>Keep</);
    // Flagged in the round's list too.
    expect(html).toContain('<span class="k-chip k-chip--you">PE objects</span>');
  });

  it("while the PE has not answered: why, from its run, and the marks stay locked", () => {
    const { s: designed, id } = withSample({ pe: false });
    const queued = R.askForPeReviews(designed, at(6));
    expect(render(<Studio />, queued)).toMatch(/>Queued<.*Waiting to start\./s);
    const reviewing = R.dispatchStudioRuns(queued, at(7)).state;
    const html = render(<Studio />, reviewing);
    expect(html).toContain(">Reviewing<");
    expect(html).toContain("The PE is reading this version: its files, screenshots and recordings.");
    expect(html).toMatch(/aria-disabled="true"[^>]*>Keep</);
    // While the screenshots are taken, the PE waits for them, and the studio says what the service is doing.
    const shooting = S.startArtifactMedia(designed, id, 1);
    const waiting = render(<Studio />, shooting);
    expect(waiting).toContain("The PE reviews it once the screenshots are taken.");
    expect(waiting).toContain("Taking screenshots…");
    const skipped = render(<Studio />, S.recordArtifactMedia(shooting, id, 1, { shots: { status: "skipped", at: at(7), reason: "no Chrome found" } }, at(7)));
    expect(skipped).toContain("No screenshots: no Chrome found");
  });

  it("a PE run that ended without a verdict says so, and says when it is asked again", () => {
    const { s: designed } = withSample({ pe: false });
    let s = R.dispatchStudioRuns(R.askForPeReviews(designed, at(6)), at(7)).state;
    const first = s.studio.runs.find((r) => r.kind === "pe")!;
    s = R.reportStudioRunFailed(s, first.id, "Its verdicts were refused: its answer has no JSON block with the verdicts", at(8));
    expect(render(<Studio />, s)).toContain("The PE&#x27;s run ended without a verdict (Its verdicts were refused: its answer has no JSON block with the verdicts); it is asked again.");
    s = R.dispatchStudioRuns(R.askForPeReviews(s, at(9)), at(10)).state;
    s = R.reportStudioRunStopped(s, s.studio.runs.filter((r) => r.kind === "pe")[1].id, at(11), { lost: true });
    expect(render(<Studio />, s)).toContain(">No verdict<");
  });
});

describe("terminal artifacts", () => {
  /** A terminal demo in two variants, as the service records it: the tape not recorded (its hand-written .cast shown), and .ans frames. */
  function withTerminal(demo?: S.MediaResult) {
    const scoped = runCommand(vision(), "setDevices", { devices: ["desktop", "mobile", "terminal"] }, at(1)).state;
    const r = openRound(scoped, "experience", at(1));
    let s = run(r.state, "startStudioRun", { kind: "designer", round: r.n, brief: "Make the trips demo." }, at(2)).state;
    s = R.dispatchStudioRuns(s, at(3), { simulated: ["claude"] }).state;
    const a = addScreen(s, r.n, at(4), {
      kind: "terminal-demo",
      title: "trips",
      devices: ["terminal"],
      variants: [
        { id: "a", label: "A · Recorded", entry: "a/demo.tape" },
        { id: "b", label: "B · Frames", entry: "b/plan.ans" },
      ],
      files: ["a/demo.tape", "a/trips.js", "a/demo.cast", "b/plan.ans"].map((path, i) => ({ path, sha256: sha("abcd"[i]) })),
      madeBy: { ...DESIGNER, attemptId: s.studio.runs[0].id },
    });
    s = S.startArtifactMedia(a.state, a.id, 1);
    if (demo) s = S.recordArtifactMedia(s, a.id, 1, demo, at(5));
    return { s: peAgrees(s, a.id, 1, ["a", "b"], at(6)), id: a.id };
  }
  const REASON = "recording is not available here: no working sandbox";
  const HAND_WRITTEN: S.MediaResult = {
    demo: {
      status: "done",
      at: at(5),
      variants: [
        { variant: "a", status: "hand-written", files: ["a/demo.cast"], reason: REASON },
        { variant: "b", status: "hand-written", files: ["b/plan.ans"] },
      ],
    },
  };

  it("each variant as the service recorded it: being recorded, recorded, hand-written with the reason, or not recorded", () => {
    const pending = S.getArtifact(withTerminal().s, withTerminal().id, 1);
    expect(variantDemo(pending, "a")).toEqual({ status: "pending" });
    const { s, id } = withTerminal(HAND_WRITTEN);
    const a = S.getArtifact(s, id, 1);
    expect(variantDemo(a, "a")).toEqual({ status: "hand-written", cast: "a/demo.cast", reason: REASON });
    expect(variantDemo(a, "b")).toEqual({ status: "hand-written", frame: "b/plan.ans" });
    const recorded = withTerminal({ demo: { status: "done", at: at(5), variants: [{ variant: "a", status: "recorded", tape: "a/demo.tape", webm: "recording/a/demo.webm", txt: "recording/a/demo.txt" }, { variant: "b", status: "not-recorded", reason: "its entry is not a .tape" }] } });
    const ra = S.getArtifact(recorded.s, recorded.id, 1);
    expect(variantDemo(ra, "a")).toEqual({ status: "recorded", video: "recording/a/demo.webm", transcript: "recording/a/demo.txt" });
    expect(variantDemo(ra, "b")).toEqual({ status: "not-recorded", reason: "its entry is not a .tape" });
    // A recording that shows a failure is still played, with its first failing line.
    const failing = withTerminal({ demo: { status: "done", at: at(5), variants: [{ variant: "a", status: "recorded-with-errors", tape: "a/demo.tape", gif: "recording/a/demo.gif", reason: "Error: Cannot find module '/w/demo/trips.js'" }, { variant: "b", status: "hand-written", files: ["b/plan.ans"] }] } });
    expect(variantDemo(S.getArtifact(failing.s, failing.id, 1), "a")).toEqual({ status: "recorded", gif: "recording/a/demo.gif", error: "Error: Cannot find module '/w/demo/trips.js'" });
    // A version the service recorded nothing for shows the hand-written files beside the entry.
    expect(variantDemo({ ...a, demo: undefined }, "a")).toEqual({ status: "hand-written", cast: "a/demo.cast" });
  });

  it("in the viewer: the studio's words on the recording, the hand-written .cast read through the app's own service, and a recording played from it with or without the prototype server", () => {
    const { s, id } = withTerminal(HAND_WRITTEN);
    const html = render(<Studio />, s);
    expect(html).toContain(`Hand-written, not recorded: ${REASON}.`);
    expect(html).toContain("Reading a/demo.cast…");
    expect(serviceFileUrl(S.getArtifact(s, id, 1), "a/demo.cast")).toBe(`/api/studio/file?artifact=${id}&version=1&path=a%2Fdemo.cast`);
    expect(render(<Studio />, withTerminal().s)).toContain("Recording…");
    const recorded = withTerminal({ demo: { status: "done", at: at(5), variants: [{ variant: "a", status: "recorded", tape: "a/demo.tape", webm: "recording/a/demo.webm" }, { variant: "b", status: "hand-written", files: ["b/plan.ans"] }] } });
    const played = render(<Studio />, recorded.s, service({ prototypePort: undefined }));
    expect(played).toContain(`src="/api/studio/file?artifact=${recorded.id}&amp;version=1&amp;path=recording%2Fa%2Fdemo.webm"`);
    expect(played).toContain("Recorded with VHS from the designer&#x27;s tape");
    expect(played).not.toContain("Recorded with errors");
    // A recording that shows a failure says so plainly, above the recording, as a failure.
    const failing = withTerminal({ demo: { status: "done", at: at(5), variants: [{ variant: "a", status: "recorded-with-errors", tape: "a/demo.tape", gif: "recording/a/demo.gif", reason: "Error: Cannot find module '/w/demo/trips.js'" }, { variant: "b", status: "hand-written", files: ["b/plan.ans"] }] } });
    const shown = render(<Studio />, failing.s, service({ prototypePort: undefined }));
    expect(shown).toContain('class="k-banner k-banner--fail" role="alert"');
    expect(shown).toContain("Recorded with errors: the demo did not run cleanly in the sandbox (Error: Cannot find module &#x27;/w/demo/trips.js&#x27;).");
    expect(shown).toContain(`src="/api/studio/file?artifact=${failing.id}&amp;version=1&amp;path=recording%2Fa%2Fdemo.gif"`);
  });

  it("a .ans frame is drawn with colours as token classes, never as inline colours, at the smallest studio size it fits", () => {
    const ans = "\x1b[1;32mtrips\x1b[0m ui\n\x1b[7m> Lake weekend \x1b[0m\n  \x1b[38;5;196mTwo spots left\x1b[39m";
    const lines = renderAnsi(ans, frameSize(ans));
    expect(lines[0]).toEqual([
      { text: "trips", cls: "st-a-fg-green st-a-bold" },
      { text: " ui", cls: "" },
    ]);
    expect(lines[1][0]).toEqual({ text: "> Lake weekend ", cls: "st-a-fg-bg st-a-bg-fg" });
    expect(lines[2]).toEqual([
      { text: "  ", cls: "" },
      { text: "Two spots left", cls: "st-a-fg-red" },
    ]);
    expect(frameSize(ans)).toEqual({ cols: 80, rows: 24 });
    expect(frameSize(`${"x".repeat(90)}\n`)).toEqual({ cols: 100, rows: 30 });
    const html = renderToStaticMarkup(<TerminalText lines={lines} cols={80} rows={24} label="Frame ui.ans" />);
    expect(html).toContain('<span class="st-a-fg-green st-a-bold">trips</span>');
    expect(html).not.toMatch(/color:/);
  });

  it("cursor moves and erases are drawn, and nothing else gets through as markup", () => {
    const text = (s: string) => renderAnsi(s, { cols: 80, rows: 24 }).map((l) => l.map((r) => r.text).join(""));
    // A progress line rewritten in place; the cursor back up a line and along; the screen cleared and redrawn.
    expect(text("loading…\r\x1b[Kdone\nnext\x1b[1A\x1b[2Cxx")).toEqual(["done  xx", "next"]);
    expect(text("old screen\n\x1b[2J\x1b[Hnew")).toEqual(["new"]);
    expect(renderAnsi("<b>not markup</b>\x1b]0;title\x07", { cols: 80, rows: 24 })[0].map((r) => r.text).join("")).toBe("<b>not markup</b>]0;title");
  });

  it("a .cast file's transcript: its output, its size and its chapters", () => {
    const cast = ['{"version": 3, "term": {"cols": 80, "rows": 24}, "title": "trips plan"}', '[0.5, "o", "$ trips plan\\r\\n"]', '[0.1, "m", "Plan"]', '[0.4, "o", "\\u001b[32m✓\\u001b[0m Lake weekend\\r\\n"]'].join("\n");
    const t = readCast(cast);
    expect(t).toEqual({ ok: true, cols: 80, rows: 24, title: "trips plan", output: "$ trips plan\r\n\x1b[32m✓\x1b[0m Lake weekend\r\n", markers: ["Plan"] });
    expect(readCast("not json")).toEqual({ ok: false, error: "its first line is not an asciicast header" });
  });
});
