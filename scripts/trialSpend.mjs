// The studio trial's spend cap (scripts/studio-trial.mjs). Before it starts work, the trial adds up what Claude has
// spent in the project so far; it starts nothing that could pass the owner's cap. Shared with its unit test
// (scripts/trialSpend.test.ts).
//
// Review finding 8: a run with no recorded cost was counted as $0, so a few such runs could pass the cap unseen. Now
// each one counts at its run limit (Claude's maxBudgetUsd, the most it could spend), never as nothing. In the fake
// runtime nothing is spent, so a simulated run with no cost counts as $0 and is listed.

/**
 * Claude's estimated spend in the project: every Claude task attempt, lead run and studio run that was started.
 * `estimate(run)` is the domain's estimate ({ basis, usd }); `limitOf(run)` is the run limit the run had. Returns
 * the dollars and the runs with no recorded cost, each with what it was counted at.
 */
export function claudeSpend(state, { estimate, limitOf, simulated = false }) {
  const runs = [
    ...state.attempts.filter((a) => a.snapshot.provider === "claude"),
    ...state.leadRuns.filter((r) => r.provider === "claude"),
    ...state.studio.runs.filter((r) => r.provider === "claude"),
  ];
  let usd = 0;
  const unknown = [];
  for (const r of runs) {
    if (("status" in r ? r.status : r.outcome) === "queued") continue;
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
