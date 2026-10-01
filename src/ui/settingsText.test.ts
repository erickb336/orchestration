// ORC-025: the Advanced card's count of open lead proposals is said truthfully. The limit caps what planning
// adds, not what exists, so a count over the limit ("8 of 5") is explained instead of shown as a fraction.

import { describe, expect, it } from "vitest";
import { proposalsLine } from "./Settings";

describe("proposalsLine", () => {
  it("under the limit it is a plain count against the limit", () => {
    expect(proposalsLine(3, 0, 5)).toBe("Open lead proposals: 3 of at most 5.");
    expect(proposalsLine(5, 0, 5)).toBe("Open lead proposals: 5 of at most 5.");
  });

  it("over the limit it says why, and what planning does about it", () => {
    expect(proposalsLine(8, 0, 5)).toBe("Open lead proposals: 8, over the limit of 5, so planning proposes nothing new until fewer are open.");
    expect(proposalsLine(8, 0, 5)).not.toMatch(/8 of 5/);
  });

  it("deferred proposals are counted apart, with the cap that stops planning", () => {
    expect(proposalsLine(2, 1, 5)).toBe("Open lead proposals: 2 of at most 5. Deferred lead proposals: 1 proposal of at most 5; they do not count as open.");
    expect(proposalsLine(2, 5, 5)).toBe("Open lead proposals: 2 of at most 5. Deferred lead proposals: 5 proposals, at the limit of 5; they do not count as open, but planning stops until the lead drops some.");
  });
});
