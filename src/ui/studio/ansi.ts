// Terminal text for the studio (ORC-029 pass 3d): a hand-written `.ans` frame, a `.cast` file's transcript, or a
// recording's `.txt`, drawn by the app inside a terminal window. Pure: no DOM.
//
// The text is the designer's, so it is only ever text: the renderer turns it into lines of runs, each with a class
// name, and React writes the runs as text. Colours become classes (studio.css maps them to the kit's tokens), never
// inline colours. What it understands is what the service's validators allow (server/studio/terminal.ts): colours
// and text attributes (SGR), cursor moves, erase in display or line, and cursor show or hide. Anything else is
// dropped, not drawn.

/** The terminal sizes a design may use, columns × rows (the same list as server/studio/terminal.ts). */
export const TERMINAL_SIZES: readonly (readonly [number, number])[] = [
  [80, 24],
  [100, 30],
  [120, 40],
];

const COLOURS = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const;
type Colour = (typeof COLOURS)[number];

/** A run of text with one style: `cls` is "" for the terminal's default, else class names from studio.css (st-a-…). */
export interface Run {
  text: string;
  cls: string;
}
export type TermLine = Run[];

interface Style {
  fg?: Colour;
  bg?: Colour;
  bright?: boolean;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

function classOf(st: Style): string {
  let fg: string | undefined = st.fg;
  let bg: string | undefined = st.bg;
  if (st.inverse) [fg, bg] = [bg ?? "bg", fg ?? "fg"];
  return [fg && `st-a-fg-${fg}`, bg && `st-a-bg-${bg}`, st.bright && fg && fg !== "bg" && "st-a-bright", st.bold && "st-a-bold", st.dim && "st-a-dim", st.italic && "st-a-italic", st.underline && "st-a-underline"].filter(Boolean).join(" ");
}

/** The nearest of the eight basic colours to an RGB value: a 256-colour or true-colour escape still uses the tokens. */
function nearest(r: number, g: number, b: number): Colour {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 40) return max < 100 ? "black" : "white";
  const on = (v: number) => v > (max + min) / 2;
  const key = `${on(r) ? 1 : 0}${on(g) ? 1 : 0}${on(b) ? 1 : 0}`;
  const byKey: Record<string, Colour> = { "100": "red", "010": "green", "110": "yellow", "001": "blue", "101": "magenta", "011": "cyan", "111": "white", "000": "black" };
  return byKey[key];
}

function colour256(n: number): { colour: Colour; bright: boolean } | undefined {
  if (!Number.isInteger(n) || n < 0 || n > 255) return undefined;
  if (n < 16) return { colour: COLOURS[n % 8], bright: n >= 8 };
  if (n >= 232) return { colour: n < 244 ? "black" : "white", bright: n >= 244 };
  const i = n - 16;
  const level = (x: number) => (x === 0 ? 0 : 55 + x * 40);
  return { colour: nearest(level(Math.floor(i / 36)), level(Math.floor(i / 6) % 6), level(i % 6)), bright: false };
}

