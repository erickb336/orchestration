// ORC-029 pass 5's settings forms: the preview the service runs for evidence (Settings › Project), the test report
// the checks read (Settings › Quality, beside the checks), and PE review of new work (Settings › Quality). Each saves
// through its owner-only command and shows the domain's refusal, in the domain's words, before Save. Rendered
// statically (there is no DOM test environment): a form's fields are given, and its save is run against the domain.

import { describe, expect, it } from "vitest";
import { runCommand } from "../../domain/commands";
import { blueprintScene } from "../../domain/testing/blueprintScene";
import type { State } from "../../domain/types";
import type { SendResult } from "../store";
import { renderScreen, visible } from "../testStore";
import { ChecksCard, checksProblem, checksSteps, liveChecks } from "../ChecksSettings";
import { sendInOrder } from "./draft";
import { QualitySection } from "./Quality";
import { PreviewCard } from "./PreviewCard";
import { ProjectSection } from "./Project";
import { livePreview, previewInput, previewProblem, previewSteps, splitArgv, type PreviewDraft } from "./preview";

const noop = () => {};
const T = "2026-10-02T10:00:00.000Z";

type Send = (name: string, args: object) => Promise<SendResult>;
type Steps = (() => Promise<SendResult> | null)[];

/** Run a form's save against the domain, as the service would: each command it sends, in order. */
async function save(s: State, steps: (send: Send) => Steps | Promise<Steps>): Promise<{ state: State; sent: [string, object][] }> {
  let state = s;
  const sent: [string, object][] = [];
  const send: Send = async (name, args) => {
    sent.push([name, args]);
    state = runCommand(state, name as never, args, T).state;
    return { ok: true };
  };
  expect(await sendInOrder(await steps(send))).toBe(true);
  return { state, sent };
}

describe("Settings › Quality › Checks: the test report", () => {
  it("sits beside the checks, with the runners' flags as examples", () => {
    const { s } = blueprintScene();
    const text = visible(renderScreen(<QualitySection current onDirty={noop} />, s));
    expect(text).toContain(
      'Test report (JUnit XML) Where your test run writes its JUnit XML report, inside the repository. The checks read one result per test from it, so each rule of a flow shows passed, failed, skipped or "No test". For example: vitest --reporter=junit --outputFile=reports/junit.xml , jest with jest-junit, or pytest --junitxml=reports/junit.xml . Empty: no report is read.',
    );
  });

  it("saves through setChecks with the rest of the checks as they are; empty reads no report", async () => {
    const { s } = blueprintScene();
    const on = runCommand(s, "setChecks", { config: { ...s.project.checks, rev: undefined, enabled: true, commands: [{ id: "test", label: "Tests", kind: "check", argv: ["npm", "test"] }] } }, T).state;
    const v = { ...liveChecks(on), testReport: " reports/junit.xml " };
    const r = await save(on, (send) => checksStepsNoAsk(on, v, send));
    expect(r.sent).toHaveLength(1);
    expect(r.state.project.checks).toMatchObject({ enabled: true, commands: [{ id: "test", argv: ["npm", "test"] }], testReport: "reports/junit.xml" });
    expect(liveChecks(r.state).testReport).toBe("reports/junit.xml");
    const cleared = await save(r.state, (send) => checksStepsNoAsk(r.state, { ...liveChecks(r.state), testReport: "" }, send));
    expect(cleared.state.project.checks.testReport).toBeUndefined();
  });

  it("shows the domain's refusal of a path outside the repository", () => {
    const { s } = blueprintScene();
    const v = { ...liveChecks(s), testReport: "../junit.xml" };
    const words = 'The test report "../junit.xml" is not a path inside the repository: use letters, digits, ".", "_", "-" and "/", no "..", no .git, ending in ".xml" (for example "reports/junit.xml").';
    expect(checksProblem(s, v)).toBe(words);
    expect(visible(renderScreen(<ChecksCard v={v} set={noop} />, s))).toContain(words);
    expect(() => runCommand(s, "setChecks", { config: { ...s.project.checks, rev: undefined, testReport: "../junit.xml" } }, T)).toThrow(words);
  });
});

/** Quality's checks steps for a changed test report (the checks are on already, so nothing asks first). */
const checksStepsNoAsk = async (s: State, v: ReturnType<typeof liveChecks>, send: Send) => (await checksSteps(s, v, new Set(["testReport"]), send as never, async () => true)) ?? [];

