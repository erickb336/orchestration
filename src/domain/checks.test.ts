// ORC-013 step 2, pure: the checks configuration and its validation (commands come only from the user's
// settings, argv only, an allowlist of programs), the suggestions, what a Checks step checks and when
// an earlier run is reused, the findings a run becomes, the repair rounds after failing final checks,
// the evidence a change has, and the merge-gate item. No process is started anywhere here.

import { describe, expect, it } from "vitest";
import * as C from "./checks";
import { runCommand } from "./commands";
import * as D from "./delivery";
import * as F from "./findings";
import * as M from "./model";
import { validatePipeline } from "./pipeline";
import { buildSeed } from "./seed";
import { ControlError, DEFAULT_CHECKS, type CheckRunRecord, type ChecksConfig, type State } from "./types";

const T0 = Date.parse("2026-09-30T12:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const task = (s: State, id: string) => s.tasks.find((t) => t.id === id)!;
const step = (s: State, id: string, stepId: string) => task(s, id).steps.find((x) => x.id === stepId)!;
const running = (s: State, id: string) => M.activeAttempts(s, id);
const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);
const cmd = (id: string, argv: string[], kind: "prepare" | "check" = "check") => ({ id, label: id, kind, argv });
const cfg = (over: Partial<ChecksConfig> = {}): ChecksConfig => ({ ...structuredClone(DEFAULT_CHECKS), enabled: true, commands: [cmd("test", ["npm", "test"])], ...over });
const ok = (c: ChecksConfig) => expect(C.validateChecks(c, { acknowledged: true })).toBeUndefined();
const bad = (c: ChecksConfig, re: RegExp) => expect(C.validateChecks(c, { acknowledged: true })).toMatch(re);

describe("validateChecks (§6.1)", () => {
  it("accepts the allowlisted programs and refuses everything else, exactly by name", () => {
    for (const p of ["npm", "pnpm", "yarn", "bun", "make", "cargo", "go", "pytest", "./gradlew", "tsc", "vitest"]) ok(cfg({ commands: [cmd("c", p === "npm" || p === "pnpm" || p === "yarn" || p === "bun" ? [p, "test"] : [p, "build"])] }));
    for (const p of ["sh", "bash", "zsh", "env", "sudo", "curl", "wget", "npx", "git", "gh", "/usr/bin/node", "./node_modules/.bin/vitest", "NPM", "node.exe"]) bad(cfg({ commands: [cmd("c", [p, "x"])] }), /is not one of the programs checks may run/);
  });

  it("package managers may only install (prepare) or test and run scripts (check); interpreters may not run inline code or preloads", () => {
    ok(cfg({ commands: [cmd("i", ["npm", "ci", "--ignore-scripts"], "prepare"), cmd("t", ["npm", "test"]), cmd("l", ["pnpm", "run", "lint"]), cmd("b", ["yarn", "run-script", "build"])] }));
    for (const sub of ["exec", "x", "publish", "login", "config", "token", "install"]) bad(cfg({ commands: [cmd("c", ["npm", sub])] }), /not allowed|is "npm test"/);
    for (const sub of ["test", "run", "publish"]) bad(cfg({ commands: [cmd("c", ["npm", sub], "prepare")] }), /prepare command with npm is/);
    ok(cfg({ commands: [cmd("py", ["python3", "-m", "pytest"]), cmd("n", ["node", "scripts/check.mjs"])] }));
    for (const flag of ["-e", "--eval", "-p", "--print", "-c", "-r", "--require", "--import", "--loader", "--experimental-loader", "--eval=1", "-pe", "--require=x"]) bad(cfg({ commands: [cmd("c", ["node", flag, "x"])] }), /inline code or preload/);
    bad(cfg({ commands: [cmd("c", ["python", "-c", "print(1)"])] }), /inline code/);
  });

  it("shape and limits: ids, labels, argv sizes, NUL and newlines, prepare order and count, timeouts, concurrency, inputs and variable names", () => {
    bad(cfg({ commands: [cmd("Bad Id", ["npm", "test"])] }), /command id is lowercase/);
    bad(cfg({ commands: [{ ...cmd("a", ["npm", "test"]), label: "x".repeat(61) }] }), /label is 1–60/);
    bad(cfg({ commands: [cmd("a", [])] }), /1–32 arguments/);
    bad(cfg({ commands: [cmd("a", ["npm", "run", ...Array.from({ length: 31 }, () => "x")])] }), /1–32 arguments/);
    bad(cfg({ commands: [cmd("a", ["npm", "run", "x".repeat(401)])] }), /1–400 characters/);
    bad(cfg({ commands: [cmd("a", ["npm", "run", "x\ny"])] }), /newline or NUL/);
    bad(cfg({ commands: [cmd("a", ["npm", "run", "x\0y"])] }), /newline or NUL/);
    bad(cfg({ commands: [cmd("a", ["npm", "test"]), cmd("a", ["npm", "test"])] }), /Two commands have the id/);
    bad(cfg({ commands: Array.from({ length: 9 }, (_, i) => cmd(`c${i}`, ["npm", "test"])) }), /At most 8 commands/);
    bad(cfg({ commands: [cmd("t", ["npm", "test"]), cmd("i", ["npm", "ci", "--ignore-scripts"], "prepare")] }), /prepare commands come before/);
    bad(cfg({ commands: [cmd("i1", ["npm", "ci", "--ignore-scripts"], "prepare"), cmd("i2", ["npm", "ci", "--ignore-scripts"], "prepare"), cmd("i3", ["npm", "ci", "--ignore-scripts"], "prepare")] }), /At most 2 prepare/);
    bad(cfg({ commands: [{ ...cmd("a", ["npm", "test"]), timeoutMinutes: 61 }] }), /1–60 minutes/);
    bad(cfg({ commandTimeoutMinutes: 0 }), /per command is 1–60/);
    bad(cfg({ runTimeoutMinutes: 121 }), /per run is 1–120/);
    bad(cfg({ maxConcurrent: 4 }), /Runs at once is 1–3/);
    bad(cfg({ protectedInputs: Array.from({ length: 31 }, (_, i) => `p${i}`) }), /At most 30 protected/);
    bad(cfg({ passEnv: ["lower"] }), /not a variable name/);
    for (const n of ["MY_API_KEY", "GH_TOKEN", "DB_PASSWORD", "AUTH_THING", "SECRET", "CREDENTIALS"]) bad(cfg({ passEnv: [n] }), /looks like a secret/);
    for (const n of ["PATH", "HOME", "NODE_OPTIONS", "LD_PRELOAD", "DYLD_LIBRARY_PATH"]) bad(cfg({ passEnv: [n] }), /set by the service itself/);
    ok(cfg({ passEnv: ["CI_PROJECT", "RUSTFLAGS"] }));
  });

  it('"none" needs the acknowledgement; the setChecks command carries it, and a sandbox already chosen as "none" needs no second one', () => {
    expect(C.validateChecks(cfg({ sandbox: "none" }))).toMatch(/needs your explicit confirmation/);
    expect(C.validateChecks(cfg({ sandbox: "none" }), { acknowledged: true })).toBeUndefined();
    const s0 = buildSeed(T0, { inFlightRuns: false });
    const config = { ...cfg({ sandbox: "none" }), rev: undefined };
    delete (config as { rev?: number }).rev;
    expect(() => runCommand(s0, "setChecks", { config }, at(1))).toThrow(/explicit confirmation/);
    const on = runCommand(s0, "setChecks", { config, acknowledgeUnsandboxed: true }, at(1)).state;
    expect(on.project.checks).toMatchObject({ enabled: true, sandbox: "none", rev: 1 });
    // Already "none": editing the commands does not need the confirmation again.
    const edited = runCommand(on, "setChecks", { config: { ...config, commands: [cmd("lint", ["npm", "run", "lint"])] } }, at(2)).state;
    expect(edited.project.checks.rev).toBe(2);
  });
});

