// ORC-029 pass 5: the coder's brief for a task whose spec cites screens, terminal demos or TUIs (`blueprintRefs`). It
// asks for the capture plan at its fixed path, says how each kind is planned, and says how the service will run the
// product (or that it is not set up yet). Other steps, tasks without such items, and flows and contracts get no such
// section.

import { describe, expect, it } from "vitest";
import * as M from "../src/domain/model";
import { buildSeed } from "../src/domain/seed";
import { run } from "../src/domain/testing/studio";
import type { BlueprintItem } from "../src/domain/studio/types";
import type { SpecContent, State } from "../src/domain/types";
import { CAPTURE_PLAN_HEADER, buildEnvelope } from "./envelope";

const T0 = Date.parse("2026-10-02T12:00:00Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const ITEMS: BlueprintItem[] = [
  { id: "bi-1", kind: "screen", title: "Trip board", artifactId: "sa-1", version: 2, variant: "B", status: "approved" },
  { id: "bi-2", kind: "flow", title: "Joining a trip", artifactId: "sa-2", version: 1, status: "approved" },
  { id: "bi-3", kind: "terminal-demo", title: "trips CLI", artifactId: "sa-3", version: 1, status: "approved" },
];

function project(preview?: object): State {
  let s = M.initProject(buildSeed(T0, { inFlightRuns: false }), { name: "Trips", repoPath: "/tmp/trips", vision: "Weekend trips.", focus: "" }, at(0));
  s = structuredClone(s);
  s.blueprint.revisions.push({ rev: 1, at: at(1), visionRev: 1, reason: "approved", items: structuredClone(ITEMS) });
  return preview ? run(s, "setPreview", { preview }, at(2)).state : s;
}

/** A Feature task citing `refs`; the envelope of its step `stepId`. */
function envelope(s0: State, refs: string[], stepId: string): string {
  const c = run<{ newId: string }>(s0, "createTask", { title: "Trip board", area: "Trips", outcome: "o", benefit: "", whyNow: "", approach: "y", acceptance: ["ok"], priority: 1, holdBeforeStart: true, flowId: "feature" }, at(10));
  let s = c.state;
  if (refs.length) {
    const t0 = s.tasks.find((x) => x.id === c.result.newId)!;
    const content: SpecContent = { ...M.currentSpec(t0).content, blueprintRefs: refs };
    s = run(s, "editSpec", { taskId: t0.id, expectedRev: 1, content, reason: "Cites the blueprint" }, at(11)).state;
  }
  const t = s.tasks.find((x) => x.id === c.result.newId)!;
  return buildEnvelope({ state: s, task: t, step: t.steps.find((x) => x.id === stepId)!, attemptId: "run-1", access: "write" });
}
const section = (text: string) => {
  const from = text.indexOf(CAPTURE_PLAN_HEADER);
  return from < 0 ? "" : text.slice(from, text.indexOf("\n\n## ", from));
};

describe("the coder's capture plan lines", () => {
  it("ask for the plan at its path, for each screen and CLI the task cites, and say the project is not set up yet", () => {
    const text = section(envelope(project(), ["bi-1", "bi-2", "bi-3"], "S2"));
    expect(text).toContain('Write the capture plan at `.orchestrator/capture.json` in the change, and name it in your handoff. For example: `{"screens":[{"item":"bi-1","path":"/","devices":["desktop","mobile"]}],"terminals":[{"item":"bi-3","tape":".orchestrator/demo.tape"}]}`.');
    expect(text).toContain("- A screen: its page path on the preview");
    expect(text).toContain("- A terminal demo or TUI: a VHS tape in the repository that types the real command from the repository's root.");
    expect(text).toContain('- The project has no preview setting yet, so the service records "not set up" and captures nothing.');
    expect(text.split("\n").slice(-2)).toEqual(["- bi-1 Trip board (screen v2, variant B)", "- bi-3 trips CLI (terminal-demo v1)"]);
    // A flow is proved by its acceptance tests, not captured.
    expect(text).not.toContain("bi-2");
  });

  it("say how the service runs the product when the owner set the preview", () => {
    const text = section(envelope(project({ preview: ["npm", "run", "preview", "--", "--port", "4173"], port: 4173, cliEntry: "bin/trips.js" }), ["bi-3", "bi-1"], "S2"));
    expect(text).toContain("types the real command (`node bin/trips.js …`) from the repository's root");
    expect(text).toContain("- The service installs with `npm ci --ignore-scripts` (no install scripts), then runs `npm run preview -- --port 4173` on port 4173 with no network.");
  });

  it("are given to the coder only, and only for screens, demos and TUIs", () => {
    expect(section(envelope(project(), ["bi-1"], "S5"))).not.toBe("");
    expect(section(envelope(project(), ["bi-1"], "S1"))).toBe("");
    expect(section(envelope(project(), ["bi-1"], "S4"))).toBe("");
    expect(section(envelope(project(), ["bi-2"], "S2"))).toBe("");
    expect(section(envelope(project(), [], "S2"))).toBe("");
  });
});
