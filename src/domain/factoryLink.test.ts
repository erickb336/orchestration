// ORC-029 pass 5, the factory link (domain side): the lead's task specs cite the approved blueprint items they build,
// the domain refuses an id that is not an approved item, and a spec that cites a flow takes that flow's rules and
// examples as acceptance, each tagged with its id; a cited contract adds a line that names it.

import { describe, expect, it } from "vitest";
import { runCommand } from "./commands";
import * as M from "./model";
import { buildSeed } from "./seed";
import * as B from "./studio/blueprint";
import { tagsIn } from "./studio/ruleResults";
import { startFactoryAsOwner } from "./testing/factory";
import { addScreen, openRound, peAgrees, run, sha } from "./testing/studio";
import type { FactorySettings, State } from "./types";

const T0 = Date.parse("2026-10-02T12:00:00Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const MANUAL: FactorySettings = { autonomy: "manual", delivery: { mode: "off", merge: "user" }, pausePoints: { tradeoffs: "user", changeOrders: "lead", startEachTask: false } };
const DESIGNER = { role: "designer", provider: "claude", model: "m", attemptId: "run-d" };
const RULES = {
  variant: "one",
  path: "join/rules.json",
  rules: [
    { id: "R1", text: "When a friend opens the invite, the app shall show the trip's dates." },
    { id: "R2", text: "If the invite has expired, then the app shall offer to ask for a new one." },
  ],
  examples: [{ id: "E1", text: "Given an expired invite, when Ana opens it, then she sees Ask for a new invite." }],
};

/** A new project with an approved screen, an approved flow with rules, an approved contract, and one open screen; then the factory started. */
function building(): { s: State; screen: string; flow: string; contract: string; open: string } {
  let s = M.initProject(buildSeed(T0, { inFlightRuns: false }), { name: "Trips", repoPath: "/tmp/trips", vision: "Weekend trips for a small group of friends.", focus: "" }, at(0));
  const r = openRound(s, "flows", at(1));
  s = r.state;
  const screen = addScreen(s, r.n, at(2), { title: "Trip home", variants: [] });
  s = peAgrees(screen.state, screen.id, 1, [], at(2));
  const flow = run<{ artifactId: string }>(s, "addStudioArtifact", { round: r.n, kind: "flow", title: "Joining a trip", variants: [{ id: "one", label: "One", entry: "join/flow.md" }], files: [{ path: "join/flow.md", sha256: sha("b") }, { path: "join/rules.json", sha256: sha("c") }], devices: [], madeBy: DESIGNER, rules: [RULES] }, at(3));
  s = peAgrees(flow.state, flow.result.artifactId, 1, ["one"], at(3));
  const contract = run<{ artifactId: string }>(s, "addStudioArtifact", { round: r.n, kind: "contract", title: "Invite API", variants: [], files: [{ path: "invite.md", sha256: sha("d") }], devices: [], madeBy: DESIGNER }, at(4));
  s = peAgrees(contract.state, contract.result.artifactId, 1, [], at(4));
  const open = addScreen(s, r.n, at(5), { title: "Settings", variants: [] });
  s = peAgrees(open.state, open.id, 1, [], at(5));
  s = runCommand(s, "sendFeedback", { entries: [{ artifactId: open.id, version: 1, mark: "change", pins: [], note: "later" }] }, at(6)).state;
  s = runCommand(s, "approveRound", { round: r.n }, at(7)).state;
  const item = (artifactId: string) => B.blueprintItems(s).find((i) => i.artifactId === artifactId)!.id;
  s = startFactoryAsOwner(s, at(8), MANUAL);
  return { s, screen: item(screen.id), flow: item(flow.result.artifactId), contract: item(contract.result.artifactId), open: item(open.id) };
}

const proposal = (title: string, over: Record<string, unknown> = {}) => ({
  title,
  outcome: `${title} works`,
  options: [
    { id: "A", name: "Do it", approach: "one way" },
    { id: "B", name: "Defer", approach: "not now" },
  ],
  recommendedOptionId: "A",
  rationale: "because",
  acceptance: ["The invite shows the trip"],
  flowId: "feature",
  ...over,
});

/** One lead run (a reply), through the real path. */
function lead(s0: State, proposals: object[]) {
  const r = M.startLeadRun(M.postMessage(s0, "plan the invite", at(10)), { provider: "claude", model: "m", trigger: "message" }, at(11));
  const s = M.completeLeadRun(r.state, r.runId, { reply: "Planned.", proposals } as never, at(12));
  const msg = s.conversation.at(-1)!;
  return { s, created: msg.proposedTaskIds ?? [], rejected: msg.rejected ?? [] };
}

describe("the lead's specs cite the blueprint items they build", () => {
  it("a proposal cites approved items; the spec keeps them, and a cited flow's rules and examples join the acceptance, tagged with their ids", () => {
    const b = building();
    expect([b.screen, b.flow, b.contract].map((id) => B.blueprintItems(b.s).find((i) => i.id === id)!.status)).toEqual(["approved", "approved", "approved"]);
    const { s, created } = lead(b.s, [proposal("Join a trip", { blueprintRefs: [b.screen, b.flow, b.contract, b.flow] })]);
    const spec = M.currentSpec(s.tasks.find((t) => t.id === created[0])!).content;
    expect(spec.blueprintRefs).toEqual([b.screen, b.flow, b.contract]);
    expect(spec.acceptance).toEqual([
      "The invite shows the trip",
      `[${b.flow} R1] When a friend opens the invite, the app shall show the trip's dates. (flow "Joining a trip", ${b.flow})`,
      `[${b.flow} R2] If the invite has expired, then the app shall offer to ask for a new one. (flow "Joining a trip", ${b.flow})`,
      `[${b.flow} E1] Given an expired invite, when Ana opens it, then she sees Ask for a new invite. (flow "Joining a trip", ${b.flow})`,
      `[${b.contract}] What crosses the boundary matches the approved contract "Invite API" v1, with its examples.`,
    ]);
    // One name for a rule everywhere: the tag a spec gives it is the tag its test result is read by.
    expect(spec.acceptance.slice(1, 4).map((line) => tagsIn(line))).toEqual([[`[${b.flow} R1]`], [`[${b.flow} R2]`], [`[${b.flow} E1]`]]);
  });

  it("a line the lead already wrote with a rule's tag is not repeated", () => {
    const b = building();
    const { s, created } = lead(b.s, [proposal("Join a trip", { blueprintRefs: [b.flow], acceptance: [`[${b.flow} R2] An expired invite offers a new one`] })]);
    const acceptance = M.currentSpec(s.tasks.find((t) => t.id === created[0])!).content.acceptance;
    expect(acceptance.filter((x) => x.startsWith(`[${b.flow} R2]`))).toEqual([`[${b.flow} R2] An expired invite offers a new one`]);
    expect(acceptance.map((x) => x.slice(0, x.indexOf("]") + 1))).toEqual([`[${b.flow} R2]`, `[${b.flow} R1]`, `[${b.flow} E1]`]);
  });

  it("the domain refuses an id that is not in the blueprint, and an item still open, and creates nothing", () => {
    const b = building();
    const unknown = lead(b.s, [proposal("Join a trip", { blueprintRefs: [b.screen, "bi-404"] })]);
    expect([unknown.created, unknown.rejected]).toEqual([[], ['"Join a trip": not in the blueprint: bi-404']]);
    const open = lead(b.s, [proposal("Settings page", { blueprintRefs: [b.open] })]);
    expect([open.created, open.rejected]).toEqual([[], [`"Settings page": ${b.open} is still open in the blueprint, not approved; cite only approved items`]]);
    const shape = lead(b.s, [proposal("Join a trip", { blueprintRefs: b.screen })]);
    expect(shape.rejected).toEqual(['"Join a trip": "blueprintRefs" must be a list of blueprint item ids']);
  });

  it("a revision the lead makes for the PE keeps citing, and takes the acceptance of what it cites now", () => {
    const b = building();
    const { s: planned, created } = lead(b.s, [proposal("Join a trip", { blueprintRefs: [b.screen] })]);
    const id = created[0];
    let s = runCommand(planned, "recordPeReview", { taskId: id, verdict: "feasible-if", reasons: "The invite flow is not cited.", change: "Cite the joining flow.", specRev: 1 }, at(20)).state;
    const r = M.startLeadRun(s, { provider: "claude", model: "m", trigger: "pe-review" }, at(21));
    s = M.completeLeadRun(r.state, r.runId, { reply: "Revised.", proposals: [proposal("Join a trip", { blueprintRefs: [b.screen, b.flow], revises: id })] } as never, at(22));
    const spec = M.currentSpec(s.tasks.find((t) => t.id === id)!);
    expect([spec.rev, spec.content.blueprintRefs, spec.content.acceptance.length]).toEqual([2, [b.screen, b.flow], 4]);
  });
});
