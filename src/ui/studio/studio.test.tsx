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
import { DESIGNER, addScreen, feedback, openRound, peAgrees, pePass, run, sha } from "../../domain/testing/studio";
import type { RoundLead } from "../../domain/studio/types";
import type { State } from "../../domain/types";
import { TABS, VisionBadge } from "../App";
import { ConfirmProvider } from "../kit";
import { Overview } from "../Overview";
import { parseRoute } from "../route";
import { StoreContext, type ServiceStore } from "../store";
import { frameSize, readCast, renderAnsi } from "./ansi";
import { TerminalText } from "./Frames";
import { LeadPanel, Studio } from "./Studio";
import { MarkdownDoc, MermaidDiagram, mermaidConfig } from "./Document";
import { MAX_SVG_CHARS, diagramFrameDocument, diagramFramePolicy, readDiagramReply } from "./diagrams";
import {
  DOMAIN_CHOICES,
  MAX_MESSAGE,
  addPin,
  artifactLine,
  answerBlocker,
  changedDrafts,
  deviceOptions,
  documentFiles,
  documentType,
  draftFrom,
  draftKey,
  pinFromMessage,
  resolveInVersion,
  roundLabel,
  roundLead,
  sendAnswer,
  serviceFileUrl,
  showKind,
  toggleDomain,
  variantDemo,
  variantEntry,
  versionHistory,
  type Draft,
} from "./studioView";

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

/** The round with the lead's message and questions on it, as the lead's run records them (pass 4b's `round.lead`). */
function withLead(s: State, n: number, lead: RoundLead): State {
  const next = structuredClone(s);
  Object.assign(next.studio.rounds.find((r) => r.n === n)!, { lead });
  return next;
}

