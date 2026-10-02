// ORC-029 terminal demos. The tape rules (every refusal), the hand-written fallback (asciicast v3 and .ans frames), and,
// where Docker runs and the recorder's image is built, real recordings in the container: the trips fixture and the
// studio's terminal sample with their transcripts, a hostile tape whose commands try the network, the host, the owner's
// terminals and files, and writes outside the copy, a timeout that kills the container, and a docker that drops the
// isolation, which the probe catches.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultRecorderRoot, dockerReady } from "./container";
import { TERMINAL_SAMPLE_FILES } from "./sample";
import { ANS_CAP, CAST_CAP, FAILURE_SIGNATURES, TAPE_CAP, readTerminalFile, recordTape, refusedEscape, transcriptError, validateAnsFrame, validateCast, validateTape } from "./terminal";

const FIXTURE = resolve(__dirname, "fixtures/trips");
const FALLBACK = resolve(__dirname, "fixtures/trips-fallback");
/** As the real trial (ORC-029 pass 3) wrote it: demo/demo.tape runs demo/trips.js by its path from the artifact's root. */
const SUBFOLDER = resolve(__dirname, "fixtures/trips-subfolder");
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

describe("a recording's transcript, scanned for failures", () => {
  // As the real studio trial's transcript showed it (ORC-029 pass 3): the script was not where the shell started.
  const TRIAL = [
    "────────────────────────────────────────────────────────────────────────────────",
    "> alias trips='node demo/trips.js'",
    "> trips plan",
    "node:internal/modules/cjs/loader:1573",
    "  throw err;",
    "  ^",
    "Error: Cannot find module '/private/var/folders/wk/ppy3ppz520j5gq98s27qc2gr0000g",
    "n/T/orc-vhs-t76sgM/work/demo/trips.js'",
    "    at Module._resolveFilename (node:internal/modules/cjs/loader:1569:15)",
    "Node.js v26.8.2",
    ">",
  ].join("\n");

  it("names the first line with a failure signature, as the trial's would have been", () => {
    expect(transcriptError(TRIAL)).toBe("Error: Cannot find module '/private/var/folders/wk/ppy3ppz520j5gq98s27qc2gr0000g");
  });

  it("knows each signature in its short list, by a line a real tool prints", () => {
    // One line per signature, in the list's order: a new signature needs a line here.
    const printed = [
      "Error: Cannot find module 'left-pad'",
      "zsh: command not found: trips",
      "cat: plans/weekend.json: No such file or directory",
      "bash: ./demo/trips.js: Permission denied",
      "ReferenceError: ideas is not defined",
      "Traceback (most recent call last):",
      "panic: runtime error: index out of range [3] with length 3",
      "bash: line 1: 4242 Segmentation fault: 11  ./trips",
      "[1]+  Exit 1                  trips pick 9",
    ];
    expect(printed).toHaveLength(FAILURE_SIGNATURES.length);
    FAILURE_SIGNATURES.forEach((s, i) => expect(s.line.test(printed[i]), s.what).toBe(true));
    const more = ["bash: trips: command not found", "zsh: no such file or directory: ./trips", "touch: /Users/owner/x: Operation not permitted", "Error: connect EPERM 1.1.1.1:443", "Error [ERR_REQUIRE_ESM]: require() of ES Module", "TypeError: Cannot read properties of undefined (reading 'name')", "SyntaxError: Unexpected token '}'", "Uncaught RangeError: Invalid array length", "zsh: exit 1     trips pick 9"];
    for (const line of [...printed, ...more]) expect(transcriptError(`> trips plan\n${line}\n>`), line).toBe(line);
  });

  it("passes a clean demo, its own words about errors, and the commands typed at the prompt", () => {
    const clean = [
      "> trips plan",
      "Weekend of Oct 11-12  5 friends, 3 ideas",
      "  Error: an indented line is the demo's own text",
      "Errors: 0   Warnings: 0",
      "trips check: no errors found",
      "> node demo/trips.js 2>&1 | grep 'command not found'",
      "> echo 'Error: shown on purpose' # the typed command, not its output",
      ">",
    ].join("\n");
    expect(transcriptError(clean)).toBeUndefined();
  });
});