describe("Settings › Project › Preview for evidence", () => {
  it("not set up: the form says so and offers the install the service would use", () => {
    const { s } = blueprintScene();
    expect(livePreview(s)).toEqual({ previewInstall: "npm ci --ignore-scripts", previewCommand: "", previewPort: "", previewCli: "" });
    const text = visible(renderScreen(<ProjectSection current onDirty={noop} />, s));
    expect(text).toContain(
      "Preview for evidence The service runs your built product to show each screen and each CLI demo beside its design. It runs in the recorder's container on a copy of the change: the install with the network, then everything else with no network. Not set up Capture runs record \"not set up\", and nothing runs.",
    );
    for (const label of ["Install command", "Preview command", "Port", "CLI entry"]) expect(text).toContain(label);
  });

  it("saves through setPreview: the commands as argument lists, the port and the CLI entry; then shows the setting", async () => {
    const { s } = blueprintScene();
    const v: PreviewDraft = { previewInstall: "npm ci --ignore-scripts", previewCommand: 'npm run preview -- --port 4173 --host "127.0.0.1"', previewPort: "4173", previewCli: "bin/trips.js" };
    const r = await save(s, (send) => previewSteps(v, new Set(["previewCommand", "previewPort", "previewCli"]), send));
    expect(r.sent).toEqual([["setPreview", { preview: { install: ["npm", "ci", "--ignore-scripts"], preview: ["npm", "run", "preview", "--", "--port", "4173", "--host", "127.0.0.1"], port: 4173, cliEntry: "bin/trips.js" } }]]);
    expect(r.state.project.preview).toEqual({ rev: 1, install: ["npm", "ci", "--ignore-scripts"], preview: ["npm", "run", "preview", "--", "--port", "4173", "--host", "127.0.0.1"], port: 4173, cliEntry: "bin/trips.js" });
    expect(visible(renderScreen(<ProjectSection current onDirty={noop} />, r.state))).toContain("Set up (r1) install `npm ci --ignore-scripts`, preview `npm run preview -- --port 4173 --host 127.0.0.1` on port 4173, CLI entry `bin/trips.js`");
    // Emptying the preview command, the port and the CLI entry clears the setting.
    const off = await save(r.state, (send) => previewSteps({ ...livePreview(r.state), previewCommand: "", previewPort: "", previewCli: "" }, new Set(["previewCommand"]), send));
    expect(off.sent).toEqual([["setPreview", { preview: null }]]);
    expect(off.state.project.preview).toBeUndefined();
    // No field of the form changed: nothing is sent.
    expect(previewSteps(v, new Set(["repoPath"]), async () => ({ ok: true }))).toEqual([]);
  });

  it("shows the domain's refusal under the fields, the same words the service answers with", () => {
    const { s } = blueprintScene();
    const cases: [Partial<PreviewDraft>, string][] = [
      [{ previewCommand: "npm run preview", previewPort: "" }, "The preview command and its port go together: give both, or neither for a product with no screens."],
      [{ previewCommand: "npm run preview", previewPort: "80" }, "The port is a whole number from 1024 to 65535."],
      [{ previewInstall: "npm run build", previewCli: "bin/trips.js" }, 'The install: a prepare command with npm is "npm ci", "npm install", "npm i" or "npm rebuild".'],
      [{ previewCli: "../outside.js" }, 'The CLI entry "../outside.js" is not a file path inside the repository (letters, digits, ".", "_", "-", " " and "/").'],
    ];
    for (const [over, words] of cases) {
      const v = { ...livePreview(s), ...over };
      expect(previewProblem(v)).toBe(words);
      expect(() => runCommand(s, "setPreview", { preview: previewInput(v) }, T)).toThrow(words);
      expect(visible(renderScreen(<PreviewCard v={v} set={noop} />, s))).toContain(words);
    }
    expect(previewProblem({ ...livePreview(s), previewCommand: "npm run preview", previewPort: "4173" })).toBeUndefined();
  });

  it("reads a command line into arguments: spaces split it, quotes keep an argument whole", () => {
    expect(splitArgv(`  node  "bin/my tool.js" --name 'a b' ""  `)).toEqual(["node", "bin/my tool.js", "--name", "a b", ""]);
    expect(splitArgv("")).toEqual([]);
  });
});