describe("Vision in the main navigation", () => {
  it("#/vision opens the studio", () => {
    expect(parseRoute("#/vision")).toEqual({ page: "vision" });
    expect(parseRoute("#/vision?round=2")).toEqual({ page: "vision" });
  });

  it("is a link in the navigation, and opening it sends no command, in Vision or in Factory", () => {
    const vTab = TABS.find((t) => t.page === "vision");
    expect(vTab).toEqual({ page: "vision", label: "Vision", href: "#/vision" });
    const { s } = withSample();
    const factory = M.startFactory(s, M.startFactoryRequest(s), at(9));
    expect(factory.project.stage).toBe("building");
    for (const state of [s, factory]) {
      const sent: string[] = [];
      const html = renderToStaticMarkup(
        <ConfirmProvider>
          <StoreContext.Provider value={{ ...store(state), send: async (name: string) => (sent.push(name), { ok: true }) } as unknown as ServiceStore}>
            <Studio />
          </StoreContext.Provider>
        </ConfirmProvider>,
      );
      expect(html).toContain("<h1 class=\"no-margin\">Vision</h1>");
      expect(sent).toEqual([]);
    }
    // In Factory it says what Vision can and cannot do there.
    expect(render(<Studio />, factory)).toContain("Looking at Vision changes nothing in it.");
  });

  it("its badge counts the agents' artifacts the PE passed to you that you have not marked", () => {
    const { s: waiting } = withSample({ pe: false });
    expect(renderToStaticMarkup(<StoreContext.Provider value={store(waiting)}>{<VisionBadge />}</StoreContext.Provider>)).toBe("");
    const { s, id } = withSample();
    expect(renderToStaticMarkup(<StoreContext.Provider value={store(s)}>{<VisionBadge />}</StoreContext.Provider>)).toContain('aria-label="1 artifact waiting for your mark"');
    const marked = feedback(s, id, 1, { mark: "keep" }, at(9));
    expect(renderToStaticMarkup(<StoreContext.Provider value={store(marked)}>{<VisionBadge />}</StoreContext.Provider>)).toBe("");
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
  it("shows the variant's entry sandboxed on its own origin, in a desktop frame, with the variants, the marks, Pin a comment and Send to the lead", () => {
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
    for (const label of [">Keep<", ">Change<", ">Drop<", "Pin a comment", "Send to the lead"]) expect(html).toContain(label);
    // The fake runtime made it: labelled so.
    expect(html).toContain("simulated");
    expect(html).toContain("Nothing marked or written yet.");
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

  it("Vision is reached from the main navigation, so Home has no studio card of its own", () => {
    const { s } = withSample();
    const html = render(<Overview />, s);
    expect(html).not.toContain("Open the studio");
    expect(html).not.toContain('href="#/vision"');
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
    expect(answerBlocker({ round: 1, questions: [], answers: [], message: "", changed })).toBe("Write a comment for pin 1 on Trip plan (simulated sample), or remove it.");
  });
});

describe("the lead's panel", () => {
  const LEAD = {
    message: "You kept the day list from round 1.\nHere are two takes on the trip plan: A puts the map first, B is a day by day list.",
    questions: [
      { text: "Should the plan work offline on the trail?", reason: "Phones lose signal on trails.", options: ["Yes, cache the plan", "Map tiles too", "Not now"] },
      { text: "Distances in miles or kilometres?" },
    ],
  };

  it("shows the round's message, its questions with suggested answers and an answer box, and Message the lead, above PE review and your feedback", () => {
    const { s, n } = withSample();
    const html = render(<Studio />, withLead(s, n, LEAD));
    expect(html).not.toContain("Not built yet");
    expect(html).toContain('<section class="k-stack k-stack--tight" aria-label="The lead">');
    expect(html).toContain('<p class="st-leadmsg">You kept the day list from round 1.\nHere are two takes on the trip plan');
    expect(html).toContain("Should the plan work offline on the trail?");
    expect(html).toContain("Why: Phones lose signal on trails.");
    expect(html).toContain('aria-label="Suggested answers to question 1"');
    for (const o of ["Yes, cache the plan", "Map tiles too", "Not now"]) expect(html).toMatch(new RegExp(`<button[^>]*aria-pressed="false"[^>]*>${o}</button>`));
    // The second question has no suggestions: only its answer box.
    expect(html).not.toContain("Suggested answers to question 2");
    expect(html).toContain("Your answer to question 2");
    expect(html).toContain(">Message the lead<");
    expect(html).toContain(">Open the conversation<");
    // Simulated: the fake runtime's lead wrote it.
    expect(html).toContain("Simulated: the demo&#x27;s lead wrote this round&#x27;s message and questions; no model ran.");
    // The lead first, then PE review, then your feedback and the one Send.
    const lead = html.indexOf('aria-label="The lead"');
    const pe = html.indexOf('aria-label="PE review"');
    const yours = html.indexOf('aria-label="Your feedback"');
    expect(lead).toBeGreaterThan(0);
    expect(pe).toBeGreaterThan(lead);
    expect(yours).toBeGreaterThan(pe);
    expect(html).toContain(">Send to the lead<");
    expect(html).not.toContain("Send feedback");
  });

  it("a suggested answer fills the answer box, pressed", () => {
    const { s, n } = withSample();
    const round = withLead(s, n, LEAD).studio.rounds.find((r) => r.n === n)!;
    const html = render(<LeadPanel round={round} answers={["Map tiles too", ""]} onAnswer={() => {}} message="" onMessage={() => {}} />, s);
    expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*>Map tiles too<\/button>/);
    expect(html).toMatch(/<button[^>]*aria-pressed="false"[^>]*>Yes, cache the plan<\/button>/);
    expect(html).toMatch(/<input[^>]*value="Map tiles too"/);
  });

  it("without the lead's words for the round (a round from before pass 4), it says so, and you can still write to the lead", () => {
    const { s, n } = withSample();
    const html = render(<Studio />, s);
    expect(html).toContain(`The lead has written nothing for round ${n}. Write to it below; it answers in the conversation.`);
    expect(html).not.toContain("The lead asks");
    expect(html).toContain(">Message the lead<");
    expect(html).toContain("Nothing marked or written yet.");
  });

  it("shows the lead's record as its run stored it, and nothing when the lead wrote neither a message nor a question", () => {
    const round = (lead?: RoundLead) => ({ n: 1, focus: "experience" as const, openedAt: at(1), summary: "", ...(lead ? { lead } : {}) });
    expect(roundLead(round())).toBeUndefined();
    expect(roundLead(round({ message: "  ", questions: [] }))).toBeUndefined();
    const lead = { message: "", questions: [{ text: "Offline?", reason: "Trails.", options: ["Yes"] }] };
    expect(roundLead(round(lead))).toEqual(lead);
  });
});

describe("Send to the lead: your marks, answers and message as one message", () => {
  const questions = [{ text: "Should the plan work offline on the trail?", options: ["Yes, cache the plan", "Not now"] }, { text: "Distances in miles or kilometres?" }];

  /** A send that runs each command against the state, as the service would, and records the calls. */
  function service2(start: State) {
    const calls: { name: string; args: object }[] = [];
    let state = start;
    const send = async (name: "sendFeedback" | "postMessage", args: object) => {
      calls.push({ name, args });
      state = runCommand(state, name, args, at(20 + calls.length)).state;
      return { ok: true };
    };
    return { calls, send, after: () => state };
  }

  it("records the marks on each version, then posts one message with your message, your answers and a line per marked artifact", async () => {
    const { s, id, n } = withSample();
    const a = S.getArtifact(s, id, 1);
    const draft: Draft = { ...addPin(draftFrom(undefined), PIN as never, "a"), mark: "change", pickedVariant: "b" };
    draft.pins[0].text = "Make the map smaller on phones.";
    draft.note = "Prefer B on phones.";
    const svc = service2(s);
    const before = s.conversation.length;
    const r = await sendAnswer(svc.send, s, { [draftKey(a)]: draft }, { round: n, questions, answers: ["Yes, cache the plan", ""], message: "Keep A's map header on desktop." });
    expect(r).toEqual({ recorded: [draftKey(a)], posted: true });
    expect(svc.calls.map((c) => c.name)).toEqual(["sendFeedback", "postMessage"]);
    // The marks are recorded on the version, pins with their element.
    const after = svc.after();
    expect(S.currentFeedback(after, id, 1)).toMatchObject({ mark: "change", pickedVariant: "b", note: "Prefer B on phones.", pins: [{ x: 0.25, y: 0.5, variant: "a", text: "Make the map smaller on phones.", selector: "main > div.map" }] });
    // One message in the conversation, the one the header's Message the lead opens.
    const added = after.conversation.slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ author: "user" });
    expect(added[0].text).toBe(
      [
        "Keep A's map header on desktop.",
        `My answers to round ${n}:\n\nQ: Should the plan work offline on the trail?\nA: Yes, cache the plan`,
        "My feedback, recorded on each version:\n- Trip plan (simulated sample) v1: Change, picked B · Day by day, 1 pin, a note",
      ].join("\n\n"),
    );
    // Once recorded, the same draft is no longer a change: nothing is sent twice.
    expect(changedDrafts(after, { [draftKey(a)]: draft })).toEqual([]);
    const html = render(<Studio />, after);
    expect(html).toContain('<code class="st-selector">main &gt; div.map</code>');
    expect(html).not.toContain("The element is not recorded");
  });

  it("answers or a message alone are one postMessage, and a message alone is exactly what you wrote", async () => {
    const { s, n } = withSample();
    const answersOnly = service2(s);
    expect(await sendAnswer(answersOnly.send, s, {}, { round: n, questions, answers: ["", "Kilometres"], message: "" })).toEqual({ recorded: [], posted: true });
    expect(answersOnly.calls.map((c) => c.name)).toEqual(["postMessage"]);
    expect(answersOnly.calls[0].args).toEqual({ text: `My answers to round ${n}:\n\nQ: Distances in miles or kilometres?\nA: Kilometres` });
    const messageOnly = service2(s);
    await sendAnswer(messageOnly.send, s, {}, { round: n, questions, answers: [], message: "  Can we see a calmer palette?  " });
    expect(messageOnly.calls).toEqual([{ name: "postMessage", args: { text: "Can we see a calmer palette?" } }]);
  });

  it("sends nothing until there is something, a pin has its comment and it fits; refused marks stop the message", async () => {
    const { s, id, n } = withSample({ pe: false });
    const a = S.getArtifact(s, id, 1);
    const empty = { round: n, questions, answers: [], message: "" };
    const svc = service2(s);
    expect(answerBlocker({ ...empty, changed: [] })).toBe("Mark, pick or pin something, answer a question, or write to the lead first.");
    expect(await sendAnswer(svc.send, s, {}, empty)).toBeNull();
    // A version still with the PE is not yours to mark: its draft is not sent.
    expect(await sendAnswer(svc.send, s, { [draftKey(a)]: { ...draftFrom(undefined), mark: "keep" } }, empty)).toBeNull();
    expect(svc.calls).toEqual([]);
    const agreed = peAgrees(s, id, 1, ["a", "b"], at(7));
    const pinned = addPin(draftFrom(undefined), PIN as never, "b");
    expect(answerBlocker({ ...empty, message: "Hi", changed: changedDrafts(agreed, { [draftKey(a)]: pinned }) })).toBe("Write a comment for pin 1 on Trip plan (simulated sample), or remove it.");
    expect(answerBlocker({ ...empty, message: "x".repeat(MAX_MESSAGE + 1), changed: [] })).toBe(`Together this is over ${MAX_MESSAGE} characters; shorten your message or your answers.`);
    // The service refuses the marks (the version moved, say): the message is not posted, so it never speaks of marks that were not recorded.
    const names: string[] = [];
    const refuse = async (name: "sendFeedback" | "postMessage") => (names.push(name), { ok: false });
    expect(await sendAnswer(refuse, agreed, { [draftKey(a)]: { ...draftFrom(undefined), mark: "keep" } }, { ...empty, message: "Hi" })).toBeNull();
    expect(names).toEqual(["sendFeedback"]);
    // The marks recorded but the message refused: the drafts can clear, and the message stays to send again.
    const half = async (name: "sendFeedback" | "postMessage") => ({ ok: name === "sendFeedback" });
    expect(await sendAnswer(half, agreed, { [draftKey(a)]: { ...draftFrom(undefined), mark: "keep" } }, { ...empty, message: "Hi" })).toEqual({ recorded: [draftKey(a)], posted: false });
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

describe("the product's kinds (domains), while they are not chosen", () => {
  it("the studio asks once, compactly: three kinds, none pressed, each a click that saves; gone once they are chosen", () => {
    const s = vision();
    expect(s.project.domains).toEqual([]);
    const html = render(<Studio />, s);
    expect(html).toContain("What kind of product is it?");
    expect(html).toContain("Screen product: people use it on a screen. Code product: other programs use it. Infrastructure: it runs other software.");
    const group = /<div class="st-chips st-kinds" role="group" aria-label="Kind of product">(.*?)<\/div>/.exec(html)?.[1] ?? "";
    expect([...group.matchAll(/<button[^>]*aria-pressed="(true|false)"[^>]*>([^<]+)<\/button>/g)].map((m) => [m[2], m[1]])).toEqual([
      ["Screen product", "false"],
      ["Code product", "false"],
      ["Infrastructure", "false"],
    ]);
    // Even with no round yet: the kind decides what the designer makes in round 1.
    expect(html).toContain("No rounds yet.");

    // A click sends setDomains with that kind, which the real command table accepts; then the prompt is gone.
    const chosen = runCommand(s, "setDomains", { domains: toggleDomain(s.project.domains, "code") }, at(5)).state;
    expect(chosen.project.domains).toEqual(["code"]);
    expect(render(<Studio />, chosen)).not.toContain("What kind of product is it?");
  });

  it("a kind toggles in and out, always in the same order", () => {
    expect(toggleDomain([], "infrastructure")).toEqual(["infrastructure"]);
    expect(toggleDomain(["infrastructure"], "screen")).toEqual(["screen", "infrastructure"]);
    expect(toggleDomain(["screen", "infrastructure"], "screen")).toEqual(["infrastructure"]);
  });

  it("the words: each kind by who uses it and what the designer makes, in short sentences", () => {
    expect(DOMAIN_CHOICES.map((c) => c.value)).toEqual(["screen", "code", "infrastructure"]);
    for (const c of DOMAIN_CHOICES) for (const sentence of `${c.use} ${c.makes}`.split(/(?<=\.)\s/)) expect(sentence.split(/\s+/).length).toBeLessThanOrEqual(20);
  });
});

describe("as it is today (round 0 of an existing repository)", () => {
  /** Round 0 with the designer's reproduction of the trip board, labelled as is, from `files`; agreed by the PE. */
  function withAsIs(files: string[]) {
    const r = openRound(vision(), "material", at(1));
    const a = addScreen(r.state, r.n, at(2), { title: "Trip board", variants: [{ id: "a", label: "As is", entry: "board/index.html" }], files: [{ path: "board/index.html", sha256: sha("a") }], provenance: { files } });
    return { s: peAgrees(a.state, a.id, 1, ["a"], at(3)), id: a.id };
  }

  it("the round is named As it is today, not What you brought; the artifact says it is a reproduction to correct, with the files it came from", () => {
    const { s, id } = withAsIs(["src/board/index.html", "src/board/style.css"]);
    expect(roundLabel(s, s.studio.rounds[0])).toBe("As it is today");
    expect(artifactLine(S.getArtifact(s, id, 1))).toBe("as is · screen");
    const html = render(<Studio />, s);
    expect(html).toContain("0 · As it is today");
    expect(html).not.toContain("What you brought");
    expect(html).toContain('aria-label="As it is today"');
    expect(html).toContain("It is not a proposal. Correct what it gets wrong");
    expect(html).toContain("Made from 2 files in the repository:");
    expect(html).toContain("<code>src/board/index.html</code>");
    expect(html).toContain("<code>src/board/style.css</code>");
    // You can mark it, as any artifact the PE agreed on.
    expect(html).toMatch(/<button[^>]*aria-pressed="false"[^>]*>Keep<\/button>/);
  });

  it("a long list of files shows the first six; the rest are one click away", () => {
    const files = Array.from({ length: 9 }, (_, i) => `src/part-${i + 1}.js`);
    const html = render(<Studio />, withAsIs(files).s);
    expect(html).toContain("Made from 9 files in the repository:");
    expect(html.indexOf("src/part-6.js")).toBeLessThan(html.indexOf("The other files"));
    expect(html.indexOf("src/part-7.js")).toBeGreaterThan(html.indexOf("The other files"));
  });

  it("what the owner brought, and every later round, keep their names", () => {
    const { s } = withSample();
    expect(s.studio.rounds.map((r) => roundLabel(s, r))).toEqual(["The experience"]);
    const material = openRound(vision(), "material", at(1)).state;
    expect(roundLabel(material, material.studio.rounds[0])).toBe("What you brought");
  });
});

describe("PE review in the right column", () => {
  /** The sample, with a PE run on Codex (simulated) that made one pass with these verdicts. */
  function reviewed(verdicts: object[]) {
    const { s: designed, id, n } = withSample({ pe: false });
    let s = R.askForPeReviews(designed, at(6));
    s = R.dispatchStudioRuns(s, at(7), { simulated: ["codex"] }).state;
    const pe = s.studio.runs.find((r) => r.kind === "pe")!;
    s = S.addPeVerdicts(s, { artifactId: id, version: 1, verdicts: verdicts as S.VerdictInput[], by: { provider: "codex", model: pe.model, runId: pe.id } }, at(8)).state;
    s = R.completeStudioRun(s, pe.id, at(8), { summary: "pass 1" });
    return { s, id, n };
  }
  /** The loop on that pass ended: the designer's two runs revising it failed (ORC-029 pass 4), so the version is the owner's at pass 1. */
  function revisionsFailed(x: { s: State; id: string; n: number }): State {
    let s = x.s;
    for (const sec of [9, 10]) {
      const r = run<{ runId: string }>(s, "startStudioRun", { kind: "designer", round: x.n, artifactId: x.id, brief: "Revise it for the PE." }, at(sec));
      s = R.reportStudioRunFailed(R.dispatchStudioRuns(r.state, at(sec), { simulated: ["claude"] }).state, r.result.runId, "The simulated designer could not revise.", at(sec));
    }
    return s;
  }

  /**
   * The PE loop (pass 4c): the PE objects to B on each pass, and the designer revises after the first two, so v1 and
   * v2 are revised and v3 holds the objection that stands after the third pass.
   */
  function threePasses() {
    const { s: designed, id, n } = withSample({ pe: false });
    const objects = (s: State, version: number, t: number) => pePass(s, id, version, [{ variant: "a", verdict: "feasible" }, { variant: "b", verdict: "not-feasible", reasons: "Live prices need a paid API.", change: "A free source of prices." }], at(t));
    const revise = (s: State, t: number) => addScreen(s, n, at(t), { artifactId: id, title: "Trip plan (simulated sample)", variants: [{ id: "a", label: "A · Map first", entry: "a/index.html" }, { id: "b", label: "B · Day by day", entry: "b/index.html" }], files: SAMPLE_FILES }).state;
    let s = objects(designed, 1, 10);
    const afterOne = s;
    s = objects(revise(s, 11), 2, 12);
    s = objects(revise(s, 13), 3, 14);
    return { afterOne, s, id };
  }
  const BUDGET = { buildUsd: [40, 90] as [number, number], maintenanceUsdPerMonth: [0, 5] as [number, number], basis: "Recorded designer runs of this size." };

  it("once the PE agrees: its verdict on each variant with the budget effect, labelled simulated, and the marks unlocked", () => {
    const { s } = reviewed([
      { variant: "a", verdict: "feasible", reasons: "A static page with a drawn map." },
      { variant: "b", verdict: "feasible", reasons: "A list of days, paged after a week.", budget: BUDGET },
    ]);
    // A real agreement: every variant feasible on the PE's pass, with no revision run at all.
    expect(S.peReview(s, S.latestVersion(s, s.studio.artifacts[0].id)!)).toEqual({ status: "agreed", pass: 1 });
    expect(s.studio.runs.filter((r) => r.kind === "designer" && r.artifactId)).toEqual([]);
    const html = render(<Studio />, s);
    expect(html).toContain(">Agreed<");
    expect(html).toContain("The PE agreed on pass 1: every option is feasible. It is yours to mark.");
    expect(html).toContain("PE · Codex · codex-sample-large");
    expect(html).toContain("Simulated: the fake runtime&#x27;s PE answered; no agent judged this.");
    expect(html).toMatch(/A · Map first<\/b><span class="k-chip k-chip--done">Feasible</);
    expect(html).toMatch(/B · Day by day<\/b><span class="k-chip k-chip--done">Feasible</);
    expect(html).toContain("Budget effect: building $40–$90, maintenance $0–$5 a month. Basis: Recorded designer runs of this size.");
    // The lock is gone: nothing says the PE is still reviewing, and the marks can be pressed.
    expect(html).not.toContain("Waiting for PE review. You can look at it now");
    expect(html).not.toContain("with the PE");
    expect(html).not.toMatch(/aria-disabled="true"[^>]*>Keep</);
  });

  it("a loop that ended with the PE still asking for a change is never shown as agreed: the change, why review ended, and the marks unlocked", () => {
    const x = reviewed([
      { variant: "a", verdict: "feasible", reasons: "A static page with a drawn map." },
      { variant: "b", verdict: "feasible-if", reasons: "Long trips need paging.", change: "Page the days after a week.", budget: BUDGET },
    ]);
    // While the designer may still revise, it is not yours yet.
    expect(render(<Studio />, x.s)).toMatch(/aria-disabled="true"[^>]*>Keep</);
    const s = revisionsFailed(x);
    expect(S.peReview(s, S.getArtifact(s, x.id, 1))).toMatchObject({ status: "ended", ended: "no-revision", pass: 1, objections: [], asks: [{ variant: "b" }] });
    const html = render(<Studio />, s);
    expect(html).not.toContain(">Agreed<");
    expect(html).toContain("The PE still asks for changes to B · Day by day. PE review ended: the designer&#x27;s runs revising it ended 2 times without a new version.");
    expect(html).toMatch(/B · Day by day<\/b><span class="k-chip k-chip--you">Feasible if changed</);
    expect(html).toContain("The change: Page the days after a week.");
    expect(html).not.toMatch(/aria-disabled="true"[^>]*>Keep</);
  });

  it("an objection while passes remain: the designer revises, and you can look but not mark", () => {
    const { afterOne } = threePasses();
    const html = render(<Studio />, afterOne);
    expect(html).toContain(">Revising<");
    expect(html).toContain("The PE objected on pass 1; the designer revises before it reaches you.");
    expect(html).toMatch(/aria-disabled="true"[^>]*>Keep</);
  });

  it("an objection that stands after the third pass says plainly that it is waiting for you, and you can answer", () => {
    const { s } = threePasses();
    const html = render(<Studio />, s);
    expect(html).toContain(">Objects: waiting for you<");
    expect(html).toContain("The PE still objects to B · Day by day. PE review ended: the PE made its 3 passes in the round. This is waiting for you: mark it Keep, Change or Drop, pick a variant, and say what you decide in your note.");
    expect(html).toMatch(/<span class="k-chip k-chip--fail">Not feasible</);
    expect(html).toContain("What would change the verdict: A free source of prices.");
    expect(html).not.toMatch(/aria-disabled="true"[^>]*>Keep</);
    // Flagged in the round's list too.
    expect(html).toContain('<span class="k-chip k-chip--you">PE objects</span>');
  });

  it("the versions: v1 → v2 → v3, the PE's pass on each, which is current, and the objection that stands waiting for you", () => {
    const { s, id } = threePasses();
    expect(versionHistory(s, S.getArtifact(s, id, 3))).toEqual([
      { version: 1, round: 1, current: false, tone: "neutral", state: "objected", text: "PE pass 1: objected to B · Day by day; the designer revised it as v2." },
      { version: 2, round: 1, current: false, tone: "neutral", state: "objected", text: "PE pass 2: objected to B · Day by day; the designer revised it as v3." },
      { version: 3, round: 1, current: true, tone: "you", state: "waiting for you", text: "PE pass 3: still objects to B · Day by day; review ended: the PE made its 3 passes in the round. This is waiting for you." },
    ]);
    const html = render(<Studio />, s);
    expect(html).toContain('aria-label="Versions of Trip plan (simulated sample)"');
    expect(html).toMatch(/<button type="button" class="st-item st-version" aria-current="true"><span class="st-version__head"><b>v3<\/b><span class="k-chip k-chip--you">waiting for you<\/span><span class="k-chip k-chip--strong">current<\/span>/);
    expect(html).toContain("PE pass 1: objected to B · Day by day; the designer revised it as v2.");
    // A version that the PE agreed on, and your mark on it, once you answered.
    const { s: agreed, id: one } = withSample();
    expect(versionHistory(feedback(agreed, one, 1, { mark: "keep" }, at(9)), S.getArtifact(agreed, one, 1))).toEqual([{ version: 1, round: 1, current: true, tone: "done", state: "agreed", text: "PE pass 1: agreed. You marked it keep." }]);
    // One version has no history to show.
    expect(render(<Studio />, agreed)).not.toContain("Versions of");
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

  it("a PE that ran on the designer's own provider is labelled not independent; on the other provider it is not", () => {
    const { s: designed, id } = withSample({ pe: false });
    const pass = (provider: "claude" | "codex") =>
      S.addPeVerdicts(
        designed,
        {
          artifactId: id,
          version: 1,
          verdicts: [
            { variant: "a", verdict: "feasible", reasons: "A static page." },
            { variant: "b", verdict: "feasible", reasons: "A list." },
          ],
          by: { provider, model: `${provider}-sample-large`, runId: "run-pe" },
        },
        at(8),
      ).state;
    // The designer ran on Claude (the sample's run), and so did the PE.
    expect(S.getArtifact(designed, id, 1).madeBy).toMatchObject({ role: "designer", provider: "claude" });
    const same = render(<Studio />, pass("claude"));
    expect(same).toContain('<span class="k-chip k-chip--you">not independent</span>');
    expect(same).toContain("Not independent: the PE ran on the designer&#x27;s own provider (Claude).");
    expect(same).toContain(">Agreed<");
    const other = render(<Studio />, pass("codex"));
    expect(other).not.toContain("ot independent");
    expect(other).toContain("PE · Codex · codex-sample-large");
  });

  it("a PE run that ended without a verdict says so and is asked again; after the second, review ends and the version is yours, never left waiting", () => {
    const { s: designed } = withSample({ pe: false });
    let s = R.dispatchStudioRuns(R.askForPeReviews(designed, at(6)), at(7)).state;
    const first = s.studio.runs.find((r) => r.kind === "pe")!;
    s = R.reportStudioRunFailed(s, first.id, "Its verdicts were refused: its answer has no JSON block with the verdicts", at(8));
    expect(render(<Studio />, s)).toContain("The PE&#x27;s run ended without a verdict (Its verdicts were refused: its answer has no JSON block with the verdicts); it is asked again.");
    s = R.dispatchStudioRuns(R.askForPeReviews(s, at(9)), at(10)).state;
    s = R.reportStudioRunStopped(s, s.studio.runs.filter((r) => r.kind === "pe")[1].id, at(11), { lost: true });
    const html = render(<Studio />, s);
    expect(html).toContain("The PE did not review it. PE review ended: the PE&#x27;s runs on it ended 2 times without a verdict.");
    expect(html).not.toMatch(/aria-disabled="true"[^>]*>Keep</);
  });
});

describe("document artifacts: interfaces, algorithms, topologies, contracts and flows", () => {
  /** A contract the designer handed in as Markdown with a Mermaid file beside it, agreed by the PE. */
  function withContract() {
    const r = openRound(vision(), "data", at(1));
    const a = addScreen(r.state, r.n, at(2), {
      kind: "contract",
      title: "Trips API",
      variants: [],
      devices: [],
      files: [
        { path: "api/contract.md", sha256: sha("a") },
        { path: "api/flow.mmd", sha256: sha("b") },
        { path: "api/notes.html", sha256: sha("c") },
      ],
    });
    return { s: peAgrees(a.state, a.id, 1, [], at(3)), id: a.id };
  }

  it("each document kind is shown as a document; screens and terminal demos are not", () => {
    const { s, id } = withContract();
    const a = S.getArtifact(s, id, 1);
    for (const kind of ["interface", "algorithm", "topology", "contract", "flow"]) expect(showKind({ ...a, kind: kind as never })).toBe("document");
    expect(showKind({ ...a, kind: "screen" })).toBe("screen");
    expect(showKind({ ...a, kind: "tui" })).toBe("terminal");
    expect(showKind({ ...a, kind: "material" })).toBe("file");
  });

  it("in the viewer: no device frame and no prototype frame; its Markdown and Mermaid files, read through the app's own service", () => {
    const { s, id } = withContract();
    const html = render(<Studio />, s);
    expect(html).toContain('aria-label="Trips API, a document"');
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("in a browser window");
    expect(html).not.toContain("in a phone frame");
    expect(html).not.toContain('aria-label="Device"');
    expect(html).not.toContain("Pin a comment");
    // Both document files, named; the HTML file is not a document and is never read from the app's origin.
    expect(html).toContain("Reading api/contract.md…");
    expect(html).toContain("Reading api/flow.mmd…");
    expect(html).not.toContain("notes.html");
    expect(serviceFileUrl(S.getArtifact(s, id, 1), "api/flow.mmd")).toBe(`/api/studio/file?artifact=${id}&version=1&path=api%2Fflow.mmd`);
  });

  it("which files a variant shows: its entry first, then the documents beside it; one take shows them all", () => {
    const { s, id } = withContract();
    const a = S.getArtifact(s, id, 1);
    expect(documentFiles(a, undefined)).toEqual(["api/contract.md", "api/flow.mmd"]);
    const two = {
      ...a,
      variants: [
        { id: "a", label: "A · REST", entry: "a/flow.mmd" },
        { id: "b", label: "B · Events", entry: "b/api.md" },
      ],
      files: ["a/api.md", "a/flow.mmd", "b/api.md", "b/index.html"].map((path, i) => ({ path, sha256: sha("abcd"[i]) })),
    };
    expect(documentFiles(two, "a")).toEqual(["a/flow.mmd", "a/api.md"]);
    expect(documentFiles(two, "b")).toEqual(["b/api.md"]);
    expect(documentFiles({ ...two, variants: [{ id: "x", label: "X" }, { id: "y", label: "Y" }] }, "x")).toEqual([]);
    expect(documentType("a/API.MD")).toBe("markdown");
    expect(documentType("a/flow.mermaid")).toBe("mermaid");
    expect(documentType("a/index.html")).toBeUndefined();
  });

  it("Markdown is rendered safely: headings under the page's, code blocks monospaced, tables as tables, raw HTML as text, links out only when http(s), images only the version's own", () => {
    const { s, id } = withContract();
    const a = { ...S.getArtifact(s, id, 1), files: [...S.getArtifact(s, id, 1).files, { path: "api/shot.png", sha256: sha("d") }] };
    const md = [
      "# Trips API",
      "",
      "Every call returns `JSON`.",
      "",
      "```ts",
      "export function plan(trip: Trip): DayPlan[];",
      "```",
      "",
      "| Status | Meaning |",
      "| --- | --- |",
      "| 404 | No such trip |",
      "",
      '<script>alert("x")</script><img src=x onerror="alert(1)">',
      "",
      "[docs](https://example.com/docs) [steal](javascript:alert(1)) [settings](#/settings)",
      "",
      "![the plan](shot.png) ![tracker](https://example.com/pixel.png)",
    ].join("\n");
    const html = renderToStaticMarkup(<MarkdownDoc text={md} artifact={a} path="api/contract.md" />);
    expect(html).toContain('<h3 class="st-doc__h">Trips API</h3>');
    expect(html).not.toContain("<h1");
    expect(html).toContain("<code>JSON</code>");
    expect(html).toContain('<pre class="st-doc__code"><code class="language-ts">export function plan(trip: Trip): DayPlan[];\n</code></pre>');
    expect(html).toMatch(/<div class="st-doc__table"><table><thead><tr><th>Status<\/th><th>Meaning<\/th><\/tr><\/thead><tbody><tr><td>404<\/td><td>No such trip<\/td><\/tr><\/tbody><\/table><\/div>/);
    // Raw HTML is shown as text, never as markup.
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).not.toMatch(/<script|<img src="x"|onerror="/);
    // Links: out of the app in a new tab when http(s); anything else is text.
    expect(html).toContain('<a href="https://example.com/docs" target="_blank" rel="noopener noreferrer">docs</a>');
    expect(html).toContain('<span class="st-doc__link">steal</span>');
    expect(html).toContain('<span class="st-doc__link">settings</span>');
    expect(html).not.toContain("javascript:");
    // Images: the version's own PNG through the app's service; nothing from elsewhere is loaded.
    expect(html).toContain(`<img src="/api/studio/file?artifact=${id}&amp;version=1&amp;path=api%2Fshot.png" alt="the plan" class="st-doc__img"/>`);
    expect(html).toContain("[Image: tracker, not shown: only the artifact&#x27;s own PNG and GIF files are.]");
    expect(html).not.toContain("pixel.png");
  });

  it("a mermaid block, or a .mmd file, is a diagram the app draws, with its source under it", () => {
    const { s, id } = withContract();
    const a = S.getArtifact(s, id, 1);
    const html = renderToStaticMarkup(<MarkdownDoc text={"Before.\n\n```mermaid\nflowchart LR\n  A[Pick a trail] --> B{Date ok?}\n```\n"} artifact={a} path="api/contract.md" />);
    expect(html).toContain('<figure class="st-doc__diagram">');
    expect(html).toContain("Drawing the diagram…");
    expect(html).toContain("<summary class=\"small muted\">Diagram source</summary>");
    expect(html).toContain("flowchart LR\n  A[Pick a trail] --&gt; B{Date ok?}</code>");
    expect(html).not.toContain("language-mermaid");
    const file = renderToStaticMarkup(<MermaidDiagram source={"sequenceDiagram\n  App->>API: plan"} label="The diagram in api/flow.mmd" />);
    expect(file).toContain("Drawing the diagram…");
    expect(file).toContain("sequenceDiagram\n  App-&gt;&gt;API: plan");
  });

  it("Mermaid runs at strict security, and a diagram's own directives cannot relax it, its labels or its sanitiser", () => {
    const tokens: Record<string, string> = { "--surface": "#1a1b1e", "--text": "#ececea", "--muted": " #a3a6ad " };
    const c = mermaidConfig((name) => tokens[name] ?? "");
    expect(c).toMatchObject({ securityLevel: "strict", startOnLoad: false, htmlLabels: false, suppressErrorRendering: true, theme: "base" });
    for (const key of ["securityLevel", "startOnLoad", "secure", "htmlLabels", "dompurifyConfig", "maxTextSize"]) expect(c.secure).toContain(key);
    // Nor add CSS or a URL (pass 4 review, finding 2): themeCSS, the fonts, absolute marker URLs, KaTeX's stylesheet mode.
    for (const key of ["themeCSS", "fontFamily", "altFontFamily", "themeVariables", "arrowMarkerAbsolute", "legacyMathML", "forceLegacyMathML"]) expect(c.secure).toContain(key);
    // The look comes from the design tokens; unset ones are left to Mermaid.
    expect(c.themeVariables).toMatchObject({ background: "#1a1b1e", primaryTextColor: "#ececea", lineColor: "#a3a6ad", darkMode: true });
    expect(c.themeVariables).not.toHaveProperty("primaryColor");
  });

  it("Mermaid draws in a frame whose own policy allows no request and only its two scripts; its replies are read strictly", () => {
    const scripts = ["http://127.0.0.1:5319/assets/mermaid.min-x.js", "http://127.0.0.1:5319/assets/diagramFrame-y.js"];
    expect(diagramFramePolicy(scripts)).toBe(`default-src 'none'; script-src ${scripts.join(" ")}; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`);
    // A query (the dev server adds one) is not part of a policy's source; the script tag keeps it.
    expect(diagramFramePolicy(["http://127.0.0.1:5317/src/ui/studio/diagramFrame.js?no-inline"])).toContain("script-src http://127.0.0.1:5317/src/ui/studio/diagramFrame.js;");
    const doc = diagramFrameDocument(scripts);
    // The policy comes first, then Mermaid, then the frame's script; no inline script.
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf(scripts[0]));
    expect(doc.indexOf(`<script src="${scripts[0]}">`)).toBeLessThan(doc.indexOf(`<script src="${scripts[1]}">`));
    expect(doc.match(/<script/g)).toHaveLength(2);
    expect(diagramFrameDocument(['http://x/a.js"><script>alert(1)</script>'])).not.toContain("<script>alert");

    expect(readDiagramReply({ type: "orc-diagram-ready", mermaid: true })).toEqual({ kind: "ready", mermaid: true });
    expect(readDiagramReply({ type: "orc-diagram-drawn", id: 3, svg: "<svg/>" })).toEqual({ kind: "drawn", id: 3, svg: "<svg/>" });
    expect(readDiagramReply({ type: "orc-diagram-failed", id: 3, message: "Parse error" })).toEqual({ kind: "failed", id: 3, message: "Parse error" });
    expect(readDiagramReply({ type: "orc-diagram-drawn", id: 3, svg: "x".repeat(MAX_SVG_CHARS + 1) })).toEqual({ kind: "failed", id: 3, message: "The drawing is too large to show." });
    for (const bad of [null, "orc-diagram-drawn", { type: "orc-diagram-drawn", id: "3", svg: "<svg/>" }, { type: "orc-diagram-drawn", id: 1.5, svg: "<svg/>" }, { type: "orc-diagram-drawn", id: 3, svg: 7 }, { type: "orchestrator-pin", id: 3 }]) {
      expect(readDiagramReply(bad)).toBeNull();
    }
  });

  it("a path a document refers to stays inside its version's folder", () => {
    expect(resolveInVersion("api/contract.md", "shot.png")).toBe("api/shot.png");
    expect(resolveInVersion("api/contract.md", "./img/a.png")).toBe("api/img/a.png");
    expect(resolveInVersion("api/contract.md", "../top.png")).toBe("top.png");
    expect(resolveInVersion("api/contract.md", "../../etc/passwd")).toBeUndefined();
    expect(resolveInVersion("api/contract.md", "/abs.png")).toBeUndefined();
    expect(resolveInVersion("api/contract.md", "https://example.com/a.png")).toBeUndefined();
    expect(resolveInVersion("api/contract.md", "data:image/png;base64,AAAA")).toBeUndefined();
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
