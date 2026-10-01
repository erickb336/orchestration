// Cleaning text an agent supplies before it is stored or shown again: control characters are rejected,
// invisible characters that change how text reads are stripped, and one-line fields stay on one line.



// Control characters other than newline and tab (those are whitespace, collapsed by `oneLine`).
export const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
/**
 * ORC-012 review 5 and ORC-014 review 3: characters that show nothing but change how text reads or is
 * matched. Text the lead supplies (drafts, questions, options, coverage, steering reasons and the focus)
 * and document text in envelopes lose: C1 controls, the zero-width space, bidi embeddings and overrides
 * (U+202A–202E) and isolates (U+2066–2069), the word joiner, the byte-order mark, and tag characters
 * outside a valid emoji tag sequence. Legitimate text keeps what it needs: ZWJ inside emoji sequences
 * and between letters, ZWNJ between letters (Persian, Devanagari), LRM/RLM, variation selectors, and
 * emoji tag sequences (U+1F3F4, tags, U+E007F: subdivision flags). Text the user typed is never altered.
 */
const HOSTILE_RE = /[\u0080-\u009F\u200B\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/gu;
/** A valid emoji tag sequence is kept whole; any other tag character goes. */
const TAG_RE = /(\u{1F3F4}[\u{E0020}-\u{E007E}]+\u{E007F})|[\u{E0000}-\u{E007F}]/gu;
const JOINER_RE = /[\u200C\u200D]/gu;
const LETTER_RE = /[\p{L}\p{M}]/u;
const EMOJI_BEFORE_RE = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\uFE0F]/u;
const EMOJI_AFTER_RE = /\p{Extended_Pictographic}/u;
/** Nothing visible: whitespace and the invisible characters legitimate text may keep. */
const ONLY_INVISIBLE_RE = /^[\s\u200C-\u200F\uFE0E\uFE0F]*$/u;

const codePointBefore = (x: string, i: number): string => {
  if (i <= 0) return "";
  const lo = x.charCodeAt(i - 1);
  if (lo >= 0xdc00 && lo <= 0xdfff && i >= 2) return x.slice(i - 2, i);
  return x[i - 1];
};
const codePointAfter = (x: string, i: number): string => {
  const cp = x.codePointAt(i);
  return cp === undefined ? "" : String.fromCodePoint(cp);
};

/** Remove hostile invisible characters, keeping the joiners and marks legitimate text needs. Reports how many were removed. */
export function stripHostile(x: string): { text: string; removed: number } {
  let removed = 0;
  let out = x.replace(HOSTILE_RE, () => {
    removed += 1;
    return "";
  });
  out = out.replace(TAG_RE, (_m, seq: string | undefined) => {
    if (seq) return seq;
    removed += 1;
    return "";
  });
  out = out.replace(JOINER_RE, (m, offset: number, whole: string) => {
    const before = codePointBefore(whole, offset);
    const after = codePointAfter(whole, offset + 1);
    const betweenLetters = LETTER_RE.test(before) && LETTER_RE.test(after);
    const inEmoji = m === "\u200D" && (EMOJI_BEFORE_RE.test(before) || EMOJI_AFTER_RE.test(after));
    if (betweenLetters || inEmoji) return m;
    removed += 1;
    return "";
  });
  return { text: out, removed };
}
export const stripInvisible = (x: string) => stripHostile(x).text;
/** Text with nothing visible in it counts as empty. */
export const visibleOrEmpty = (x: string) => (ONLY_INVISIBLE_RE.test(x) ? "" : x);
/**
 * Review finding 8: every text the lead supplies (focus, reason, why) is one line of plain text. The
 * focus is printed verbatim in every later envelope, so newlines would give injected text a persistent
 * channel; control characters are rejected outright by `CONTROL_RE`, invisible ones are stripped.
 */
export const oneLine = (x: string) => visibleOrEmpty(stripInvisible(x).replace(/\s+/g, " ").trim());