// ---------- real recordings, in the recorder's container where Docker and the image are present ----------

describe("never outside the container", () => {
  it("refuses to record without Docker, and a tape whose shell the recorder does not have, before anything runs", async () => {
    const missing = await recordTape(FIXTURE, join(dir, "out1"), { docker: join(dir, "no-docker"), tmpRoot: dir });
    expect(missing).toMatchObject({ sandbox: null, reason: "unavailable" });
    expect(missing.error).toBe(`Not recorded: Docker is not installed (${join(dir, "no-docker")} was not found). Nothing runs unsandboxed; use a hand-written .cast or .ans instead.`);
    expect(readdirSync(join(dir, "out1"))).toEqual([]);
    // The stage folder is removed.
    expect(readdirSync(dir).filter((f) => f.startsWith("orc-rec-"))).toEqual([]);
    const src = join(dir, "zsh");
    mkdirSync(src);
    writeFileSync(join(src, "demo.tape"), `Output demo.gif\nSet Shell zsh\n${SIZE}Type "echo hi"\nEnter\n`);
    const zsh = await recordTape(src, join(dir, "out2"), { docker: join(dir, "no-docker"), tmpRoot: dir });
    expect(zsh).toMatchObject({ sandbox: null, reason: "unavailable", error: "Not recorded: the recorder has bash only, and this tape sets zsh (Set Shell bash records). Use a hand-written .cast or .ans instead." });
  });
});

