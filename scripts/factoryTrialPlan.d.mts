import type { TestCaseResult } from "../src/domain/types";
import type { ItemRuleResults } from "../src/domain/studio/ruleResults";
import type { ItemFactoryView } from "../src/domain/studio/itemStatus";

type Judged = { ok: boolean; detail: unknown };

export const PLANNED_RULES: Record<"R1" | "R2" | "R3" | "E1", "passed" | "failed">;
export const PLANNED_STATUSES: Record<"screen" | "terminal-demo" | "flow", string>;
export const FLOW_ITEM_PLACEHOLDER: string;
export function renderR3Test(template: string, flowItemId: string): string;
export function rulesAsPlanned(results: ItemRuleResults | undefined, taskId: string): Judged;
export function statusesAsPlanned(views: (ItemFactoryView | undefined)[], itemIds: string[]): Judged;
export function r3FailsOnPurpose(o: { exitCode: number | null; cases: TestCaseResult[]; tag: string; carriesTag: (c: Pick<TestCaseResult, "name" | "suite">, tag: string) => boolean }): Judged;
export function runLimitUsd(capUsd: number): number;
