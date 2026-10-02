// Principles in every flow, pure: the compiled principles (the 200-word bodies, the credit, the parser), the
// mapping table pinned step by step for the six flows, the internal flows and the check rounds, the resolver's
// and the pipeline rules' refusals, the hash, and the automatic "attack the premise": added to a repair round
// after a round that failed the same way, with its reason, and to nothing else. The files on disk are
// compared with the compiled copy in server/principles.test.ts (this directory has no file access).

import { describe, expect, it } from "vitest";
import * as C from "./checks";
import * as F from "./findings";
import { BUILT_IN_FILES } from "./builtInFlows";
import { INTERNAL_FLOWS } from "./internalFlows";
import { builtInCatalog, flowHash, resolveFlows, type FlowFile, type RawFlow } from "./flows";
import * as M from "./model";
import { structuralKey, toDef, validatePipeline } from "./pipeline";
import { EVERY_RUN_PRINCIPLE_IDS, LEAD_PRINCIPLE_IDS, PREMISE_ID, PRINCIPLES, PRINCIPLE_BODY_WORDS, PRINCIPLE_IDS, PSTACK_COMMIT, orderPrinciples, parsePrincipleFile, principle, stepPrinciples, wordCount } from "./principles";
import { buildSeed } from "./seed";
import { DEFAULT_CHECKS, type CheckRunRecord, type ChecksConfig, type Finding, type State, type StepDef } from "./types";

const T0 = Date.parse("2026-09-30T12:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const task = (s: State, id: string) => s.tasks.find((t) => t.id === id)!;
const step = (s: State, id: string, stepId: string) => task(s, id).steps.find((x) => x.id === stepId)!;
const running = (s: State, id: string) => M.activeAttempts(s, id);
const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);
const SHA3 = "c".repeat(40);

/** The table in docs/tasks/ORC-024.md, step by step. A step not listed gets none. */
const TABLE: Record<string, Record<string, string[]>> = {
  change: {
    S1: ["laziness-protocol", "subtract-before-you-add", "test-behavior-not-implementation", "migrate-callers-then-delete-legacy-apis", "prove-it-works"],
    S2: ["laziness-protocol", "test-behavior-not-implementation", "migrate-callers-then-delete-legacy-apis", "minimize-reader-load"],
    SR1: ["boundary-discipline"],
    S3: ["laziness-protocol", "migrate-callers-then-delete-legacy-apis", "fix-root-causes"],
    S4: ["prove-it-works"],
  },
  bugfix: {
    S1: ["fix-root-causes", "prove-it-works"],
    S2: ["laziness-protocol", "test-behavior-not-implementation", "migrate-callers-then-delete-legacy-apis", "fix-root-causes", "prove-it-works"],
    S3: ["laziness-protocol", "test-behavior-not-implementation", "migrate-callers-then-delete-legacy-apis", "minimize-reader-load"],
    SR1: ["boundary-discipline"],
    S4: ["laziness-protocol", "migrate-callers-then-delete-legacy-apis", "fix-root-causes"],
    S5: ["prove-it-works"],
  },
  feature: {
    S1: ["exhaust-the-design-space", "experience-first", "foundational-thinking"],
    S2: ["laziness-protocol", "subtract-before-you-add", "test-behavior-not-implementation", "migrate-callers-then-delete-legacy-apis", "prove-it-works"],
    S3: ["laziness-protocol", "test-behavior-not-implementation", "migrate-callers-then-delete-legacy-apis", "minimize-reader-load"],
    SR1: ["boundary-discipline"],
    S4: ["experience-first"],
    S5: ["laziness-protocol", "migrate-callers-then-delete-legacy-apis", "fix-root-causes"],
    S6: ["prove-it-works"],
  },
  design: { S1: ["exhaust-the-design-space", "experience-first"], S2: ["experience-first"], S3: ["experience-first"], S4: ["sequence-verifiable-units"] },
  // ORC-028: S3 revises the report with the investigator's two; the lead's step moved to S4.
  investigation: { S1: ["fix-root-causes", "prove-it-works"], S2: ["prove-it-works"], S3: ["fix-root-causes", "prove-it-works"], S4: ["fix-root-causes"] },
  goal: { S1: ["foundational-thinking", "sequence-verifiable-units"], S2: ["prove-it-works"] },
  revert: { S1: ["laziness-protocol"], S2: ["laziness-protocol", "test-behavior-not-implementation", "migrate-callers-then-delete-legacy-apis", "minimize-reader-load"], SR1: ["boundary-discipline"], S3: ["prove-it-works"] },
  "delivery-review": { S1: ["laziness-protocol", "test-behavior-not-implementation", "migrate-callers-then-delete-legacy-apis", "minimize-reader-load"], SR1: ["boundary-discipline"] },
  "delivery-checks": {},
};
const CHECK_ROUND = { fix: ["laziness-protocol", "migrate-callers-then-delete-legacy-apis", "fix-root-causes"], review: ["laziness-protocol", "test-behavior-not-implementation", "migrate-callers-then-delete-legacy-apis", "minimize-reader-load"], security: ["boundary-discipline"], checks: [] };