describe("the user's settings (§9, Q1)", () => {
  const s0 = buildSeed(T0, { inFlightRuns: false });
  const input = (over: Partial<ChecksConfig> = {}) => {
    const c: Partial<ChecksConfig> = { ...cfg(over) };
    delete c.rev;
    return c;
  };

  it("only setChecks writes the commands: no lead decision, worker output or other command touches them (mutation check: the command registry has one entry for them)", () => {
    const on = runCommand(s0, "setChecks", { config: input() }, at(1)).state;
    expect(on.project.checks).toMatchObject({ enabled: true, rev: 1, commands: [cmd("test", ["npm", "test"])] });
    expect(on.events.at(-1)!.message).toContain("test: npm test");
    expect(on.events.at(-1)!.actor).toBe("user");
    // A lead run's output cannot reach the settings: the lead output contract has no field for them, and the
    // completion applies only reply, proposals, steering, vision, coverage, questions and decisions.
    const r = M.startLeadRun(on, { provider: "claude", model: "claude-sample-large", trigger: "planning" }, at(2));
    const done = M.completeLeadRun(r.state, r.runId, { reply: "x", proposals: [], ...({ checks: { enabled: false, commands: [] } } as object) }, at(3));
    expect(done.project.checks).toEqual(on.project.checks);
    // An agent's completion report cannot either: reportCompletion reads outputs, never settings.
    expect(M.reportCompletion(on, "run-none", [], at(4), [{ name: "x", summary: "y", ...({ checks: { commands: [] } } as object) }]).project.checks).toEqual(on.project.checks);
    // Switching on marks the sandbox for a probe; the revision only moves on a real change.
    expect(on.project.checksHealth).toMatchObject({ sandbox: "codex", status: "unverified", recheck: true });
    expect(runCommand(on, "setChecks", { config: input() }, at(5)).state.project.checks.rev).toBe(1);
    expect(runCommand(on, "setChecks", { config: input({ commandTimeoutMinutes: 5 }) }, at(5)).state.project.checks.rev).toBe(2);
    // Off never turns anything else on; recheck asks for a probe.
    expect(runCommand(on, "setChecks", { config: input({ enabled: false }) }, at(6)).state.project.checks.enabled).toBe(false);
    expect(runCommand(on, "recheckChecks", {}, at(7)).state.project.checksHealth?.recheck).toBe(true);
    expect(M.applyAutopilot(s0, "main", at(8)).project.checks.enabled).toBe(false);
    expect(() => runCommand(on, "setChecks", { config: { ...input(), commands: [cmd("x", ["sh", "-c", "rm -rf /"])] } }, at(9))).toThrow(ControlError);
  });

  it("a settings change stops active check runs for revision and bumps their step, so a late result is discarded and the step runs again", () => {
    let s = runCommand(s0, "setChecks", { config: input() }, at(1)).state;
    s = C.reportChecksHealth(s, { sandbox: "codex", status: "ready", detail: "ok", checkedAt: at(1) }, at(1));
    for (const t of s.tasks) t.hold = true;
    const r = M.createTask(s, { title: "T", area: "A", outcome: "o", benefit: "b", whyNow: "", approach: "a", acceptance: ["ok"], priority: 1, holdBeforeStart: false, patternId: "change" }, at(2));
    s = M.dispatchEligible(M.leadPromoteProposals(r.state, at(3)), at(3));
    const impl = running(s, r.newId)[0];
    s = M.reportCompletion(s, impl.id, [], at(4), [{ name: "change", summary: "done", ref: `${SHA} on b` }, { name: "handoff", summary: "h" }]);
    s = M.dispatchEligible(s, at(5));
    const check = running(s, r.newId)[0];
    expect(check).toMatchObject({ stepId: "C1", snapshot: { provider: "service", model: "checks", source: "service", checks: { configRev: 1, sandbox: "codex", target: { ref: SHA }, commands: [{ id: "test", argv: ["npm", "test"], timeoutMs: 600_000 }] } } });
    const changed = runCommand(s, "setChecks", { config: input({ commands: [cmd("test", ["npm", "test"]), cmd("lint", ["npm", "run", "lint"])] }) }, at(6)).state;
    expect(running(changed, r.newId)[0]).toMatchObject({ outcome: "stopping", stopReason: "revision" });
    expect(step(changed, r.newId, "C1").revision).toBe(2);
    // A result for the old revision is discarded, never integrated (mutation check: stale results).
    const late = M.reportCompletion(changed, check.id, [], at(7), [{ name: "checks", summary: "x", checkRun: record(SHA) }]);
    expect(late.attempts.find((a) => a.id === check.id)!.outcome).toBe("discarded");
    expect(late.artifacts.some((a) => a.taskId === r.newId && a.kind === "check-results")).toBe(false);
    // Timeouts and inputs count as a change; the label alone does not stop anything.
    expect(running(runCommand(s, "setChecks", { config: input({ protectedInputs: ["x"] }) }, at(6)).state, r.newId)[0].outcome).toBe("stopping");
    expect(running(runCommand(s, "setChecks", { config: input({ commands: [{ ...cmd("test", ["npm", "test"]), label: "Tests" }] }) }, at(6)).state, r.newId)[0].outcome).toBe("stopping");
  });
});

describe("suggestChecks (§6.2)", () => {
  it("reads this repository's package.json and lockfile into npm ci, typecheck, test and build", () => {
    const pkg = JSON.stringify({ scripts: { dev: "x", build: "tsc", typecheck: "tsc", test: "vitest run", lint: undefined } });
    expect(C.suggestChecks([{ path: "package.json", text: pkg }, { path: "package-lock.json", text: "{}" }])).toEqual([
      { id: "install", label: "Install dependencies", kind: "prepare", argv: ["npm", "ci", "--ignore-scripts"] },
      { id: "typecheck", label: "typecheck", kind: "check", argv: ["npm", "run", "typecheck"] },
      { id: "test", label: "test", kind: "check", argv: ["npm", "test"] },
      { id: "build", label: "build", kind: "check", argv: ["npm", "run", "build"] },
    ]);
  });

  it("pnpm, cargo, go and pytest fixtures; everything suggested passes validation; nothing without evidence", () => {
    const pnpm = C.suggestChecks([{ path: "package.json", text: JSON.stringify({ scripts: { lint: "eslint .", test: "vitest" } }) }, { path: "pnpm-lock.yaml", text: "" }]);
    expect(pnpm.map((c) => c.argv)).toEqual([["pnpm", "install", "--frozen-lockfile", "--ignore-scripts", "--ignore-pnpmfile"], ["pnpm", "run", "lint"], ["pnpm", "test"]]);
    const rust = C.suggestChecks([{ path: "Cargo.toml", text: "[package]" }, { path: "go.mod", text: "module x" }, { path: "pyproject.toml", text: "[tool.pytest.ini_options]" }]);
    expect(rust.map((c) => c.argv)).toEqual([["cargo", "build"], ["cargo", "test"], ["go", "vet", "./..."], ["go", "test", "./..."], ["python3", "-m", "pytest"]]);
    for (const list of [pnpm, rust]) expect(C.validateChecks(cfg({ commands: list }), { acknowledged: true })).toBeUndefined();
    expect(C.suggestChecks([{ path: "package.json", text: "not json" }])).toEqual([]);
    expect(C.suggestChecks([{ path: "pyproject.toml", text: "[tool.black]" }])).toEqual([]);
  });
});

function record(sha: string, over: Partial<CheckRunRecord> = {}): CheckRunRecord {
  return { sha, configRev: 1, sandbox: "codex", touchedInputs: [], results: [{ id: "test", label: "test", kind: "check", status: "passed", exitCode: 0, durationMs: 1000, excerpt: "", bytes: 0, truncated: false }], durationMs: 1000, ...over };
}
const failed = (sha: string, over: Partial<CheckRunRecord> = {}) => record(sha, { results: [{ id: "test", label: "test", kind: "check", status: "failed", exitCode: 1, durationMs: 1000, excerpt: "1 failing", bytes: 9, truncated: false }], ...over });

/** A user task on the Change template with checks on and the sandbox ready; S1 done at SHA; C1 running. */
function withChecks(over: Partial<ChecksConfig> = {}): { s: State; id: string } {
  let s = buildSeed(T0, { inFlightRuns: false });
  for (const t of s.tasks) t.hold = true;
  s = { ...s, project: { ...s.project, checks: { ...cfg(over), rev: 1 }, checksHealth: { sandbox: "codex", status: "ready", detail: "ok", checkedAt: at(0) } } };
  const r = M.createTask(s, { title: "T", area: "A", outcome: "o", benefit: "b", whyNow: "", approach: "a", acceptance: ["ok"], priority: 1, holdBeforeStart: false, patternId: "change" }, at(0));
  s = M.dispatchEligible(M.leadPromoteProposals(r.state, at(1)), at(1));
  const impl = running(s, r.newId)[0];
  s = M.reportCompletion(s, impl.id, [], at(2), [{ name: "change", summary: "done", ref: `${SHA} on b` }, { name: "handoff", summary: "h" }]);
  s = M.dispatchEligible(s, at(3));
  return { s, id: r.newId };
}
const finishRun = (s: State, id: string, t: number, rec: CheckRunRecord) => {
  const a = running(s, id).find((x) => x.snapshot.provider === "service")!;
  const findings = C.findingsFromRun(rec, a.snapshot.checks!.commands);
  return M.reportCompletion(s, a.id, [], at(t), [{ name: task(s, id).steps.find((x) => x.id === a.stepId)!.outputs[0].name, summary: C.runSummary(rec), checkRun: rec, findings }]);
};