const ready = await dockerReady();
const skipReason = ready.ok ? "" : ` (skipped: ${ready.reason})`;
mkdirSync(defaultRecorderRoot(), { recursive: true });
/** Where these recordings stage their folders: one Docker can see. Each recording's stage must be gone afterwards. */
const ROOT = mkdtempSync(join(defaultRecorderRoot(), "test-terminal-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
/** This process's containers that still exist (running or not). */
const containersLeft = () => (ready.ok ? execFileSync(ready.docker, ["ps", "--all", "--filter", `name=orc-rec-${process.pid}-`, "--format", "{{.Names}}"], { encoding: "utf8" }).trim() : "");

describe(`recording with VHS in the container${skipReason}`, () => {
  const listeners: Server[] = [];
  afterAll(() => {
    for (const l of listeners) l.close();
  });
  afterEach(() => {
    // Nothing a recording made stays behind: its stage folder and its container are gone.
    expect(readdirSync(ROOT)).toEqual([]);
    expect(containersLeft()).toBe("");
  });

  it.skipIf(!ready.ok)(
    "records the trips fixture at 80×24 into gif, webm and a transcript with the planned output",
    async () => {
      const out = join(dir, "out");
      const r = await recordTape(FIXTURE, out, { tmpRoot: ROOT });
      expect(r.error).toBeUndefined();
      expect(r.sandbox).toBe("container");
      const real = realpathSync(out);
      expect(r).toMatchObject({ gif: join(real, "trips.gif"), webm: join(real, "trips.webm"), txt: join(real, "trips.txt") });
      expect(readdirSync(out).sort()).toEqual(["trips.gif", "trips.txt", "trips.webm"]);
      expect(readFileSync(r.gif!).subarray(0, 6).toString("latin1")).toBe("GIF89a");
      expect(readFileSync(r.webm!).subarray(0, 4)).toEqual(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])); // EBML
      const txt = readFileSync(r.txt!, "utf8");
      for (const line of ["> trips plan", "Weekend trips from Lisbon  Sat 10 - Sun 11 Oct", "  1  Sintra     45 min by train   hiking, palaces      EUR 38", "  3  Evora      1 h 30 by train   Roman temple, wine   EUR 52", "> trips pick 1", "  10:00  Pena Palace, then the trail to the Moorish Castle", "Saved. trips share 1 makes a link for your group"]) {
        expect(txt.split("\n")).toContain(line);
      }
      // A clean demo: nothing in its transcript reads as a failure.
      expect(r.errorLine).toBeUndefined();
      // The hidden setup line never shows, and the frame is 80 columns wide.
      expect(txt).not.toContain("alias trips");
      expect(txt.split("\n").find((l) => l.startsWith("─"))).toHaveLength(80);
    },
    90_000,
  );

  it.skipIf(!ready.ok)(
    "records the studio's terminal sample (the fake designer's) into WebM, GIF and a transcript: its script runs by its path from the artifact's root",
    async () => {
      const src = join(dir, "sample");
      for (const [p, text] of Object.entries(TERMINAL_SAMPLE_FILES)) {
        mkdirSync(dirname(join(src, p)), { recursive: true });
        writeFileSync(join(src, p), text);
      }
      const out = join(dir, "out");
      const r = await recordTape(src, out, { tape: "cli/trips.tape", tmpRoot: ROOT });
      expect(r.error).toBeUndefined();
      const real = realpathSync(out);
      expect(r).toMatchObject({ sandbox: "container", gif: join(real, "trips.gif"), webm: join(real, "trips.webm"), txt: join(real, "trips.txt") });
      expect(readFileSync(r.gif!).subarray(0, 6).toString("latin1")).toBe("GIF89a");
      expect(readFileSync(r.webm!).subarray(0, 4)).toEqual(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
      const txt = readFileSync(r.txt!, "utf8").split("\n");
      for (const line of ["> trips plan", "Lake weekend  Sat 17 - Sun 18 Oct · Pine Lake · 4 friends", "  1  Cabin at Pine Lake   check in Sat 15:00   $140 each", "> trips pick 1", "  15:00  check in, booked by Jo", "Saved. trips share 1 makes a link for your group"]) expect(txt).toContain(line);
      expect(r.errorLine).toBeUndefined();
      expect(r.durationMs).toBeLessThan(90_000);
    },
    90_000,
  );

  it.skipIf(!ready.ok)(
    "records a tape in a subfolder, as the real trial's designer wrote it: the shell starts at the artifact's root, so its script called by its root path prints its real output; Output and Source stay relative to the tape",
    async () => {
      const out = join(dir, "out");
      const r = await recordTape(SUBFOLDER, out, { tape: "demo/demo.tape", tmpRoot: ROOT });
      expect(r.error).toBeUndefined();
      const real = realpathSync(out);
      expect(r).toMatchObject({ sandbox: "container", gif: join(real, "demo.gif"), txt: join(real, "demo.txt") });
      expect(readdirSync(out).sort()).toEqual(["demo.gif", "demo.txt"]);
      const txt = readFileSync(r.txt!, "utf8");
      expect(txt.split("\n")).toContain(" 1  Lake Tahoe cabin      3h 40m   $148");
      expect(txt).not.toContain("Cannot find module");
      expect(r.errorLine).toBeUndefined();
    },
    90_000,
  );

  it.skipIf(!ready.ok)(
    "a recording whose transcript shows a failure names its first failing line, from the service's own transcript when the tape asks for none",
    async () => {
      const src = join(dir, "broken");
      mkdirSync(join(src, "demo"), { recursive: true });
      // The trial's mistake the other way round: a path from the tape's folder, while the shell starts at the root.
      writeFileSync(join(src, "demo", "demo.tape"), `Output demo.gif\nSet Columns 80\nSet Rows 24\nSet TypingSpeed 10ms\nType "node trips.js"\nEnter\nSleep 1.5s\n`);
      writeFileSync(join(src, "demo", "trips.js"), "console.log('not reached')\n");
      const out = join(dir, "out");
      const r = await recordTape(src, out, { tape: "demo/demo.tape", tmpRoot: ROOT });
      expect(r.error).toBeUndefined();
      expect(r.sandbox).toBe("container");
      expect(r.errorLine).toMatch(/^Error: Cannot find module '\/work\/trips\.js'/);
      // The service's transcript is not an output: only what the tape asked for is kept.
      expect(readdirSync(out)).toEqual(["demo.gif"]);
      expect(r.txt).toBeUndefined();
    },
    90_000,
  );

  it.skipIf(!ready.ok)(
    "a hostile tape's commands cannot reach the network or the host, write to the owner's terminals, read the owner's files or write outside the copy; the recording still finishes",
    async () => {
      // The service's stand-in on this machine's loopback: nothing may connect to it.
      let connections = 0;
      const service = await new Promise<Server>((res) => {
        const s = createServer((c) => {
          connections++;
          c.destroy();
        });
        s.listen(0, "127.0.0.1", () => res(s));
      });
      listeners.push(service);
      const port = (service.address() as { port: number }).port;
      // A secret beside the artifact, on the host, and the owner's home folder.
      const secret = join(dir, "secret.txt");
      writeFileSync(secret, "the owner's secret\n");
      const outsideFile = join(dir, "outside.txt");
      const home = homedir();
      const src = join(dir, "hostile");
      const out = join(dir, "out");
      mkdirSync(src);
      writeFileSync(
        join(src, "hostile.sh"),
        `node -e 'require("net").connect(443,"1.1.1.1").on("connect",()=>{console.log("node-net=CONNECTED");process.exit()}).on("error",e=>console.log("node-net="+e.code))'
node -e 'require("dns").lookup("example.com",(e)=>console.log("dns="+(e?e.code:"RESOLVED")))'
(exec 3<>/dev/tcp/1.1.1.1/443) 2>/dev/null; echo "bash-tcp=$?"
(exec 3<>/dev/tcp/127.0.0.1/${port}) 2>/dev/null; echo "loopback=$?"
echo pwned > /dev/ttys000 2>/dev/null; echo "ttys000=$?"
echo "ttys-devices=$(ls /dev | grep -c '^ttys')"
cat ${JSON.stringify(secret)} 2>/dev/null; echo "secret=$?"
ls ${JSON.stringify(home)} >/dev/null 2>&1; echo "list-home=$?"
cat ${JSON.stringify(join(home, ".zshrc"))} >/dev/null 2>&1; echo "zshrc=$?"
echo x > ${JSON.stringify(outsideFile)} 2>/dev/null; echo "write-outside=$?"
echo x > ../escaped.txt 2>/dev/null; echo "write-parent=$?"
echo x > /etc/planted 2>/dev/null; echo "write-etc=$?"
echo x > /usr/local/bin/ttyd 2>/dev/null; echo "write-tools=$?"
echo GIF89a > /out/planted.gif; echo "write-out=$?"
kill -0 ${process.pid} 2>/dev/null; echo "signal=$?"
echo x > ./inside.txt; echo "write-inside=$?"
`,
      );
      writeFileSync(join(src, "hostile.tape"), `Output hostile.txt\nSet Columns 120\nSet Rows 40\nSet TypingSpeed 10ms\nType "bash hostile.sh"\nEnter\nSleep 6s\n`);
      const r = await recordTape(src, out, { tmpRoot: ROOT });
      expect(r.error).toBeUndefined();
      expect(r.sandbox).toBe("container");
      const txt = readFileSync(r.txt!, "utf8");
      const result = (k: string) => new RegExp(`^${k}=(\\S+)$`, "m").exec(txt)?.[1];
      expect(result("node-net")).toBe("ENETUNREACH"); // no network at all
      expect(result("dns")).not.toBe("RESOLVED");
      expect(result("bash-tcp")).toBe("1");
      expect(result("loopback")).toBe("1"); // the container's own loopback: the service is not there
      expect(connections).toBe(0);
      expect(result("ttys000")).toBe("1"); // the owner's terminals do not exist in the container
      expect(result("ttys-devices")).toBe("0");
      expect(result("secret")).toBe("1");
      expect(txt).not.toContain("the owner's secret");
      expect(result("list-home")).toBe("2"); // the owner's home folder does not exist in the container
      expect(result("zshrc")).toBe("1");
      expect(result("write-outside")).toBe("1");
      expect(existsSync(outsideFile)).toBe(false);
      expect(result("write-parent")).toBe("1"); // the root is read-only
      expect(result("write-etc")).toBe("1");
      expect(result("write-tools")).toBe("1");
      expect(txt).toContain("Read-only file system");
      // The shell can write to the output folder, but only the declared output leaves it.
      expect(result("write-out")).toBe("0");
      expect(readdirSync(out)).toEqual(["hostile.txt"]);
      expect(result("signal")).toBe("1"); // no process of the host exists in the container
      expect(result("write-inside")).toBe("0");
    },
    90_000,
  );

  it.skipIf(!ready.ok)(
    "a tape that swaps an output folder for a link to its copy gets nothing copied out",
    async () => {
      const src = join(dir, "swap");
      mkdirSync(src);
      // VHS writes its outputs at the end, through the link, into the copy: the service refuses to follow it.
      writeFileSync(join(src, "swap.tape"), `Output media/swap.txt\n${SIZE}Set TypingSpeed 10ms\nType "rm -rf /out/media && ln -s /work /out/media && echo swapped"\nEnter\nSleep 1s\n`);
      const out = join(dir, "out");
      const r = await recordTape(src, out, { tmpRoot: ROOT });
      expect(r).toMatchObject({ sandbox: "container", reason: "failed" });
      expect(r.error).toMatch(/^media\/swap\.txt: a folder on its way is a link/);
      expect(readdirSync(out)).toEqual([]);
    },
    90_000,
  );

  it.skipIf(!ready.ok)(
    "nothing a tape starts outlives the recording, however it detaches: the container is gone",
    async () => {
      const src = join(dir, "detach");
      mkdirSync(src);
      writeFileSync(join(src, "detach.sh"), "sleep 3271 &\nnohup sleep 3272 >/dev/null 2>&1 &\n(sleep 3273 &)\nperl -MPOSIX -e 'exit if fork; setsid; exit if fork; exec qw(sleep 3274)'\necho started\n");
      writeFileSync(join(src, "detach.tape"), `Output detach.txt\n${SIZE}Set TypingSpeed 10ms\nType "bash detach.sh"\nEnter\nSleep 2s\n`);
      const r = await recordTape(src, join(dir, "out"), { tmpRoot: ROOT });
      expect(r.error).toBeUndefined();
      expect(readFileSync(r.txt!, "utf8")).toContain("started");
      // afterEach: the container (and with it every process in it) is gone.
    },
    90_000,
  );

  it.skipIf(!ready.ok)(
    "a tape that runs too long is stopped: the container is killed by its name, and nothing is left",
    async () => {
      const src = join(dir, "slow");
      mkdirSync(src);
      writeFileSync(join(src, "slow.tape"), `Output slow.txt\n${SIZE}Type "sleep 317"\nEnter\nSleep 60s\n`);
      const t0 = Date.now();
      const r = await recordTape(src, join(dir, "out"), { tmpRoot: ROOT, timeoutMs: 6_000 });
      expect(r).toMatchObject({ sandbox: "container", reason: "timeout", error: "VHS did not finish within 6 s; it was stopped" });
      expect(Date.now() - t0).toBeLessThan(25_000);
      expect(readdirSync(join(dir, "out"))).toEqual([]);
    },
    60_000,
  );

  it.skipIf(!ready.ok)("refuses an invalid tape before anything runs", async () => {
    const src = join(dir, "bad");
    mkdirSync(src);
    writeFileSync(join(src, "bad.tape"), `Output ../../escape.gif\n${SIZE}`);
    const r = await recordTape(src, join(dir, "out"), { tmpRoot: ROOT });
    expect(r).toMatchObject({ sandbox: null, reason: "invalid-tape" });
    expect(r.error).toMatch(/bad\.tape:1: Output must be one path inside/);
    expect(readdirSync(join(dir, "out"))).toEqual([]);
  });

  it.skipIf(!ready.ok)(
    "a docker that drops the isolation fails the probe, so nothing records",
    async () => {
      if (!ready.ok) return;
      const loose = join(dir, "loose-docker");
      writeFileSync(loose, `#!/bin/bash\nargs=()\nfor a in "$@"; do [ "$a" = "--read-only" ] || args+=("$a"); done\nexec ${JSON.stringify(ready.docker)} "\${args[@]}"\n`);
      chmodSync(loose, 0o755);
      const out = join(dir, "out");
      const r = await recordTape(FIXTURE, out, { docker: loose, tmpRoot: ROOT });
      expect(r).toMatchObject({ sandbox: null, reason: "unavailable" });
      expect(r.error).toMatch(/^Not recorded: the recorder's container failed the check "writes only to its copy, its output folder and its temporary folders" \(saw: \/probe-x EACCES/);
      expect(readdirSync(out)).toEqual([]);
    },
    60_000,
  );
});
