// Unit E2 (docs/design/project-environment.md): a tape's typed commands in a pseudo-terminal, recorded by the service as
// an asciicast v2 file. The tape's steps, the output a cast keeps (only the escapes the app's player draws), the
// recording and its validation, and a session against a stand-in shell. No Docker here: the real sessions are in
// server/studio/evidence.container.test.ts.

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { CastRecorder, SESSION_PROMPT, WaitMatcher, recordSession, refusedEscape, sanitizeOutput, tapeSession, transcriptError, validateCast, validateTape, waitPatternRefusal, type SessionStream, type TapeSession } from "./terminal";

const SIZE = "Set Columns 80\nSet Rows 24\n";

describe("a tape's steps in a session", () => {
  it("types each character with VHS's pause, presses keys, sleeps, waits, hides and shows; the look and the outputs type nothing", () => {
    const tape = `Output demo.gif\nOutput demo.txt\n${SIZE}Set Theme "Dracula"\nSet FontSize 18\nRequire node\nHide\nType "cd app"\nEnter\nShow\nSet TypingSpeed 20ms\nType "ls"\nType@5ms "x"\nEnter 2\nSleep 500ms\nSleep 2\nCtrl+C\nAlt+b\nShift+Tab\nUp\nBackspace 3\nWait\nWait+Screen@3s /Done/\nScrollUp 3\n`;
    const r = tapeSession(tape);
    if (!r.ok) throw new Error(r.errors.join("\n"));
    expect(r.session.size).toEqual({ cols: 80, rows: 24 });
    expect(r.session.actions).toEqual([
      { kind: "hide" },
      { kind: "keys", keys: ["c", "d", " ", "a", "p", "p"], delayMs: 50 },
      { kind: "keys", keys: ["\r"], delayMs: 50 },
      { kind: "show" },
      { kind: "keys", keys: ["l", "s"], delayMs: 20 },
      { kind: "keys", keys: ["x"], delayMs: 5 },
      { kind: "keys", keys: ["\r", "\r"], delayMs: 20 },
      { kind: "sleep", ms: 500 },
      { kind: "sleep", ms: 2000 },
      { kind: "keys", keys: ["\x03"], delayMs: 20 },
      { kind: "keys", keys: ["\x1bb"], delayMs: 20 },
      { kind: "keys", keys: ["\x1b[Z"], delayMs: 20 },
      { kind: "keys", keys: ["\x1b[A"], delayMs: 20 },
      { kind: "keys", keys: ["\x7f", "\x7f", "\x7f"], delayMs: 20 },
      { kind: "wait", pattern: ">$", scope: "line", timeoutMs: 15_000 },
      { kind: "wait", pattern: "Done", scope: "screen", timeoutMs: 3000 },
    ]);
  });

  it("reads a sourced tape in place", () => {
    const r = tapeSession(`Output demo.gif\nSource setup.tape\n${SIZE}Type "go"\n`, { readSource: (rel) => (rel === "setup.tape" ? 'Hide\nType "export A=1"\nEnter\nShow\n' : undefined) });
    expect(r.ok && r.session.actions.map((a) => a.kind)).toEqual(["hide", "keys", "keys", "show", "keys"]);
    expect(tapeSession(`Output demo.gif\nSource missing.tape\n${SIZE}`).ok).toBe(false);
  });

  it("refuses what a session cannot do as VHS does, and a Wait pattern that is too long or not a regular expression", () => {
    const errors = (body: string) => {
      const r = tapeSession(`Output demo.gif\n${SIZE}${body}`);
      return r.ok ? "" : r.errors.join("\n");
    };
    expect(errors("Wait /[a-/\n")).toMatch(/not a regular expression/);
    expect(errors(`Set WaitPattern /${"a".repeat(101)}/\n`)).toMatch(/longer than 100 characters/);
    expect(errors("Wait+Somewhere /x/\n")).toMatch(/Wait takes \+Screen or \+Line/);
    expect(errors("Ctrl+Shift+Left\n")).toMatch(/cannot be typed in a session/);
    expect(errors("Enter 1000\n")).toMatch(/a count from 1 to 100/);
    expect(errors("Type@fast \"x\"\n")).toMatch(/is not a duration/);
    expect(errors("Type x\n")).toMatch(/Type takes a quoted string/);
    expect(tapeSession('Output demo.gif\nType "x"\n').ok).toBe(false);
    expect(waitPatternRefusal(">$")).toBeUndefined();
    expect(waitPatternRefusal("\\$ $")).toBeUndefined();
    // A pattern that backtracks for long is not refused by its text: the time of each test is bounded (WaitMatcher).
    expect(waitPatternRefusal("(a+)+b")).toBeUndefined();
  });

  it("every tape the tape rules accept for the recorder's fixtures is one a session can type", () => {
    const tape = `Output trips.gif\nOutput trips.txt\nSet Shell bash\n${SIZE}Set Theme "Catppuccin Mocha"\nType "node bin/trips.js list"\nSleep 300ms\nEnter\nSleep 2s\n`;
    expect(validateTape(tape).ok).toBe(true);
    expect(tapeSession(tape).ok).toBe(true);
  });
});