describe("dispatch, target and reuse (§6.4)", () => {
  it("checks off: every Checks step skips with the reason; on with no check command: the same; on: C1 runs on the change's commit", () => {
    let s = buildSeed(T0, { inFlightRuns: false });
    for (const t of s.tasks) t.hold = true;
    const r = M.createTask(s, { title: "T", area: "A", outcome: "o", benefit: "b", whyNow: "", approach: "a", acceptance: ["ok"], priority: 1, holdBeforeStart: false, patternId: "change" }, at(0));
    s = M.dispatchEligible(M.leadPromoteProposals(r.state, at(1)), at(1));
    s = M.reportCompletion(s, running(s, r.newId)[0].id, [], at(2), [{ name: "change", summary: "done", ref: `${SHA} on b` }, { name: "handoff", summary: "h" }]);
    const off = M.dispatchEligible(s, at(3));
    expect(step(off, r.newId, "C1").state).toBe("skipped");
    expect(off.events.some((e) => e.message === "Skipped C1: checks are off for this project (Settings → Checks)")).toBe(true);
    expect(M.activeServiceAttempts(off)).toHaveLength(0);
    const noCheck = M.dispatchEligible({ ...s, project: { ...s.project, checks: cfg({ commands: [cmd("i", ["npm", "ci"], "prepare")] }) } }, at(3));
    expect(step(noCheck, r.newId, "C1").state).toBe("skipped");
    const { s: on, id } = withChecks();
    expect(step(on, id, "C1").state).toBe("running");
    expect(C.checkTargetOf(on, task(on, id), step(on, id, "C1"))).toEqual({ artifactId: expect.stringMatching(/^art-/), ref: SHA });
    expect(running(on, id)[0].snapshot.routingReason).toBe("Run by the service (sandboxed)");
  });

  it("the sandbox not ready holds check steps, labelled, and never falls back to running unsandboxed (Q3, mutation check)", () => {
    for (const health of [undefined, { sandbox: "codex" as const, status: "unavailable" as const, detail: "x", checkedAt: at(0) }, { sandbox: "codex" as const, status: "unverified" as const, detail: "x", checkedAt: at(0) }, { sandbox: "none" as const, status: "ready" as const, detail: "x", checkedAt: at(0) }]) {
      const { s: base, id } = withChecks();
      const held = { ...base, attempts: base.attempts.filter((a) => a.snapshot.provider !== "service"), project: { ...base.project, checksHealth: health } };
      for (const t of held.tasks) for (const st of t.steps) if (st.role === "checks" && st.state === "running") st.state = "pending";
      expect(C.checksHeld(held)).toBe(true);
      const next = M.dispatchEligible(held, at(4));
      expect(M.activeServiceAttempts(next)).toHaveLength(0);
      expect(next.attempts.every((a) => a.snapshot.provider !== "service" || a.outcome !== "running")).toBe(true);
      expect(step(next, id, "C1").state).toBe("pending");
      expect(M.stateLabel(next, task(next, id))).toBe(C.HELD_LABEL);
    }
    // "none" chosen by the user is never held, and the run says so.
    const none = withChecks({ sandbox: "none" });
    expect(C.checksHeld(none.s)).toBe(false);
    expect(running(none.s, none.id)[0].snapshot).toMatchObject({ provider: "service", routingReason: "Run by the service (no sandbox)", checks: { sandbox: "none" } });
  });

  it("at most maxConcurrent check runs at once; service runs do not count against the worker limit", () => {
    let { s } = withChecks();
    const r2 = M.createTask(s, { title: "T2", area: "A", outcome: "o", benefit: "b", whyNow: "", approach: "a", acceptance: ["ok"], priority: 2, holdBeforeStart: false, patternId: "change" }, at(4));
    s = M.dispatchEligible(M.leadPromoteProposals(r2.state, at(5)), at(5));
    s = M.reportCompletion(s, running(s, r2.newId)[0].id, [], at(6), [{ name: "change", summary: "done", ref: `${SHA2} on b` }, { name: "handoff", summary: "h" }]);
    s = M.dispatchEligible(s, at(7));
    expect(M.activeServiceAttempts(s)).toHaveLength(1); // maxConcurrent 1: the second waits
    expect(step(s, r2.newId, "C1").state).toBe("pending");
    const three = M.dispatchEligible({ ...s, project: { ...s.project, checks: { ...s.project.checks, maxConcurrent: 3 } } }, at(8));
    expect(M.activeServiceAttempts(three)).toHaveLength(2);
    expect(M.activeAgentAttempts(three)).toHaveLength(0);
  });

  it("a passing C1 is reused by Final checks on the same commit and settings; a different commit or revision runs again (mutation check: reuse)", () => {
    let { s, id } = withChecks();
    s = finishRun(s, id, 4, record(SHA));
    expect(step(s, id, "C1").state).toBe("done");
    const c1 = s.artifacts.find((a) => a.taskId === id && a.stepId === "C1")!;
    expect(c1.checkRun).toMatchObject({ sha: SHA, configRev: 1 });
    expect(c1.findings).toEqual([]);
    // Review clean → repair skipped → C2 reuses C1's run in the same transaction.
    s = M.dispatchEligible(s, at(5));
    const review = running(s, id)[0];
    expect(review.stepId).toBe("S2");
    s = M.reportRunContext(s, review.id, { scope: { from: SHA2, to: SHA, paths: ["a"], total: 1 } });
    s = M.reportCompletion(s, review.id, [], at(6), [{ name: "findings", summary: "clean", findings: [], reviewedPaths: ["a"] }]);
    s = M.dispatchEligible(s, at(7));
    expect(step(s, id, "S3").state).toBe("skipped");
    expect(step(s, id, "C2").state).toBe("done");
    const reuse = s.attempts.find((a) => a.taskId === id && a.stepId === "C2")!;
    expect(reuse).toMatchObject({ outcome: "completed", snapshot: { checks: { reusedFrom: c1.attemptId } } });
    expect(reuse.snapshot.routingReason).toContain("not run again");
    const c2 = s.artifacts.find((a) => a.taskId === id && a.stepId === "C2")!;
    expect(c2.checkRun).toMatchObject({ sha: SHA, reusedFrom: c1.attemptId });
    expect(c2.summary).toContain(`same as ${c1.attemptId}`);
    expect(running(M.dispatchEligible(s, at(8)), id)[0]?.stepId).toBe("S4");
    // Not reused: another commit, or another settings revision.
    expect(C.reusableRun(s, task(s, id), step(s, id, "C2"), SHA2)).toBeUndefined();
    expect(C.reusableRun({ ...s, project: { ...s.project, checks: { ...s.project.checks, rev: 2 } } }, task(s, id), step(s, id, "C2"), SHA)).toBeUndefined();
    expect(C.reusableRun(s, task(s, id), step(s, id, "C2"), SHA)?.attempt.id).toBe(reuse.id);
  });
});

