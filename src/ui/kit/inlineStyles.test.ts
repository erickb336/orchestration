// Screens do not size or colour things inline; they use the kit and the tokens, so the type scale and the state
// colours live in one place. This test fails on any `style={{ … }}` in a screen file that sets a font size or a
// literal colour (a style that only places something, such as a bar segment's width, is fine), and on a screen
// that asks with the browser's confirm() instead of the kit's in-page confirmation.

import { describe, expect, it } from "vitest";
import { findInlineStyleDrift } from "./inlineStyleCheck";

/** The screen files as source text: every .tsx under src/ui, not the kit (its own folder) and not tests. */
const sources: Record<string, string> = Object.fromEntries(
  Object.entries(import.meta.glob<string>(["../**/*.tsx", "!./**", "!../**/*.test.tsx"], { query: "?raw", import: "default", eager: true })).map(([path, text]) => [path.replace(/^\.\.\//, ""), text]),
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

  it("reads the screens in subfolders too, and leaves out the kit and the tests", () => {
    expect(screens).toContain("Overview.tsx");
    expect(screens).toContain("task/Steps.tsx");
    expect(screens).toContain("settings/Agents.tsx");
    expect(screens.some((f) => f.startsWith("kit/") || f.endsWith(".test.tsx"))).toBe(false);
  });
});

describe("screens confirm in the page", () => {
  // The kit's useConfirm shows the in-page dialog; the browser's confirm() blocks the page and cannot be styled. A
  // file that calls confirm() must have its own binding of that name: from useConfirm, or passed in as a `Confirm`.
  const ownConfirm = /\bconst confirm = useConfirm\(\)|\bconfirm\??\s*:\s*Confirm\b|[{,]\s*confirm\s*[,}]/;
  for (const file of screens) {
    it(file, () => {
      const src = sources[file];
      expect(src, `src/ui/${file} calls window.confirm; use the kit's useConfirm`).not.toMatch(/\bwindow\.confirm\(/);
      if (/(?<![\w.])confirm\(/.test(src)) expect(src, `src/ui/${file} calls the browser's confirm(); use the kit's useConfirm`).toMatch(ownConfirm);
    });
  }
});

describe("screens set no inline font sizes or colours", () => {
  for (const file of screens) {
    it(file, () => {
      const hits = findInlineStyleDrift(sources[file]);
      const where = hits.map((h) => `  line ${h.line} (${h.why}): ${h.text}`).join("\n");
      expect(
        hits.length,
        `src/ui/${file} has ${hits.length} inline style${hits.length === 1 ? "" : "s"} with a font size or colour.\n` +
          `Use the kit instead (src/ui/kit, gallery at #/kit): Button, Chip, StatePill, Banner, Row, Field, Disclosure, StepList, EmptyState, Toast;\n` +
          `or a token class: .small/.meta/.micro for size, .muted or a tone class for colour.\n${where}`,
      ).toBe(0);
    });
  }
});