describe("the output a cast keeps", () => {
  it("keeps the text, colours and moves within a line; drops titles, modes, bracketed paste, bells and other controls", () => {
    const raw = "\x1b]0;my title\x07\x1b[?2004h> \x1b[1;32mok\x1b[0m\x07 done\x1b(B\x1b[?1049h\x1b[2K\x1b[3D!\x1b[5n\x00\x7f\x1b=\r\n";
    const { clean, rest } = sanitizeOutput(raw);
    expect(rest).toBe("");
    expect(clean).toBe("> \x1b[1;32mok\x1b[0m done\x1b[2K\x1b[3D!\r\n");
    expect(refusedEscape(clean)).toBeUndefined();
  });

  it("holds an escape cut by the end of a chunk for the next one", () => {
    expect(sanitizeOutput("ab\x1b[3")).toEqual({ clean: "ab", rest: "\x1b[3" });
    expect(sanitizeOutput("\x1b[3" + "1mred")).toEqual({ clean: "\x1b[31mred", rest: "" });
    expect(sanitizeOutput("x\x1b]0;tit")).toEqual({ clean: "x", rest: "\x1b]0;tit" });
    expect(sanitizeOutput("x\x1b")).toEqual({ clean: "x", rest: "\x1b" });
  });
});

describe("the recording: asciicast v2", () => {
  it("one output event per chunk, its time since the start, never going back; hidden output is not recorded; it validates as v2", () => {
    const rec = new CastRecorder({ cols: 80, rows: 24, startedAt: 1_000_000, title: "trips\x1b[31m CLI" });
    rec.output(Buffer.from("\x1b[?2004h> "), 1_000_120);
    rec.hidden = true;
    rec.output("secret setup\r\n", 1_000_200);
    rec.hidden = false;
    // Chunks cut inside a character and inside an escape, the later ones stamped earlier.
    const bytes = Buffer.from("xé\x1b[32mgreen\x1b[0m\r\n");
    rec.output(bytes.subarray(0, 2), 1_000_250);
    rec.output(bytes.subarray(2, 3), 1_000_300);
    rec.output(bytes.subarray(3, 6), 1_000_290);
    rec.output(bytes.subarray(6), 1_000_280);
    const lines = rec.cast().trimEnd().split("\n").map((l) => JSON.parse(l));
    expect(lines[0]).toEqual({ version: 2, width: 80, height: 24, timestamp: 1000, env: { TERM: "xterm-256color", SHELL: "bash" }, title: "trips[31m CLI" });
    expect(lines.slice(1)).toEqual([
      [0.12, "o", "> "],
      [0.25, "o", "x"],
      [0.3, "o", "é"],
      [0.3, "o", "\x1b[32mgreen\x1b[0m\r\n"],
    ]);
    expect(validateCast(rec.cast(), 2)).toMatchObject({ ok: true, info: { cols: 80, rows: 24, duration: 0.3, events: 4, title: "trips[31m CLI" } });
    expect(rec.transcript()).toBe("> xégreen\n");
    expect(rec.all.text()).toContain("secret setup");
  });

  it("stops recording at its cap", () => {
    const rec = new CastRecorder({ cols: 80, rows: 24, startedAt: 0, maxBytes: 200 });
    for (let i = 0; i < 20; i++) rec.output(`line ${i} of output\r\n`, i);
    expect(rec.tooLarge).toBe(true);
    expect(Buffer.byteLength(rec.cast())).toBeLessThanOrEqual(200);
    expect(validateCast(rec.cast(), 2).ok).toBe(true);
  });

  it("the transcript shows what the terminal showed: carriage returns overwrite, erases cut, and typed commands sit on the prompt", () => {
    const rec = new CastRecorder({ cols: 80, rows: 24, startedAt: 0 });
    rec.output(`${SESSION_PROMPT}node cli.js\r\n10%\r50%\r100%\r\nError: boom\r\n${SESSION_PROMPT}abc\x1b[2D\x1b[K\r\n`, 10);
    expect(rec.transcript()).toBe("> node cli.js\n100%\nError: boom\n> a\n");
    expect(transcriptError(rec.transcript())).toBe("Error: boom");
  });

  it("hostile output stays small: the cursor stops at the session's width, so 16,000 bytes of far cursor moves keep one line (pass 6 review finding 2)", () => {
    const rec = new CastRecorder({ cols: 80, rows: 24, startedAt: 0 });
    const before = process.memoryUsage().heapUsed;
    // The review's case: "move 9,999 columns right, write x", 2,000 times. Before the fix: +624 MB of heap.
    rec.output("\x1b[9999Cx".repeat(2000), 1);
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(16 * 1024 * 1024);
    // As a terminal shows it: the cursor stops at the last column, and each x overwrites the one before.
    expect(rec.transcript()).toBe(`${" ".repeat(79)}x\n`);
    expect(rec.all.text()).toBe(`${" ".repeat(79)}x`);
  });

  it("a line wraps at the session's width, and the terminal keeps its last lines, hidden output included (pass 6 review finding 2)", () => {
    const rec = new CastRecorder({ cols: 80, rows: 24, startedAt: 0 });
    rec.output(`${"a".repeat(100)}é😀\r\n`, 1);
    expect(rec.transcript()).toBe(`${"a".repeat(80)}\n${"a".repeat(20)}é😀\n`);
    // An emoji takes two columns and is never cut in two at the wrap.
    rec.output(`${"b".repeat(79)}😀\r\n`, 2);
    expect(rec.transcript().split("\n").slice(2, 4)).toEqual(["b".repeat(79), "😀"]);
    // Hidden output is not recorded, but the terminal (for Waits) keeps only its last 500 lines of 80 characters.
    rec.hidden = true;
    rec.output("y".repeat(1_000_000), 3);
    rec.output("\x1b[9999Cz\r\n".repeat(20_000), 4);
    const lines = rec.all.text().split("\n");
    expect(lines.length).toBeLessThanOrEqual(501);
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(80);
    expect(rec.all.lastLine()).toBe(`${" ".repeat(79)}z`);
  });

  it("v2 validation refuses a time that goes back, another version, an exit event and escapes the player does not draw", () => {
    const head = JSON.stringify({ version: 2, width: 80, height: 24 });
    expect(validateCast(`${head}\n[1,"o","a"]\n[0.5,"o","b"]\n`, 2)).toEqual({ ok: false, error: "line 3: the time goes back (0.5 after 1)" });
    expect(validateCast(`${head}\n[1,"x","0"]\n`, 2)).toMatchObject({ ok: false, error: expect.stringMatching(/unknown event code "x" \(o, i, m or r\)/) });
    expect(validateCast(`${head}\n[1,"o","\\u001b]0;t\\u0007"]\n`, 2)).toMatchObject({ ok: false });
    expect(validateCast(`${JSON.stringify({ version: 2, width: 81, height: 24 })}\n`, 2)).toMatchObject({ ok: false, error: "81×24 is not a studio terminal size" });
    expect(validateCast(`${head}\n`, 3)).toMatchObject({ ok: false, error: "the header's version is not 3 (asciicast v3)" });
  });
});

