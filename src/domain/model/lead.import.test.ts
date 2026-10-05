// ORC-032: the lead's run that writes the import's review message. Once the import is in review, one reply in Vision
// says what it found and drafts the vision; none while the import reads, none at the import's stop, and none once a
// reply has answered the review.

import { describe, expect, it } from "vitest";
import * as M from "../model";
import { importStop } from "../spend";
import { at, tallyImport } from "../testing/import";

const due = (s: Parameters<typeof M.leadDue>[0]) => M.leadDue(s, Date.parse(at(500)), 600);

describe("the lead's review of the import", () => {
  it("is due once the import is in review, as a reply in Vision, and not while it reads", () => {
    expect(due(tallyImport("parts").s)).toBeNull();
    expect(due(tallyImport("review").s)).toBe("message");
  });

  it("is due once: a completed reply since the review answers it, and a failed one is retried", () => {
    const { s } = tallyImport("review");
    const r = M.startLeadRun(s, { provider: "claude", model: "claude-sample-large", trigger: "message" }, at(200));
    expect(due(r.state)).toBeNull();
    const failed = M.reportLeadFailed(r.state, r.runId, "the provider was down", at(210));
    expect(M.leadDue(failed, Date.parse(at(210)) + 2 * 60_000, 600)).toBe("message");
    const done = M.completeLeadRun(r.state, r.runId, { reply: "I read tally.", proposals: [] }, at(220));
    expect(due(done)).toBeNull();
  });

  it("waits at the import's stop", () => {
    const { s } = tallyImport("review");
    s.studio.import!.budgetUsd = 0.000001;
    s.studio.runs[0].usage = { costUsd: 1 } as never;
    expect(importStop(s)).toBeDefined();
    expect(due(s)).toBeNull();
  });
});
