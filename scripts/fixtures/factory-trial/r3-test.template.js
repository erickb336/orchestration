// Rule R3 of the flow "Splitting a bill" ({{FLOW_ITEM}} in Orchestrator's blueprint), deliberately left failing for the
// factory trial. public/split.js drops the cents left over after rounding, and the trial keeps it so. This is a todo
// test: Node's test runner does not fail the run for it, and its JUnit report still records the failure. So the
// checks pass while the rule reads "failed". Do not change this file or public/split.js.
import assert from "node:assert/strict";
import { test } from "node:test";
import { split } from "../public/split.js";

test("[{{FLOW_ITEM}} R3] the shares add up to the total: the first person pays the cents left over", { todo: "deliberately left failing for the factory trial" }, () => {
  assert.deepEqual(split(10000, 3), [3334, 3333, 3333]);
});
