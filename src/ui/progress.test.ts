// Progress by area is derived from state only. Counts, ordering, the "Other" group, the
// live line, and what a task waits on the user for.

import { describe, expect, it } from "vitest";
import * as M from "../domain/model";
import { buildDemo } from "../domain/demo";
import { buildSeed } from "../domain/seed";
import { OTHER_AREA, agentsStopping, agentsWorking, areaOf, changeSummary, latestLeadReply, liveAgents, liveIndicatorText, liveText, needsYouOf, progressByArea, replyExcerpt, unreadLeadReplies } from "./progress";

const T0 = Date.parse("2026-09-30T12:00:00Z");
const by = (rows: ReturnType<typeof progressByArea>, area: string) => rows.find((r) => r.area === area)!;

describe("progressByArea", () => {
  it("counts done, working and needs-you per area, and orders areas with activity first, then by recency", () => {
    const s = buildSeed(T0);
    const rows = progressByArea(s, T0);
    expect(rows.map((r) => r.area)).toEqual(["Storage", "Library", "Capture", "Search", "Onboarding", "Settings", "Export"]);
    // Storage: EX-002 is under review by Claude.
    expect(by(rows, "Storage")).toMatchObject({ total: 1, done: 0, working: 1, needsYou: 0, buckets: { done: 0, work: 1, you: 0, rest: 0 }, segments: ["work"] });
    // Library: EX-001 is being implemented by Codex.
    expect(by(rows, "Library")).toMatchObject({ total: 1, working: 1, segments: ["work"] });
    // Capture: EX-004 is held before start with two options; that waits for you.
    expect(by(rows, "Capture")).toMatchObject({ total: 1, done: 0, working: 0, needsYou: 1, segments: ["you"] });
    // Export: EX-006 finished.
    expect(by(rows, "Export")).toMatchObject({ total: 1, done: 1, working: 0, needsYou: 0, segments: ["done"] });
    // Onboarding: EX-005 is paused by the user: neutral, nothing needs you.
    expect(by(rows, "Onboarding")).toMatchObject({ total: 1, done: 0, needsYou: 0, segments: ["rest"] });
    expect(by(rows, "Export").label).toBe("Export: 1 of 1 task done");
    expect(by(rows, "Capture").label).toBe("Capture: 0 of 1 task done, 1 needs you");
    expect(by(rows, "Storage").label).toBe("Storage: 0 of 1 task done, 1 in progress");
    // A task the user paused is called paused, not "not started".
    expect(by(rows, "Onboarding").label).toBe("Onboarding: 0 of 1 task done, 1 paused");
  });

  it("the live line names the provider and what it is doing on which task", () => {
    const s = buildSeed(T0);
    const rows = progressByArea(s, T0);
    const storage = by(rows, "Storage").live;
    expect(storage).toHaveLength(1);
    expect(liveText(storage[0])).toBe("Claude · reviewing");
    expect(storage[0]).toMatchObject({ taskId: "EX-002", title: "Report backup failures instead of failing silently", stepId: "S2" });
    const library = by(rows, "Library").live;
    expect(liveText(library[0])).toBe("Codex · implementing");
    expect(by(rows, "Export").live).toEqual([]);
    // Idle seed: nothing is live anywhere, and the order falls back to recency alone.
    const idle = progressByArea(buildSeed(T0, { inFlightRuns: false }), T0);
    expect(idle.every((r) => r.live.length === 0)).toBe(true);
    expect(idle.map((r) => r.area)).toEqual(["Capture", "Storage", "Library", "Search", "Onboarding", "Settings", "Export"]);
    expect(agentsWorking(buildSeed(T0))).toBe(2);
    expect(agentsWorking(buildSeed(T0, { inFlightRuns: false }))).toBe(0);
    // A check run by the service is not an agent.
    const withCheck = buildSeed(T0);
    const a = withCheck.attempts.find((x) => x.outcome === "running")!;
    a.snapshot = { ...a.snapshot, provider: "service" };
    expect(agentsWorking(withCheck)).toBe(1);
  });

  it("tasks with no area are grouped as Other; cancelled tasks and the service's own delivery tasks are left out", () => {
    const s = buildSeed(T0, { inFlightRuns: false });
    const search = s.tasks.find((t) => t.id === "EX-003")!;
    M.currentSpec(search).content.area = "  ";
    expect(areaOf(search)).toBe(OTHER_AREA);
    const settings = s.tasks.find((t) => t.id === "EX-007")!;
    settings.lifecycle = "cancelled";
    const capture = s.tasks.find((t) => t.id === "EX-004")!;
    capture.reviewTarget = { taskId: "EX-006", n: 1, headSha: "a".repeat(40), baseSha: "b".repeat(40) };
    const rows = progressByArea(s, T0);
    expect(rows.map((r) => r.area)).not.toContain("Search");
    expect(rows.map((r) => r.area)).not.toContain("Settings");
    expect(rows.map((r) => r.area)).not.toContain("Capture");
    expect(by(rows, OTHER_AREA)).toMatchObject({ total: 1, done: 0 });
    // Several tasks in one area: one segment each, in priority order, and the done count is the lifecycle.
    const library = s.tasks.find((t) => t.id === "EX-001")!;
    M.currentSpec(library).content.area = "Export";
    const again = by(progressByArea(s, T0), "Export");
    expect(again.total).toBe(2);
    expect(again.done).toBe(1);
    expect(again.segments).toEqual(["rest", "done"]);
    // EX-001 has started and nothing runs on it now: waiting, not "not started".
    expect(again.label).toBe("Export: 1 of 2 tasks done, 1 waiting");
  });

  it("the demo's labels name paused and deferred work, and one task's two same-provider reviews are listed once", () => {
    const s = buildDemo(T0);
    const reliability = by(progressByArea(s, T0), "Reliability");
    expect(reliability.label).toBe("Reliability: 2 of 4 tasks done, 1 paused, 1 deferred");
    // Two active runs of one provider doing the same thing on one task: one live line.
    // The demo starts with no runs (the scheduler dispatches them), so the sample fixture with runs in flight is used here.
    const seed = buildSeed(T0);
    const t = seed.tasks.find((x) => M.activeAttempts(seed, x.id).length)!;
    const a = M.activeAttempts(seed, t.id)[0];
    seed.attempts.push({ ...structuredClone(a), id: `${a.id}-twin` });
    expect(liveAgents(seed, t)).toHaveLength(1);
  });

  it("the header counts stopping runs as busy and never says Idle over them", () => {
    const s = buildSeed(T0);
    expect(agentsWorking(s)).toBe(2);
    expect(agentsStopping(s)).toBe(0);
    // A project pause asks every run to stop; until the agents acknowledge, they are still working.
    const pausing = M.pauseProject(s, new Date(T0 + 1000).toISOString());
    expect(agentsWorking(pausing)).toBe(0);
    expect(agentsStopping(pausing)).toBe(2);
    expect(liveIndicatorText(agentsWorking(pausing), agentsStopping(pausing))).toBe("2 agents stopping");
    // A stopping check run is the service's, not an agent's.
    const service = structuredClone(pausing);
    service.attempts.find((a) => a.outcome === "stopping")!.snapshot.provider = "service";
    expect(agentsStopping(service)).toBe(1);
    expect(liveIndicatorText(0, 1)).toBe("1 agent stopping");
    expect(liveIndicatorText(3, 1)).toBe("3 agents working, 1 stopping");
    expect(liveIndicatorText(1, 0)).toBe("1 agent working");
    expect(liveIndicatorText(0, 0)).toBe("Idle");
    expect(liveIndicatorText(2, 0, true)).toBe("2 agents working (finishing; in Vision)");
    expect(liveIndicatorText(0, 2, true)).toBe("2 agents stopping");
    // The text says nothing about the simulation: the demo bar says it once.
    expect(liveIndicatorText(3, 0)).not.toMatch(/simulated/);
  });

  it("needsYouOf names what waits: a held task with options, a review gate, failing final checks, a user decision", () => {
    const s = buildSeed(T0, { inFlightRuns: false });
    const held = s.tasks.find((t) => t.id === "EX-004")!;
    expect(needsYouOf(s, held, T0)).toMatchObject({ what: "choose an option", href: "#/task/EX-004" });
    M.currentSpec(held).content.options = M.currentSpec(held).content.options.slice(0, 1);
    expect(needsYouOf(s, held, T0)?.what).toBe("give the go-ahead");
    // A paused task is the user's own choice, not a request for attention.
    expect(needsYouOf(s, s.tasks.find((t) => t.id === "EX-005")!, T0)).toBeUndefined();
    // A review gate waits for you.
    const gated = s.tasks.find((t) => t.id === "EX-002")!;
    gated.hold = true;
    gated.holdReason = "Review every step";
    expect(needsYouOf(s, gated, T0)?.what).toBe("review the step");
    // Failing final checks wait for a decision.
    const failing = s.tasks.find((t) => t.id === "EX-001")!;
    const c = failing.steps.find((st) => st.role === "checks")!;
    c.state = "blocked";
    c.blockedReason = "Checks failed on the final change: test";
    expect(needsYouOf(s, failing, T0)?.what).toBe("decide on failing checks");
    // A finished task with nothing open needs nothing; the proposed one with a dependency needs nothing either.
    expect(needsYouOf(s, s.tasks.find((t) => t.id === "EX-006")!, T0)).toBeUndefined();
    expect(needsYouOf(s, s.tasks.find((t) => t.id === "EX-007")!, T0)).toBeUndefined();
    expect(liveAgents(s, failing)).toEqual([]);
  });
});

