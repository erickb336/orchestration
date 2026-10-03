// How a check run says where it ran: in the project's container (the environment, any language), in the host's
// sandbox, or with no sandbox. A container run is never labelled "ran without a sandbox", whatever the host setting.

import { describe, expect, it } from "vitest";
import { buildSeed } from "../domain/seed";
import type { CheckRunRecord } from "../domain/types";
import { CheckResults } from "./Findings";
import { renderScreen, visible } from "./testStore";

const T0 = Date.parse("2026-10-03T09:00:00Z");
const run = (over: Partial<CheckRunRecord>): CheckRunRecord => ({ sha: "a".repeat(40), configRev: 1, sandbox: "codex", touchedInputs: [], results: [], durationMs: 1000, ...over });
const text = (r: CheckRunRecord) => visible(renderScreen(<CheckResults run={r} attemptId="run-1" />, buildSeed(T0, { inFlightRuns: false })));

describe("where a check run ran", () => {
  it("a run in the project's container says so, and is not called unsandboxed", () => {
    const t = text(run({ sandbox: "none", environment: { ran: "container", from: "setting", image: "python:3.13-slim", prepare: "ran", key: "0123456789abcdef", prepareMs: 1200 } }));
    expect(t).toContain("in the project's container, with no network");
    expect(t).not.toContain("ran without a sandbox");
  });

  it("a host run says whether it was sandboxed, and warns when it was not", () => {
    expect(text(run({ sandbox: "codex" }))).toContain("sandboxed");
    const bare = text(run({ sandbox: "none" }));
    expect(bare).toContain("no sandbox");
    expect(bare).toContain("ran without a sandbox");
  });
});