/** A stand-in for bash in a pseudo-terminal: it shows its prompt, echoes what is typed, and runs two commands. */
class FakeShell extends EventEmitter implements SessionStream {
  line = "";
  typed: string[] = [];
  constructor(o: { prompt?: boolean } = {}) {
    super();
    if (o.prompt !== false) setTimeout(() => this.emit("data", Buffer.from(`\x1b[?2004h${SESSION_PROMPT}`)), 5);
  }
  write(k: string) {
    this.typed.push(k);
    if (k !== "\r") {
      this.line += k;
      setImmediate(() => this.emit("data", Buffer.from(k)));
      return true;
    }
    const cmd = this.line;
    this.line = "";
    setImmediate(() => {
      this.emit("data", Buffer.from("\r\n\x1b[?2004l\r"));
      if (cmd === "exit") return this.emit("end");
      if (cmd === "slow") setTimeout(() => this.emit("data", Buffer.from(`Done\r\n${SESSION_PROMPT}`)), 100);
      else if (cmd === "wide") this.emit("data", Buffer.from(`${`${"a".repeat(79)}\r\n`.repeat(8)}${SESSION_PROMPT}`));
      else this.emit("data", Buffer.from(`ran ${cmd}\r\n${SESSION_PROMPT}`));
    });
    return true;
  }
}

const session = (body: string): TapeSession => {
  const r = tapeSession(`Output demo.gif\n${SIZE}${body}`);
  if (!r.ok) throw new Error(r.errors.join("\n"));
  return r.session;
};

