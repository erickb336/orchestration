// The structural check behind inlineStyles.test.ts. A screen must not size or colour things inline; it uses the
// kit (src/ui/kit) and the tokens.

export type InlineStyleHit = { line: number; text: string; why: "font size" | "colour" };

/** Every `style={{ … }}` in a TSX source whose object sets a font size or a literal colour. */
export function findInlineStyleDrift(source: string): InlineStyleHit[] {
  const hits: InlineStyleHit[] = [];
  const marker = "style={{";
  let from = 0;
  for (;;) {
    const start = source.indexOf(marker, from);
    if (start < 0) break;
    // Scan to the brace that closes the attribute, counting nested braces (template literals, nested objects).
    let depth = 0;
    let i = start + "style=".length;
    for (; i < source.length; i++) {
      const c = source[i];
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    const text = source.slice(start, i + 1);
    from = i + 1;
    const why = /\bfontSize\b/.test(text) ? "font size" : /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/.test(text) ? "colour" : null;
    if (why) hits.push({ line: source.slice(0, start).split("\n").length, text: text.replace(/\s+/g, " "), why });
  }
  return hits;
}
