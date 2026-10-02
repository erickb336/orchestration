// ORC-029 pass 3, unit 3c: terminal demos. The tape rules (every refusal), the hand-written fallback
// (asciicast v3 and .ans frames), and, where macOS sandbox-exec, VHS, ttyd, ffmpeg and Chrome are all
// present, real recordings: the trips fixture at 80×24 with its transcript, a hostile tape whose
// commands try the internet, loopback, writes outside and signals and are refused by the sandbox, a
// timeout that leaves nothing running, and a fake "sandbox" that the probe catches.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { ANS_CAP, CAST_CAP, FAILURE_SIGNATURES, TAPE_CAP, probeTerminalSandbox, readTerminalFile, recordTape, refusedEscape, shellProfile, shellReads, transcriptError, validateAnsFrame, validateCast, validateTape } from "./terminal";

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

  it("builds the shell profile only for a real port", () => {
    expect(() => shellProfile(0)).toThrow(/not a port/);
    expect(() => shellProfile(70000)).toThrow(/not a port/);
    expect(shellProfile(4321)).toContain('(local ip "localhost:4321")');
  });

  it("denies the shell the home folders, apart from its own folders and the tools inside them", () => {
    const home = join(dir, "home");
    mkdirSync(join(home, ".nvm", "bin"), { recursive: true });
    const real = realpathSync(home);
    const reads = shellReads({ HOME: home }, [join(real, ".nvm", "bin"), "/opt/homebrew/bin"]);
    if (typeof reads === "string") throw new Error(reads);
    // The user's own home folder from the system, and HOME (here another folder); only the tool inside a home is kept.
    expect(reads.deny).toEqual([realpathSync(userInfo().homedir), real]);
    expect(reads.allow).toEqual([join(real, ".nvm", "bin")]);
    const profile = shellProfile(4321, reads);
    expect(profile).toContain(`(deny file-read* (subpath "${realpathSync(userInfo().homedir)}") (subpath "${real}"))`);
    expect(profile).toContain(`(allow file-read* (subpath (param "WORK")) (subpath (param "SHELL_TMP")) (subpath "${join(real, ".nvm", "bin")}"))`);
    // The allow rule comes after the deny rule: in a profile, the later rule wins.
    expect(profile.indexOf("(allow file-read*")).toBeGreaterThan(profile.indexOf("(deny file-read*"));
    // A home folder a profile cannot name means no profile, rather than one that misses it.
    const quoted = join(dir, 'a"b');
    mkdirSync(quoted);
    expect(shellReads({ HOME: quoted }, [])).toMatch(/cannot be named in a sandbox profile/);
    expect(() => shellProfile(4321, { deny: [quoted], allow: [] })).toThrow(/cannot name/);
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

// ---------- real recordings, where the sandbox and the tools are present ----------

const health = await probeTerminalSandbox();
const skipReason = health.ok ? "" : ` (skipped: ${health.detail})`;

describe(`recording with VHS in the sandbox${skipReason}`, () => {
  const listeners: Server[] = [];
  afterAll(() => {
    for (const l of listeners) l.close();
  });

  it.skipIf(!health.ok)("the probe proved both profiles: the shell gets no network, loopback, outside writes, home folder or signals out; the recorder gets loopback only", () => {
    expect(health.probes).toEqual({ shellWriteOutside: "denied", shellSignal: "denied", shellReadHome: "denied", shellLoopback: "denied", shellNetwork: "denied", recorderWriteOutside: "denied", recorderLoopback: "allowed", recorderNetwork: "denied" });
  });

  it.skipIf(!health.ok)(
    "records the trips fixture at 80×24 into gif, webm and a transcript with the planned output, and leaves only the outputs",
    async () => {
      const out = join(dir, "out");
      const tmpRoot = join(dir, "tmp");
      mkdirSync(tmpRoot);
      const r = await recordTape(FIXTURE, out, { tmpRoot });
      expect(r.error).toBeUndefined();
      expect(r.sandbox).toBe("sandbox-exec");
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
      // The run's temporary folders are gone, and nothing it started is still running.
      expect(readdirSync(tmpRoot)).toEqual([]);
      expect(execFileSync("/bin/ps", ["-axo", "command="], { encoding: "utf8" })).not.toContain(tmpRoot);
    },
    90_000,
  );

  it.skipIf(!health.ok)(
    "records a tape in a subfolder, as the real trial's designer wrote it: the shell starts at the artifact's root, so its script called by its root path prints its real output; Output and Source stay relative to the tape",
    async () => {
      const out = join(dir, "out");
      const r = await recordTape(SUBFOLDER, out, { tape: "demo/demo.tape", tmpRoot: dir });
      expect(r.error).toBeUndefined();
      const real = realpathSync(out);
      expect(r).toMatchObject({ sandbox: "sandbox-exec", gif: join(real, "demo.gif"), txt: join(real, "demo.txt") });
      expect(readdirSync(out).sort()).toEqual(["demo.gif", "demo.txt"]);
      const txt = readFileSync(r.txt!, "utf8");
      expect(txt.split("\n")).toContain(" 1  Lake Tahoe cabin      3h 40m   $148");
      expect(txt).not.toContain("Cannot find module");
      expect(r.errorLine).toBeUndefined();
    },
    90_000,
  );

  it.skipIf(!health.ok)(
    "a recording whose transcript shows a failure names its first failing line, from the service's own transcript when the tape asks for none",
    async () => {
      const src = join(dir, "broken");
      mkdirSync(join(src, "demo"), { recursive: true });
      // The trial's mistake the other way round: a path from the tape's folder, while the shell starts at the root.
      writeFileSync(join(src, "demo", "demo.tape"), `Output demo.gif\nSet Columns 80\nSet Rows 24\nSet TypingSpeed 10ms\nType "node trips.js"\nEnter\nSleep 1.5s\n`);
      writeFileSync(join(src, "demo", "trips.js"), "console.log('not reached')\n");
      const out = join(dir, "out");
      const r = await recordTape(src, out, { tape: "demo/demo.tape", tmpRoot: dir });
      expect(r.error).toBeUndefined();
      expect(r.sandbox).toBe("sandbox-exec");
      expect(r.errorLine).toMatch(/^Error: Cannot find module '/);
      // The service's transcript is not an output: only what the tape asked for is kept.
      expect(readdirSync(out)).toEqual(["demo.gif"]);
      expect(r.txt).toBeUndefined();
    },
    90_000,
  );

  it.skipIf(!health.ok)(
    "a hostile tape's commands cannot reach the internet or loopback, write outside its folder, or signal this process",
    async () => {
      const loop = await new Promise<Server>((res) => {
        const s = createServer((c) => {
          connections++;
          c.destroy();
        });
        s.listen(0, "127.0.0.1", () => res(s));
      });
      listeners.push(loop);
      let connections = 0;
      const port = (loop.address() as { port: number }).port;
      const src = join(dir, "hostile");
      const out = join(dir, "out");
      const outsideFile = join(dir, "outside.txt");
      mkdirSync(src);
      writeFileSync(
        join(src, "hostile.sh"),
        `#!/bin/bash
curl -sS -m 5 -o /dev/null https://example.com 2>/dev/null; echo "curl-dns=$?"
curl -sS -m 5 -o /dev/null http://1.1.1.1/ 2>/dev/null; echo "curl-ip=$?"
node -e 'require("net").connect(443,"1.1.1.1").on("connect",()=>{console.log("node-net=CONNECTED");process.exit()}).on("error",e=>console.log("node-net="+e.code))'
curl -sS -m 3 -o /dev/null http://127.0.0.1:${port}/ 2>/dev/null; echo "loopback=$?"
echo x > ${JSON.stringify(outsideFile)} 2>/dev/null; echo "write-outside=$?"
echo x > ../escaped.txt 2>/dev/null; echo "write-parent=$?"
echo x > ${JSON.stringify(join(out, "planted.gif"))} 2>/dev/null; echo "write-out=$?"
kill -0 ${process.pid} 2>/dev/null; echo "signal=$?"
echo x > ./inside.txt; echo "write-inside=$?"
`,
      );
      chmodSync(join(src, "hostile.sh"), 0o755);
      writeFileSync(join(src, "hostile.tape"), `Output hostile.txt\nSet Columns 80\nSet Rows 24\nSet TypingSpeed 10ms\nType "bash hostile.sh"\nEnter\nSleep 8s\n`);
      const r = await recordTape(src, out, { tmpRoot: dir });
      expect(r.error).toBeUndefined();
      expect(r.sandbox).toBe("sandbox-exec");
      const txt = readFileSync(r.txt!, "utf8");
      const result = (k: string) => new RegExp(`^${k}=(\\S+)$`, "m").exec(txt)?.[1];
      expect(result("curl-dns")).toBe("6"); // the DNS socket is refused, so nothing resolves
      expect(result("curl-ip")).toBe("7"); // the connection is refused
      expect(result("node-net")).toBe("EPERM"); // by the sandbox, not by an unreachable network
      expect(result("loopback")).toBe("7");
      expect(connections).toBe(0);
      expect(result("write-outside")).toBe("1");
      expect(existsSync(outsideFile)).toBe(false);
      expect(result("write-parent")).toBe("1");
      expect(result("write-out")).toBe("1");
      expect(readdirSync(out)).toEqual(["hostile.txt"]);
      expect(result("signal")).toBe("1");
      expect(result("write-inside")).toBe("0");
      expect(txt).toContain("Operation not permitted");
    },
    90_000,
  );

  it.skipIf(!health.ok)(
    "a hostile tape cannot read the home folder: not a file in it, not ~/.zshrc, not a listing; its own folder it reads",
    async () => {
      // A home of the test's own, outside the tape's folder, with a secret and a shell startup file.
      const home = join(dir, "home");
      mkdirSync(home);
      writeFileSync(join(home, "secret.txt"), "the owner's secret\n");
      writeFileSync(join(home, ".zshrc"), "export TOKEN=the-owners-token\n");
      const src = join(dir, "reader");
      mkdirSync(src);
      writeFileSync(join(src, "inside.txt"), "readable inside\n");
      writeFileSync(
        join(src, "read.sh"),
        `cat ${JSON.stringify(join(home, "secret.txt"))}; echo "secret=$?"
cat ~/.zshrc; echo "zshrc=$?"
cat "$HOME/.zshrc"; echo "home-zshrc=$?"
ls ${JSON.stringify(home)}; echo "list-home=$?"
ls ${JSON.stringify(userInfo().homedir)} >/dev/null; echo "list-user-home=$?"
cat ./inside.txt; echo "inside=$?"
`,
      );
      writeFileSync(join(src, "read.tape"), `Output read.txt\nSet Columns 80\nSet Rows 24\nSet TypingSpeed 10ms\nType "bash read.sh"\nEnter\nSleep 4s\n`);
      const r = await recordTape(src, join(dir, "out"), { tmpRoot: dir, env: { ...process.env, HOME: home } });
      expect(r.error).toBeUndefined();
      const txt = readFileSync(r.txt!, "utf8");
      const result = (k: string) => new RegExp(`^${k}=(\\S+)$`, "m").exec(txt)?.[1];
      for (const k of ["secret", "zshrc", "home-zshrc", "list-home", "list-user-home"]) expect(result(k), k).toBe("1");
      expect(txt).not.toContain("the owner's secret");
      expect(txt).not.toContain("the-owners-token");
      expect(txt).toContain("Operation not permitted");
      expect(result("inside")).toBe("0");
      expect(txt).toContain("readable inside");
    },
    90_000,
  );

  it.skipIf(!health.ok)(
    "nothing a tape starts outlives the recording, however it detaches; a process outside the sandbox is left alone",
    async () => {
      // Distinct durations name each way out: a background job, nohup, a subshell, and a double fork into a
      // session of its own (with and without its environment).
      const ways: Record<string, string> = {
        "3271": "sleep 3271 &",
        "3272": "nohup sleep 3272 >/dev/null 2>&1 &",
        "3273": "(sleep 3273 &)",
        "3274": "perl -MPOSIX -e 'exit if fork; setsid; exit if fork; exec qw(sleep 3274)'",
        "3275": "env -i /usr/bin/perl -MPOSIX -e 'exit if fork; setsid; exit if fork; exec qw(sleep 3275)'",
      };
      const sleeping = () =>
        execFileSync("/bin/ps", ["-axo", "command="], { encoding: "utf8" })
          .split("\n")
          .map((l) => /^(?:\/bin\/)?sleep (32\d\d)$/.exec(l.trim())?.[1])
          .filter(Boolean)
          .sort();
      const outside = execFileSync("/bin/sh", ["-c", "sleep 3279 >/dev/null 2>&1 & echo $!"], { encoding: "utf8" }).trim();
      try {
        const src = join(dir, "detach");
        mkdirSync(src);
        writeFileSync(join(src, "detach.sh"), `${Object.values(ways).join("\n")}\necho started\n`);
        writeFileSync(join(src, "detach.tape"), `Output detach.txt\nSet Columns 80\nSet Rows 24\nSet TypingSpeed 10ms\nType "bash detach.sh"\nEnter\nSleep 2s\n`);
        const r = await recordTape(src, join(dir, "out"), { tmpRoot: dir });
        expect(r.error).toBeUndefined();
        expect(readFileSync(r.txt!, "utf8")).toContain("started");
        expect(sleeping()).toEqual(["3279"]);
      } finally {
        execFileSync("/bin/kill", ["-9", outside]);
      }
    },
    90_000,
  );

  it.skipIf(!health.ok)(
    "a tape that runs too long is stopped, and nothing it started keeps running",
    async () => {
      const src = join(dir, "slow");
      mkdirSync(src);
      writeFileSync(join(src, "slow.tape"), `Output slow.txt\nSet Columns 80\nSet Rows 24\nType "sleep 317"\nEnter\nSleep 60s\n`);
      const tmpRoot = join(dir, "tmp");
      mkdirSync(tmpRoot);
      const t0 = Date.now();
      const r = await recordTape(src, join(dir, "out"), { tmpRoot, timeoutMs: 6_000 });
      expect(r).toMatchObject({ sandbox: "sandbox-exec", reason: "timeout" });
      expect(Date.now() - t0).toBeLessThan(20_000);
      expect(readdirSync(tmpRoot)).toEqual([]);
      await new Promise((res) => setTimeout(res, 500));
      const ps = execFileSync("/bin/ps", ["-axo", "command="], { encoding: "utf8" });
      expect(ps).not.toContain(tmpRoot); // VHS, Chrome, ffmpeg, ttyd
      expect(ps).not.toMatch(/^sleep 317$/m); // the shell's own command
      expect(readdirSync(join(dir, "out"))).toEqual([]);
    },
    60_000,
  );

  it.skipIf(!health.ok)("refuses an invalid tape before anything runs", async () => {
    const src = join(dir, "bad");
    mkdirSync(src);
    writeFileSync(join(src, "bad.tape"), `Output ../../escape.gif\nSet Columns 80\nSet Rows 24\n`);
    const r = await recordTape(src, join(dir, "out"), { tmpRoot: dir });
    expect(r).toMatchObject({ sandbox: null, reason: "invalid-tape" });
    expect(r.error).toMatch(/bad\.tape:1: Output must be one path inside/);
    expect(readdirSync(join(dir, "out"))).toEqual([]);
  });
});

describe("never unsandboxed", () => {
  it("refuses to record when sandbox-exec is missing, and when a stand-in does not actually sandbox anything", async () => {
    const missing = await recordTape(FIXTURE, join(dir, "out1"), { sandboxExec: join(dir, "no-such-sandbox-exec"), tmpRoot: dir });
    expect(missing).toMatchObject({ sandbox: null, reason: "unavailable" });
    expect(missing.error).toMatch(/Not recorded/);
    expect(existsSync(join(dir, "out1", "trips.gif"))).toBe(false);
    if (process.platform !== "darwin") return;
    // A "sandbox-exec" that drops its profile and runs the command as is: the probe must catch it.
    const fake = join(dir, "fake-sandbox-exec");
    writeFileSync(fake, `#!/bin/bash\nwhile [ "$1" = "-f" ] || [ "$1" = "-D" ]; do shift 2; done\nexec "$@"\n`);
    chmodSync(fake, 0o755);
    const fooled = await recordTape(FIXTURE, join(dir, "out2"), { sandboxExec: fake, tmpRoot: dir });
    expect(fooled).toMatchObject({ sandbox: null, reason: "unavailable" });
    expect(fooled.error).toMatch(/no working sandbox.*shellWriteOutside allowed/);
    expect(existsSync(join(dir, "out2", "trips.gif"))).toBe(false);
    expect(statSync(dir).isDirectory()).toBe(true);
  }, 60_000);
});
