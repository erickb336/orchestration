// The studio trial's spend cap (scripts/studio-trial.mjs). Before it starts work, the trial adds up what Claude has
// spent in the project so far; it starts nothing that could pass the owner's cap. Shared with its unit test
// (scripts/trialSpend.test.ts).
//
// Review finding 8 (pass 3): a run with no recorded cost was counted as $0, so a few such runs could pass the cap
// unseen. Now each one counts at its run limit (Claude's maxBudgetUsd, the most it could spend), never as nothing. In
// the fake runtime nothing is spent, so a simulated run with no cost counts as $0 and is listed.
//
// Review finding 9 (pass 4): the service starts runs of its own (the PE's, the designer's revisions), which the trial's
// check before its own runs does not bound. `claudeExposure` adds the runs under way at their limits, and the trial
// pauses the project once that reaches the cap.

const isClaude = (r) => ("snapshot" in r ? r.snapshot.provider : r.provider) === "claude";
const statusOf = (r) => ("status" in r ? r.status : r.outcome);

/**
 * Claude's estimated spend in the project: every Claude task attempt, lead run and studio run that was started.
 * `estimate(run)` is the domain's estimate ({ basis, usd }); `limitOf(run)` is the run limit the run had. Returns
 * the dollars and the runs with no recorded cost, each with what it was counted at.
 */
export function claudeSpend(state, { estimate, limitOf, simulated = false }) {
  const runs = [...state.attempts, ...state.leadRuns, ...state.studio.runs].filter(isClaude);
  let usd = 0;
  const unknown = [];
  for (const r of runs) {
    if (statusOf(r) === "queued") continue;
    const cost = estimate(r);
    if (cost.basis !== "unknown") {
      usd += cost.usd;
      continue;
    }
    const counted = simulated || r.simulated ? 0 : limitOf(r);
    unknown.push({ id: r.id, countedUsd: counted });
    usd += counted;
  }
  return { usd, unknown };
}

/**
 * What Claude could have spent once every run under way ends: the spend so far (`claudeSpend`, where a running run with
 * no cost yet counts at its limit), plus each queued Claude studio run at its limit. In the fake runtime it is the
 * spend so far.
 */
export function claudeExposure(state, opts) {
  const spend = claudeSpend(state, opts);
  const queued = state.studio.runs.filter((r) => isClaude(r) && r.status === "queued" && !r.simulated);
  const queuedUsd = opts.simulated ? 0 : queued.reduce((usd, r) => usd + opts.limitOf(r), 0);
  return { usd: spend.usd + queuedUsd, spend, queued: queued.map((r) => r.id) };
}
