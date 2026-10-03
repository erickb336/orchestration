// ORC-029 pass 4d: the project's dictionary and a flow's rules, as tables in the studio, with the owner's mark on each
// row (keep, change, drop: one click each, a second click clears it). Rendered through react-dom/server over a fake
// store, as studio.test.tsx does; what a click does is checked through the functions the screen calls (studioView.ts),
// against the real command table.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ServiceInfo } from "../../api";
import { runCommand } from "../../domain/commands";
import * as M from "../../domain/model";
import { buildSeed } from "../../domain/seed";
import * as S from "../../domain/studio/studio";
import { DESIGNER, addScreen, lockInAsOwner, openRound, peAgrees, run, sha } from "../../domain/testing/studio";
import type { State } from "../../domain/types";
import { ConfirmProvider } from "../kit";
import { StoreContext, type ServiceStore } from "../store";
import { Studio } from "./Studio";
import { changedDrafts, draftFrom, draftKey, draftSummary, keepUnmarked, peView, rowMark, sendAnswer, showKind, tableRows, toggleRow, versionHistory, waitingForYourMark, type Draft } from "./studioView";

const T0 = Date.parse("2026-10-02T12:00:00Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const service: ServiceInfo = {
  startedAt: at(0),
  scheduler: "active",
  runtime: "fake",
  sim: { auto: false, ackMode: "normal" },
  dbPath: "/tmp/orchestration-test.db",
  providers: { claude: { label: "Claude", capabilities: {} as never }, codex: { label: "Codex", capabilities: {} as never } },
  prototypePort: 5320,
};
const store = (state: State) => ({ state, version: 1, service, status: "online", disabled: false, send: async () => ({ ok: true }), notice: null, setNotice: () => {} }) as unknown as ServiceStore;
const render = (state: State) =>
  renderToStaticMarkup(
    <ConfirmProvider>
      <StoreContext.Provider value={store(state)}>
        <Studio />
      </StoreContext.Provider>
    </ConfirmProvider>,
  );
const visible = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");
const vision = () => M.initProject(buildSeed(T0, { inFlightRuns: false }), { name: "Weekend Trips", repoPath: "/tmp/trips", vision: "Plan weekend trips with friends.", focus: "" }, at(0));

const WORDS = [
  { term: "trip", meaning: "A weekend away that a group plans together.", avoid: ["journey", "outing"] },
  { term: "member", meaning: "A person who said they are in.", avoid: [] },
  { term: "waiting list", meaning: "Who said they are in after the trip was full.", avoid: ["waitlist"] },
];
/** The data round with the designer's dictionary, which reaches the owner with no PE review. */
function withWords() {
  const r = openRound(vision(), "data", at(1));
  const a = run<{ artifactId: string }>(r.state, "addStudioArtifact", { round: r.n, kind: "dictionary", title: "Words", variants: [{ id: "a", label: "As drafted", entry: "dictionary.json" }], files: [{ path: "dictionary.json", sha256: sha("d") }], devices: [], madeBy: DESIGNER, dictionary: WORDS }, at(2));
  return { s: a.state, id: a.result.artifactId };
}
const RULES = [
  { id: "R1", text: "When a member says they are in, the app shall show the cost each." },
  { id: "R2", text: "If the trip is full, then the app shall add the person to the waiting list." },
];
/** The flows round with a flow whose one variant carries its rules, agreed by the PE. */
function withFlow(rules = true) {
  const r = openRound(vision(), "flows", at(1));
  const args = {
    round: r.n,
    kind: "flow",
    title: "Saying you are in",
    variants: [{ id: "a", label: "As drafted", entry: "doc/index.md" }],
    files: [{ path: "doc/index.md", sha256: sha("1") }, ...(rules ? [{ path: "doc/rules.json", sha256: sha("2") }] : [])],
    devices: [],
    madeBy: DESIGNER,
    ...(rules ? { rules: [{ variant: "a", path: "doc/rules.json", rules: RULES, examples: [{ id: "E1", text: "Given a full trip, when Sam says he is in, then Sam is on the waiting list." }] }] } : {}),
  };
  const a = run<{ artifactId: string }>(r.state, "addStudioArtifact", args, at(2));
  return { s: peAgrees(a.state, a.result.artifactId, 1, ["a"], at(3)), id: a.result.artifactId };
}

