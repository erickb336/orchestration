import type { State } from "../src/domain/types";

type AnyRun = State["attempts"][number] | State["leadRuns"][number] | State["studio"]["runs"][number];

export function claudeSpend(
  state: State,
  opts: { estimate: (run: AnyRun) => { basis: string; usd: number | null }; limitOf: (run: AnyRun) => number; simulated?: boolean },
): { usd: number; unknown: { id: string; countedUsd: number }[] };
