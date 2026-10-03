// The checks in the project's own environment (docs/design/project-environment.md, unit E1). A CheckRunner like the
// host sandboxes (server/checks.ts), for runs whose assignment carries an environment. The environment itself (the
// setup probe, the copy, the image, the prepare and its reuse) is prepared.ts's, shared with the capture of evidence;
// this runner only runs the check commands in it, each in its own container with no network, and reads the test
// report from the copy (a report there before the checks is removed first).
//
// When the environment cannot run (no Docker, a failed probe, an image that cannot be pulled), the run goes to the host
// sandbox with the reason, as before the environment existed.

import type { ChecksHealth } from "../../src/domain/types";
import { BaseChecks, notRun, resultOf, type CheckAssignment, type CheckRunner, type Run } from "../checks";
import { redact } from "../redact";
import { clearReport, readTestReport } from "../testReport";
import { sharedEnvironments, type PreparedEnvironments } from "./prepared";

export class EnvironmentChecks extends BaseChecks {
  readonly simulated = false;
  private readonly fallback: (a: CheckAssignment) => CheckRunner;
  private readonly environments: PreparedEnvironments;

  constructor(o: { fallback: (a: CheckAssignment) => CheckRunner; environments?: PreparedEnvironments; log?: (msg: string) => void; env?: NodeJS.ProcessEnv }) {
    super(o);
    this.fallback = o.fallback;
    this.environments = o.environments ?? sharedEnvironments(o.log);
  }

  /** The host sandboxes' probe: this runner has none of its own; the environment's setup probe runs before its first run. */
  async probe(sandbox: "codex" | "none"): Promise<ChecksHealth> {
    return { sandbox, status: "unavailable", detail: "The environment runner has no host sandbox.", checkedAt: new Date().toISOString() };
  }

  /** Hand a run to the host sandbox, with the reason it did not run in its environment. */
  private handOff(run: Run, reason: string) {
    const a: CheckAssignment = { ...run.a, environment: undefined, hostReason: reason };
    run.done = true;
    this.clearTimers(run);
    this.runs.delete(a.attemptId);
    this.log(`checks: ${a.attemptId} runs in the host sandbox: ${reason}`);
    this.emit({ type: "activity", attemptId: a.attemptId, note: `Running on this computer: ${reason}`.slice(0, 200) });
    this.fallback(a).start(a);
  }

  protected async drive(run: Run): Promise<void> {
    const { a } = run;
    const stop = new AbortController();
    run.current = () => stop.abort();
    const note = (msg: string) => this.emit({ type: "activity", attemptId: a.attemptId, note: msg.slice(0, 200) });
    try {
      if (run.stopRequested) stop.abort();
      const out = await this.environments.withPrepared(
        {
          attemptId: a.attemptId,
          workspace: a.workspace,
          sha: a.target,
          environment: a.environment!,
          logDir: a.logDir,
          signal: stop.signal,
          note,
          // The run's time limit counts from its turn: the prepare is part of it, another run's turn is not.
          onReady: () =>
            this.timer(run, () => {
              if (run.done) return;
              run.current?.();
              this.finish(run, { type: "failed", attemptId: a.attemptId, message: `Checks reached their ${Math.round(a.runTimeoutMs / 60_000)}-minute time limit.` });
            }, a.runTimeoutMs),
        },
        async (p) => {
          // A report the change or its prepare left in the copy never counts: it goes before the checks run.
          const refused = a.testReport ? clearReport(p.work, a.testReport) : undefined;
          for (const c of a.commands) {
            if (c.kind !== "check") continue;
            if (run.done || run.stopRequested) break;
            note(`Running ${c.label} (${c.argv.join(" ")}) in the project's environment, with no network`);
            const t1 = Date.now();
            const cap = await p.run(c.argv, c.timeoutMs);
            if (run.done || run.stopRequested || cap.ended) break;
            run.results.push(resultOf(c, cap, Date.now() - t1, this.baseEnv, a.logDir, a.attemptId));
          }
          if (run.done || run.stopRequested || !a.testReport) return undefined;
          return refused ? { status: "refused" as const, path: a.testReport, reason: refused } : readTestReport(a.testReport, { workspace: p.work, scratch: [], env: this.baseEnv });
        },
      );
      if (run.done) return;
      if (run.stopRequested || (!out.ok && out.reason === "stopped")) return this.finish(run, { type: "stopped", attemptId: a.attemptId, how: "interrupted" });
      if (!out.ok && out.reason === "unavailable") return this.handOff(run, out.detail);
      run.results.unshift(...out.prepare);
      if (!out.ok) {
        for (const c of a.commands) if (c.kind === "check") run.results.push(notRun(c));
        return this.finish(run, { type: "completed", attemptId: a.attemptId, finalText: "", checks: { sha: a.target, results: run.results, durationMs: Date.now() - run.startedAt, sandbox: a.sandbox, ...(out.record ? { environment: out.record } : {}) } });
      }
      const tests = out.value;
      if (tests) note(`Test report ${tests.path}: ${tests.status === "read" ? `${tests.counts.passed} passed, ${tests.counts.failed + tests.counts.error} failed, ${tests.counts.skipped} skipped` : tests.reason}`);
      this.finish(run, { type: "completed", attemptId: a.attemptId, finalText: "", checks: { sha: a.target, results: run.results, durationMs: Date.now() - run.startedAt, sandbox: a.sandbox, ...(tests ? { tests } : {}), environment: out.record } });
    } catch (e) {
      this.finish(run, { type: "failed", attemptId: a.attemptId, message: redact(e instanceof Error ? e.message : String(e), this.baseEnv).slice(0, 300) });
    }
  }

  protected exec(): never {
    throw new Error("the environment runner drives its own commands");
  }
}
