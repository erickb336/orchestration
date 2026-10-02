import type { State } from "../src/domain/types";

type AnyRun = State["attempts"][number] | State["leadRuns"][number] | State["studio"]["runs"][number];
type SpendOpts = { estimate: (run: AnyRun) => { basis: string; usd: number | null }; limitOf: (run: AnyRun) => number; simulated?: boolean };
type ClaudeSpend = { usd: number; unknown: { id: string; countedUsd: number }[] };

export function claudeSpend(state: State, opts: SpendOpts): ClaudeSpend;

export function claudeExposure(state: State, opts: SpendOpts): { usd: number; spend: ClaudeSpend; queued: string[] };
