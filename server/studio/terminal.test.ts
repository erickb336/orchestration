// ORC-029 pass 3, unit 3c: terminal demos. The tape rules (every refusal) and the hand-written
// fallback (asciicast v3 and .ans frames).

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ANS_CAP, CAST_CAP, TAPE_CAP, readTerminalFile, refusedEscape, validateAnsFrame, validateCast, validateTape } from "./terminal";

const FIXTURE = resolve(__dirname, "fixtures/trips");
const FALLBACK = resolve(__dirname, "fixtures/trips-fallback");
const SIZE = "Set Columns 80\nSet Rows 24\n";
const tape = (body: string) => `Output demo.gif\n${SIZE}${body}`;
const refusal = (text: string, o: Parameters<typeof validateTape>[1] = {}) => {
  const r = validateTape(text, o);
  expect(r.ok).toBe(false);
  return r.errors.join("\n");
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orc-terminal-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("tape validation", () => {
  it("accepts the trips fixture: its outputs, size and shell, and points every Output at the output folder", () => {
    const r = validateTape(readFileSync(join(FIXTURE, "trips.tape"), "utf8"), { name: "trips.tape", outDir: "/out/dir" });
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.outputs).toEqual({ gif: "trips.gif", webm: "trips.webm", txt: "trips.txt" });
    expect(r.size).toEqual({ cols: 80, rows: 24 });
    expect(r.shell).toBe("bash");
    const outs = r.normalized!.split("\n").filter((l) => l.startsWith("Output"));
    expect(outs).toEqual(['Output "/out/dir/trips.gif"', 'Output "/out/dir/trips.webm"', 'Output "/out/dir/trips.txt"']);
    // Everything else is kept as written.
    expect(r.normalized).toContain(`Type "alias trips='bash ./fake-trips' && clear"`);
  });

  it("refuses an Output outside the folder, of another type, or twice", () => {
    expect(refusal(`Output ../demo.gif\n${SIZE}`)).toMatch(/:1: Output must be one path inside/);
    expect(refusal(`Output /tmp/demo.gif\n${SIZE}`)).toMatch(/inside the tape's folder/);
    expect(refusal(`Output "~/demo.gif"\n${SIZE}`)).toMatch(/inside the tape's folder/);
    expect(refusal(`Output media/../../demo.gif\n${SIZE}`)).toMatch(/inside the tape's folder/);
    expect(refusal(`Output "$HOME/demo.gif"\n${SIZE}`)).toMatch(/inside the tape's folder/);
    expect(refusal(`Output demo.mp4\n${SIZE}`)).toMatch(/\.mp4 is not allowed \(webm, gif or txt\)/);
    expect(refusal(`Output demo.png\n${SIZE}`)).toMatch(/\.png is not allowed/);
    expect(refusal(`Output frames/\n${SIZE}`)).toMatch(/\.\(none\) is not allowed/);
    expect(refusal(`Output a.gif\nOutput b.gif\n${SIZE}`)).toMatch(/:2: a second \.gif Output/);
    expect(refusal(SIZE)).toMatch(/no Output/);
    // Inside the folder, a subfolder is fine.
    expect(validateTape(`Output media/demo.webm\n${SIZE}`).outputs).toEqual({ webm: "media/demo.webm" });
  });

  it("refuses Source of a path outside the folder, of a missing or non-tape file, nested, or of a tape that breaks the rules", () => {
    const files: Record<string, string> = { "intro.tape": 'Type "hello"\n', "nested.tape": "Source intro.tape\n", "fish.tape": "Set Shell fish\n", "out.tape": "Output /etc/evil.gif\n" };
    const readSource = (rel: string) => files[rel];
    expect(refusal(tape("Source ../other.tape\n"), { readSource })).toMatch(/Source must be one \.tape inside/);
    expect(refusal(tape("Source /etc/other.tape\n"), { readSource })).toMatch(/Source must be one \.tape inside/);
    expect(refusal(tape("Source notes.txt\n"), { readSource })).toMatch(/Source must be one \.tape inside/);
    expect(refusal(tape("Source missing.tape\n"), { readSource })).toMatch(/missing\.tape was not found/);
    expect(refusal(tape("Source nested.tape\n"), { readSource })).toMatch(/nested\.tape:1: a Source inside a sourced tape/);
    expect(refusal(tape("Source fish.tape\n"), { readSource })).toMatch(/fish\.tape:1: Set Shell must be bash or zsh/);
    expect(refusal(tape("Source out.tape\n"), { readSource })).toMatch(/out\.tape:1: Output must be one path inside/);
    expect(validateTape(tape("Source intro.tape\n"), { readSource }).ok).toBe(true);
  });

  it("refuses Require of a path, and Set Shell other than bash or zsh", () => {
    expect(refusal(tape("Require /usr/bin/curl\n"))).toMatch(/Require takes one program name, not a path/);
    expect(refusal(tape("Require ./fake-trips\n"))).toMatch(/Require takes one program name/);
    expect(refusal(tape("Require ../bin/x\n"))).toMatch(/Require takes one program name/);
    expect(validateTape(tape("Require bash\n")).ok).toBe(true);
    for (const sh of ["fish", "sh", "pwsh", "nu", "xonsh", "cmd", '"bash -c curl"']) expect(refusal(tape(`Set Shell ${sh}\n`))).toMatch(/Set Shell must be bash or zsh/);
    expect(validateTape(tape("Set Shell zsh\n")).shell).toBe("zsh");
    expect(validateTape(tape('Set Shell "bash"\n')).ok).toBe(true);
  });

  it("refuses a tape over the size cap", () => {
    const big = tape(`Type "${"x".repeat(TAPE_CAP)}"\n`);
    expect(refusal(big, { name: "big.tape" })).toMatch(/big\.tape: larger than 64 KB/);
  });

  it("refuses the clipboard, screenshots, Env, unknown commands and settings, MarginFill files and unterminated strings", () => {
    expect(refusal(tape('Copy "x"\n'))).toMatch(/Copy is not allowed/);
    expect(refusal(tape("Paste\n"))).toMatch(/Paste is not allowed/);
    expect(refusal(tape("Screenshot shot.png\n"))).toMatch(/Screenshot is not allowed/);
    expect(refusal(tape("Env NODE_OPTIONS --require=./evil.js\n"))).toMatch(/Env is not allowed/);
    expect(refusal(tape('Exec "curl example.com"\n'))).toMatch(/"Exec" is not a VHS command/);
    expect(refusal(tape("Set Bogus 1\n"))).toMatch(/Set Bogus is not a VHS setting/);
    expect(refusal(tape("Set MarginFill /etc/secret.png\n"))).toMatch(/MarginFill must be a colour/);
    expect(validateTape(tape('Set MarginFill "#674EFF"\n')).ok).toBe(true);
    expect(refusal(tape('Type "abc\n'))).toMatch(/an unterminated string/);
  });

  it("refuses a second command hidden on the same line, the way VHS's parser would read it", () => {
    expect(refusal(tape("Sleep 1s Output /tmp/evil.gif\n"))).toMatch(/one command per line \(found "Output" after Sleep\)/);
    expect(refusal(tape('Type "ls" Enter\n'))).toMatch(/one command per line/);
    // VHS strings have no escapes: the quote ends at the backslash, and Source is a command.
    expect(refusal(tape('Type "a\\" Source /etc/x.tape\n'))).toMatch(/one command per line \(found "Source"/);
    // Inside a string or a Wait /regex/, a keyword is text.
    expect(validateTape(tape('Type "Output /tmp/x.gif"\nWait+Screen@5s /Output done/\n')).ok).toBe(true);
  });

  it("requires a studio terminal size", () => {
    expect(refusal("Output demo.gif\n")).toMatch(/declare Set Columns and Set Rows \(80×24, 100×30, 120×40\)/);
    expect(refusal("Output demo.gif\nSet Columns 90\nSet Rows 30\n")).toMatch(/90×30 is not a studio terminal size/);
    expect(validateTape("Output demo.gif\nSet Columns 120\nSet Rows 40\n").size).toEqual({ cols: 120, rows: 40 });
  });
});

describe("the fallback: hand-written asciicast v3 and .ans frames", () => {
  const header = '{"version": 3, "term": {"cols": 80, "rows": 24}}';
  const cast = (...events: string[]) => [header, ...events].join("\n") + "\n";

  it("accepts the trips cast, with its size, duration and chapter markers", () => {
    const text = readTerminalFile(join(FALLBACK, "trips.cast"), CAST_CAP);
    expect(typeof text).toBe("string");
    const r = validateCast(text as string);
    expect(r).toMatchObject({ ok: true, info: { cols: 80, rows: 24, title: "trips plan (hand-written, not recorded)" } });
    if (!r.ok) return;
    expect(r.info.markers.map((m) => m.label)).toEqual(["trips plan", "trips pick 1"]);
    expect(r.info.duration).toBeGreaterThan(5);
    expect(r.info.events).toBe(24);
  });

  it("refuses a cast that is not v3, not a studio size, malformed, or longer or larger than the caps", () => {
    const bad = (text: string) => {
      const r = validateCast(text);
      expect(r.ok).toBe(false);
      return r.ok ? "" : r.error;
    };
    expect(bad('{"version": 2, "width": 80, "height": 24}\n')).toMatch(/version is not 3/);
    expect(bad('{"version": 3, "term": {"cols": 81, "rows": 24}}\n')).toMatch(/81×24 is not a studio terminal size/);
    expect(bad('{"version": 3}\n')).toMatch(/term\.cols and term\.rows/);
    expect(bad(cast("[0.5, \"o\", \"hi\"", ""))).toMatch(/line 2: not JSON/);
    expect(bad(cast('[0.5, "o"]'))).toMatch(/line 2: an event is \[interval, code, data\]/);
    expect(bad(cast('[-1, "o", "x"]'))).toMatch(/interval must be a number of seconds/);
    expect(bad(cast('[0.1, "z", "x"]'))).toMatch(/unknown event code "z"/);
    expect(bad(cast('[0.1, "r", "200x50"]'))).toMatch(/a resize must be COLSxROWS from the studio sizes/);
    expect(bad(cast('[0.1, "x", "zero"]'))).toMatch(/an exit status is a number/);
    expect(bad(cast('[601, "o", "x"]'))).toMatch(/longer than 10 minutes/);
    expect(bad(`${header}\n${'[0, "o", "xxxxxxxxxxxxxxxxxxxxxxxx"]\n'.repeat(CAST_CAP / 32 + 1)}`)).toMatch(/larger than 2 MB/);
    expect(bad('{"version": 3, "term": {"cols": 80, "rows": 24, "theme": {"fg": "red", "bg": "#000000", "palette": "#000000"}}}\n')).toMatch(/fg and bg must be #rrggbb/);
  });

  it("refuses escapes beyond colours and cursor moves: titles, links, clipboard writes, device control, mode switches", () => {
    const bad = (data: string) => {
      const r = validateCast(cast(JSON.stringify([0.1, "o", data])));
      expect(r.ok).toBe(false);
      return r.ok ? "" : r.error;
    };
    expect(bad("\u001b]0;pwned\u0007")).toMatch(/line 2: the escape/); // OSC title
    expect(bad("\u001b]52;c;Y3VybCBldmlsLnNo\u0007")).toMatch(/the escape/); // OSC 52 clipboard write
    expect(bad("\u001b]8;;https://example.com\u001b\\link\u001b]8;;\u001b\\")).toMatch(/the escape/); // OSC 8 link
    expect(bad("\u001bP$q\"p\u001b\\")).toMatch(/the escape/); // DCS request
    expect(bad("\u001b[6n")).toMatch(/the escape/); // cursor position report
    expect(bad("\u001b[?1049h")).toMatch(/the escape/); // alternate screen
    expect(bad("ding\u0007")).toMatch(/control character U\+0007/);
    expect(bad("\u009b31m")).toMatch(/control character U\+009B/); // 8-bit CSI
    // Allowed: colours (16, 256, true colour), cursor moves, erase, cursor show/hide.
    for (const ok of ["\u001b[1;31mred\u001b[0m", "\u001b[38;5;208mx", "\u001b[38;2;90;86;224m>", "\u001b[2J\u001b[H", "\u001b[10;5H", "\u001b[3A\u001b[2C\u001b[K", "\u001b[?25l\u001b[?25h", "a\r\n\tb\b"]) expect(refusedEscape(ok)).toBeUndefined();
  });

  it("accepts the trips TUI frame, and refuses a frame that is too wide, too tall, too large, or carries other escapes", () => {
    const text = readTerminalFile(join(FALLBACK, "trips-plan.ans"), ANS_CAP);
    expect(typeof text).toBe("string");
    const r = validateAnsFrame(text as string, { cols: 80, rows: 24 });
    expect(r).toEqual({ ok: true, info: { lines: 23, width: 80 } });
    const bad = (t: string, size?: { cols: number; rows: number }) => {
      const x = validateAnsFrame(t, size);
      expect(x.ok).toBe(false);
      return x.ok ? "" : x.error;
    };
    expect(bad("x".repeat(81), { cols: 80, rows: 24 })).toMatch(/81 characters wide, more than 80 columns/);
    expect(bad("\u001b[1m" + "x".repeat(80) + "\u001b[0m\n".repeat(25), { cols: 80, rows: 24 })).toMatch(/25 lines, more than 24 rows/);
    expect(bad("\u001b]8;;file:///etc/passwd\u0007open\u001b]8;;\u0007")).toMatch(/the escape/);
    expect(bad("y".repeat(ANS_CAP + 1))).toMatch(/larger than 64 KB/);
  });

  it("reads only regular UTF-8 files within the cap", () => {
    writeFileSync(join(dir, "bad.ans"), Buffer.from([0x41, 0xff, 0x42]));
    expect(readTerminalFile(join(dir, "bad.ans"), ANS_CAP)).toEqual({ error: "not valid UTF-8" });
    writeFileSync(join(dir, "big.cast"), "x".repeat(100));
    expect(readTerminalFile(join(dir, "big.cast"), 10)).toEqual({ error: "larger than 0 KB" });
    execFileSync("/bin/ln", ["-s", join(FALLBACK, "trips.cast"), join(dir, "link.cast")]);
    expect(readTerminalFile(join(dir, "link.cast"), CAST_CAP)).toEqual({ error: "not a regular file" });
  });
});
