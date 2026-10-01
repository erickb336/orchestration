// ORC-025 (L3): the demo's simulated lead answers questions about the board from the service's state ("what needs
// me?", "how is offline maps going?", "what is WT-002 doing?") instead of "Noted. In live mode…", in the words Home
// uses, so the two never disagree. Steering messages keep their simulated behaviour (focus, defer, notes).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as D from "../../src/domain/delivery";
import { buildDemo } from "../../src/domain/demo";
import * as M from "../../src/domain/model";
import type { State } from "../../src/domain/types";
import { needsYouItems } from "../../src/ui/progress";
import { parseLeadOutput } from "../envelope";
import { Scheduler } from "../scheduler";
import { Store } from "../store";
import { FakeAdapter, defaultFakeConfig, fakeLeadText } from "./fake";
import { statusAnswer, statusQuestion } from "./fakeStatus";

const T0 = Date.parse("2026-10-01T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const task = (s: State, id: string) => s.tasks.find((t) => t.id === id)!;

let dir: string;
const opened: { close(): void | Promise<void> }[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orch-fakestatus-"));
});
afterEach(async () => {
  for (const o of opened.splice(0).reverse()) {
    try {
      await o.close();
    } catch {
      /* already closed */
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

/** The demo in the fake service, as `npm start` runs it: the fake adapters read the board (and the test sees what they read). */
async function demoService() {
  const store = new Store(join(dir, "demo.db"), () => buildDemo(T0));
  opened.push(store);
  let seen: State | undefined;
  const board = () => (seen = store.read().state);
  const config = { ...defaultFakeConfig(), ackDelayMs: 2000 };
  const scheduler = new Scheduler(store, { claude: new FakeAdapter("claude", config, [], board), codex: new FakeAdapter("codex", config, [], board) }, { leaseMs: 5000, ackTimeoutMs: 6000 });
  opened.push({ close: () => scheduler.stop() });
  let now = T0 + 1000;
  let key = 0;
  const tick = async () => {
    now += 1000;
    scheduler.tick(now);
    await scheduler.prIdle();
    return store.read().state;
  };
  // The start of the demo: three agents working, and WT-005's pull request held for you on the simulated GitHub.
  let s = await tick();
  for (let i = 0; i < 12 && !D.prReady(s, task(s, "WT-005"), now); i++) s = await tick();
  const start = { state: s, nowMs: now };
  const leadReplies = () => store.read().state.conversation.filter((m) => m.author === "lead");
  /** Send a message and wait for the simulated lead's reply; `seen` is the board the lead read while writing it. */
  const ask = async (text: string) => {
    store.command("postMessage", { text }, `k-${++key}`, iso(now));
    const before = leadReplies().length;
    seen = undefined;
    for (let i = 0; i < 60 && leadReplies().length === before; i++) s = await tick();
    expect(leadReplies().length, `a reply to "${text}"`).toBe(before + 1);
    return { reply: leadReplies().pop()!, state: s, seen, nowMs: now };
  };
  return { start, ask };
}

describe("the demo lead answers from the board (ORC-025 L3)", () => {
  it("at the start of the demo: what needs you, what is going on, how an area and a task are going, what landed", async () => {
    const { start } = await demoService();
    const { state: s, nowMs } = start;
    const answer = (text: string, from?: string) => statusAnswer(s, statusQuestion(s, text, from)!, nowMs);
    // The same three things Home's Needs-you card lists, in its order (by priority).
    expect(needsYouItems(s, nowMs).map((e) => `${e.kind} ${e.task?.id}`)).toEqual(["choose WT-004.3", "finding WT-007", "merge WT-005"]);
    expect(answer("what needs me?")).toBe(
      [
        "3 things need you:",
        "- Choose an option for “Join a trip without an account” (A, Guest link · B, One-time code) (WT-004.3)",
        "- Decide a finding on “Make the trail map readable with VoiceOver”: Read distances in miles or kilometres? (WT-007)",
        "- Merge the pull request for “Suggest a packing list from trail length and weather” (WT-005)",
        "Each is on Home under Needs you.",
      ].join("\n"),
    );
    expect(answer("What's going on?")).toMatch(
      new RegExp(
        "^3 agents are working: Codex is implementing “Show a clear offline state on the map”, Claude is reviewing “Make the trail map readable with VoiceOver” and Claude is implementing “See who is coming”\\. " +
          "3 things need you: choose an option for “Join a trip without an account” \\(A, Guest link · B, One-time code\\); decide a finding on “Make the trail map readable with VoiceOver”: Read distances in miles or kilometres\\?; merge the pull request for “Suggest a packing list from trail length and weather”\\. " +
          "Last landed: “Faster trail search”, \\d+[hd] ago\\.$",
      ),
    );
    expect(answer("how is offline maps going?")).toBe("Offline maps: 1 of 3 tasks done, 1 in progress, 1 not started. Codex is implementing “Show a clear offline state on the map”.");
    expect(answer("what is WT-002 doing?")).toBe("“Show a clear offline state on the map” (WT-002): Running. Codex is implementing it.");
    expect(answer("Thanks. Keep the VoiceOver work going, though.")).toBe("“Make the trail map readable with VoiceOver” (WT-007): In review. Claude is reviewing it. It needs you: decide a finding: Read distances in miles or kilometres?");
    expect(answer("How is this going?", "WT-004")).toBe("“Share a trip plan with friends” (WT-004): Waiting for 2 child tasks. Claude is implementing “See who is coming”. 1 of 3 parts done. It needs you: choose an option for “Join a trip without an account” (A, Guest link · B, One-time code).");
    expect(answer("What landed recently?")).toMatch(/^Landed most recently: “Faster trail search” \(\d+[hd] ago\), “Invite friends with a link” \(\d+[hd] ago\) and “Larger tap targets on the trip page” \(\d+[hd] ago\)\. 2 results are new for you in Results\. “Suggest a packing list from trail length and weather” waits for you to merge its pull request\.$/);
  }, 20_000); // many scheduler cycles: more than vitest's default under a full-suite load

  it("in the running service, 'what needs me?' is answered from the board the lead read, labelled simulated, with nothing changed", async () => {
    const demo = await demoService();
    const { reply, state, seen, nowMs } = await demo.ask("what needs me?");
    expect(seen).toBeDefined();
    expect(reply.text).toBe(statusAnswer(seen!, { kind: "needs-you" }, nowMs));
    expect(reply.text).toMatch(/^3 things need you:\n- /);
    for (const e of needsYouItems(seen!, nowMs)) expect(reply.text).toContain(`(${e.task!.id})`);
    expect(reply.text).not.toMatch(/live mode/i);
    expect(reply.changeSetId).toBeUndefined();
    // The reply came from the fake runtime: its run is simulated, and nothing was steered.
    expect(state.leadRuns.find((r) => r.id === reply.leadRunId)).toMatchObject({ outcome: "completed" });
    expect(state.steering).toHaveLength(1);
  }, 20_000);

  it("keeps the simulated steering: a note to a coder is passed on, named in the user's words, and listed under the reply", async () => {
    const demo = await demoService();
    const { reply, state } = await demo.ask("tell the coder on WT-002 to keep the banner short");
    expect(reply.text).toBe("I asked to pass your note on to the coder on “Show a clear offline state on the map”. The line under this reply shows whether it was sent and has reached them.");
    const set = state.steering.find((cs) => cs.id === reply.changeSetId)!;
    expect(set.simulated).toBe(true);
    expect(set.changes).toEqual([expect.objectContaining({ kind: "note", taskId: "WT-002", stepId: "S1", status: "applied", after: "Keep the banner short" })]);
    // A direction change still sets the focus; the reply claims nothing the service did not apply.
    const focus = await demo.ask("Focus on offline maps instead");
    expect(focus.reply.text).toMatch(/^Noted the new direction\. I asked to make your words the focus/);
    expect(M.currentVision(focus.state).focus).toBe("Focus on offline maps instead");
  }, 20_000);

  it("says plainly what it can do when a message asks nothing it can answer, with or without the board", () => {
    const prompt = ["# Lead run lead-1 (reply to the user)", "## Open work", "- No open work.", "", "## Messages to answer now", "- Rename the app to Trailhead", "", "## Rules for proposals", ""].join("\n");
    for (const board of [buildDemo(T0), undefined]) {
      const text = parseLeadOutput(fakeLeadText("lead-1", "message", prompt, board, T0)).reply;
      expect(text).toMatch(/^Noted; I changed nothing\. Ask me what is running, what needs you/);
      expect(text).not.toMatch(/live mode/i);
    }
  });
});

describe("which messages are status questions", () => {
  const s = buildDemo(T0);
  const kind = (text: string, from?: string) => {
    const q = statusQuestion(s, text, from);
    return q && (q.kind === "task" ? `task ${q.taskId}${q.asked ? "" : " (statement)"}` : q.kind === "area" ? `area ${q.area}${q.asked ? "" : " (statement)"}` : q.kind);
  };

  it("tells needs-you, overview, landed, a task and an area apart", () => {
    expect(kind("what needs me?")).toBe("needs-you");
    expect(kind("Anything waiting on me")).toBe("needs-you");
    expect(kind("what do you need from me?")).toBe("needs-you");
    expect(kind("what's going on")).toBe("overview");
    expect(kind("Give me a status update")).toBe("overview");
    expect(kind("Is anything blocked?")).toBe("overview");
    expect(kind("What landed this week?")).toBe("landed");
    expect(kind("what is wt-002 doing?")).toBe("task WT-002");
    expect(kind("How's the VoiceOver work going?")).toBe("task WT-007");
    expect(kind("what does WT-007 need from me?")).toBe("task WT-007");
    expect(kind("how is offline maps going?")).toBe("area Offline maps");
    expect(kind("How is this going?", "WT-003")).toBe("task WT-003");
    // Naming one without asking: its state, and the reply says nothing changed.
    expect(kind("Put offline maps first")).toBe("area Offline maps (statement)");
    // Nothing to answer: the caller keeps its other behaviour.
    expect(kind("Rename the app to Trailhead")).toBeUndefined();
    expect(kind("Thanks")).toBeUndefined();
  });

  it("names no task it cannot tell apart from another, and says nothing changed for a statement", () => {
    // "trip" is in several titles: not a reference to any one task, so the question gets the overview.
    expect(kind("how is the trip going?")).toBe("overview");
    const statement = statusAnswer(s, { kind: "area", area: "Offline maps", asked: false }, T0);
    expect(statement).toMatch(/^I changed nothing\. Offline maps: .* To change direction, tell me what to focus on\.$/);
    expect(statusAnswer(s, { kind: "task", taskId: "WT-404", asked: true }, T0)).toBe("WT-404 is not on the board.");
  });
});
