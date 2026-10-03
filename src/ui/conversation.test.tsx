// The lead conversation reads like a chat. One quiet line names the lead's model (and says
// "simulated" once, in the demo); what a reply changed folds into one line under it, with Undo all; no internal ids
// in the text; no scheduler buttons ("Answer together now", "Ask again"); a one-line composer hint. Rendered through
// react-dom/server over a fake store, as home.test.tsx does (there is no DOM test environment here).

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ServiceInfo } from "../api";
import { buildDemo } from "../domain/demo";
import { buildSeed } from "../domain/seed";
import { at as coAt, changeOrdered, fullAnswer } from "../domain/testing/changeOrders";
import * as M from "../domain/model";
import type { FindingDecision, State, SteeringChange } from "../domain/types";
import { Conversation } from "./Conversation";
import { ConfirmProvider } from "./kit";
import { foldActions, foldSummary, leadBlockedLink, leadDecisionText, messageStatusText } from "./notes";
import { StoreContext, type ServiceStore } from "./store";

const T0 = Date.parse("2026-10-01T12:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

const service = (runtime: ServiceInfo["runtime"] = "fake"): ServiceInfo => ({
  startedAt: at(0),
  scheduler: "active",
  runtime,
  sim: { auto: false, ackMode: "normal" },
  dbPath: "/tmp/orchestration-test.db",
  providers: { claude: { label: "Claude", capabilities: {} as never }, codex: { label: "Codex", capabilities: {} as never } },
});

function store(state: State, svc: ServiceInfo = service()): ServiceStore {
  const noop = async () => ({ ok: true as const });
  return { state, version: 1, service: svc, status: "online", disabled: false, send: noop, notice: null, setNotice: () => {} } as unknown as ServiceStore;
}

const render = (state: State, svc?: ServiceInfo) =>
  renderToStaticMarkup(
    <ConfirmProvider>
      <StoreContext.Provider value={store(state, svc)}>
        <Conversation onClose={() => {}} />
      </StoreContext.Provider>
    </ConfirmProvider>,
  );
/** What a person reads: the markup without tags and attributes. */
const text = (markup: string) => markup.replace(/<[^>]*>/g, " ").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ");
const count = (s: string, needle: string) => s.split(needle).length - 1;

describe("the lead conversation", () => {
  it("in the demo: one quiet line with the lead's model and one simulated chip, then the messages, then the composer", () => {
    const s = buildDemo(T0);
    const markup = render(s);
    const words = text(markup);
    expect(count(words, M.providerLabel(s.project.leadSelection.provider) + " · " + s.project.leadSelection.model)).toBe(1);
    expect(count(markup, "k-chip--sim")).toBe(1);
    // No explainer at the top and no repeated chips.
    expect(words).not.toMatch(/simulated, not written by a model|When you message the lead, it can change/);
    // The conversation first: the demo's messages read as You / Lead and the text.
    for (const m of s.conversation) expect(words).toContain(m.text.replace(/\s+/g, " ").slice(0, 40));
    expect(markup.indexOf("Most of our hikes")).toBeLessThan(markup.indexOf("Done. Offline maps is now the focus"));
    // The one-line composer hint.
    expect(words).toContain("⌘/Ctrl + Enter to send");
    expect(words).not.toMatch(/undo any of them|\(Settings\)/);
  });

  it("folds a reply's changes into one line with Undo all; the list opens from it and keeps the note's status and no Undo", () => {
    const s = buildDemo(T0);
    const markup = render(s);
    const words = text(markup);
    expect(words).toContain("2 changes, 1 note");
    expect(words).toContain("Undo all");
    expect(markup).toMatch(/<button[^>]*aria-expanded="false"[^>]*>2 changes, 1 note<\/button>/);
    expect(markup).toMatch(/class="fold-body" hidden=""/);
    // Inside: the focus diff, the deferral with Undo, and the note with its status chip and no Undo.
    expect(markup).toContain('aria-label="Focus change"');
    expect(words).toContain("Weather alerts for the trip day : Deferred (after its current step)");
    // The note reached the packing list's coder while it ran, so it reads Delivered.
    expect(words).toMatch(/Note to WT-005 S1 \(Coder · Codex\) : “Put a first-aid kit on every packing list/);
    expect(words).toMatch(/\bDelivered\b/);
    expect(words).not.toContain("Delivered when the run started");
    expect(words).toContain("sent; no Undo: a sent note cannot be unsent");
    expect(count(markup, ">Undo</button>")).toBe(2); // the deferral's and the focus's rows; never the note's
  });

  it("a change order's rows under a reply whose steering was refused read as applied, never as 'none were applied' (review finding 10)", () => {
    const f = changeOrdered();
    const r = M.startLeadRun(f.s, { provider: "claude", model: "m", trigger: "change-order" }, coAt(20));
    const s = M.completeLeadRun(r.state, r.runId, { reply: "Done.", proposals: [], steer: { focus: "Trips first" }, changeOrder: fullAnswer(f) } as never, coAt(21));
    const words = text(render(s));
    expect(words).toContain("steering block was refused: planning runs cannot steer.");
    expect(words).not.toContain("none were applied");
    // A set an earlier build stored refused, with the rows in it, reads the same way.
    const stored = structuredClone(s);
    const set = stored.steering.find((x) => x.id === `cs-${r.runId}`)!;
    Object.assign(set, { refused: "planning runs cannot steer", notes: [] });
    const old = text(render(stored));
    expect(old).toContain("steering block was refused: planning runs cannot steer.");
    expect(old).not.toContain("none were applied");
    // A refused set with no rows still says that nothing was applied, which is true.
    Object.assign(set, { changes: [] });
    expect(text(render(stored))).toContain("The lead asked for changes, but none were applied: planning runs cannot steer.");
  });

  it("shows no internal ids and no scheduler buttons", () => {
    // A second message while the lead writes its reply: it waits, and says so; nothing to press.
    let s = M.postMessage(buildDemo(T0), "What is running?", at(1));
    s = M.startLeadRun(s, { provider: "claude", model: "claude-sample-large", trigger: "message" }, at(2)).state;
    s = M.postMessage(s, "And what needs me?", at(3));
    const words = text(render(s));
    expect(words).toContain("The lead is working on this…");
    expect(words).toContain("The lead answers this right after its reply to your earlier message.");
    expect(words).not.toMatch(/Answer together now|Ask again|Queued behind/);
    expect(words).not.toMatch(/\b(?:msg|vd|fd|cs|lead|note)-[\w-]*\d/);
  });

  it("a reply held because you wrote again keeps its rows as suggestions, with Apply all and no Ask again", () => {
    let s = M.postMessage(buildSeed(T0, { inFlightRuns: false }), "Focus on reliability", at(1));
    const { state, runId } = M.startLeadRun(s, { provider: "claude", model: "claude-sample-large", trigger: "message" }, at(2));
    s = M.postMessage(state, "Actually, keep everything as it is", at(3));
    const ids = s.tasks.filter((t) => !t.parentTaskId && t.lifecycle !== "done" && t.lifecycle !== "cancelled").map((t) => t.id);
    s = M.completeLeadRun(s, runId, { reply: "Refocusing on reliability.", proposals: [], steer: { focus: "Reliability first.", reason: "You asked.", tasks: [{ id: ids[ids.length - 1], defer: true, why: "Not reliability." }] } }, at(4));
    const set = s.steering[s.steering.length - 1];
    expect(set.heldBecause).toBeTruthy();
    const words = text(render(s, service("real")));
    expect(words).toContain("2 suggestions");
    expect(words).toContain("Apply all");
    expect(words).toContain("Held as suggestions: you sent another message while the lead was working; its next reply decides.");
    expect(words).not.toMatch(/Ask again|re-apply/);
    // Outside the demo there is no simulated chip.
    expect(render(s, service("real"))).not.toContain("k-chip--sim");
  });
});

describe("the conversation's words", () => {
  const row = (over: Partial<SteeringChange>): SteeringChange => ({ id: `c${Math.random()}`, kind: "defer", taskId: "T-1", status: "applied", ...over }) as SteeringChange;

  it("the fold line counts changes, notes, suggestions, what was not applied and what was undone; it offers Undo and Apply", () => {
    expect(foldSummary({ changes: [row({ kind: "focus" }), row({}), row({ kind: "note" })] })).toBe("2 changes, 1 note");
    expect(foldSummary({ changes: [row({ status: "suggested" }), row({ status: "suggested", kind: "priority" })] })).toBe("2 suggestions");
    expect(foldSummary({ changes: [row({}), row({ status: "skipped" })] })).toBe("1 change, 1 not applied");
    expect(foldSummary({ changes: [row({ status: "undone" }), row({ status: "dismissed" })] })).toBe("2 undone or dismissed");
    expect(foldSummary({ changes: [] })).toBe("No changes");
    expect(foldActions({ changes: [row({ kind: "focus" }), row({}), row({ kind: "note" })] })).toEqual({ undo: "Undo all" });
    expect(foldActions({ changes: [row({}), row({ kind: "note" })] })).toEqual({ undo: "Undo" });
    // A note cannot be unsent and a drop you applied is a cancel: neither is undone.
    expect(foldActions({ changes: [row({ kind: "note" }), row({ kind: "drop", appliedBy: "user" })] })).toEqual({});
    // One suggestion is applied from the line too (a note is sent); a rerun with a note asks first, on its own row only.
    expect(foldActions({ changes: [row({ status: "suggested", kind: "focus" })] })).toEqual({ apply: "Apply" });
    expect(foldActions({ changes: [row({ status: "suggested", kind: "note" })] })).toEqual({ apply: "Send" });
    expect(foldActions({ changes: [row({ status: "suggested" }), row({ status: "suggested", kind: "note", rerun: true })] })).toEqual({ apply: "Apply" });
    expect(foldActions({ changes: [row({ status: "suggested", kind: "note", rerun: true })] })).toEqual({});
    expect(foldActions({ changes: [row({ status: "suggested" }), row({ status: "suggested", kind: "note" }), row({})] })).toEqual({ undo: "Undo", apply: "Apply all" });
  });

  it("a decision on a finding reads by the task and the finding's title, never its id", () => {
    const d = { id: "fd-12", taskId: "WT-007", status: "accept", finding: { title: "Distances are read in miles only" } } as FindingDecision;
    expect(leadDecisionText({ id: "fd-12", taskId: "WT-007", what: "decided", status: "accept", why: "Miles are what the users use." }, d)).toBe("WT-007 “Distances are read in miles only”: accepted as it is — Miles are what the users use.");
    expect(leadDecisionText({ id: "fd-12", taskId: "WT-007", what: "decided", status: "accept" }, { ...d, status: "fix" })).toBe("WT-007 “Distances are read in miles only”: accepted as it is (since then: to be fixed)");
    expect(leadDecisionText({ id: "fd-12", taskId: "WT-007", what: "suggested", status: "open" }, undefined)).toBe("A finding on WT-007: the lead suggests a fix; yours to decide");
    expect(leadDecisionText({ id: "fd-12", taskId: "WT-007", what: "handed-over", status: "open" }, d)).not.toContain("fd-12");
  });

  it("a message queued behind a reply says the lead answers it next; other statuses keep the domain's words", () => {
    let s = M.postMessage(buildSeed(T0, { inFlightRuns: false }), "First", at(1));
    s = M.startLeadRun(s, { provider: "claude", model: "m", trigger: "message" }, at(2)).state;
    expect(messageStatusText(s, { kind: "queued-behind-reply", text: "Queued behind the current reply." })).toBe("The lead answers this right after its reply to your earlier message.");
    expect(messageStatusText(s, { kind: "working", text: "The lead is working on this…" })).toBe("The lead is working on this…");
  });

  it("a message the lead cannot answer links to the Settings card that unblocks it, not to Settings in general", () => {
    const own = structuredClone(buildSeed(T0, { inFlightRuns: false }));
    own.project.sample = false;
    const sample = structuredClone(own);
    sample.project.sample = true;
    // The service's reasons (server/scheduler.ts), each to its card.
    expect(leadBlockedLink(sample, "This is the sample project; start a new project in Settings for a live lead.").href).toBe("#/settings/project/new-project");
    expect(leadBlockedLink(own, "No usable repository is configured (Settings → Project).").href).toBe("#/settings/project/repository");
    expect(leadBlockedLink(own, "Claude is not available: not signed in").href).toBe("#/settings/agents/providers");
    expect(leadBlockedLink(own, "Checking the lead's provider…").href).toBe("#/settings/agents/providers");
    expect(leadBlockedLink(own, "The lead (Claude · m) is not enabled or not in the model catalog. Choose another lead in Settings.").href).toBe("#/settings/agents/models");
    // In the conversation, under the waiting message.
    const waiting = M.postMessage(own, "Plan the next step.", at(1));
    const markup = render(waiting, { ...service("real"), leadBlocked: "No usable repository is configured (Settings → Project)." });
    expect(markup).toContain('href="#/settings/project/repository"');
    expect(markup).not.toContain('href="#/settings"');
  });
});
