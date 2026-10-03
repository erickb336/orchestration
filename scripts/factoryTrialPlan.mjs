// What the factory trial (scripts/factory-trial.mjs) plans to see, and the judgments it makes of what it saw. Pure, and
// shared with its unit test (scripts/factoryTrialPlan.test.ts).
//
// The plan: one Feature task builds the fixture's screen, CLI and flow (scripts/fixtures/factory-trial). Of the flow's
// rules and example, R1, R2 and E1 pass, and R3 fails on purpose (the fixture's README says how). So the screen and
// the CLI read "built and verified", and the flow "fails a check".

/** The rule results the trial plans: each line of the flow by its id, and the status its tests must give. */
export const PLANNED_RULES = { R1: "passed", R2: "passed", R3: "failed", E1: "passed" };

/** The factory status each kind of cited item must reach once the task landed. */
export const PLANNED_STATUSES = { screen: "built-and-verified", "terminal-demo": "built-and-verified", flow: "fails-a-check" };

/** The placeholder for the flow's blueprint item id in the fixture's R3 test (scripts/fixtures/factory-trial/r3-test.template.js). */
export const FLOW_ITEM_PLACEHOLDER = "{{FLOW_ITEM}}";

/** The fixture's R3 test with the flow's item id in its tag. */
export function renderR3Test(template, flowItemId) {
  if (!/^bi-\d+$/.test(flowItemId)) throw new Error(`"${flowItemId}" is not a blueprint item id`);
  if (!template.includes(FLOW_ITEM_PLACEHOLDER)) throw new Error(`the R3 test template has no ${FLOW_ITEM_PLACEHOLDER}`);
  return template.replaceAll(FLOW_ITEM_PLACEHOLDER, flowItemId);
}

/**
 * Whether the flow's rule results follow the plan: every planned line has its planned status, from the task's landed
 * work. `results` is the domain's ItemRuleResults (src/domain/studio/ruleResults.ts), or undefined.
 */
export function rulesAsPlanned(results, taskId) {
  if (!results) return { ok: false, detail: "the flow has no rule results" };
  const got = Object.fromEntries(results.results.map((r) => [r.id, r.status]));
  const wrong = Object.entries(PLANNED_RULES).filter(([id, want]) => got[id] !== want);
  const elsewhere = results.results.filter((r) => r.from && r.from.taskId !== taskId).map((r) => r.id);
  const extra = Object.keys(got).filter((id) => !(id in PLANNED_RULES));
  return {
    ok: !wrong.length && !elsewhere.length && !extra.length,
    detail: {
      results: results.results.map((r) => `${r.id} ${r.status}${r.message ? `: ${r.message}` : ""}`),
      ...(wrong.length ? { notAsPlanned: wrong.map(([id, want]) => `${id} is ${got[id] ?? "missing"}, planned ${want}`) } : {}),
      ...(elsewhere.length ? { fromOtherWork: elsewhere } : {}),
      ...(extra.length ? { unplannedLines: extra } : {}),
    },
  };
}

/**
 * Whether each cited item's factory status follows the plan. `views` are the domain's ItemFactoryView
 * (src/domain/studio/itemStatus.ts) of the cited items; an item with no view fails.
 */
export function statusesAsPlanned(views, itemIds) {
  const lines = itemIds.map((id) => {
    const v = views.find((x) => x?.item.id === id);
    const want = v ? PLANNED_STATUSES[v.item.kind] : undefined;
    return { item: id, kind: v?.item.kind ?? null, status: v?.status ?? null, planned: want ?? null, ok: !!v && v.status === want };
  });
  return { ok: lines.length > 0 && lines.every((l) => l.ok), detail: lines.map((l) => `${l.item} ${l.kind}: ${l.status}${l.ok ? "" : ` (planned ${l.planned})`}`) };
}

/**
 * The fixture check before any agent runs: the test run passed (exit 0), and its JUnit report has exactly one case
 * with R3's tag, recorded as failed, and no other failure. `cases` are the parsed report's (server/testReport.ts), and
 * `carriesTag` the domain's (src/domain/studio/ruleResults.ts).
 */
export function r3FailsOnPurpose({ exitCode, cases, tag, carriesTag }) {
  const tagged = cases.filter((c) => carriesTag(c, tag));
  const otherFailures = cases.filter((c) => !carriesTag(c, tag) && (c.status === "failed" || c.status === "error"));
  return {
    ok: exitCode === 0 && tagged.length === 1 && tagged[0].status === "failed" && !otherFailures.length,
    detail: { exitCode, tagged: tagged.map((c) => `${c.name}: ${c.status}`), otherFailures: otherFailures.map((c) => c.name) },
  };
}

/**
 * The limit of each run (Claude's maxBudgetUsd), from the cap: a fifth of it, at most $0.50, in whole cents. With the
 * $2 default, three reviews at once ($1.20) and the spend before them still fit under the cap.
 */
export function runLimitUsd(capUsd) {
  return Math.min(0.5, Math.floor((capUsd / 5) * 100) / 100);
}