/** An agent run's recorded set is "contextualize and write for the reader" plus its step's own (table order puts it first). */
const run = (ids: string[]) => orderPrinciples([...EVERY_RUN_PRINCIPLE_IDS, ...ids]);
const SOURCE_RE = /^pstack principle-[a-z-]+, MIT, Copyright \(c\) 2026 Lauren Tan, github\.com\/cursor\/plugins at 12d587d, adapted$/;

describe("the compiled principles", () => {
  it("16, in table order, each with a name, a one-line apply-when, a body of at most 200 words, a hash and a source: pstack and the commit, or Orchestrator's own", () => {
    expect(PRINCIPLES.map((p) => p.id)).toEqual([...PRINCIPLE_IDS]);
    expect(PRINCIPLES).toHaveLength(16);
    for (const p of PRINCIPLES) {
      expect(p.name.length, p.id).toBeGreaterThan(3);
      expect(p.applyWhen, p.id).not.toMatch(/\n/);
      expect(wordCount(p.applyWhen), p.id).toBeLessThanOrEqual(25);
      expect(wordCount(p.body), p.id).toBeLessThanOrEqual(PRINCIPLE_BODY_WORDS);
      if (p.id === "contextualize-and-write-for-the-reader") expect(p.source).toMatch(/^Orchestrator's own, from the owner's direction \(2026-10-01\)/);
      else {
        expect(p.source, p.id).toMatch(SOURCE_RE);
        expect(p.source, p.id).toContain(`principle-${p.id}`);
      }
      expect(PSTACK_COMMIT.startsWith("12d587d")).toBe(true);
      expect(p.hash, p.id).toMatch(/^[0-9a-f]{64}$/);
      expect(principle(p.id)).toBe(p);
      // Plain voice, and no leftovers from the sources: no links, no sub-agents, no tool names.
      expect(p.body, p.id).not.toMatch(/\]\(|SKILL\.md|sub-?agent|subagent/i);
      // "pattern" is the product's retired word for a flow; the bodies use other words.
      expect(p.body, p.id).not.toMatch(/pattern/i);
    }
    expect(principle("not-a-principle")).toBeUndefined();
    // The spec's extra rule for one of them: internal code only; external callers are reported, not broken.
    const migrate = principle("migrate-callers-then-delete-legacy-apis")!;
    expect(migrate.body).toContain("Internal code that your change replaced");
    expect(migrate.body).toMatch(/external caller.*report/i);
    // "Attack the premise" in general terms: what each failed fix assumed and what still failed; the factor present every time.
    const premise = principle(PREMISE_ID)!;
    expect(premise.body).toContain("list what each failed fix assumed and what still failed");
    expect(premise.body).toContain("the factor present every time");
    expect(premise.body).not.toMatch(/census|\bactors?\b/i);
    expect(LEAD_PRINCIPLE_IDS).toEqual(["contextualize-and-write-for-the-reader", "experience-first", "sequence-verifiable-units", "never-block-on-the-human", "encode-lessons-in-structure"]);
    expect(EVERY_RUN_PRINCIPLE_IDS).toEqual(["contextualize-and-write-for-the-reader"]);
  });

  it("the parser refuses a missing frontmatter, a wrong id, an unknown or repeated field, a missing field, a multi-line applyWhen and a long body, naming the file", () => {
    const ok = "---\nid: x\nname: X\napplyWhen: when\nsource: pstack principle-x, MIT\n---\n\nBody.\n";
    expect(parsePrincipleFile("principles/x.md", ok)).toEqual({ id: "x", name: "X", applyWhen: "when", source: "pstack principle-x, MIT", body: "Body.", hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(parsePrincipleFile("principles/x.md", ok.replace(/\n/g, "\r\n")).body).toBe("Body.");
    expect(() => parsePrincipleFile("principles/x.md", "no frontmatter")).toThrow(/^principles\/x\.md: expected a --- frontmatter/);
    expect(() => parsePrincipleFile("principles/y.md", ok)).toThrow(/named "y" but declares the id "x"/);
    expect(() => parsePrincipleFile("principles/x.md", ok.replace("name: X", "name: X\nextra: 1"))).toThrow(/unknown frontmatter field "extra"/);
    expect(() => parsePrincipleFile("principles/x.md", ok.replace("name: X", "name: X\nname: Y"))).toThrow(/appears twice/);
    expect(() => parsePrincipleFile("principles/x.md", ok.replace("name: X\n", ""))).toThrow(/needs "name"/);
    expect(() => parsePrincipleFile("principles/x.md", ok.replace("name: X", "nonsense line"))).toThrow(/unreadable frontmatter line/);
    expect(() => parsePrincipleFile("principles/x.md", ok.replace("Body.", ""))).toThrow(/body is empty/);
    expect(() => parsePrincipleFile("principles/x.md", ok.replace("Body.", Array(201).fill("w").join(" ")))).toThrow(/201 words; at most 200/);
    expect(() => parsePrincipleFile("principles/x.md", ok.replace("Body.", Array(200).fill("w").join(" ")))).not.toThrow();
  });

  it("wordCount counts runs of non-space characters; the hash is of the body alone", () => {
    expect(wordCount("  one two\n\nthree  ")).toBe(3);
    expect(wordCount("")).toBe(0);
    const a = parsePrincipleFile("principles/x.md", "---\nid: x\nname: X\napplyWhen: a\nsource: s\n---\nBody.");
    const b = parsePrincipleFile("principles/x.md", "---\nid: x\nname: Other\napplyWhen: b\nsource: t\n---\n\nBody.\n\n");
    expect(a.hash).toBe(b.hash);
    expect(parsePrincipleFile("principles/x.md", "---\nid: x\nname: X\napplyWhen: a\nsource: s\n---\nBody!").hash).not.toBe(a.hash);
  });
});

describe("the mapping", () => {
  it("every built-in, internal and check-round step carries exactly the table's principles; checks steps and Goal S3 get none", () => {
    const seen: string[] = [];
    for (const p of [...builtInCatalog(), ...INTERNAL_FLOWS]) {
      for (const st of p.steps) {
        seen.push(`${p.id} ${st.id}`);
        expect(stepPrinciples(st), `${p.id} ${st.id}`).toEqual(TABLE[p.id][st.id] ?? []);
        expect(st.principles, `${p.id} ${st.id}`).toEqual(TABLE[p.id][st.id]);
      }
    }
    expect(seen).toContain("goal S3");
    expect(seen.filter((x) => x.startsWith("delivery-checks"))).toEqual(["delivery-checks S1"]);
    // Every step the table names exists.
    for (const [flow, steps] of Object.entries(TABLE)) for (const id of Object.keys(steps)) expect(seen, `${flow} ${id}`).toContain(`${flow} ${id}`);
    // The raw files carry the field as written, in table order and without a duplicate.
    for (const f of BUILT_IN_FILES) for (const st of f.raw.steps) expect(st.principles, `${f.file} ${st.id}`).toEqual(TABLE[f.raw.id][st.id]);
    // Every named id is one of the 15.
    for (const ids of Object.values(TABLE).flatMap((x) => Object.values(x))) for (const id of ids) expect(PRINCIPLE_IDS).toContain(id);
    // "Attack the premise" is given to no step directly.
    expect(Object.values(TABLE).flatMap((x) => Object.values(x).flat())).not.toContain(PREMISE_ID);
  });

  it("a check round's fix, review and security review carry the repair's and the reviews' principles; its checks step none", () => {
    const { s, id } = blockedFinal();
    const d = s.decisions.find((x) => x.kind === "final-checks")!;
    const r = F.decideFinding(s, d.id, "fix", undefined, at(50));
    expect(step(r, id, "C2-r1-fix").principles).toEqual(CHECK_ROUND.fix);
    expect(step(r, id, "C2-r1-review").principles).toEqual(CHECK_ROUND.review);
    expect(step(r, id, "C2-r1-security").principles).toEqual(CHECK_ROUND.security);
    expect(step(r, id, "C2-r1-checks").principles).toBeUndefined();
  });

  it("the resolver refuses an unknown id and a repeated one, naming the file and the step; the pipeline rules refuse an unknown id and principles on a Checks step", () => {
    const base = BUILT_IN_FILES.find((f) => f.raw.id === "change")!.raw;
    const file = (steps: RawFlow["steps"]): FlowFile => ({ file: "flows/xx.json", raw: { ...structuredClone(base), id: "xx", steps } });
    const withS1 = (over: Partial<RawFlow["steps"][number]>) => structuredClone(base.steps).map((s) => (s.id === "S1" ? { ...s, ...over } : s));
    expect(() => resolveFlows([...BUILT_IN_FILES, file(withS1({ principles: ["laziness-protocol", "be-nice"] }))])).toThrow(/^flows\/xx\.json: S1 names principles that do not exist: be-nice/);
    expect(() => resolveFlows([...BUILT_IN_FILES, file(withS1({ principles: ["laziness-protocol", "laziness-protocol"] }))])).toThrow(/flows\/xx\.json: S1 names a principle twice/);
    expect(resolveFlows([...BUILT_IN_FILES, file(withS1({ principles: ["prove-it-works", "laziness-protocol"] }))]).find((p) => p.id === "xx")!.steps[0].principles).toEqual(["laziness-protocol", "prove-it-works"]);
    const defs = builtInCatalog().find((p) => p.id === "change")!.steps;
    expect(validatePipeline(defs.map((s) => (s.id === "S1" ? { ...s, principles: ["nope"] } : s))).map((i) => i.message)).toEqual(['S1 names a principle that does not exist: "nope".']);
    expect(validatePipeline(defs.map((s) => (s.id === "C1" ? { ...s, principles: ["prove-it-works"] } : s))).map((i) => i.message)).toEqual(["C1 is a Checks step, run by the service; it takes no principles."]);
    expect(validatePipeline(defs)).toEqual([]);
  });

  it("toDef keeps the principles in table order without duplicates and drops an empty list; the flow hash and the structural key cover them", () => {
    const s1: StepDef = { id: "S1", purpose: "Implement", role: "coder", dependsOn: [], inputs: [], outputs: [{ name: "change", kind: "code-change" }] };
    expect(toDef({ ...s1, principles: ["prove-it-works", "laziness-protocol", "prove-it-works"] }).principles).toEqual(["laziness-protocol", "prove-it-works"]);
    expect(toDef({ ...s1, principles: [] })).not.toHaveProperty("principles");
    expect(toDef(s1)).not.toHaveProperty("principles");
    expect(orderPrinciples(["encode-lessons-in-structure", "exhaust-the-design-space", "unknown"])).toEqual(["exhaust-the-design-space", "encode-lessons-in-structure"]);
    const change = builtInCatalog().find((p) => p.id === "change")!;
    const stripped = change.steps.map(({ principles: _p, ...s }) => s);
    expect(flowHash(stripped)).not.toBe(change.hash);
    expect(flowHash(change.steps.map((s) => (s.id === "S1" ? { ...s, principles: [...s.principles!].reverse() } : s)))).toBe(change.hash);
    expect(structuralKey(change.steps[0])).not.toBe(structuralKey(stripped[0]));
    expect(structuralKey(change.steps[0])).toBe(structuralKey({ ...change.steps[0], principles: [...change.steps[0].principles!].reverse() }));
    // The catalog in a fresh state carries the new hashes.
    expect(buildSeed(T0, { inFlightRuns: false }).flows.find((p) => p.id === "change")!.hash).toBe(change.hash);
  });
});

// ---------- the automatic "attack the premise" ----------

let n = 0;
/** A finding with the carry-forward identity the parser would give it (file, normalised title, severity), so a repeat in a later round is recognised. */
function finding(over: Partial<Finding> = {}): Finding {
  n += 1;
  const f: Omit<Finding, "key"> = { id: `F${n}`, source: "review", severity: "error", action: "auto-fix", title: `Finding ${n}`, detail: "what is wrong", ...over };
  const text = `${f.severity}|${f.file ?? ""}|${f.title.toLowerCase().replace(/\s+/g, " ").trim()}`;
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return { ...f, key: h.toString(16).padStart(12, "0") };
}
const cmd = (id: string, argv: string[], kind: "prepare" | "check" = "check") => ({ id, label: id, kind, argv });
const cfg = (over: Partial<ChecksConfig> = {}): ChecksConfig => ({ ...structuredClone(DEFAULT_CHECKS), enabled: true, commands: [cmd("test", ["npm", "test"]), cmd("lint", ["npm", "run", "lint"])], ...over });
const result = (id: string, status: "passed" | "failed") => ({ id, label: id, kind: "check" as const, status, ...(status === "failed" ? { exitCode: 1 } : {}), durationMs: 1000, excerpt: status === "failed" ? "1 failing" : "ok", bytes: 2, truncated: false });
const record = (sha: string, failing: string[]): CheckRunRecord => ({ sha, configRev: 1, sandbox: "codex", touchedInputs: [], results: ["test", "lint"].map((id) => result(id, failing.includes(id) ? "failed" : "passed")), durationMs: 2000 });

/** A Change task with checks on, its implementation done; C1 is running. */
function withChecks(flowId = "change"): { s: State; id: string } {
  let s = buildSeed(T0, { inFlightRuns: false });
  for (const t of s.tasks) t.hold = true;
  s = { ...s, project: { ...s.project, checks: { ...cfg(), rev: 1 }, checksHealth: { sandbox: "codex", status: "ready", detail: "ok", checkedAt: at(0) } } };
  const r = M.createTask(s, { title: "T", area: "A", outcome: "o", benefit: "b", whyNow: "", approach: "a", acceptance: ["ok"], priority: 1, holdBeforeStart: false, flowId }, at(0));
  s = M.dispatchEligible(M.leadPromoteProposals(r.state, at(1)), at(1));
  const impl = running(s, r.newId)[0];
  s = M.reportCompletion(s, impl.id, [], at(2), [{ name: "change", summary: "done", ref: `${SHA} on b` }, { name: "handoff", summary: "h" }]);
  s = M.dispatchEligible(s, at(3));
  return { s, id: r.newId };
}

const finishChecks = (s: State, id: string, t: number, rec: CheckRunRecord) => {
  const a = running(s, id).find((x) => x.snapshot.provider === "service")!;
  return M.reportCompletion(s, a.id, [], at(t), [{ name: step(s, id, a.stepId).outputs[0].name, summary: C.runSummary(rec), checkRun: rec, findings: C.findingsFromRun(rec, a.snapshot.checks!.commands) }]);
};

/** Complete every running review of the task: the code review with `codeFindings`, the security review clean. */
function finishReviews(s: State, id: string, t: number, codeFindings: Finding[] = []): State {
  let next = M.dispatchEligible(s, at(t));
  for (const a of running(next, id)) {
    const role = step(next, id, a.stepId).role;
    if (role === "code_reviewer") {
      next = M.reportRunContext(next, a.id, { scope: { from: SHA2, to: SHA, paths: ["a"], total: 1 } });
      next = M.reportCompletion(next, a.id, [], at(t), [{ name: "findings", summary: codeFindings.length ? "issues" : "clean", findings: codeFindings, reviewedPaths: ["a"] }]);
    } else if (role === "security_reviewer") next = M.reportCompletion(next, a.id, [], at(t), [{ name: "findings", summary: "no security findings", findings: [], reviewedPaths: ["a"] }]);
  }
  return M.dispatchEligible(next, at(t));
}

/** One loop round from a running checks step: the checks (failing `failing`), the reviews (the code review with `codeFindings`), then the repair is running or skipped. */
function round(s: State, id: string, t: number, failing: string[], codeFindings: Finding[] = [], sha = SHA): State {
  let next = finishChecks(s, id, t, record(sha, failing));
  next = finishReviews(next, id, t + 1, codeFindings);
  return next;
}

/** The repair completes with a new commit; the next round's checks start. */
function repair(s: State, id: string, t: number, sha: string): State {
  const a = running(s, id).find((x) => step(s, id, x.stepId).role === "coder")!;
  return M.dispatchEligible(M.reportCompletion(s, a.id, [], at(t), [{ name: "change", summary: "fixed", ref: `${sha} on b` }]), at(t));
}

/** The loop ran out with `test` failing every round; C2 is blocked with a decision. */
function blockedFinal(): { s: State; id: string } {
  let { s, id } = withChecks();
  s = round(s, id, 4, ["test"]);
  s = repair(s, id, 6, SHA2);
  s = round(s, id, 7, ["test"], [], SHA2);
  s = repair(s, id, 9, SHA3);
  s = round(s, id, 10, ["test"], [], SHA3);
  s = repair(s, id, 12, SHA3);
  // C2 either reused the loop's failing run on the same commit (and blocked at once) or runs now and fails again.
  if (step(s, id, "C2").state !== "blocked") s = finishChecks(s, id, 13, record(SHA3, ["test"]));
  expect(step(s, id, "C2").state).toBe("blocked");
  return { s, id };
}

describe("the automatic 'attack the premise'", () => {
  it("a first repair gets the step's own principles, each with the hash of its body, and no automatic one", () => {
    let { s, id } = withChecks();
    s = round(s, id, 4, ["test"]);
    const first = running(s, id)[0];
    expect(first.stepId).toBe("S3");
    expect(first.snapshot.principles).toEqual(run(TABLE.change.S3).map((pid) => ({ id: pid, hash: principle(pid)!.hash })));
    expect(first.snapshot.principles!.some((p) => p.added)).toBe(false);
    expect(M.premiseReason(s, task(s, id), step(s, id, "S3"))).toBeUndefined();
    // The implementation's run recorded its own set too; the check run none.
    const impl = s.attempts.find((a) => a.taskId === id && a.stepId === "S1")!;
    expect(impl.snapshot.principles!.map((p) => p.id)).toEqual(run(TABLE.change.S1));
    expect(s.attempts.find((a) => a.taskId === id && a.stepId === "C1")!.snapshot.principles).toBeUndefined();
  });

  it("is added for a same-check failure in round 2, with the check named; round 3 names the previous repair", () => {
    let { s, id } = withChecks();
    s = round(s, id, 4, ["test"]);
    s = repair(s, id, 6, SHA2);
    s = round(s, id, 7, ["test"], [], SHA2);
    const second = running(s, id)[0];
    expect(second.stepId).toBe("S3-i2");
    // Table order: laziness, migrate, fix-root-causes, then attack-the-premise, which the table lists after fix-root-causes.
    expect(second.snapshot.principles).toEqual(run([...TABLE.change.S3, PREMISE_ID]).map((pid) => ({ id: pid, hash: principle(pid)!.hash, ...(pid === PREMISE_ID ? { added: "added: check `test` failed again after S3" } : {}) })));
    expect(second.snapshot.principles!.map((p) => p.id)).toEqual(["contextualize-and-write-for-the-reader", "laziness-protocol", "migrate-callers-then-delete-legacy-apis", "fix-root-causes", PREMISE_ID]);
    s = repair(s, id, 9, SHA3);
    s = round(s, id, 10, ["test", "lint"], [], SHA3);
    const third = running(s, id)[0];
    expect(third.stepId).toBe("S3-i3");
    expect(third.snapshot.principles!.find((p) => p.id === PREMISE_ID)!.added).toBe("added: check `test` failed again after S3-i2");
  });

  it("is not added when every failure is new: another check, another finding", () => {
    let { s, id } = withChecks();
    s = round(s, id, 4, ["test"], [finding({ title: "Null check", file: "src/a.ts", line: 3 })]);
    s = repair(s, id, 6, SHA2);
    s = round(s, id, 7, ["lint"], [finding({ title: "Unused import", file: "src/a.ts", line: 1 })], SHA2);
    const second = running(s, id)[0];
    expect(second.stepId).toBe("S3-i2");
    expect(second.snapshot.principles!.map((p) => p.id)).toEqual(run(TABLE.change.S3));
    expect(M.premiseReason(s, task(s, id), step(s, id, "S3-i2"))).toBeUndefined();
  });

  it("is added for a returning finding: same file and normalised title, open in both rounds; a settled one does not count", () => {
    let { s, id } = withChecks();
    s = round(s, id, 4, [], [finding({ title: "Invite links are not scoped to the trip", file: "src/invite.ts", line: 3 }), finding({ title: "Accept me", action: "ask-user" })]);
    const ds = F.decisionsOf(s, id);
    s = F.decideFinding(s, ds.find((d) => d.finding.title === "Accept me")!.id, "accept", "by design", at(5));
    s = M.dispatchEligible(s, at(5));
    expect(running(s, id)[0].stepId).toBe("S3");
    s = repair(s, id, 6, SHA2);
    // The same finding, differently spaced and cased, at another line, plus the accepted one again.
    s = round(s, id, 7, [], [finding({ title: "  invite links are NOT scoped to the trip ", file: "src/invite.ts", line: 9 }), finding({ title: "Accept me", action: "ask-user" })], SHA2);
    const second = running(s, id)[0];
    expect(second.stepId).toBe("S3-i2");
    expect(second.snapshot.principles!.find((p) => p.id === PREMISE_ID)!.added).toBe('added: the finding "  invite links are NOT scoped to the trip " came back after S3');
  });

  it("is not added when the finding came back in another file, and the reason lists at most five", () => {
    let { s, id } = withChecks();
    s = round(s, id, 4, [], [finding({ title: "Null check", file: "src/a.ts" })]);
    s = repair(s, id, 6, SHA2);
    s = round(s, id, 7, [], [finding({ title: "Null check", file: "src/b.ts" })], SHA2);
    expect(running(s, id)[0].stepId).toBe("S3-i2");
    expect(M.premiseReason(s, task(s, id), step(s, id, "S3-i2"))).toBeUndefined();
    // Seven returning findings: five named, two counted.
    let { s: s2, id: id2 } = withChecks();
    const seven = () => Array.from({ length: 7 }, (_, i) => finding({ title: `Problem ${i}`, file: "src/x.ts" }));
    s2 = round(s2, id2, 4, [], seven());
    s2 = repair(s2, id2, 6, SHA2);
    s2 = round(s2, id2, 7, [], seven(), SHA2);
    const reason = M.premiseReason(s2, task(s2, id2), step(s2, id2, "S3-i2"))!;
    expect(reason).toMatch(/^added: the finding "Problem 0" came back after S3; .*"Problem 4" came back after S3; and 2 more$/);
    expect(reason).not.toContain("Problem 5");
  });

  it("is added for Design S3's next iteration when the same UX finding returns, and not when the finding is new", () => {
    const design = (title2: string) => {
      let s = buildSeed(T0, { inFlightRuns: false });
      for (const t of s.tasks) t.hold = true;
      const r = M.createTask(s, { title: "D", area: "A", outcome: "o", benefit: "b", whyNow: "", approach: "a", acceptance: ["ok"], priority: 1, holdBeforeStart: false, flowId: "design" }, at(0));
      const id = r.newId;
      s = M.dispatchEligible(M.leadPromoteProposals(r.state, at(1)), at(1));
      s = M.reportCompletion(s, running(s, id)[0].id, [], at(2), [{ name: "design", summary: "the design" }]);
      s = M.dispatchEligible(s, at(3));
      expect(running(s, id)[0].stepId).toBe("S2");
      s = M.reportCompletion(s, running(s, id)[0].id, [], at(4), [{ name: "findings", summary: "one", findings: [finding({ title: "The empty state has no next step", file: "design.md" })], reviewedPaths: [] }]);
      s = M.dispatchEligible(s, at(5));
      const revise = running(s, id)[0];
      expect(revise.stepId).toBe("S3");
      expect(revise.snapshot.principles!.map((p) => p.id)).toEqual(["contextualize-and-write-for-the-reader", "experience-first"]);
      s = M.reportCompletion(s, revise.id, [], at(6), [{ name: "design", summary: "revised" }]);
      s = M.dispatchEligible(s, at(7));
      expect(running(s, id)[0].stepId).toBe("S2-i2");
      s = M.reportCompletion(s, running(s, id)[0].id, [], at(8), [{ name: "findings", summary: "again", findings: [finding({ title: title2, file: "design.md" })], reviewedPaths: [] }]);
      s = M.dispatchEligible(s, at(9));
      const again = running(s, id)[0];
      expect(again.stepId).toBe("S3-i2");
      return again.snapshot.principles!;
    };
    expect(design("The empty state has no next step")).toEqual([
      { id: "contextualize-and-write-for-the-reader", hash: principle("contextualize-and-write-for-the-reader")!.hash },
      { id: "experience-first", hash: principle("experience-first")!.hash },
      { id: PREMISE_ID, hash: principle(PREMISE_ID)!.hash, added: 'added: the finding "The empty state has no next step" came back after S3' },
    ]);
    expect(design("The error copy blames the user").map((p) => p.id)).toEqual(["contextualize-and-write-for-the-reader", "experience-first"]);
  });

  it("a check-round fix after a round that failed the same check gets it; the first round's fix gets it when the loop's last repair failed the same check", () => {
    const { s: blocked, id } = blockedFinal();
    // The loop's own repairs: S3 had none, S3-i2 and S3-i3 had it.
    const loopRepairs = blocked.attempts.filter((a) => a.taskId === id && /^S3/.test(a.stepId)).map((a) => [a.stepId, a.snapshot.principles!.find((p) => p.id === PREMISE_ID)?.added]);
    expect(loopRepairs).toEqual([
      ["S3", undefined],
      ["S3-i2", "added: check `test` failed again after S3"],
      ["S3-i3", "added: check `test` failed again after S3-i2"],
    ]);
    const d1 = blocked.decisions.find((x) => x.kind === "final-checks" && x.status === "open")!;
    let s = M.dispatchEligible(F.decideFinding(blocked, d1.id, "fix", undefined, at(50)), at(50));
    const fix1 = running(s, id)[0];
    expect(fix1.stepId).toBe("C2-r1-fix");
    expect(fix1.snapshot.principles).toEqual(run([...CHECK_ROUND.fix, PREMISE_ID]).map((pid) => ({ id: pid, hash: principle(pid)!.hash, ...(pid === PREMISE_ID ? { added: "added: check `test` failed again after S3-i3" } : {}) })));
    s = M.reportCompletion(s, fix1.id, [], at(51), [{ name: "change", summary: "f", ref: `${"d".repeat(40)} on b` }, { name: "handoff", summary: "h" }]);
    s = finishReviews(s, id, 52);
    expect(running(s, id)[0].stepId).toBe("C2-r1-checks");
    s = finishChecks(s, id, 53, record("d".repeat(40), ["test"]));
    const d2 = s.decisions.filter((x) => x.kind === "final-checks" && x.status === "open").pop()!;
    s = M.dispatchEligible(F.decideFinding(s, d2.id, "fix", undefined, at(54)), at(54));
    const fix2 = running(s, id)[0];
    expect(fix2.stepId).toBe("C2-r1-checks-r2-fix");
    expect(fix2.snapshot.principles).toEqual(run([...CHECK_ROUND.fix, PREMISE_ID]).map((pid) => ({ id: pid, hash: principle(pid)!.hash, ...(pid === PREMISE_ID ? { added: "added: check `test` failed again after C2-r1-fix" } : {}) })));
  });

  it("a run from before principles recorded none, and nothing is invented for it; a step from before principles gives its runs none", () => {
    const s = buildSeed(T0, { inFlightRuns: true });
    // The seed's own runs are written by hand, as runs from before the field: none carries principles.
    expect(s.attempts.length).toBeGreaterThan(0);
    for (const a of s.attempts) expect(a.snapshot.principles, a.id).toBeUndefined();
    // A task whose copied steps have no principles (an older task): its new runs record an empty list.
    let { s: old, id } = withChecks();
    for (const st of task(old, id).steps) delete st.principles;
    old = round(old, id, 4, ["test"]);
    const repairRun = running(old, id)[0];
    expect(repairRun.stepId).toBe("S3");
    expect(repairRun.snapshot.principles).toEqual([]);
    expect(stepPrinciples(step(old, id, "S3"))).toEqual([]);
    // Not even the automatic one, when its second repair fails the same check.
    old = repair(old, id, 6, SHA2);
    old = round(old, id, 7, ["test"], [], SHA2);
    const second = running(old, id)[0];
    expect(second.stepId).toBe("S3-i2");
    expect(second.snapshot.principles).toEqual([]);
  });

  it("a flow step that names 'attack the premise' itself keeps it without a reason; the trigger adds nothing twice", () => {
    let { s, id } = withChecks();
    for (const st of task(s, id).steps) if (st.id === "S3") st.principles = [...st.principles!, PREMISE_ID];
    s = round(s, id, 4, ["test"]);
    expect(running(s, id)[0].snapshot.principles!.filter((p) => p.id === PREMISE_ID)).toEqual([{ id: PREMISE_ID, hash: principle(PREMISE_ID)!.hash }]);
    s = repair(s, id, 6, SHA2);
    s = round(s, id, 7, ["test"], [], SHA2);
    const second = running(s, id)[0];
    expect(second.stepId).toBe("S3-i2");
    expect(second.snapshot.principles!.filter((p) => p.id === PREMISE_ID)).toEqual([{ id: PREMISE_ID, hash: principle(PREMISE_ID)!.hash }]);
  });
});