describe("the badges and the lead's latest reply", () => {
  it("the Lead badge counts replies newer than the last one shown, and nothing else", () => {
    const s = buildDemo(T0);
    const replies = s.conversation.filter((m) => m.author === "lead");
    expect(replies.length).toBeGreaterThan(1);
    expect(unreadLeadReplies(s, null)).toBe(replies.length);
    expect(unreadLeadReplies(s, replies[replies.length - 1].at)).toBe(0);
    expect(unreadLeadReplies(s, replies[0].at)).toBe(replies.length - 1);
  });

  it("the latest reply is the newest lead message, with what its change set did", () => {
    const s = buildDemo(T0);
    const latest = latestLeadReply(s)!;
    expect(latest.message.author).toBe("lead");
    expect(latest.message.id).toBe([...s.conversation].reverse().find((m) => m.author === "lead")!.id);
    expect(latest.summary).toBe("No changes");
    // The steering reply: a focus change, a deferral and a note were applied.
    const steeringAt = s.conversation.findIndex((m) => m.author === "lead" && m.changeSetId && s.steering.find((x) => x.id === m.changeSetId)?.changes.some((c) => c.kind === "focus"));
    expect(steeringAt).toBeGreaterThanOrEqual(0);
    const earlier = structuredClone(s);
    earlier.conversation = earlier.conversation.slice(0, steeringAt + 1);
    expect(latestLeadReply(earlier)).toMatchObject({ applied: 3, suggested: 0, summary: "3 changes" });
    expect(changeSummary(1, 1)).toBe("1 change, 1 suggestion");
    expect(changeSummary(0, 2)).toBe("2 suggestions");
    expect(latestLeadReply(buildSeed(T0, { inFlightRuns: false }))).toBeUndefined();
  });

  it("the excerpt is the first paragraph, cut at a word with an ellipsis", () => {
    expect(replyExcerpt("Done.\n\nMore detail follows.")).toBe("Done.");
    expect(replyExcerpt("  one  line\nwith a break  ")).toBe("one line with a break");
    const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
    const cut = replyExcerpt(long, 50);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(51);
    // Cut between words, never inside one.
    expect(long.startsWith(cut.slice(0, -1) + " ")).toBe(true);
  });
});