describe("findings from a run (§6.7)", () => {
  it("a failing check is an auto-fix error with the output tail; a timeout names the limit; a failed prepare and touched inputs need a decision", () => {
    const rec: CheckRunRecord = {
      sha: SHA,
      configRev: 1,
      sandbox: "codex",
      touchedInputs: ["package.json", "tsconfig.json"],
      results: [
        { id: "install", label: "install", kind: "prepare", status: "failed", exitCode: 2, durationMs: 100, excerpt: "npm ERR! 404", bytes: 12, truncated: false },
        { id: "test", label: "test", kind: "check", status: "not-run", durationMs: 0, excerpt: "", bytes: 0, truncated: false },
      ],
      durationMs: 100,
    };
    const fs = C.findingsFromRun(rec, [{ id: "test", timeoutMs: 600_000 }]);
    expect(fs.map((f) => [f.id, f.severity, f.action, f.title])).toEqual([
      ["F1", "error", "ask-user", "Preparing the checks failed (install, exit 2)"],
      ["F2", "warning", "ask-user", "The change edits files the checks depend on: package.json, tsconfig.json"],
    ]);
    expect(fs[0]).toMatchObject({ checkId: "install", detail: "npm ERR! 404", why: expect.stringMatching(/often the environment/) });
    expect(fs[1].file).toBe("package.json");
    const f2 = C.findingsFromRun(failed(SHA, { results: [{ id: "test", label: "test", kind: "check", status: "timed-out", durationMs: 600_000, excerpt: "x".repeat(2000), bytes: 2000, truncated: false }] }), [{ id: "test", timeoutMs: 600_000 }]);
    expect(f2).toEqual([expect.objectContaining({ severity: "error", action: "auto-fix", title: "test did not finish within 10 minutes", checkId: "test" })]);
    expect(f2[0].detail).toHaveLength(1200);
    expect(f2[0].key).toMatch(/^[0-9a-f]{12}$/);
    const f3 = C.findingsFromRun(failed(SHA));
    expect(f3[0].title).toBe("test failed (exit 1)");
    expect(C.findingsFromRun(record(SHA))).toEqual([]);
    expect(C.touchedInputs(cfg(), ["package.json", "src/a.ts", "docs/x.md", ".github/workflows/ci.yml"])).toEqual(["package.json", ".github/workflows/ci.yml"]);
    expect(C.runSummary(rec)).toBe(`Checks on ${SHA.slice(0, 12)} (settings r1, sandboxed): ✗ install exit 2, 1 s · – test not run`);
    expect(C.runSummary(record(SHA, { simulated: true, reusedFrom: "run-3" }))).toContain("(settings r1, sandboxed, simulated, same as run-3): ✓ test 1 s");
  });

  it("a failing C1 becomes a repair's work; the repair's change is checked again in the next round (runIf counts check results)", () => {
    let { s, id } = withChecks();
    s = finishRun(s, id, 4, failed(SHA));
    const c1 = s.artifacts.find((a) => a.taskId === id && a.stepId === "C1")!;
    expect(c1.findings).toEqual([expect.objectContaining({ action: "auto-fix", title: "test failed (exit 1)" })]);
    expect(c1.openFindings).toBe(1);
    expect(F.fixable(s, c1)).toBe(1);
    s = M.dispatchEligible(s, at(5));
    const review = running(s, id)[0];
    s = M.reportRunContext(s, review.id, { scope: { from: SHA2, to: SHA, paths: ["a"], total: 1 } });
    s = M.reportCompletion(s, review.id, [], at(6), [{ name: "findings", summary: "clean", findings: [], reviewedPaths: ["a"] }]);
    s = M.dispatchEligible(s, at(7));
    const repair = running(s, id)[0];
    expect(repair.stepId).toBe("S3");
    s = M.reportCompletion(s, repair.id, [], at(8), [{ name: "change", summary: "fixed", ref: `${SHA2} on b` }]);
    s = M.dispatchEligible(s, at(9));
    const again = running(s, id)[0];
    expect(again).toMatchObject({ stepId: "C1-i2", snapshot: { provider: "service", checks: { target: { ref: SHA2 } } } });
  });
});