describe("the dictionary as a table", () => {
  it("shows each term with its meaning and the words to avoid, a mark on each row, and that it is not in force yet", () => {
    const { s, id } = withWords();
    expect(showKind(S.getArtifact(s, id, 1))).toBe("dictionary");
    const html = render(s);
    const text = visible(html);
    expect(text).toContain("Term Meaning Words to avoid Your mark");
    expect(text).toContain("trip A weekend away that a group plans together. journey, outing Keep Change Drop");
    expect(text).toContain("member A person who said they are in. none Keep Change Drop");
    expect(text).toContain("Not in force Not in force yet. Mark it Keep and send to put these words in the draft.");
    expect(html).toContain('aria-label="Your mark on &quot;waiting list&quot;"');
    expect(text).toContain("0 of 3 terms marked.");
    expect(text).toContain("Keep the other 3 terms");
    expect(html).not.toContain("<iframe");
  });

  it("the PE does not review it: PE review says why, and its marks are open at once", () => {
    const html = render(withWords().s);
    expect(visible(html)).toContain("PE review Not reviewed The PE does not review it: it is a word list, and the PE judges feasibility, scale, longevity and budget.");
    expect(html).toMatch(/aria-label="Your mark on &quot;trip&quot;"><button[^>]*aria-pressed="false"[^>]*>Keep</);
    expect(html).not.toMatch(/aria-label="Your mark on &quot;trip&quot;"><button[^>]*aria-disabled="true"/);
    // A flow the PE has not reviewed yet: its rule marks are locked.
    const r = openRound(vision(), "flows", at(1));
    const flow = run(r.state, "addStudioArtifact", { round: r.n, kind: "flow", title: "Saying you are in", variants: [{ id: "a", label: "As drafted", entry: "doc/index.md" }], files: [{ path: "doc/index.md", sha256: sha("1") }, { path: "doc/rules.json", sha256: sha("2") }], devices: [], madeBy: DESIGNER, rules: [{ variant: "a", path: "doc/rules.json", rules: RULES, examples: [] }] }, at(2)).state;
    expect(render(flow)).toMatch(/aria-label="Your mark on rule R1"><button[^>]*aria-disabled="true"/);
  });

  it("one click marks a row and a second clears it; Keep the rest marks only the open rows", () => {
    const { s, id } = withWords();
    const a = S.getArtifact(s, id, 1);
    let d: Draft = draftFrom(undefined);
    d = toggleRow(d, "member", undefined, "drop");
    expect(rowMark(d, "member")).toBe("drop");
    expect(rowMark(toggleRow(d, "member", undefined, "drop"), "member")).toBeNull();
    expect(rowMark(toggleRow(d, "member", undefined, "change"), "member")).toBe("change");
    d = keepUnmarked(d, tableRows(a));
    expect(d.rows).toEqual([
      { row: "member", mark: "drop" },
      { row: "trip", mark: "keep" },
      { row: "waiting list", mark: "keep" },
    ]);
    expect(draftSummary(a, d)).toBe("3 terms marked");
  });

  it("the marks show on their rows, and Send records them on the version through the real command", async () => {
    const { s, id } = withWords();
    const a = S.getArtifact(s, id, 1);
    const d = toggleRow(toggleRow(draftFrom(undefined), "trip", undefined, "keep"), "member", undefined, "change");
    let state = s;
    const send = async (name: string, args: object) => {
      state = runCommand(state, name, args, at(20)).state;
      return { ok: true };
    };
    expect(await sendAnswer(send, s, { [draftKey(a)]: d }, { round: 1, questions: [], answers: [], message: "" })).toEqual({ recorded: [draftKey(a)], draft: [], posted: true });
    expect(S.currentFeedback(state, id, 1)?.rows).toEqual([
      { row: "trip", mark: "keep" },
      { row: "member", mark: "change" },
    ]);
    expect(state.conversation.at(-1)?.text).toBe("My feedback, recorded on each version:\n- Words v1: 2 terms marked");
    expect(changedDrafts(state, { [draftKey(a)]: d })).toEqual([]);
    const html = render(state);
    expect(html).toContain('<tr class="st-row--change"><th scope="row">member</th>');
    expect(html).toMatch(/aria-label="Your mark on &quot;member&quot;">(?:<button[^>]*>[^<]*<\/button>){1}<button[^>]*aria-pressed="true"[^>]*>Change</);
    expect(visible(html)).toContain("2 of 3 terms marked");
  });

  it("is in the draft once approved and in force once locked in, and says so; with every term marked, it no longer waits for your mark", () => {
    const { s, id } = withWords();
    expect(waitingForYourMark(s).map((a) => a.id)).toEqual([id]);
    const some = runCommand(s, "sendFeedback", { entries: [{ artifactId: id, version: 1, mark: null, pins: [], note: "", rows: [{ row: "trip", mark: "keep" }] }] }, at(9)).state;
    expect(waitingForYourMark(some).map((a) => a.id)).toEqual([id]);
    const marked = runCommand(s, "sendFeedback", { entries: [{ artifactId: id, version: 1, mark: null, pins: [], note: "", rows: WORDS.map((w) => ({ row: w.term, mark: "keep" })) }] }, at(10)).state;
    expect(waitingForYourMark(marked)).toEqual([]);
    const approved = runCommand(marked, "approveArtifact", { artifactId: id, version: 1 }, at(11)).state;
    expect(visible(render(approved))).toContain("In the draft The studio uses these words now. The factory's agents get them at your next Lock in.");
    const locked = lockInAsOwner(approved, at(12));
    expect(visible(render(locked))).toContain("In force These are the project's words. Every agent gets them, and the writing check reports a word to avoid.");
  });
});

