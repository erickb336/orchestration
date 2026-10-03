// The bill splitter's core, shared by the page (index.html loads it) and the CLI (bin/split.js).
//
// Frozen for Orchestrator's factory trial: do not change this file. It drops the cents left over after rounding, which
// rule R3 of the flow "Splitting a bill" forbids. The trial leaves R3 failing on purpose, so that "Design and reality"
// shows a rule that fails a check; test/rules-r3.test.js records it.

/** Each person's share of `totalCents`, in cents, rounded down. Refuses fewer than one person. */
export function split(totalCents, people) {
  if (!Number.isInteger(people) || people < 1) throw new Error("Need at least one person");
  return Array.from({ length: people }, () => Math.floor(totalCents / people));
}

/** An amount in cents as dollars: 3000 is "$30.00". */
export const money = (cents) => `$${(cents / 100).toFixed(2)}`;
