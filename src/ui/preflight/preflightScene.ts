// Test fixture (pure): Weekend Trips in Vision, the moment before Start the factory, built through the real commands,
// for the pre-flight's tests and its seeded browser pass. Not used by the application.
//
// The draft (nothing is locked in yet):
// - the experience (round 1): Trip plan and Packing list approved, the PE agreed on each, with its estimate on
//   Packing list only; Trip map open (the owner marked it Change);
// - inputs and outputs (round 2): Trip data approved (the PE agreed) and Words, a word list the PE does not review;
// - flows (round 3, still open): Join flow approved (the PE agreed).
// Also open: a PE probe still running, and two areas of the vision. The lead planned two tasks while shaping (the
// roadmap): one Feature, one Change. Budgets: $40 to build, $10 a month to maintain.

import * as M from "../../domain/model";
import { buildSeed } from "../../domain/seed";
import { DESIGNER, openRound, peAgrees, pePass, run, sha } from "../../domain/testing/studio";
import type { State } from "../../domain/types";

export interface PreflightScene {
  s: State;
  at: (sec: number) => string;
  /** The roadmap's task ids. */
  tasks: { packing: string; join: string };
  probeId: string;
}

const COVERAGE = { intent: "clear", audience: "clear", problem: "clear", outcome: "partial", scope: "clear", constraints: "open", risks: "open", priorities: "clear", material: "clear" };

/** A lead proposal while shaping: held for the start, as the roadmap's tasks are. */
const proposal = (title: string, flowId: string, priority: number) => ({
  title,
  area: "Trips",
  whyNow: "The blueprint has it.",
  outcome: `${title} works as the blueprint shows.`,
  benefit: "Friends plan a trip together.",
  scopeIncluded: [title],
  scopeExcluded: [],
  options: [
    { id: "A", name: "As designed", approach: "Build the approved screens.", benefit: "Matches the blueprint.", effort: "Small", risks: "Low", reversibility: "High" },
    { id: "B", name: "Defer", approach: "Do nothing yet.", benefit: "No cost.", effort: "None", risks: "No trip plans.", reversibility: "High" },
  ],
  recommendedOptionId: "A",
  rationale: "The approved design.",
  uncertainty: "None.",
  acceptance: [`${title} matches the approved design`],
  flowId,
  priority,
});

export function preflightScene(t0 = Date.parse("2026-10-02T09:00:00Z")): PreflightScene {
  const at = (sec: number) => new Date(t0 + sec * 1000).toISOString();
  let s = M.initProject(buildSeed(t0, { inFlightRuns: false }), { name: "Weekend Trips", repoPath: "/tmp/weekend-trips", vision: "Weekend trips for a small group of friends.", focus: "Plan a trip together" }, at(0));
  s = run(s, "setBudgets", { buildingUsd: 40, maintenanceUsdPerMonth: 10 }, at(1)).state;
  s = run(s, "setDomains", { domains: ["screen"] }, at(1)).state;
  // Autopilot, so the lead plans while shaping (on Manual it does not).
  s = M.setAutonomy(s, { ...s.project.autonomy, enabled: true, holdLeadProposals: false }, at(2));
  const add = (round: number, sec: number, args: Record<string, unknown>) => {
    const r = run<{ artifactId: string; version: number }>(s, "addStudioArtifact", { round, devices: [], madeBy: DESIGNER, ...args }, at(sec));
    s = r.state;
    return r.result.artifactId;
  };
  const screen = (round: number, sec: number, title: string, dir: string, c: string) =>
    add(round, sec, { kind: "screen", title, variants: [{ id: "A", label: title, entry: `${dir}/index.html` }], files: [{ path: `${dir}/index.html`, sha256: sha(c) }], devices: ["desktop", "mobile"] });

  // Round 1, the experience.
  let r = openRound(s, "experience", at(10));
  s = r.state;
  const plan = screen(r.n, 11, "Trip plan", "trip-plan", "a");
  s = peAgrees(s, plan, 1, [], at(12));
  const packing = screen(r.n, 13, "Packing list", "packing", "9");
  s = pePass(s, packing, 1, [{ verdict: "feasible", budget: { buildUsd: [3, 5], maintenanceUsdPerMonth: [0.4, 0.8], basis: "storage of shared lists" } }], at(14));
  const map = screen(r.n, 15, "Trip map", "trip-map", "8");
  s = peAgrees(s, map, 1, [], at(16));
  s = run(s, "sendFeedback", { entries: [{ artifactId: map, version: 1, mark: "change", pins: [], note: "Show the stops as a list too.", rows: [] }] }, at(17)).state;
  s = run(s, "approveRound", { round: r.n }, at(18)).state;
  s = run(s, "closeRound", { round: r.n }, at(19)).state;

  // Round 2, inputs and outputs.
  r = openRound(s, "data", at(20));
  s = r.state;
  const data = add(r.n, 21, { kind: "contract", title: "Trip data", variants: [{ id: "A", label: "Trip data", entry: "trip-data/contract.md" }], files: [{ path: "trip-data/contract.md", sha256: sha("d") }] });
  s = peAgrees(s, data, 1, [], at(22));
  add(r.n, 23, { kind: "dictionary", title: "Words", variants: [{ id: "a", label: "As drafted", entry: "dictionary.json" }], files: [{ path: "dictionary.json", sha256: sha("e") }], dictionary: [{ term: "trip", meaning: "A weekend away that a group plans together.", avoid: ["journey"] }] });
  s = run(s, "approveRound", { round: r.n }, at(24)).state;
  s = run(s, "closeRound", { round: r.n }, at(25)).state;

  // Round 3, flows: still open, with a probe the PE asked for.
  r = openRound(s, "flows", at(30));
  s = r.state;
  const join = add(r.n, 31, { kind: "flow", title: "Join flow", variants: [{ id: "A", label: "Join flow", entry: "join/flow.md" }], files: [{ path: "join/flow.md", sha256: sha("b") }] });
  s = peAgrees(s, join, 1, [], at(32));
  s = run(s, "approveArtifact", { artifactId: join, version: 1 }, at(33)).state;
  const probe = run<{ probeId: string }>(s, "addProbe", { question: "Can the trip plan load offline on the trail?" }, at(34));
  s = run(probe.state, "setProbeStatus", { probeId: probe.result.probeId, status: "running", attemptId: "run-probe" }, at(35)).state;

  // The lead's reply while shaping: what is clear so far, and the roadmap.
  s = M.postMessage(s, "Plan the first tasks from what we approved.", at(40));
  const lead = M.startLeadRun(s, { provider: "claude", model: "auto", trigger: "message" }, at(41));
  s = M.completeLeadRun(lead.state, lead.runId, { reply: "Two tasks are planned.", proposals: [proposal("Packing list", "feature", 1), proposal("Join by link", "change", 2)], coverage: COVERAGE }, at(42));
  const id = (title: string) => s.tasks.find((t) => M.currentSpec(t).content.title === title)!.id;
  return { s, at, tasks: { packing: id("Packing list"), join: id("Join by link") }, probeId: probe.result.probeId };
}
