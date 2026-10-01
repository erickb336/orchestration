// ORC-025 r3: screens do not size or colour things inline; they use the kit and the tokens. The screens written
// before the kit still do, so inlineStyles.baseline.json holds today's count per file and this test fails only when
// a file's count goes up. When a pass lowers a count, it lowers the baseline too (the test says so).

import { describe, expect, it } from "vitest";
import baseline from "./inlineStyles.baseline.json";
import { findInlineStyleDrift } from "./inlineStyleCheck";

const allowed: Record<string, number> = baseline;

/** The screen files as source text: src/ui/*.tsx, not the kit (its own folder) and not tests. */
const sources: Record<string, string> = Object.fromEntries(
  Object.entries(import.meta.glob<string>("../*.tsx", { query: "?raw", import: "default", eager: true }))
    .map(([path, text]) => [path.replace(/^.*\//, ""), text])
    .filter(([file]) => !file.endsWith(".test.tsx")),
);
const screens = Object.keys(sources).sort();

describe("the inline-style check", () => {
  it("finds font sizes and literal colours in style objects, and nothing else", () => {
    const src = [
      '<p style={{ fontSize: "0.85rem" }}>a</p>',
      '<span style={{ color: "#e3a14a" }}>b</span>',
      '<i style={{ background: "rgb(0 0 0 / 0.5)" }} />',
      '<i style={{ borderColor: `rgba(${r}, 0, 0, 1)` }} />',
      '<div style={{ display: "contents" }} />',
      '<div style={{ width: `${pct}%`, marginLeft: "0.35rem" }} />',
      '<a href="#/tasks" style={{ padding: 0 }} />',
    ].join("\n");
    const hits = findInlineStyleDrift(src);
    expect(hits.map((h) => [h.line, h.why])).toEqual([
      [1, "font size"],
      [2, "colour"],
      [3, "colour"],
      [4, "colour"],
    ]);
    expect(hits[0].text).toBe('style={{ fontSize: "0.85rem" }}');
  });

  it("names every baseline file (a renamed or deleted screen leaves a stale entry)", () => {
    for (const file of Object.keys(allowed)) expect(screens, `${file} is in inlineStyles.baseline.json but not in src/ui`).toContain(file);
  });
});

describe("screens do not add inline font sizes or colours", () => {
  for (const file of screens) {
    it(file, () => {
      const hits = findInlineStyleDrift(sources[file]);
      const max = allowed[file] ?? 0;
      const where = hits.map((h) => `  line ${h.line} (${h.why}): ${h.text}`).join("\n");
      expect(
        hits.length,
        `src/ui/${file} has ${hits.length} inline style${hits.length === 1 ? "" : "s"} with a font size or colour; the baseline allows ${max}.\n` +
          `Use the kit instead (src/ui/kit, gallery at #/kit): Button, Chip, StatePill, Banner, Row, Field, Disclosure, StepList, EmptyState, Toast;\n` +
          `or a token class: .small/.meta/.micro for size, .muted or a tone class for colour.\n${where}`,
      ).toBeLessThanOrEqual(max);
      if (hits.length < max) console.info(`inlineStyles: src/ui/${file} is down to ${hits.length} (baseline ${max}); lower it in src/ui/kit/inlineStyles.baseline.json.`);
    });
  }
});
