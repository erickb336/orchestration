// ORC-025 pass 3 (R2): the one verdict line of a pull request, the landed line, and the delivery confirmations.

import { describe, expect, it } from "vitest";
import { buildDemo } from "../domain/demo";
import type { State } from "../domain/types";
import { DELIVERY_CONFIRM, changesText, gateLabel, landedVerdict, landedWhere, landedWho, prName, prVerdict, reviewParts, verdictText } from "./deliveryView";
import { openCleanPr } from "./task/needsYouItems.test";

const T0 = Date.parse("2026-10-01T12:00:00Z");
const task = (s: State, id: string) => s.tasks.find((t) => t.id === id)!;

describe("prVerdict", () => {
  it("reads 'Pull request #1000 · Code ✓ Security ✓ Checks ✓ · 6 files, +167 −12' for a ready pull request", () => {
    const s = openCleanPr(buildDemo(T0));
    const v = prVerdict(s, task(s, "WT-005"), T0 + 1000)!;
    expect(v.name).toBe("Pull request #1000");
    expect(verdictText(v.parts)).toBe("Code ✓ Security ✓ Checks ✓");
    expect(v.changes).toBe("6 files, +167 −12");
    // Hold mode: only your Merge is missing, so it is ready for you.
    expect(v.status).toBe("ready");
    expect(gateLabel(v.status)).toBe("Why it's ready");
    expect(v.gate.map((g) => g.id)).toContain("review");
    expect(v.parts.find((p) => p.label === "Code")!.detail).toMatch(/Clean review/);
  });

  it("before GitHub reports the checks, the checks part is pending and the pull request has no number yet", () => {
    const s = buildDemo(T0);
    const v = prVerdict(s, task(s, "WT-005"), T0)!;
    expect(v.name).toBe("Pull request");
    expect(verdictText(v.parts)).toBe("Code ✓ Security ✓ Checks …");
    expect(v.status).toBe("waiting");
  });

  it("a merged pull request keeps its verdict from the checks at merge and has no checklist", () => {
    const s = buildDemo(T0);
    const v = prVerdict(s, task(s, "WT-001"), T0)!;
    expect(v).toMatchObject({ name: "Pull request #991", status: "merged", changes: "2 files, +31 −9", gate: [] });
    expect(verdictText(v.parts)).toBe("Code ✓ Security ✓ Checks ✓");
  });

  it("open findings or a failed check turn a part to ✗", () => {
    const s = openCleanPr(buildDemo(T0));
    const pr = task(s, "WT-005").integration!.pr!;
    pr.observed!.checks[0].conclusion = "FAILURE";
    const v = prVerdict(s, task(s, "WT-005"), T0 + 1000)!;
    expect(v.parts.find((p) => p.label === "Checks")).toMatchObject({ state: "fail" });
    expect(v.status).toBe("blocked");
    expect(gateLabel(v.status)).toBe("What stops it");
    const parts = reviewParts(s, task(s, "WT-001"));
    expect(parts.map((p) => `${p.label}:${p.state}`)).toEqual(["Code:ok", "Security:ok"]);
  });

  it("the words around it", () => {
    expect(prName({ number: 12 })).toBe("Pull request #12");
    expect(prName({ number: undefined })).toBe("Pull request");
    expect(changesText({ changed: { files: 1, additions: 3, deletions: 0, paths: [], protectedHits: [], workflowHits: [] } })).toBe("1 file, +3 −0");
    expect(changesText({ simulated: true, changed: { files: 0, additions: 0, deletions: 0, paths: [], protectedHits: [], workflowHits: [] } })).toBe("no files changed (simulated)");
    expect(gateLabel("ready")).toBe("Why it's ready");
    expect(gateLabel("waiting")).toBe("What it waits for");
    expect(gateLabel("merged")).toBe("How it merged");
  });
});

describe("the landed line", () => {
  it("says when, by whom and where it landed, and the agent reviews and checks as marks", () => {
    const s = buildDemo(T0);
    const t = task(s, "WT-001");
    const landed = t.integration!.landed!;
    expect(landedWho(landed)).toBe("Orchestrator");
    expect(landedWhere(landed)).toMatch(/^pull request #991 into /);
    expect(verdictText(landedVerdict(s, t))).toBe("Code ✓ Security ✓ Checks ✓");
  });
});

describe("the delivery confirmations", () => {
  it("name the pull request and the commit, and say what the app never does", () => {
    const merge = DELIVERY_CONFIRM.merge({ number: 1000, headSha: "0216fb9f4941abcdef", base: "main" });
    expect(merge.title).toBe("Merge pull request #1000 into main?");
    expect(merge.text).toMatch(/Exactly commit 0216fb9f4941 is merged/);
    expect(DELIVERY_CONFIRM.mergeAutomatically({ number: 1000 }).text).toMatch(/never bypasses branch rules/);
    expect(DELIVERY_CONFIRM.closePr({ number: 1000, phase: "open" })).toMatchObject({ title: "Close pull request #1000 without merging?", danger: true });
    expect(DELIVERY_CONFIRM.closePr({ number: undefined, phase: "built" }).title).toBe("Abandon this delivery?");
    expect(DELIVERY_CONFIRM.fixPr("the failed check test", "abc123def456789", 0, 2).text).toMatch(/0 of 2 fix tasks used/);
    expect(DELIVERY_CONFIRM.resumeAutoMerge("main failed").text).toMatch(/It was paused because main failed\./);
  });
});