describe("Final checks: the decision, check rounds and acceptance (§6.7)", () => {
  /** The loop ended with a failing check on the final change: C2 ran (reused the failing C1) and blocked. */
  function blockedFinal(routeTo: "lead" | "user" = "user"): { s: State; id: string } {
    let { s, id } = withChecks();
    s = { ...s, project: { ...s.project, triage: { askUserBy: routeTo } } };
    s = finishRun(s, id, 4, failed(SHA));
    s = M.dispatchEligible(s, at(5));
    const review = running(s, id)[0];
    s = M.reportRunContext(s, review.id, { scope: { from: SHA2, to: SHA, paths: ["a"], total: 1 } });
    s = M.reportCompletion(s, review.id, [], at(6), [{ name: "findings", summary: "clean", findings: [], reviewedPaths: ["a"] }]);
    // The repair produces the same commit (nothing changed), so the loop's next check reuses nothing and fails again; run the loop out.
    for (let i = 0; i < 12 && task(s, id).lifecycle === "active" && !task(s, id).steps.some((x) => x.state === "blocked"); i++) {
      s = M.dispatchEligible(s, at(10 + i));
      for (const a of running(s, id)) {
        const st = step(s, id, a.stepId);
        if (st.role === "coder") s = M.reportCompletion(s, a.id, [], at(10 + i), [{ name: "change", summary: "same", ref: `${SHA} on b` }]);
        else if (st.role === "checks") s = finishRun(s, id, 10 + i, failed(SHA));
        else if (st.role === "code_reviewer") {
          s = M.reportRunContext(s, a.id, { scope: { from: SHA2, to: SHA, paths: ["a"], total: 1 } });
          s = M.reportCompletion(s, a.id, [], at(10 + i), [{ name: "findings", summary: "clean", findings: [], reviewedPaths: ["a"] }]);
        }
      }
    }
    return { s, id };
  }

  it("a failing final change blocks the task with a decision; nothing is retried by itself; a config change leaves the blocked step alone", () => {
    const { s, id } = blockedFinal();
    const c2 = step(s, id, "C2");
    expect(c2.state).toBe("blocked");
    expect(c2.blockedReason).toMatch(new RegExp(`^Checks failed on the final change ${SHA.slice(0, 12)}: test\\. A decision is needed \\(fd-\\d+\\)\\.$`));
    expect(task(s, id).lifecycle).toBe("active");
    const d = s.decisions.find((x) => x.kind === "final-checks")!;
    expect(d).toMatchObject({ taskId: id, routedTo: "user", status: "open", finding: { source: "check", severity: "error" } });
    expect(M.autoRetryCandidates({ ...s, project: { ...s.project, autonomy: { ...s.project.autonomy, autoRetry: 3 } } }, T0 + 10 * 60_000)).toEqual([]);
    expect(step(M.setProviderEnabled(s, "codex", true, at(40)), id, "C2").state).toBe("blocked");
    // The same failure never gets a second open decision.
    expect(s.decisions.filter((x) => x.kind === "final-checks" && x.status === "open")).toHaveLength(1);
  });

  it("only the user can accept failing checks: the step ends, the decision records it, the evidence is ok with acceptedByUser and the landed item is flagged (mutation check)", () => {
    const { s, id } = blockedFinal();
    const d = s.decisions.find((x) => x.kind === "final-checks")!;
    expect(() => F.decideFinding(s, d.id, "follow-up", undefined, at(50))).toThrow(/repair round or accepted/);
    // The lead's accept is refused whatever it says.
    const lr = M.startLeadRun({ ...s, decisions: s.decisions.map((x) => ({ ...x, routedTo: "lead" as const })) }, { provider: "claude", model: "claude-sample-large", trigger: "decisions" }, at(50));
    const leadTried = M.completeLeadRun(lr.state, lr.runId, { reply: "", proposals: [], decisions: [{ id: d.id, decision: "accept", why: "good enough" }] }, at(51));
    expect(leadTried.decisions.find((x) => x.id === d.id)!.status).toBe("open");
    expect(leadTried.conversation.at(-1)!.rejected).toEqual([expect.stringMatching(/only the user can accept failing checks/)]);
    expect(step(leadTried, id, "C2").state).toBe("blocked");
    const accepted = F.decideFinding(s, d.id, "accept", "ship it", at(52));
    expect(step(accepted, id, "C2").state).toBe("done");
    expect(accepted.decisions.find((x) => x.id === d.id)).toMatchObject({ status: "accept", decidedBy: "user", why: "ship it" });
    expect(accepted.events.some((e) => e.actor === "user" && e.message.startsWith(`You accepted failing checks on ${SHA.slice(0, 12)} (test)`))).toBe(true);
    expect(C.checkEvidence(accepted, SHA)).toMatchObject({ ok: true, acceptedByUser: true });
    expect(C.landedCheckFlags(accepted, task(accepted, id), SHA)).toEqual(["checks-accepted-failing"]);
    // The task finishes on the next dispatch; local delivery flags the landed item.
    let done = M.dispatchEligible(accepted, at(53));
    expect(running(done, id)[0]?.stepId).toBe("S4");
    done = M.reportCompletion(done, running(done, id)[0].id, [], at(54), [{ name: "verification", summary: "ok" }]);
    expect(task(done, id).lifecycle).toBe("done");
  });

  it("review M6: accepting failing checks never covers a configured check that did not run; the missing-check rule is applied first (mutation check)", () => {
    const { s, id } = blockedFinal();
    const d = s.decisions.find((x) => x.kind === "final-checks")!;
    const accepted = F.decideFinding(s, d.id, "accept", "ship it", at(52));
    expect(C.checkEvidence(accepted, SHA)).toMatchObject({ ok: true, acceptedByUser: true });
    // The same acceptance, with a configured check the run never ran (the settings revision is unchanged): not evidence.
    const wider = structuredClone(accepted);
    wider.project.checks.commands.push(cmd("lint", ["npm", "run", "lint"]));
    expect(C.checkEvidence(wider, SHA)).toMatchObject({ ok: false, attemptId: expect.any(String), reason: `The run on ${SHA.slice(0, 12)} did not run every configured check (missing: lint).` });
    expect(C.checkEvidence(wider, SHA)).not.toHaveProperty("acceptedByUser");
    expect(C.landedCheckFlags(wider, task(wider, id), SHA)).toEqual(["checks-accepted-failing", "checks-not-run"]);
    expect(C.landedCheckFlags(accepted, task(accepted, id), SHA)).toEqual(["checks-accepted-failing"]);
    // A run that recorded the check as not-run (a failed prepare left it) is the same case.
    const notRun = structuredClone(accepted);
    const art = notRun.artifacts.find((a) => a.kind === "check-results" && a.checkRun && C.sameSha(a.checkRun.sha, SHA))!;
    art.checkRun!.results.push({ id: "lint", label: "lint", kind: "check", status: "not-run", durationMs: 0, excerpt: "", bytes: 0, truncated: false });
    notRun.project.checks.commands.push(cmd("lint", ["npm", "run", "lint"]));
    expect(C.checkEvidence(notRun, SHA)).toMatchObject({ ok: false, reason: expect.stringMatching(/missing: lint/) });
  });

  it("a fix round (user or lead) appends fix → review → final checks after the blocked step, rewires what follows, and is limited to two", () => {
    const { s, id } = blockedFinal("lead");
    const d = s.decisions.find((x) => x.kind === "final-checks")!;
    expect(d.routedTo).toBe("lead");
    const lr = M.startLeadRun(s, { provider: "claude", model: "claude-sample-large", trigger: "decisions" }, at(50));
    let r1 = M.completeLeadRun(lr.state, lr.runId, { reply: "", proposals: [], decisions: [{ id: d.id, decision: "fix", why: "the test is right" }] }, at(51));
    expect(r1.decisions.find((x) => x.id === d.id)).toMatchObject({ status: "fix", decidedBy: "lead" });
    const t1 = task(r1, id);
    expect(t1.checkRounds).toBe(1);
    expect(t1.steps.map((x) => x.id)).toEqual(expect.arrayContaining(["C2-r1-fix", "C2-r1-review", "C2-r1-checks"]));
    const fix = step(r1, id, "C2-r1-fix");
    expect(fix).toMatchObject({ role: "coder", dependsOn: ["C2"], inputs: expect.arrayContaining([{ step: "C2", output: "final" }]) });
    expect(step(r1, id, "C2-r1-checks")).toMatchObject({ role: "checks", checks: { onFail: "block" }, inputs: expect.arrayContaining([{ step: "C2-r1-fix", output: "change" }]) });
    expect(step(r1, id, "C2").state).toBe("done");
    expect(step(r1, id, "S4").dependsOn).toContain("C2-r1-checks");
    expect(step(r1, id, "S4").inputs).toEqual(expect.arrayContaining([{ step: "C2-r1-checks", output: "final" }, { step: "C2-r1-fix", output: "change" }]));
    expect(t1.pipelineHistory.at(-1)!.reason).toBe("Check round 1 after C2 failed: test");
    // Round 1 runs: the fix, the review, the checks; they fail again → round 2; a third is refused and goes to the user.
    r1 = M.dispatchEligible(r1, at(52));
    expect(running(r1, id)[0].stepId).toBe("C2-r1-fix");
    r1 = M.reportCompletion(r1, running(r1, id)[0].id, [], at(53), [{ name: "change", summary: "f", ref: `${SHA2} on b` }, { name: "handoff", summary: "h" }]);
    r1 = M.dispatchEligible(r1, at(54));
    const rv = running(r1, id)[0];
    r1 = M.reportRunContext(r1, rv.id, { scope: { from: SHA, to: SHA2, paths: ["a"], total: 1 } });
    r1 = M.reportCompletion(r1, rv.id, [], at(55), [{ name: "findings", summary: "clean", findings: [], reviewedPaths: ["a"] }]);
    r1 = M.dispatchEligible(r1, at(56));
    expect(running(r1, id)[0]).toMatchObject({ stepId: "C2-r1-checks", snapshot: { checks: { target: { ref: SHA2 } } } });
    r1 = finishRun(r1, id, 57, failed(SHA2));
    expect(step(r1, id, "C2-r1-checks").state).toBe("blocked");
    const d2 = r1.decisions.filter((x) => x.kind === "final-checks" && x.status === "open").pop()!;
    const r2 = F.decideFinding(r1, d2.id, "fix", undefined, at(58));
    expect(task(r2, id).checkRounds).toBe(2);
    expect(step(r2, id, "C2-r1-checks-r2-checks")).toBeDefined();
    // A third round is refused for the user; a lead "fix" is handed to the user with the reason.
    const blocked3 = { ...r2, tasks: r2.tasks.map((t) => (t.id === id ? { ...t, steps: t.steps.map((x) => (x.id === "C2-r1-checks-r2-checks" ? { ...x, state: "blocked" as const, blockedReason: "Checks failed on the final change" } : x)) } : t)) };
    const art3 = { ...blocked3.artifacts.find((a) => a.stepId === "C2-r1-checks")!, id: "art-x3", stepId: "C2-r1-checks-r2-checks" };
    const s3 = { ...blocked3, artifacts: [...blocked3.artifacts, art3], decisions: [...blocked3.decisions, { ...d2, id: "fd-x3", artifactId: "art-x3", status: "open" as const, routedTo: "lead" as const }] };
    expect(() => F.decideFinding(s3, "fd-x3", "fix", undefined, at(60))).toThrow(/2 check rounds were already added/);
    const lr3 = M.startLeadRun(s3, { provider: "claude", model: "claude-sample-large", trigger: "decisions" }, at(61));
    const handed = M.completeLeadRun(lr3.state, lr3.runId, { reply: "", proposals: [], decisions: [{ id: "fd-x3", decision: "fix", why: "again" }] }, at(62));
    expect(handed.decisions.find((x) => x.id === "fd-x3")).toMatchObject({ status: "open", routedTo: "user" });
    expect(task(handed, id).checkRounds).toBe(2);
  });
});