describe("a session against a stand-in shell", () => {
  it("waits for the prompt, types the tape, waits for its output, and records a valid cast", async () => {
    const shell = new FakeShell();
    const r = await recordSession({ stream: shell, session: session('Type@1ms "hello"\nEnter\nType@1ms "slow"\nEnter\nWait+Screen@2s /Done/\nSleep 10ms\n'), title: "demo", timeoutMs: 5000, settleMs: 20 });
    expect(r.status).toBe("recorded");
    expect(shell.typed.join("")).toBe("hello\rslow\r");
    expect(r.transcript).toBe("> hello\nran hello\n> slow\nDone\n>\n");
    expect(validateCast(r.cast, 2)).toMatchObject({ ok: true, info: { cols: 80, rows: 24, title: "demo" } });
  });

  it("a shell that ends early ends the session; one with no prompt fails; a Wait that never matches fails; the time limit stops it", async () => {
    const early = await recordSession({ stream: new FakeShell(), session: session('Type@1ms "exit"\nEnter\nType@1ms "never"\n'), timeoutMs: 5000, settleMs: 10 });
    expect(early).toMatchObject({ status: "recorded", ended: true });
    const silent = await recordSession({ stream: new FakeShell({ prompt: false }), session: session('Type "x"\n'), timeoutMs: 5000, readyMs: 100 });
    expect(silent).toMatchObject({ status: "failed", error: "the shell showed no prompt within 0 s" });
    const wait = await recordSession({ stream: new FakeShell(), session: session("Wait@100ms /never/\n"), timeoutMs: 5000 });
    expect(wait).toMatchObject({ status: "failed", error: "Wait /never/ did not match within 0 s" });
    const long = await recordSession({ stream: new FakeShell(), session: session("Sleep 10s\n"), timeoutMs: 150 });
    expect(long).toMatchObject({ status: "timeout" });
    expect(long.durationMs).toBeLessThan(2000);
  });

  it("stops when the capture is stopped", async () => {
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 50);
    const r = await recordSession({ stream: new FakeShell(), session: session("Sleep 10s\n"), timeoutMs: 5000, signal: abort.signal });
    expect(r).toMatchObject({ status: "failed", error: "the capture was stopped" });
  });
});

/** What `f` gives, how long it took, and the longest time the event loop was blocked meanwhile (from a 10 ms timer). */
async function blocking<T>(f: () => Promise<T>): Promise<{ result: T; ms: number; blockedMs: number }> {
  const t0 = performance.now();
  let last = t0;
  let blockedMs = 0;
  const tick = setInterval(() => {
    const t = performance.now();
    blockedMs = Math.max(blockedMs, t - last - 10);
    last = t;
  }, 10);
  try {
    const result = await f();
    return { result, ms: performance.now() - t0, blockedMs: Math.max(blockedMs, performance.now() - last - 10) };
  } finally {
    clearInterval(tick);
  }
}

describe("a Wait pattern that backtracks for long (pass 6 review finding 1)", () => {
  it("is tested off the main thread: the review's /\\s*\\s*\\s*!/ over 1,000 spaces answers slow within its time limit", async () => {
    const m = new WaitMatcher();
    try {
      // On the main thread, this one test took 79 s in the review.
      const r = await blocking(() => m.test("\\s*\\s*\\s*!", " ".repeat(1000)));
      expect(r.result).toBe("slow");
      expect(r.ms).toBeLessThan(1500);
      expect(r.blockedMs).toBeLessThan(200);
      // The next test starts a new worker; a pattern that throws matches nothing.
      expect(await m.test("done$", "all done")).toBe(true);
      expect(await m.test(">$", "> x")).toBe(false);
      expect(await m.test("(?<=", "x")).toBe(false);
    } finally {
      m.close();
    }
  });

  it("fails its Wait within a small bound, and the service's event loop keeps running meanwhile", async () => {
    // About 660 characters on the screen. Before the fix this session took 45 s here, with the event loop blocked.
    const tape = 'Type@1ms "wide"\nEnter\nWait+Screen@10s /[\\s\\S]*[\\s\\S]*[\\s\\S]*!/\n';
    const r = await blocking(() => recordSession({ stream: new FakeShell(), session: session(tape), timeoutMs: 20_000, settleMs: 10 }));
    expect(r.result).toMatchObject({ status: "failed", error: expect.stringMatching(/took longer than 0\.25 s to test the output/) });
    expect(r.ms).toBeLessThan(3000);
    expect(r.blockedMs).toBeLessThan(200);
  });
});
