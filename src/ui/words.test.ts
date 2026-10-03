// ORC-029 pass 6, the words: the app says Vision (not Shaping), the factory (not Building), and Start the factory (not
// Start building); "Back to vision" is gone. The domain's stage values stay ("shaping", "building"), so the quoted value
// alone is allowed. This scans the text of every screen file (comments taken out) for the old words, so a new string
// with one fails here. Identifiers (ShapingBanner, heldForShaping) and class names (try-shaping) are not words the
// owner sees, and do not count.

import { describe, expect, it } from "vitest";

/** Every screen file under src/ui as source text, by its path under src/ui; not the tests or the test store. */
const sources: Record<string, string> = Object.fromEntries(
  Object.entries(import.meta.glob<string>(["./**/*.ts", "./**/*.tsx", "!./**/*.test.ts", "!./**/*.test.tsx", "!./testStore.tsx"], { query: "?raw", import: "default", eager: true })).map(([path, text]) => [path.replace(/^\.\//, ""), text]),
);

/**
 * Files with old words left on purpose, by path under src/ui, each with the reason. None today: Home (Overview.tsx,
 * Board.tsx) shows none either, though another unit rebuilds it.
 */
const EXCEPTIONS: Record<string, string> = {};

/** The old words: "Shaping" (any case) as a word, "Start building", "Back to vision". */
const OLD = /(?<![A-Za-z0-9_./-])shaping(?![A-Za-z0-9_-])|start building|back to vision/gi;
/** The domain's stage value, quoted: allowed, in a literal of its own or in code the JSX scan picks up. */
const STAGE_VALUE = /["'`]shaping["'`]/g;

/** The file without its comments: block comments (JSX ones too), then line comments that start a line or follow code. */
const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

/** The text a file can show: its string literals (quotes kept) and the JSX text between tags. Code and comments are not. */
function shownText(source: string): string[] {
  const text = withoutComments(source);
  const literals = [...text.matchAll(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g)].map((m) => m[0]);
  const jsx = [...text.matchAll(/>([^<>{}]+)</g)].map((m) => m[1]);
  return [...literals, ...jsx];
}

/** The texts with an old word, apart from the quoted stage value. */
const oldWords = (texts: string[]) => texts.filter((x) => new RegExp(OLD.source, "i").test(x.replace(STAGE_VALUE, ""))).map((x) => x.trim().slice(0, 120));

describe("the words across the app (ORC-029 pass 6)", () => {
  it('no screen says "Shaping", "Start building" or "Back to vision"; the exceptions are listed with a reason', () => {
    const files = Object.keys(sources).filter((f) => !Object.hasOwn(EXCEPTIONS, f));
    expect(files.length).toBeGreaterThan(50);
    expect(files.flatMap((f) => oldWords(shownText(sources[f])).map((x) => `${f}: ${x}`))).toEqual([]);
  });

  it("finds an old word in a string or in JSX text, never in code, a comment, a class name or the quoted stage value", () => {
    const sample = [
      'const a = "Shaping: nothing runs";',
      "const shaping = stage === 'shaping';",
      "// Shaping in a comment",
      "<p>Start building now</p>",
      "<p className='try-shaping'>{shaping ? 'x' : 'y'}</p>",
      'import { ShapingBanner } from "./Shaping";',
      "const b = `back to vision`;",
    ].join("\n");
    expect(oldWords(shownText(sample))).toEqual(['"Shaping: nothing runs"', "`back to vision`", "Start building now"]);
  });
});