describe("evidence and the merge gate (§6.9)", () => {
  const seed = () => {
    const s = buildSeed(T0, { inFlightRuns: false });
    return { ...s, project: { ...s.project, checks: { ...cfg(), rev: 3 } } };
  };
  const withArt = (s: State, rec: CheckRunRecord, over: Partial<{ id: string; author: "user" }> = {}) => ({
    ...s,
    artifacts: [...s.artifacts, { id: over.id ?? "art-c", taskId: "EX-006", stepId: "C2", attemptId: "run-c", name: "final", kind: "check-results" as const, version: 1, summary: "s", createdAt: at(1), checkRun: rec, findings: C.findingsFromRun(rec), openFindings: C.findingsFromRun(rec).length }],
  });

  it("checkEvidence is bound to the exact commit and the current settings revision, from any task", () => {
    const s = seed();
    expect(C.checkEvidence(s, SHA)).toMatchObject({ ok: false, reason: `No service checks ran on ${SHA.slice(0, 12)}.` });
    expect(C.checkEvidence(withArt(s, record(SHA, { configRev: 3 })), SHA)).toMatchObject({ ok: true, configRev: 3, attemptId: "run-c", taskId: "EX-006", sandbox: "codex", reason: `test passed on ${SHA.slice(0, 12)}.` });
    expect(C.checkEvidence(withArt(s, record(SHA, { configRev: 2 })), SHA)).toMatchObject({ ok: false, reason: expect.stringMatching(/settings changed after the last run/) });
    expect(C.checkEvidence(withArt(s, record(SHA, { configRev: 3 })), SHA2)).toMatchObject({ ok: false, reason: expect.stringMatching(/No service checks ran/) });
    expect(C.checkEvidence(withArt(s, failed(SHA, { configRev: 3 })), SHA)).toMatchObject({ ok: false, attemptId: "run-c", reason: `test failed on ${SHA.slice(0, 12)}.` });
    expect(C.checkEvidence(withArt(s, record(SHA, { configRev: 3, sandbox: "none" })), SHA).reason).toContain("(no sandbox)");
    expect(C.checkEvidence(withArt(s, record(SHA, { configRev: 3, touchedInputs: ["package.json"] })), SHA)).toMatchObject({ ok: false, reason: expect.stringMatching(/1 finding of the check run .* needs a decision/) });
    expect(C.checkEvidence({ ...s, project: { ...s.project, checks: { ...s.project.checks, enabled: false } } }, SHA).ok).toBe(false);
  });

  it("the gate item: ok, waiting (a run is started), blocked on a failure, advisory for the user's own merge; a landed change without evidence is flagged", () => {
    const s = seed();
    const pr = D.reportPrHead(D.setDeliveryMode({ ...s, tasks: s.tasks.map((t) => (t.id === "EX-006" ? { ...t, lifecycle: "done" as const, integration: { status: "pending" as const } } : t)) }, { mode: "pr" }, at(0)), "EX-006", { n: 1, sha: SHA, baseSha: SHA2, changed: { files: 1, additions: 1, deletions: 0, paths: ["a"], protectedHits: [], workflowHits: [] } }, at(1));
    const item = (st: State, byUser = false) => D.prGate(st, task(st, "EX-006"), T0 + 5000, { byUser }).items.find((i) => i.id === "service-checks")!;
    expect(item(pr)).toMatchObject({ state: "waiting", detail: expect.stringMatching(/No service checks ran on .* One check run is started for it/) });
    const okState = withArt(pr, record(SHA, { configRev: 3 }));
    expect(item(okState)).toMatchObject({ state: "ok", detail: `test passed on ${SHA.slice(0, 12)}.` });
    const failedState = withArt(pr, failed(SHA, { configRev: 3 }));
    expect(item(failedState)).toMatchObject({ state: "blocked", code: "service-checks" });
    expect(item(failedState, true)).toMatchObject({ state: "blocked", advisory: true });
    expect(D.repairCause(failedState, task(failedState, "EX-006"))).toEqual({ kind: "service-checks", sha: SHA, results: [{ id: "test", label: "test", exitCode: 1 }] });
    // Off: no item at all.
    expect(D.prGate({ ...pr, project: { ...pr.project, checks: { ...pr.project.checks, enabled: false } } }, task(pr, "EX-006"), T0 + 5000, { byUser: false }).items.some((i) => i.id === "service-checks")).toBe(false);
    // ensureChecks: one dedicated check task per change, capped, cancelled when the head moves on.
    const started = D.ensureChecks(D.reportPreflight(pr, { ok: true, repo: "o/r", login: "me", ghVersion: "2.101.0", requiredChecks: [], autoMergeBlockers: [], posture: [] }, at(2)), "EX-006", at(3));
    const ck = started.tasks.find((t) => t.checkTarget?.taskId === "EX-006")!;
    expect(ck).toMatchObject({ id: "EX-006-CK1", checkTarget: { taskId: "EX-006", n: 1, sha: SHA }, lifecycle: "ready" });
    expect(ck.steps.map((x) => x.role)).toEqual(["checks"]);
    expect(ck.specs[0].author).toBe("system");
    // ORC-016: the dedicated check pipeline is the service's own, recorded as such.
    expect(ck.pattern).toMatchObject({ id: "delivery-checks", source: "internal", chosenBy: "service" });
    expect(ck.patternSince).toBe(1);
    expect(D.ensureChecks(started, "EX-006", at(4)).tasks.filter((t) => t.checkTarget).length).toBe(1);
    expect(item(started)).toMatchObject({ state: "waiting", detail: expect.stringMatching(/EX-006-CK1 runs them/) });
    expect(M.openLeadProposals(started).some((t) => t.checkTarget)).toBe(false);
    const capped = { ...pr, tasks: pr.tasks.map((t) => (t.id === "EX-006" ? { ...t, integration: { ...t.integration!, pr: { ...t.integration!.pr!, counters: { ...t.integration!.pr!.counters, checks: 3 } } } } : t)) };
    expect(D.ensureChecks(capped, "EX-006", at(5)).tasks.some((t) => t.checkTarget)).toBe(false);
    expect(item(capped)).toMatchObject({ state: "blocked", detail: expect.stringMatching(/3 check runs were already started/) });
    // Landed without evidence while checks are on: flagged.
    expect(C.landedCheckFlags(pr, task(pr, "EX-006"), SHA)).toEqual(["checks-not-run"]);
    expect(C.landedCheckFlags(okState, task(okState, "EX-006"), SHA)).toEqual([]);
  });
});

