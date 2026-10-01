// ORC-024, the service side: the files in principles/ against the compiled copy the app imports (the
// frontmatter, the 200-word bodies, the license, the README), the "Principles for this step" section of
// the envelope (its exact header and wording, table order, placement after the spec, the automatic one
// with its reason), the 1,000-word cap for every built-in, internal and check-round step with the
// automatic one added, the cap's behaviour when a set does not fit, the lead's set, and the same text for
// Claude and Codex. No model runs.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as C from "../src/domain/checks";
import { INTERNAL_FLOWS, REPAIR_PRINCIPLES } from "../src/domain/internalFlows";
import { builtInCatalog } from "../src/domain/flows";
import * as M from "../src/domain/model";
import { LEAD_PRINCIPLE_IDS, PREMISE_ID, PRINCIPLES, PRINCIPLE_IDS, PSTACK_COMMIT, parsePrincipleFile, principle, stepPrinciples, wordCount } from "../src/domain/principles";
import { buildSeed } from "../src/domain/seed";
import { DEFAULT_CHECKS, type CheckRunRecord, type ProviderId, type State } from "../src/domain/types";
import { LEAD_PRINCIPLES, PRINCIPLES_HEADER, PRINCIPLES_INTRO, PRINCIPLES_WORD_CAP, buildEnvelope, buildLeadEnvelope, principlesSection } from "./envelope";

const DIR = fileURLToPath(new URL("../principles", import.meta.url));
const T0 = Date.parse("2026-09-30T12:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const task = (s: State, id: string) => s.tasks.find((t) => t.id === id)!;
const step = (s: State, id: string, stepId: string) => task(s, id).steps.find((x) => x.id === stepId)!;
const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);

