// A disabled button keeps its look under the pointer. The kit's Button disables in two ways: `disabled`, or
// `aria-disabled` when it has a reason to show or is loading (it stays focusable). A hover rule that skips only
// `:disabled` still paints an aria-disabled button: the global `button:hover` once gave a disabled primary button the
// hover background under its dark label, so the label could not be read (ORC-030 QA, Q-11). So every hover rule that
// can reach a kit button (a bare `button` selector, or `.k-btn`) skips both.

import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** The stylesheets as source text: every .css under src/ui, by its path from there. */
const UI = fileURLToPath(new URL("..", import.meta.url));
const sheets: Record<string, string> = Object.fromEntries(
  readdirSync(UI, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".css"))
    .map((f) => [relative(UI, join(UI, f)), readFileSync(join(UI, f), "utf8")]),
);

/** Each selector of each rule, comments removed. */
function selectors(css: string): string[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...clean.matchAll(/([^{}]+)\{[^{}]*\}/g)].flatMap((m) => m[1].split(",").map((s) => s.trim())).filter(Boolean);
}

/** A hover selector whose last part can match a kit button: `button` as an element, or the kit's `.k-btn`. */
const reachesKitButton = (sel: string) => {
  const last = sel.split(/\s+|>|\+|~/).filter(Boolean).at(-1) ?? "";
  return /:hover/.test(last) && (/^button(?![\w-])/.test(last) || /\.k-btn(?![\w-])/.test(last));
};

describe("a disabled button has no hover look", () => {
  it("reads the stylesheets", () => {
    expect(Object.keys(sheets)).toEqual(expect.arrayContaining(["styles.css", "kit/kit.css"]));
  });

  for (const [file, css] of Object.entries(sheets)) {
    it(file, () => {
      const wrong = selectors(css).filter((s) => reachesKitButton(s) && !(/:not\(:disabled\)/.test(s) && /:not\(\[aria-disabled="true"\]\)/.test(s)));
      expect(wrong, `src/ui/${file}: a hover rule on a button must skip :disabled and [aria-disabled="true"]`).toEqual([]);
    });
  }
});