describe("security review of step 2 (H1, M2, L5, L6)", () => {
  const withArt = (s: State, rec: CheckRunRecord) => ({
    ...s,
    artifacts: [...s.artifacts, { id: "art-x", taskId: "EX-006", stepId: "C2", attemptId: "run-x", name: "final", kind: "check-results" as const, version: 1, summary: "s", createdAt: at(1), checkRun: rec, findings: C.findingsFromRun(rec), openFindings: C.findingsFromRun(rec).length }],
  });

  it("H1: an install that may use the network must carry its package manager's no-scripts flags; offline it need not; a rebuild step is allowed and marked offline (mutation check)", () => {
    for (const argv of [["npm", "ci"], ["npm", "install"], ["pnpm", "install", "--frozen-lockfile"], ["pnpm", "install", "--ignore-scripts"], ["yarn", "install", "--immutable"]]) {
      bad(cfg({ prepareNetwork: true, commands: [cmd("i", argv, "prepare"), cmd("t", ["npm", "test"])] }), /must carry/);
      ok(cfg({ prepareNetwork: false, commands: [cmd("i", argv, "prepare"), cmd("t", ["npm", "test"])] }));
    }
    for (const argv of [["npm", "ci", "--ignore-scripts"], ["pnpm", "install", "--ignore-scripts", "--ignore-pnpmfile", "--frozen-lockfile"], ["yarn", "install", "--immutable", "--mode=skip-build"], ["yarn", "install", "--ignore-scripts"]]) {
      ok(cfg({ prepareNetwork: true, commands: [cmd("i", argv, "prepare"), cmd("t", ["npm", "test"])] }));
    }
    expect(C.validateCommand(cmd("i", ["npm", "ci"], "prepare"), { networked: true })).toMatch(/must carry "--ignore-scripts" or "--ignore-scripts=true"\. Repository code must not run while the network is on; scripts your project needs can run offline afterwards in a separate "npm rebuild" prepare command/);
    expect(C.validateCommand(cmd("i", ["pnpm", "i"], "prepare"), { networked: true })).toMatch(/"--ignore-scripts" or "--ignore-scripts=true" and "--ignore-pnpmfile" or "--ignore-pnpmfile=true"/);
    // The offline way to run install scripts.
    ok(cfg({ prepareNetwork: true, commands: [cmd("i", ["npm", "ci", "--ignore-scripts"], "prepare"), cmd("s", ["npm", "rebuild"], "prepare"), cmd("t", ["npm", "test"])] }));
    ok(cfg({ prepareNetwork: true, commands: [cmd("s", ["pnpm", "rebuild"], "prepare"), cmd("t", ["pnpm", "test"])] }));
    bad(cfg({ commands: [cmd("s", ["npm", "rebuild"])] }), /a check with npm is/); // rebuild is a prepare step, never a check
    const plannedCommands = C.commandsFor(cfg({ prepareNetwork: true, commands: [cmd("i", ["npm", "ci", "--ignore-scripts"], "prepare"), cmd("s", ["npm", "rebuild"], "prepare"), cmd("t", ["npm", "test"])] }), {});
    expect(plannedCommands.map((c) => [c.id, c.offline])).toEqual([["i", undefined], ["s", true], ["t", undefined]]);
    expect(C.isInstall(["npm", "ci"])).toBe(true);
    expect(C.isRebuild(["yarn", "rebuild"])).toBe(true);
    expect(C.networkRefusal(["yarn", "install", "--mode=skip-build"])).toBeUndefined();
    // Suggestions carry the flags; a project that needs scripts adds the offline step itself.
    const sug = C.suggestChecks([{ path: "package.json", text: JSON.stringify({ scripts: { test: "vitest" } }) }, { path: "yarn.lock", text: "" }]);
    expect(sug[0].argv).toEqual(["yarn", "install", "--immutable", "--mode=skip-build"]);
    expect(C.validateChecks({ ...cfg(), prepareNetwork: true, commands: sug }, { acknowledged: true })).toBeUndefined();
    expect(C.suggestChecks([{ path: "package.json", text: "{}" }, { path: "pnpm-lock.yaml", text: "" }])[0].argv).toEqual(["pnpm", "install", "--frozen-lockfile", "--ignore-scripts", "--ignore-pnpmfile"]);
  });

  it("review H1: the network goes only to npm, pnpm and yarn installs with every repository-code hook off; everything else runs offline with the reason (mutation check: the allowlist)", () => {
    // Not on the allowlist: allowed as prepare commands, but marked offline with the rule, whatever the settings say.
    for (const argv of [["make", "deps"], ["./gradlew", "dependencies"], ["bundle", "install"], ["node", "scripts/setup.js"], ["python3", "-m", "pip", "install", "-e", "."], ["uv", "sync"], ["poetry", "install"], ["mix", "deps.get"], ["swift", "package", "resolve"], ["cargo", "fetch"], ["go", "mod", "download"]]) {
      expect(C.networkRefusal(argv), argv.join(" ")).toBe(`${C.NETWORK_RULE}.`);
      const planned = C.commandsFor(cfg({ prepareNetwork: true, commands: [cmd("p", argv, "prepare"), cmd("t", ["npm", "test"])] }), {});
      expect(planned[0], argv.join(" ")).toMatchObject({ id: "p", offline: true, offlineReason: `${C.NETWORK_RULE}.` });
      expect(planned[1].offline).toBeUndefined();
    }
    ok(cfg({ prepareNetwork: true, commands: [cmd("p", ["make", "deps"], "prepare"), cmd("t", ["npm", "test"])] }));
    // bun: its hooks beyond lifecycle scripts could not be ruled out, so its installs run offline even with --ignore-scripts.
    expect(C.networkRefusal(["bun", "install", "--frozen-lockfile", "--ignore-scripts"])).toMatch(/^bun installs run offline: bun has hooks beyond install scripts/);
    expect(C.commandsFor(cfg({ prepareNetwork: true, commands: [cmd("i", ["bun", "install", "--ignore-scripts"], "prepare"), cmd("t", ["bun", "test"])] }), {})[0]).toMatchObject({ offline: true, offlineReason: expect.stringMatching(/bun installs run offline/) });
    ok(cfg({ prepareNetwork: true, commands: [cmd("i", ["bun", "install"], "prepare"), cmd("t", ["bun", "test"])] })); // no flag needed: it never gets the network
    // On the allowlist, with every hook off.
    expect(C.networkRefusal(["npm", "ci", "--ignore-scripts"])).toBeUndefined();
    expect(C.networkRefusal(["npm", "install", "--ignore-scripts=true"])).toBeUndefined();
    expect(C.networkRefusal(["pnpm", "install", "--frozen-lockfile", "--ignore-scripts", "--ignore-pnpmfile"])).toBeUndefined();
    expect(C.networkRefusal(["yarn", "install", "--immutable", "--mode=skip-build"])).toBeUndefined();
    expect(C.networkRefusal(["yarn", "install", "--ignore-scripts"])).toBeUndefined();
    expect(C.commandsFor(cfg({ prepareNetwork: true, commands: [cmd("i", ["npm", "ci", "--ignore-scripts"], "prepare")] }), {})[0].offlineReason).toBeUndefined();
    // pnpm's .pnpmfile.cjs runs even under --ignore-scripts: --ignore-pnpmfile is required too.
    expect(C.networkRefusal(["pnpm", "install", "--ignore-scripts"])).toMatch(/must carry "--ignore-pnpmfile" or "--ignore-pnpmfile=true"/);
    // The runner re-adds what is missing and drops what contradicts, whatever the settings say.
    expect(C.hardenedInstall(["npm", "ci"])).toEqual(["npm", "ci", "--ignore-scripts"]);
    expect(C.hardenedInstall(["pnpm", "install", "--frozen-lockfile"])).toEqual(["pnpm", "install", "--frozen-lockfile", "--ignore-scripts", "--ignore-pnpmfile"]);
    expect(C.hardenedInstall(["pnpm", "install", "--ignore-scripts", "--no-ignore-scripts", "--ignore-pnpmfile=false"])).toEqual(["pnpm", "install", "--ignore-scripts", "--ignore-pnpmfile"]);
    expect(C.hardenedInstall(["yarn", "install", "--immutable"])).toEqual(["yarn", "install", "--immutable", "--ignore-scripts"]);
    expect(C.hardenedInstall(["yarn", "install", "--mode=skip-build", "--mode=update-lockfile"])).toEqual(["yarn", "install", "--mode=skip-build"]);
    expect(C.hardenedInstall(["bun", "install"])).toEqual(["bun", "install"]); // offline anyway
    expect(C.hardenedInstall(["npm", "rebuild"])).toEqual(["npm", "rebuild"]);
    // Yarn's own configuration runs repository JavaScript: such a copy is refused the network, from the copy the install runs in.
    expect(C.yarnrcRefusal({})).toBeUndefined();
    expect(C.yarnrcRefusal({ yarnrcYml: "nodeLinker: node-modules\nenableGlobalCache: true\n" })).toBeUndefined();
    expect(C.yarnrcRefusal({ yarnrcYml: "yarnPath: .yarn/releases/yarn-4.0.0.cjs\n" })).toBe(".yarnrc.yml sets yarnPath, which runs repository JavaScript; the install runs offline.");
    expect(C.yarnrcRefusal({ yarnrcYml: "plugins:\n  - path: .yarn/plugins/x.cjs\n" })).toMatch(/sets plugins, which runs repository JavaScript/);
    expect(C.yarnrcRefusal({ yarnrcYml: "plugins: []\nyarnPath: x\n" })).toMatch(/sets plugins and yarnPath/);
    expect(C.yarnrcRefusal({ yarnrcYml: "# plugins: none\nsomething: plugins\n" })).toBeUndefined(); // only a top-level key counts
    expect(C.yarnrcRefusal({ yarnrc: 'yarn-path "./.yarn/releases/yarn-1.22.19.cjs"\n' })).toBe(".yarnrc sets yarn-path, which runs repository JavaScript; the install runs offline.");
    expect(C.yarnrcRefusal({ yarnrc: 'registry "https://registry.npmjs.org"\n' })).toBeUndefined();
  });

  it("review L11: contradicting flags are refused; NPM_CONFIG_*, YARN_* and PNPM_* never pass through; interpreter flags with a separate value are skipped (mutation check)", () => {
    for (const argv of [
      ["npm", "ci", "--ignore-scripts", "--no-ignore-scripts"],
      ["npm", "ci", "--ignore-scripts=false"],
      ["npm", "ci", "--ignore-scripts", "--ignore-scripts=false"],
      ["pnpm", "install", "--ignore-scripts", "--ignore-pnpmfile", "--no-ignore-pnpmfile"],
      ["pnpm", "install", "--ignore-scripts", "--ignore-pnpmfile=false"],
      ["yarn", "install", "--mode=skip-build", "--mode=update-lockfile"],
      ["yarn", "install", "--ignore-scripts", "--no-ignore-scripts"],
    ]) {
      bad(cfg({ prepareNetwork: true, commands: [cmd("i", argv, "prepare"), cmd("t", ["npm", "test"])] }), /would let repository code run while the network is on/);
      expect(C.networkRefusal(argv), argv.join(" ")).toMatch(/would let repository code run/);
    }
    expect(C.contradictingFlags(["npm", "ci", "--ignore-scripts", "--no-ignore-scripts", "--ignore-scripts=false"])).toEqual(["--no-ignore-scripts", "--ignore-scripts=false"]);
    // Variable names: package-manager configuration is blocked whatever its case (the name rule is uppercase; the block is case-insensitive).
    for (const n of ["NPM_CONFIG_IGNORE_SCRIPTS", "NPM_CONFIG_REGISTRY", "YARN_ENABLE_SCRIPTS", "YARN_IGNORE_PATH", "PNPM_HOME"]) bad(cfg({ passEnv: [n] }), /configures a package manager and cannot be passed through/);
    for (const n of ["npm_config_x", "Yarn_X", "pnpm_home"]) expect(C.blockedEnvName(n), n).toBe(true);
    ok(cfg({ passEnv: ["MY_TOOL_HOME", "YARNX"] }));
    // A flag whose value is the next argument does not hide the inline flag behind it.
    bad(cfg({ commands: [cmd("c", ["python", "-W", "x", "-c", "print(1)"])] }), /inline code or preload/);
    bad(cfg({ commands: [cmd("c", ["python3", "-X", "dev", "-c", "print(1)"])] }), /inline code or preload/);
    bad(cfg({ commands: [cmd("c", ["ruby", "-I", "lib", "-e", "puts 1"])] }), /inline code or preload/);
    bad(cfg({ commands: [cmd("c", ["node", "--input-type", "module", "-e", "1"])] }), /inline code or preload/);
    bad(cfg({ commands: [cmd("c", ["node", "-C", "x", "-e", "1"])] }), /inline code or preload/);
    bad(cfg({ commands: [cmd("c", ["node", "--env-file", ".env", "--require", "x"])] }), /inline code or preload/);
    // The value itself is never mistaken for a flag or the script.
    ok(cfg({ commands: [cmd("c", ["python", "-W", "error", "-m", "pytest"])] }));
    ok(cfg({ commands: [cmd("c", ["ruby", "-I", "lib", "test.rb", "-e"])] }));
    ok(cfg({ commands: [cmd("c", ["node", "--input-type", "module", "scripts/check.mjs", "-e"])] }));
    ok(cfg({ commands: [cmd("c", ["node", "-C", "development", "scripts/check.mjs"])] }));
  });

  it("L6: interpreter flags are matched by prefix and in clusters, deno eval is refused, and scanning stops at -m, -- or the script (mutation check)", () => {
    for (const a of ["-cprint(1)", "-e1", "-pe", "-rfoo", "-Ec", "-ic", "--eval=1", "--require=x", "--import", "--loader"]) bad(cfg({ commands: [cmd("c", ["python3", a, "x"])] }), /inline code or preload/);
    for (const a of ["-cprint(1)", "-e1", "-pe", "-rfoo"]) bad(cfg({ commands: [cmd("c", ["node", a])] }), /inline code or preload/);
    bad(cfg({ commands: [cmd("c", ["ruby", "-rjson", "x.rb"])] }), /inline code or preload/);
    bad(cfg({ commands: [cmd("c", ["deno", "eval", "1"])] }), /deno eval runs inline code/);
    // Legitimate flags: attached values, and anything after -m <module>, "--" or the script belongs to the script.
    ok(cfg({ commands: [cmd("c", ["python3", "-Werror", "-X", "dev", "-m", "pytest", "-p", "xdist", "-c", "pytest.ini"])] }));
    ok(cfg({ commands: [cmd("c", ["python3", "-m", "pytest", "-p", "xdist"])] }));
    ok(cfg({ commands: [cmd("c", ["node", "scripts/check.mjs", "-e", "--require", "x"])] }));
    ok(cfg({ commands: [cmd("c", ["node", "--", "-e"])] }));
    ok(cfg({ commands: [cmd("c", ["ruby", "-Ilib/core", "-W2", "test.rb"])] }));
    ok(cfg({ commands: [cmd("c", ["deno", "run", "-A", "--allow-net", "main.ts"])] }));
    ok(cfg({ commands: [cmd("c", ["deno", "test", "-r"])] }));
  });

  it("M2: a Checks step that names checks that do not exist, or would run no check, blocks with the reason instead of counting as passing (mutation check)", () => {
    const { s, id } = withChecks();
    // Rename the step's `only` to an id that is not configured: the pending Final checks step blocks at dispatch.
    const s1 = structuredClone(s);
    const final = step(s1, id, "C2");
    final.checks = { onFail: "block", only: ["tests"] };
    final.dependsOn = [];
    const out = M.dispatchEligible(s1, at(4));
    expect(step(out, id, "C2")).toMatchObject({ state: "blocked", blockedReason: "this step names checks that do not exist: tests. Fix the pipeline, or the check settings." });
    expect(M.activeServiceAttempts(out).map((a) => a.stepId)).toEqual(["C1"]); // only the earlier step runs
    // Only a prepare command is named: nothing to run.
    const s2 = structuredClone(s);
    step(s2, id, "C2").checks = { onFail: "block", only: ["i"] };
    step(s2, id, "C2").dependsOn = [];
    const s2cfg = { ...s2, project: { ...s2.project, checks: { ...cfg({ commands: [cmd("i", ["npm", "ci", "--ignore-scripts"], "prepare"), cmd("test", ["npm", "test"])] }), rev: 1 } } };
    expect(step(M.dispatchEligible(s2cfg, at(4)), id, "C2")).toMatchObject({ state: "blocked", blockedReason: expect.stringMatching(/names checks that do not exist: i\./) });
    expect(C.missingChecks(cfg({ commands: [cmd("test", ["npm", "test"])] }), { checks: { onFail: "block", only: ["tests", "test"] } })).toEqual(["tests"]);
    // Saving a pipeline or a template that names an unknown check is refused with the same words.
    const defs = task(s, id).steps.map((x) => ({ id: x.id, purpose: x.purpose, role: x.role, dependsOn: [...x.dependsOn], inputs: [...x.inputs], outputs: [...x.outputs], ...(x.checks ? { checks: { ...x.checks } } : {}), ...(x.runIf ? { runIf: [...x.runIf] } : {}), ...(x.iterate ? { iterate: { ...x.iterate } } : {}) }));
    const c2 = defs.find((d) => d.id === "C2")!;
    c2.checks = { onFail: "block", only: ["tests"] };
    expect(validatePipeline(defs, { checkIds: C.configuredCheckIds(s.project.checks) }).filter((i) => i.severity === "error").map((i) => i.message)).toEqual(["C2 names checks that do not exist: tests. The configured checks are test (Settings → Checks)."]);
    expect(validatePipeline(defs).filter((i) => i.severity === "error")).toEqual([]); // without the ids nothing is known
    expect(() => M.setPipeline(s, id, task(s, id).pipelineRev, defs, "rename", "user", at(5))).toThrow(/C2 names checks that do not exist: tests/);
  });

  it("M2: evidence means every configured check passed on the commit; a run of a subset, or one missing a check, is not evidence (mutation check)", () => {
    const base = { ...buildSeed(T0, { inFlightRuns: false }) };
    const two = { ...base, project: { ...base.project, checks: { ...cfg({ commands: [cmd("lint", ["npm", "run", "lint"]), cmd("test", ["npm", "test"])] }), rev: 1 } } };
    const both = record(SHA, { results: [{ id: "lint", label: "lint", kind: "check", status: "passed", exitCode: 0, durationMs: 1, excerpt: "", bytes: 0, truncated: false }, ...record(SHA).results] });
    expect(C.checkEvidence(withArt(two, both), SHA)).toMatchObject({ ok: true, reason: `lint, test passed on ${SHA.slice(0, 12)}.` });
    expect(C.checkEvidence(withArt(two, record(SHA)), SHA)).toMatchObject({ ok: false, attemptId: "run-x", reason: `The run on ${SHA.slice(0, 12)} did not run every configured check (missing: lint).` });
    const notRun = record(SHA, { results: [{ id: "lint", label: "lint", kind: "check", status: "not-run", durationMs: 0, excerpt: "", bytes: 0, truncated: false }, ...record(SHA).results] });
    expect(C.checkEvidence(withArt(two, notRun), SHA).ok).toBe(false);
    // The landed flag and the merge-gate item follow the evidence.
    expect(C.landedCheckFlags(withArt(two, record(SHA)), task(two, "EX-006"), SHA)).toEqual(["checks-not-run"]);
    expect(C.landedCheckFlags(withArt(two, both), task(two, "EX-006"), SHA)).toEqual([]);
  });

  it("L5: a probe result does not clear a 'Check again' asked for after the probe began (mutation check)", () => {
    let s = buildSeed(T0, { inFlightRuns: false });
    s = { ...s, project: { ...s.project, checks: cfg() } };
    const asked = C.recheckChecks(s, at(10)); // the probe starts on this request
    const askedAgain = C.recheckChecks(asked, at(20)); // …and a newer request arrives while it runs
    const health = { sandbox: "codex" as const, status: "ready" as const, detail: "ok", checkedAt: at(12) };
    expect(C.reportChecksHealth(askedAgain, health, at(25), { startedAt: at(11) }).project.checksHealth).toMatchObject({ status: "ready", recheck: true });
    // A result for the newest request clears it.
    expect(C.reportChecksHealth(askedAgain, health, at(25), { startedAt: at(21) }).project.checksHealth!.recheck).toBeUndefined();
    expect(C.reportChecksHealth(asked, health, at(25), { startedAt: at(11) }).project.checksHealth!.recheck).toBeUndefined();
  });
});