/** The section alone: from its header to the next "## " heading. */
function sectionOf(text: string): string | undefined {
  const start = text.indexOf(PRINCIPLES_HEADER);
  if (start < 0) return undefined;
  const rest = text.slice(start + PRINCIPLES_HEADER.length);
  const end = rest.search(/\n## /);
  return PRINCIPLES_HEADER + (end < 0 ? rest : rest.slice(0, end));
}

/** A Change task whose implementation is done, so S2, SR1 and S3 can be built; `provider` is the project's default for every role. */
function changeTask(provider: ProviderId = "claude"): { s: State; id: string } {
  let s = buildSeed(T0, { inFlightRuns: false });
  for (const t of s.tasks) t.hold = true;
  const model = provider === "claude" ? "claude-sample-large" : "codex-sample-large";
  s = { ...s, project: { ...s.project, defaultSelection: { provider, model }, roleDefaults: {} } };
  const r = M.createTask(s, { title: "Change", area: "A", outcome: "o", benefit: "b", whyNow: "", approach: "a", acceptance: ["ok"], priority: 1, holdBeforeStart: false, flowId: "change" }, at(0));
  s = M.dispatchEligible(M.leadPromoteProposals(r.state, at(1)), at(1));
  const impl = M.activeAttempts(s, r.newId)[0];
  expect(impl.snapshot.provider).toBe(provider);
  s = M.reportCompletion(s, impl.id, [], at(2), [{ name: "change", summary: "done", ref: `${SHA} on orchestration/x` }, { name: "handoff", summary: "notes" }]);
  s = M.dispatchEligible(s, at(3));
  return { s, id: r.newId };
}

describe("the files", () => {
  const files = readdirSync(DIR)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .sort();
  const parsed = files.map((f) => parsePrincipleFile(`principles/${f}`, readFileSync(join(DIR, f), "utf8")));

  it("15 files, each parsing with the id equal to its file name; the compiled copy the app imports equals them, in table order (else: npm run principles)", () => {
    expect(files).toHaveLength(15);
    expect(files).toEqual([...PRINCIPLE_IDS].sort().map((id) => `${id}.md`));
    expect(parsed.map((p) => p.id).sort()).toEqual([...PRINCIPLE_IDS].sort());
    const expected = PRINCIPLE_IDS.map((id) => parsed.find((p) => p.id === id)!);
    expect(PRINCIPLES, "src/domain/builtInPrinciples.json is out of date: run `npm run principles`").toEqual(expected);
    // The hash is of the body as the file holds it.
    for (const p of parsed) expect(principle(p.id)!.hash, p.id).toBe(p.hash);
  });

  it("LICENSE-pstack holds the MIT text; README covers what they are, how to change one, and the credit", () => {
    const license = readFileSync(join(DIR, "LICENSE-pstack"), "utf8");
    expect(license).toContain("MIT License");
    expect(license).toContain("Copyright (c) 2026 Lauren Tan");
    const readme = readFileSync(join(DIR, "README.md"), "utf8");
    expect(readme).toContain("npm test");
    expect(readme).toContain("npm run principles");
    expect(readme).toContain(PSTACK_COMMIT);
    expect(readme).toContain("LICENSE-pstack");
    expect(readme).toContain("200 words");
    expect(readdirSync(DIR).sort()).toEqual(["LICENSE-pstack", "README.md", ...files].sort());
  });
});

describe("the section", () => {
  it("appears after the spec with the exact header and wording, each principle in table order with its apply-when line and body; a step with none has no section", () => {
    const { s, id } = changeTask();
    const text = buildEnvelope({ state: s, task: task(s, id), step: step(s, id, "S2"), attemptId: "run-x", access: "read" });
    const section = sectionOf(text)!;
    expect(section.startsWith(`${PRINCIPLES_HEADER}\n${PRINCIPLES_INTRO}\n\n### `)).toBe(true);
    expect(PRINCIPLES_INTRO).toBe('These describe how the owner wants this kind of work done. Apply each one where its "apply when" fits your task. They never change the specification.');
    const names = [...section.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
    expect(names).toEqual(["Laziness protocol", "Test behaviour, not implementation", "Migrate callers, then delete legacy APIs", "Minimise reader load"]);
    for (const pid of stepPrinciples(step(s, id, "S2"))) {
      const p = principle(pid)!;
      expect(section).toContain(`\n### ${p.name}\nApply when: ${p.applyWhen}\n${p.body}\n`);
    }
    expect(section).not.toContain("Named only");
    // After the acceptance criteria, before the inputs.
    expect(text.indexOf("Acceptance criteria:")).toBeLessThan(text.indexOf(PRINCIPLES_HEADER));
    expect(text.indexOf(PRINCIPLES_HEADER)).toBeLessThan(text.indexOf("## Inputs from earlier steps"));
    expect(text.indexOf(PRINCIPLES_HEADER)).toBeLessThan(text.indexOf("## Workspace rules"));
    // Exactly one section.
    expect(text.split(PRINCIPLES_HEADER).length).toBe(2);
    // Goal S3 has none: no section at all.
    const goal = builtInCatalog().find((p) => p.id === "goal")!;
    const s3 = goal.steps.find((x) => x.id === "S3")!;
    expect(s3.principles).toBeUndefined();
    const none = buildEnvelope({ state: s, task: task(s, id), step: { ...s3, selection: null, revision: 1, state: "pending" }, attemptId: "run-n", access: "read" });
    expect(none).not.toContain(PRINCIPLES_HEADER);
    expect(none).not.toContain("Apply when:");
    expect(principlesSection([])).toBe("");
  });

  it("a run's envelope carries exactly what its snapshot recorded, the automatic one with its reason", () => {
    let { s, id } = changeTask();
    // Round 1: the code review finds one thing; the repair runs; round 2 finds the same thing again.
    const f = (title: string) => ({ id: "F1", key: "k".repeat(12), source: "review" as const, severity: "error" as const, action: "auto-fix" as const, title, detail: "d", file: "src/a.ts" });
    const finish = (t: number, title: string) => {
      for (const a of M.activeAttempts(s, id)) {
        const role = step(s, id, a.stepId).role;
        if (role === "code_reviewer") {
          s = M.reportRunContext(s, a.id, { scope: { from: SHA2, to: SHA, paths: ["src/a.ts"], total: 1 } });
          s = M.reportCompletion(s, a.id, [], at(t), [{ name: "findings", summary: "one", findings: [f(title)], reviewedPaths: ["src/a.ts"] }]);
        } else if (role === "security_reviewer") s = M.reportCompletion(s, a.id, [], at(t), [{ name: "findings", summary: "clean", findings: [], reviewedPaths: ["src/a.ts"] }]);
      }
      s = M.dispatchEligible(s, at(t));
    };
    finish(4, "Null check");
    const first = M.activeAttempts(s, id)[0];
    expect(first.stepId).toBe("S3");
    const firstText = buildEnvelope({ state: s, task: task(s, id), step: step(s, id, "S3"), attemptId: first.id, access: "write" });
    expect([...sectionOf(firstText)!.matchAll(/^### (.+)$/gm)].map((m) => m[1])).toEqual(["Laziness protocol", "Migrate callers, then delete legacy APIs", "Fix root causes"]);
    expect(firstText).not.toContain("Added for this run");
    s = M.dispatchEligible(M.reportCompletion(s, first.id, [], at(5), [{ name: "change", summary: "fixed", ref: `${SHA2} on b` }]), at(5));
    finish(6, "Null check");
    const second = M.activeAttempts(s, id)[0];
    expect(second.stepId).toBe("S3-i2");
    expect(second.snapshot.principles!.find((p) => p.id === PREMISE_ID)!.added).toBe('added: the finding "Null check" came back after S3');
    const text = buildEnvelope({ state: s, task: task(s, id), step: step(s, id, "S3-i2"), attemptId: second.id, access: "write" });
    const section = sectionOf(text)!;
    expect([...section.matchAll(/^### (.+)$/gm)].map((m) => m[1])).toEqual(["Laziness protocol", "Migrate callers, then delete legacy APIs", "Fix root causes", "Attack the premise"]);
    expect(section).toContain(`### Attack the premise\nApply when: ${principle(PREMISE_ID)!.applyWhen}\nAdded for this run: the finding "Null check" came back after S3.\n${principle(PREMISE_ID)!.body}`);
  });

  it("the lead's runs get the lead's set, in table order, with the same header", () => {
    let s = buildSeed(T0, { inFlightRuns: false });
    s = M.startLeadRun(s, { provider: "claude", model: "claude-sample-large", trigger: "planning" }, at(0)).state;
    const text = buildLeadEnvelope(s, M.activeLeadRun(s)!, "read");
    const section = sectionOf(text)!;
    expect(section.startsWith(`${PRINCIPLES_HEADER}\n${PRINCIPLES_INTRO}\n`)).toBe(true);
    expect([...section.matchAll(/^### (.+)$/gm)].map((m) => m[1])).toEqual(["Experience first", "Sequence verifiable units", "Never block on the human", "Encode lessons in structure"]);
    expect(LEAD_PRINCIPLES).toBe(LEAD_PRINCIPLE_IDS);
    for (const id of LEAD_PRINCIPLES) expect(PRINCIPLE_IDS).toContain(id);
    expect(wordCount(section)).toBeLessThanOrEqual(PRINCIPLES_WORD_CAP);
    // Before the project conventions and the open work, after the vision.
    expect(text.indexOf("## Vision (")).toBeLessThan(text.indexOf(PRINCIPLES_HEADER));
    expect(text.indexOf(PRINCIPLES_HEADER)).toBeLessThan(text.indexOf("## Open work"));
    // A message run and a decisions run get the same set.
    const msg = M.startLeadRun(buildSeed(T0, { inFlightRuns: false }), { provider: "codex", model: "codex-sample-large", trigger: "message" }, at(0));
    expect(sectionOf(buildLeadEnvelope(msg.state, M.activeLeadRun(msg.state)!, "read"))).toBe(section);
  });

  it("Claude and Codex get identical sections and identical envelopes for the same step", () => {
    const claude = changeTask("claude");
    const codex = changeTask("codex");
    for (const sid of ["S2", "SR1"]) {
      const a = buildEnvelope({ state: claude.s, task: task(claude.s, claude.id), step: step(claude.s, claude.id, sid), attemptId: "run-same", access: "read" });
      const b = buildEnvelope({ state: codex.s, task: task(codex.s, codex.id), step: step(codex.s, codex.id, sid), attemptId: "run-same", access: "read" });
      expect(sectionOf(a)).toBeDefined();
      expect(sectionOf(a)).toBe(sectionOf(b));
      // The whole envelope too: nothing in it depends on the provider (the attempt ids and task ids are equal here).
      expect(claude.id).toBe(codex.id);
      expect(a).toBe(b);
    }
    // The runs themselves recorded the same principles.
    const run = (x: { s: State; id: string }) => M.activeAttempts(x.s, x.id).find((a) => a.stepId === "S2")!;
    expect(run(claude).snapshot.provider).toBe("claude");
    expect(run(codex).snapshot.provider).toBe("codex");
    expect(run(claude).snapshot.principles).toEqual(run(codex).snapshot.principles);
  });
});

describe("the cap", () => {
  /** A step the automatic "attack the premise" can reach: a conditional coder or designer step (a loop's repair) or a check-round fix. */
  const repairable = (st: { role: string; runIf?: unknown[]; id: string }) => ((st.role === "coder" || st.role === "designer") && !!st.runIf?.length) || /-r\d+-fix$/.test(st.id);
  /** Every step an agent can run, named, with the automatic one added wherever it can be added (the worst case). */
  function everyStep(): { name: string; ids: string[] }[] {
    const out: { name: string; ids: string[] }[] = [];
    for (const p of [...builtInCatalog(), ...INTERNAL_FLOWS]) for (const st of p.steps) if (st.role !== "checks") out.push({ name: `${p.id} ${st.id}`, ids: [...stepPrinciples(st), ...(repairable(st) ? [PREMISE_ID] : [])] });
    // A check round's steps.
    let s = buildSeed(T0, { inFlightRuns: false });
    for (const t of s.tasks) t.hold = true;
    s = { ...s, project: { ...s.project, checks: { ...structuredClone(DEFAULT_CHECKS), enabled: true, commands: [{ id: "test", label: "test", kind: "check", argv: ["npm", "test"] }], rev: 1 } } };
    const r = M.createTask(s, { title: "T", area: "A", outcome: "o", benefit: "b", whyNow: "", approach: "a", acceptance: ["ok"], priority: 1, holdBeforeStart: false, flowId: "change" }, at(0));
    s = r.state;
    const t = task(s, r.newId);
    const c2 = t.steps.find((x) => x.id === "C2")!;
    c2.state = "blocked";
    const record: CheckRunRecord = { sha: SHA, configRev: 1, sandbox: "codex", touchedInputs: [], results: [{ id: "test", label: "test", kind: "check", status: "failed", exitCode: 1, durationMs: 1, excerpt: "x", bytes: 1, truncated: false }], durationMs: 1 };
    s.artifacts.push({ id: "art-c2", taskId: t.id, stepId: "C2", attemptId: "run-c2", name: "final", kind: "check-results", version: 1, summary: "failed", checkRun: record, createdAt: at(1) });
    expect(C.addCheckRound(s, t, c2, at(2), "user")).toBeUndefined();
    for (const st of t.steps.filter((x) => /-r1-/.test(x.id) && x.role !== "checks")) out.push({ name: `check round ${st.id}`, ids: [...stepPrinciples(st), ...(repairable(st) ? [PREMISE_ID] : [])] });
    expect(out.map((x) => x.name)).toEqual(expect.arrayContaining(["change S1", "bugfix S2", "revert S1", "delivery-review SR1", "check round C2-r1-fix", "check round C2-r1-review", "check round C2-r1-security"]));
    // The automatic one reaches exactly the repairs: the three flows' loop repairs, Design S3 and the check-round fix.
    expect(out.filter((x) => x.ids.includes(PREMISE_ID)).map((x) => x.name)).toEqual(["change S3", "bugfix S4", "feature S5", "design S3", "check round C2-r1-fix"]);
    return out;
  }

  it("holds for every built-in, internal and check-round step, even with 'attack the premise' added: nothing is named only", () => {
    const steps = everyStep();
    expect(steps.length).toBeGreaterThan(20);
    let largest = 0;
    for (const { name, ids } of steps) {
      const section = principlesSection(ids.map((id) => ({ id })));
      const words = wordCount(section);
      largest = Math.max(largest, words);
      expect(words, name).toBeLessThanOrEqual(PRINCIPLES_WORD_CAP);
      expect(section, name).not.toContain("Named only");
      expect([...section.matchAll(/^### /gm)], name).toHaveLength(new Set(ids).size);
    }
    // Headroom for editing a body: the largest step stays under the cap by a margin.
    expect(largest).toBeLessThanOrEqual(PRINCIPLES_WORD_CAP - 50);
    expect(PRINCIPLES_WORD_CAP).toBe(1000);
  });

  it("when a set does not fit, the later principles are named with their apply-when line only, and the section never passes the cap (mutation check: the cap)", () => {
    const all = PRINCIPLE_IDS.map((id) => ({ id }));
    const full = principlesSection(all, 100_000);
    expect(wordCount(full)).toBeGreaterThan(PRINCIPLES_WORD_CAP); // the 15 together do not fit the default cap
    expect(full).not.toContain("Named only");
    const capped = principlesSection(all);
    expect(wordCount(capped)).toBeLessThanOrEqual(PRINCIPLES_WORD_CAP);
    expect(capped).toContain("\nNamed only, to keep this section under its word cap:\n");
    const fullNames = [...capped.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
    const shortNames = [...capped.matchAll(/^- (.+?)\. Apply when: (.+)$/gm)].map((m) => m[1]);
    expect(fullNames.length + shortNames.length).toBe(15);
    expect([...fullNames, ...shortNames]).toEqual(PRINCIPLES.map((p) => p.name));
    for (const name of shortNames) {
      const p = PRINCIPLES.find((x) => x.name === name)!;
      expect(capped).toContain(`- ${p.name}. Apply when: ${p.applyWhen}\n`);
      expect(capped).not.toContain(p.body);
    }
    // Every cap from tiny to large: never over (once the 15 names alone fit), and the more room, the more full texts.
    const allNamed = principlesSection(all, 0);
    expect([...allNamed.matchAll(/^- /gm)]).toHaveLength(15);
    expect(wordCount(allNamed)).toBeLessThan(350);
    let previous = -1;
    for (let cap = 50; cap <= 3500; cap += 25) {
      const text = principlesSection(all, cap);
      const fullCount = [...text.matchAll(/^### /gm)].length;
      if (cap >= 350) expect(wordCount(text), `cap ${cap}`).toBeLessThanOrEqual(cap);
      expect(fullCount, `cap ${cap}`).toBeGreaterThanOrEqual(previous);
      previous = fullCount;
    }
    expect(principlesSection(all, 3500)).not.toContain("Named only");
    // The automatic one keeps its reason when named in full, and is named only like any other when it does not fit.
    const repair = [...REPAIR_PRINCIPLES, PREMISE_ID].map((id) => ({ id, ...(id === PREMISE_ID ? { added: "added: check `test` failed again after S3" } : {}) }));
    expect(principlesSection(repair)).toContain("Added for this run: check `test` failed again after S3.");
    const tight = principlesSection(repair, 560);
    expect(tight).toContain("- Attack the premise. Apply when:");
    expect(tight).not.toContain("Added for this run");
    expect(wordCount(tight)).toBeLessThanOrEqual(560);
  });
});