/** Apply one SGR escape's parameters ("1;31", "38;5;208", "38:2::255:0:0") to a style. */
function sgr(style: Style, params: string): Style {
  const st = { ...style };
  const parts = params === "" ? ["0"] : params.split(";");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    // An extended colour, in either form: 38;5;n / 38;2;r;g;b, or with colons 38:5:n / 38:2::r:g:b.
    const sub = part.includes(":") ? part.split(":") : undefined;
    const head = Number(sub ? sub[0] : part);
    if (head === 38 || head === 48) {
      let mode: number;
      let args: number[];
      if (sub) {
        mode = Number(sub[1]);
        args = sub.slice(2).filter((x) => x !== "").map(Number);
        if (mode === 2 && args.length === 4) args = args.slice(1); // a colour-space id before r:g:b
      } else {
        mode = Number(parts[i + 1]);
        args = mode === 5 ? [Number(parts[i + 2])] : mode === 2 ? [Number(parts[i + 2]), Number(parts[i + 3]), Number(parts[i + 4])] : [];
        i += mode === 5 ? 2 : mode === 2 ? 4 : 1;
      }
      const c = mode === 5 ? colour256(args[0]) : mode === 2 && args.length === 3 && args.every((x) => Number.isFinite(x)) ? { colour: nearest(args[0], args[1], args[2]), bright: false } : undefined;
      if (c && head === 38) {
        st.fg = c.colour;
        st.bright = c.bright;
      } else if (c) st.bg = c.colour;
      continue;
    }
    const n = head;
    if (n === 0 || Number.isNaN(n)) Object.assign(st, { fg: undefined, bg: undefined, bright: false, bold: false, dim: false, italic: false, underline: false, inverse: false });
    else if (n === 1) st.bold = true;
    else if (n === 2) st.dim = true;
    else if (n === 3) st.italic = true;
    else if (n === 4) st.underline = true;
    else if (n === 7) st.inverse = true;
    else if (n === 22) st.bold = st.dim = false;
    else if (n === 23) st.italic = false;
    else if (n === 24) st.underline = false;
    else if (n === 27) st.inverse = false;
    else if (n >= 30 && n <= 37) [st.fg, st.bright] = [COLOURS[n - 30], false];
    else if (n === 39) [st.fg, st.bright] = [undefined, false];
    else if (n >= 40 && n <= 47) st.bg = COLOURS[n - 40];
    else if (n === 49) st.bg = undefined;
    else if (n >= 90 && n <= 97) [st.fg, st.bright] = [COLOURS[n - 90], true];
    else if (n >= 100 && n <= 107) st.bg = COLOURS[n - 100];
  }
  return st;
}

type Cell = { ch: string; cls: string };

/**
 * Draw terminal text into lines of styled runs. `cols` wraps long lines (as a terminal does); `rows` is the screen
 * height that absolute cursor positions and "erase display" are relative to (the last `rows` lines). Lines grow as
 * needed, so a recording's whole transcript is kept. A newline also returns to the first column, as a terminal does
 * for a program's output. Trailing blanks are trimmed.
 */
export function renderAnsi(text: string, size: { cols: number; rows: number } = { cols: 120, rows: 40 }): TermLine[] {
  const grid: Cell[][] = [[]];
  let r = 0;
  let c = 0;
  let style: Style = {};
  let cls = "";
  const top = () => Math.max(0, grid.length - size.rows);
  const row = (n: number) => {
    while (grid.length <= n) grid.push([]);
    return grid[n];
  };
  const put = (ch: string) => {
    if (c >= size.cols) {
      r++;
      c = 0;
    }
    const line = row(r);
    while (line.length < c) line.push({ ch: " ", cls: "" });
    line[c] = { ch, cls };
    c++;
  };
  const erase = (line: Cell[], from: number, to: number) => {
    for (let i = from; i < Math.min(to, line.length); i++) line[i] = { ch: " ", cls: "" };
  };
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === "\x1b") {
      if (chars[i + 1] !== "[") continue; // not a CSI: the validator refuses it; drop the escape character
      let j = i + 2;
      let params = "";
      while (j < chars.length && /[0-9;:?]/.test(chars[j]) && params.length < 64) params += chars[j++];
      const final = chars[j] ?? "";
      i = j;
      const nums = params.replace(/^\?/, "").split(";").map((x) => (x === "" ? NaN : Number(x)));
      const n = Number.isFinite(nums[0]) && nums[0] > 0 ? nums[0] : 1;
      switch (final) {
        case "m":
          style = sgr(style, params);
          cls = classOf(style);
          break;
        case "A":
          r = Math.max(top(), r - n);
          break;
        case "B":
          r += n;
          break;
        case "C":
          c = Math.min(size.cols - 1, c + n);
          break;
        case "D":
          c = Math.max(0, c - n);
          break;
        case "E":
          r += n;
          c = 0;
          break;
        case "F":
          r = Math.max(top(), r - n);
          c = 0;
          break;
        case "G":
          c = Math.min(size.cols - 1, n - 1);
          break;
        case "d":
          r = top() + Math.min(size.rows - 1, n - 1);
          break;
        case "H":
        case "f": {
          const t = top();
          r = t + Math.min(size.rows - 1, (Number.isFinite(nums[0]) && nums[0] > 0 ? nums[0] : 1) - 1);
          c = Math.min(size.cols - 1, (Number.isFinite(nums[1]) && nums[1] > 0 ? nums[1] : 1) - 1);
          break;
        }
        case "J": {
          const mode = Number.isFinite(nums[0]) ? nums[0] : 0;
          const t = top();
          if (mode === 0) {
            erase(row(r), c, Infinity);
            for (let k = r + 1; k < grid.length; k++) grid[k] = [];
          } else if (mode === 1) {
            for (let k = t; k < r; k++) grid[k] = [];
            erase(row(r), 0, c + 1);
          } else for (let k = t; k < grid.length; k++) grid[k] = [];
          break;
        }
        case "K": {
          const mode = Number.isFinite(nums[0]) ? nums[0] : 0;
          const line = row(r);
          if (mode === 0) erase(line, c, Infinity);
          else if (mode === 1) erase(line, 0, c + 1);
          else erase(line, 0, Infinity);
          break;
        }
        default:
          break; // cursor show or hide, or anything else: nothing to draw
      }
      continue;
    }
    if (ch === "\n") {
      r++;
      c = 0;
      row(r);
    } else if (ch === "\r") c = 0;
    else if (ch === "\t") c = Math.min(size.cols - 1, (Math.floor(c / 8) + 1) * 8);
    else if (ch === "\b") c = Math.max(0, c - 1);
    else if (ch < " " || ch === "\x7f" || (ch >= "\x80" && ch <= "\x9f")) continue;
    else put(ch);
  }
  // Runs of one style; trailing default blanks and trailing empty lines go.
  const lines = grid.map((cells) => {
    let end = cells.length;
    while (end > 0 && cells[end - 1].ch === " " && cells[end - 1].cls === "") end--;
    const runs: TermLine = [];
    for (const cell of cells.slice(0, end)) {
      const last = runs.at(-1);
      if (last && last.cls === cell.cls) last.text += cell.ch;
      else runs.push({ text: cell.ch, cls: cell.cls });
    }
    return runs;
  });
  while (lines.length > 1 && lines.at(-1)!.length === 0) lines.pop();
  return lines;
}

