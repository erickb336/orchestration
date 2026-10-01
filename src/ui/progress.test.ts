// ORC-017 §3.3: progress by area is derived from state only. Counts, ordering, the "Other" group, the
// live line, and what a task waits on the user for.

import { describe, expect, it } from "vitest";
import * as M from "../domain/model";
import { buildSeed } from "../domain/seed";
import { OTHER_AREA, agentsWorking, areaOf, liveAgents, liveText, needsYouOf, progressByArea } from "./progress";

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
    expect(by(rows, "Storage").label).toBe("Storage: 0 of 1 task done, 1 with agents working");
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
    expect(again.label).toBe("Export: 1 of 2 tasks done, 1 not started");
  });

  it("needsYouOf names what waits: a held task with options, a review gate, failing final checks, a user decision", () => {
    const s = buildSeed(T0, { inFlightRuns: false });
    const held = s.tasks.find((t) => t.id === "EX-004")!;
    expect(needsYouOf(s, held, T0)).toMatchObject({ what: "choose an option", href: "#/task/EX-004" });
    M.currentSpec(held).content.options = M.currentSpec(held).content.options.slice(0, 1);
    expect(needsYouOf(s, held, T0)?.what).toBe("release it");
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