describe("what waits for your mark, by the kind's rules", () => {
  it("a dictionary waits for your mark with no PE review; what you brought is not reviewed and does not wait", () => {
    const zero = openRound(vision(), "material", at(1));
    const brought = addScreen(zero.state, zero.n, at(2), { kind: "material", title: "Group page sketch", variants: [], devices: [], madeBy: { role: "user" } });
    const data = openRound(runCommand(brought.state, "closeRound", { round: 0 }, at(3)).state, "data", at(3));
    const words = run<{ artifactId: string }>(data.state, "addStudioArtifact", { round: data.n, kind: "dictionary", title: "Words", variants: [{ id: "a", label: "As drafted", entry: "dictionary.json" }], files: [{ path: "dictionary.json", sha256: sha("d") }], devices: [], madeBy: DESIGNER, dictionary: WORDS }, at(4));
    const s = words.state;
    expect(waitingForYourMark(s).map((a) => a.title)).toEqual(["Words"]);
    const sketch = S.getArtifact(s, brought.id, 1);
    expect(peView(s, sketch, M.providerLabel)).toEqual({ tone: "neutral", state: "Not reviewed", text: "The PE does not review it: it is source material, not a design.", simulated: false, verdicts: [] });
    expect(versionHistory(s, sketch)).toEqual([{ version: 1, round: 0, current: true, tone: "neutral", state: "not reviewed", text: "The PE does not review it: it is source material, not a design." }]);
  });
});

describe("a flow's rules as a table", () => {
  it("shows each rule with its id and the pattern it fits, a mark on each, and the examples below", () => {
    const { s } = withFlow();
    const html = render(s);
    const text = visible(html);
    expect(text).toContain("Rules (2)");
    expect(text).toContain("Rule Pattern Your mark");
    expect(text).toContain("R1 When a member says they are in, the app shall show the cost each. Event Keep Change Drop");
    expect(text).toContain("R2 If the trip is full, then the app shall add the person to the waiting list. Unwanted Keep Change Drop");
    expect(text).toContain("Examples (1) E1 Given a full trip, when Sam says he is in, then Sam is on the waiting list.");
    expect(html).toContain('<span class="k-chip" title="If &lt;unwanted condition&gt;, then the &lt;system&gt; shall &lt;response&gt;.">Unwanted</span>');
    expect(html).toContain('aria-label="Your mark on rule R2"');
    // The flow is still a document: its Markdown shows above the rules.
    expect(html).toContain("Reading doc/index.md…");
  });

  it("a flow without rules shows no rules table", () => {
    const html = render(withFlow(false).s);
    expect(html).toContain("Reading doc/index.md…");
    expect(html).not.toContain('aria-label="Rules"');
  });
});