/** The smallest studio terminal size the frame fits in (widest line × line count), or the largest. */
export function frameSize(text: string): { cols: number; rows: number } {
  const lines = renderAnsi(text, { cols: 1000, rows: 1000 });
  const width = Math.max(0, ...lines.map((l) => l.reduce((n, run) => n + Array.from(run.text).length, 0)));
  const fit = TERMINAL_SIZES.find(([cols, rows]) => width <= cols && lines.length <= rows) ?? TERMINAL_SIZES[TERMINAL_SIZES.length - 1];
  return { cols: fit[0], rows: fit[1] };
}

/** An asciicast file read for its transcript: the terminal size, the title, the output, and the chapter markers. */
export type CastTranscript = { ok: true; cols: number; rows: number; title?: string; output: string; markers: string[] } | { ok: false; error: string };

/**
 * Read an asciicast (v3, or v2) for its text transcript: the output events joined in order. The service validated it
 * on import; this reads defensively anyway and says what is wrong instead of throwing.
 */
export function readCast(text: string): CastTranscript {
  const lines = text.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
  if (!lines.length) return { ok: false, error: "the file is empty" };
  let header: { version?: unknown; term?: { cols?: unknown; rows?: unknown }; width?: unknown; height?: unknown; title?: unknown };
  try {
    header = JSON.parse(lines[0]);
  } catch {
    return { ok: false, error: "its first line is not an asciicast header" };
  }
  const cols = Number(header?.term?.cols ?? header?.width);
  const rows = Number(header?.term?.rows ?? header?.height);
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) return { ok: false, error: "its header has no terminal size" };
  let output = "";
  const markers: string[] = [];
  for (const line of lines.slice(1)) {
    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      return { ok: false, error: "an event line is not JSON" };
    }
    if (!Array.isArray(ev) || ev.length < 3 || typeof ev[2] !== "string") continue;
    if (ev[1] === "o") output += ev[2];
    else if (ev[1] === "m" && ev[2]) markers.push(ev[2]);
  }
  return { ok: true, cols, rows, ...(typeof header.title === "string" && header.title ? { title: header.title } : {}), output, markers };
}
