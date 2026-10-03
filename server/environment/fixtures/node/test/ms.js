// A dependency from the npm registry, installed in the prepare phase and used with no network.
const { test } = require("node:test");
const assert = require("node:assert");
const ms = require("ms");

test("ms reads a duration", () => {
  assert.strictEqual(ms("2 days"), 172800000);
});
