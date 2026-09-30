// Notification events are keyed on what changed, never on when something was retried (ORC-008 §14).

import { describe, expect, it } from "vitest";
import * as M from "../domain/model";
import { buildSeed } from "../domain/seed";
import type { State } from "../domain/types";
import { detectEvents } from "./notifications";

const T0 = Date.parse("2026-09-30T12:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const task = (s: State, id: string) => s.tasks.find((t) => t.id === id)!;
const SHA_A = "a".repeat(40);

/** The sample project with EX-006 integrated and local delivery on. */
function deliverOn(): State {
  const s = buildSeed(T0, { inFlightRuns: false });
  task(s, "EX-006").integration = { status: "integrated", at: at(0), ref: "aaaaaaaaaaaa on orchestration/sample/integration", sha: SHA_A };
  return M.setAutonomy(s, { ...s.project.autonomy, autoDeliver: { enabled: true, branch: "main" } }, at(1));
}

describe("notifications: local delivery", () => {
  const deliveryEvents = (a: State, b: State) => detectEvents(a, b).filter((e) => e.key.startsWith("deliver:"));

  it("an identical retry produces no event; each change of outcome produces exactly one", () => {
    const s0 = deliverOn();
    const waiting = { status: "skipped" as const, message: "main is checked out with uncommitted changes; delivery waits until it is clean." };
    const s1 = M.reportDeliveryResult(s0, waiting, at(2));
    expect(deliveryEvents(s0, s1).map((e) => e.key)).toEqual([`deliver:EX-006:skipped:${waiting.message}`]);

    // The same result a minute later, and again: the task's record is untouched, so nothing fires.
    const s2 = M.reportDeliveryResult(s1, waiting, at(62));
    const s3 = M.reportDeliveryResult(s2, waiting, at(122));
    expect(task(s2, "EX-006").integration?.delivered).toEqual(task(s1, "EX-006").integration?.delivered);
    expect(deliveryEvents(s1, s2)).toEqual([]);
    expect(deliveryEvents(s2, s3)).toEqual([]);
    expect(s3.events.filter((e) => e.message.startsWith("Delivery to main")).length).toBe(1);

    const s4 = M.reportDeliveryResult(s3, { status: "delivered", message: "main fast-forwarded to aaaaaaaaaaaa.", sha: SHA_A }, at(182));
    const fired = deliveryEvents(s3, s4);
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ title: "Work delivered", taskId: "EX-006" });
    expect(deliveryEvents(s4, M.markVisited(s4, at(200)))).toEqual([]);
  });
});
