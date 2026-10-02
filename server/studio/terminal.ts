// Terminal demos and TUIs (ORC-029 pass 3, unit 3c; docs/design/ORC-029-pass3-design.md §3c).
//
// A designer writes a VHS `.tape` and a script that prints the planned output of a CLI that does not
// exist yet. The service validates the tape here, then records it with VHS (a fixed argument list,
// never `vhs publish`) inside two macOS sandbox-exec profiles:
//
//   the recorder   VHS, Chrome and ffmpeg. Loopback only (VHS drives Chrome over the DevTools port and
//                  Chrome reads ttyd), no other network, writes only to the output folder and its own
//                  temp folder. Chrome's own sandbox cannot start inside sandbox-exec (a sandboxed process
//                  may not apply another sandbox), so VHS_NO_SANDBOX is set and this profile is Chrome's
//                  boundary.
//   the shell      ttyd and the shell, where the tape's commands run. No network at all, not even
//                  loopback (the service's API listens there), no Mach services (through LaunchServices a
//                  sandboxed `open` launches an unsandboxed app), no Apple events, signals only inside
//                  this sandbox, writes only to the working copy of the artifact and a temp folder, and no
//                  reads in the user's home folder (so a recording cannot show the owner's files) apart
//                  from those folders and the tools it runs.
//
// The working copy holds the whole artifact version, and the shell starts at its root, so paths in the tape's
// commands are relative to the artifact's root, as in its manifest (`node demo/trips.js`). VHS itself runs in the
// tape's folder: its own `Output` and `Source` paths are relative to the tape, as VHS has them.
//
// After recording, the transcript is scanned for clear failure signatures (FAILURE_SIGNATURES), so a demo that
// shows an error is not passed off as a clean recording.
//
// VHS starts `ttyd` from PATH. That name is a small wrapper that asks this process (a broker on a Unix
// socket) to start the real ttyd under the shell profile, because the wrapper, inside the recorder
// sandbox, cannot apply a sandbox of its own. The first process of the shell sandbox is a reaper that
// starts ttyd and, when the recording ends, ends every process of the sandbox, including any the tape
// detached into a session of its own (see reaperSource).
//
// The ORC-013 checks sandbox cannot run VHS: it refuses loopback by design, and VHS panics when it
// cannot bind a port. Without a working sandbox nothing is recorded: terminal demos fall back to
// hand-written asciicast v3 files and `.ans` frames, validated here and labelled as not recorded.

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { createServer, type Server as NetServer, type Socket } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { delimiter, dirname, isAbsolute, join, posix } from "node:path";
import { killGroup, trackLive } from "../processes";

// ---------- limits ----------

/** The terminal sizes a design may use, columns × rows (design §3c). */
export const TERMINAL_SIZES: readonly (readonly [number, number])[] = [
  [80, 24],
  [100, 30],
  [120, 40],
];
export const TAPE_CAP = 64 * 1024;
/** The artifact's files, copied before anything reads them: files, bytes, depth (an artifact holds at most 100 files and 20 MB). */
export const FOLDER_CAPS = { files: 200, bytes: 20 * 1024 * 1024, depth: 8 };
export const CAST_CAP = 2 * 1024 * 1024;
export const CAST_MAX_SECONDS = 600;
export const ANS_CAP = 64 * 1024;
export const RECORD_DEFAULTS = { timeoutMs: 120_000, maxOutputBytes: 25 * 1024 * 1024, maxDiskBytes: 512 * 1024 * 1024 };
const OUTPUT_TYPES = ["gif", "webm", "txt"] as const;
type OutputType = (typeof OUTPUT_TYPES)[number];

// ---------- the tape ----------

/** Every VHS 0.12 command keyword. A line holds one command; a second keyword on a line is refused. */
const COMMANDS = new Set(["Set", "Sleep", "Type", "Enter", "Space", "Backspace", "Delete", "Insert", "Ctrl", "Alt", "Shift", "Down", "Left", "Right", "Up", "PageUp", "PageDown", "ScrollUp", "ScrollDown", "Tab", "Escape", "End", "Hide", "Show", "Require", "Output", "Wait", "Source", "Screenshot", "Copy", "Paste", "Env"]);
/** Refused outright: the clipboard (Copy, Paste), files the service does not keep (Screenshot), and the recorder's own environment (Env), which ffmpeg and the ttyd wrapper inherit. */
const REFUSED: Record<string, string> = {
  Copy: "Copy writes the clipboard",
  Paste: "Paste reads the clipboard",
  Screenshot: "Screenshot writes a PNG; the outputs are webm, gif and txt",
  Env: "Env changes the recorder's own environment",
};
const SETTINGS = new Set(["Shell", "FontFamily", "FontSize", "Framerate", "Height", "Width", "LetterSpacing", "LineHeight", "PlaybackSpeed", "TypingSpeed", "Padding", "Theme", "Margin", "MarginFill", "WindowBar", "WindowBarSize", "BorderRadius", "Rows", "Columns", "LoopOffset", "WaitTimeout", "WaitPattern", "CursorBlink"]);
export const TAPE_SHELLS = ["bash", "zsh"] as const;

export interface TapeCheck {
  ok: boolean;
  /** Every refusal, with its line ("trips.tape:3: ..."). */
  errors: string[];
  /** The outputs as written in the tape (relative to its folder), one per type. */
  outputs: Partial<Record<OutputType, string>>;
  /** Columns × rows, from `Set Columns` and `Set Rows`. */
  size?: { cols: number; rows: number };
  shell: (typeof TAPE_SHELLS)[number];
  /** The tape with every Output pointed at `outDir` (only when ok and an outDir was given). */
  normalized?: string;
}

interface Tok {
  text: string;
  quoted: boolean;
}

/** VHS's strings: "…", '…' or `…`, no escapes, never across lines. A Wait line's /regex/ is one token. */
function tokenize(line: string, regex: boolean): Tok[] | string {
  const toks: Tok[] = [];
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === " " || c === "\t") {
      i++;
      continue;
    }
    const close = c === '"' || c === "'" || c === "`" ? c : regex && c === "/" ? "/" : undefined;
    if (close) {
      let end = i + 1;
      while (end < line.length && (line[end] !== close || (close === "/" && line[end - 1] === "\\"))) end++;
      if (end >= line.length) return close === "/" ? "an unterminated /regex/" : "an unterminated string";
      toks.push({ text: line.slice(i + 1, end), quoted: true });
      i = end + 1;
      continue;
    }
    let j = i;
    while (j < line.length && !` \t"'\``.includes(line[j])) j++;
    toks.push({ text: line.slice(i, j), quoted: false });
    i = j;
  }
  return toks;
}

const keywordOf = (t: Tok) => (t.quoted ? "" : (/^[A-Za-z]+/.exec(t.text)?.[0] ?? ""));

/** A path inside the tape's folder: relative, normalized, no `..`, no `~` or `$`, plain characters. */
function insidePath(p: string): string | undefined {
  if (!p || isAbsolute(p) || p.startsWith("~") || /[$\\\0\n\r"'`]/.test(p) || !/^[A-Za-z0-9._\-/ ]+$/.test(p)) return undefined;
  const n = posix.normalize(p);
  if (n === "." || n === ".." || n.startsWith("../") || n.startsWith("/")) return undefined;
  return n;
}

const quoteForTape = (p: string) => `"${p}"`;

/**
 * Check a tape against the rules (design §3c): one command per line, from VHS's own list; Output only
 * inside the folder and only webm, gif or txt (one each); Source only of a .tape inside the folder (its
 * own Source refused, as VHS does); Require only of a program name; Set Shell only bash or zsh; a
 * declared size from TERMINAL_SIZES; no Copy, Paste, Screenshot or Env; at most TAPE_CAP bytes.
 * `readSource` reads a sourced tape from the folder (undefined when it is missing). With `outDir`, the
 * result carries the tape with every Output rewritten to an absolute path there.
 */
export function validateTape(text: string, o: { name?: string; readSource?: (rel: string) => string | undefined; outDir?: string } = {}): TapeCheck {
  const name = o.name ?? "tape";
  const errors: string[] = [];
  const outputs: TapeCheck["outputs"] = {};
  let shell: TapeCheck["shell"] = "bash";
  let cols: number | undefined;
  let rows: number | undefined;
  const out: string[] = [];

  const check = (src: string, file: string, sourced: boolean) => {
    if (Buffer.byteLength(src, "utf8") > TAPE_CAP) {
      errors.push(`${file}: larger than ${TAPE_CAP / 1024} KB`);
      return;
    }
    if (src.includes("\0")) {
      errors.push(`${file}: contains a NUL byte`);
      return;
    }
    const lines = src.split(/\r?\n/);
    lines.forEach((raw, idx) => {
      const at = `${file}:${idx + 1}`;
      const line = raw.trim();
      if (!line || line.startsWith("#")) {
        if (!sourced) out.push(raw);
        return;
      }
      const toks = tokenize(line, /^Wait\b/.test(line));
      if (typeof toks === "string") {
        errors.push(`${at}: ${toks}`);
        return;
      }
      const kw = keywordOf(toks[0]);
      if (!COMMANDS.has(kw)) {
        errors.push(`${at}: "${toks[0].text.slice(0, 40)}" is not a VHS command`);
        return;
      }
      const second = toks.slice(1).find((t) => COMMANDS.has(keywordOf(t)));
      if (second) {
        errors.push(`${at}: one command per line (found "${second.text}" after ${kw})`);
        return;
      }
      const args = toks.slice(1);
      let emitted = raw;
      if (REFUSED[kw]) errors.push(`${at}: ${kw} is not allowed (${REFUSED[kw]})`);
      else if (kw === "Output") {
        const rel = args.length === 1 ? insidePath(args[0].text) : undefined;
        const ext = rel ? (/\.([a-z0-9]+)$/i.exec(rel)?.[1]?.toLowerCase() ?? "") : "";
        if (!rel) errors.push(`${at}: Output must be one path inside the tape's folder`);
        else if (!(OUTPUT_TYPES as readonly string[]).includes(ext)) errors.push(`${at}: Output type .${ext || "(none)"} is not allowed (webm, gif or txt)`);
        else if (!sourced) {
          const t = ext as OutputType;
          if (outputs[t]) errors.push(`${at}: a second .${t} Output (one of each type)`);
          else {
            outputs[t] = rel;
            if (o.outDir) emitted = `Output ${quoteForTape(join(o.outDir, rel))}`;
          }
        }
        // A sourced tape's Output is dropped by VHS itself; it is still checked above.
      } else if (kw === "Source") {
        const rel = args.length === 1 ? insidePath(args[0].text) : undefined;
        if (sourced) errors.push(`${at}: a Source inside a sourced tape (VHS refuses nesting too)`);
        else if (!rel || !rel.endsWith(".tape")) errors.push(`${at}: Source must be one .tape inside the tape's folder`);
        else {
          const inner = o.readSource?.(rel);
          if (inner === undefined) errors.push(`${at}: Source ${rel} was not found in the folder`);
          else check(inner, rel, true);
        }
      } else if (kw === "Require") {
        if (args.length !== 1 || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(args[0].text)) errors.push(`${at}: Require takes one program name, not a path`);
      } else if (kw === "Set") {
        const setting = args[0]?.text ?? "";
        const value = args.slice(1);
        if (!SETTINGS.has(setting)) errors.push(`${at}: Set ${setting.slice(0, 30) || "(nothing)"} is not a VHS setting`);
        else if (setting === "Shell") {
          if (value.length !== 1 || !(TAPE_SHELLS as readonly string[]).includes(value[0].text)) errors.push(`${at}: Set Shell must be bash or zsh`);
          else shell = value[0].text as TapeCheck["shell"];
        } else if (setting === "MarginFill") {
          if (value.length !== 1 || !/^#[0-9a-fA-F]{6}$/.test(value[0].text)) errors.push(`${at}: Set MarginFill must be a colour (#rrggbb), not a file`);
        } else if (setting === "Columns" || setting === "Rows") {
          const n = value.length === 1 && /^\d{1,4}$/.test(value[0].text) ? Number(value[0].text) : NaN;
          if (!Number.isInteger(n)) errors.push(`${at}: Set ${setting} takes a whole number`);
          else if (setting === "Columns") cols = n;
          else rows = n;
        }
      }
      if (!sourced) out.push(emitted);
    });
  };

  check(text, name, false);
  if (!Object.keys(outputs).length && !errors.length) errors.push(`${name}: no Output (declare webm, gif or txt)`);
  if (cols === undefined || rows === undefined) errors.push(`${name}: declare Set Columns and Set Rows (${TERMINAL_SIZES.map(([c, r]) => `${c}×${r}`).join(", ")})`);
  else if (!TERMINAL_SIZES.some(([c, r]) => c === cols && r === rows)) errors.push(`${name}: ${cols}×${rows} is not a studio terminal size (${TERMINAL_SIZES.map(([c, r]) => `${c}×${r}`).join(", ")})`);
  const ok = errors.length === 0;
  return { ok, errors, outputs, shell, ...(cols !== undefined && rows !== undefined ? { size: { cols, rows } } : {}), ...(ok && o.outDir ? { normalized: `${out.join("\n")}\n` } : {}) };
}

// ---------- the folder copy ----------

/** Copy the artifact's folder (regular files and folders only, within FOLDER_CAPS). Returns an error, or undefined. */
function copyFolder(src: string, dst: string): string | undefined {
  let files = 0;
  let bytes = 0;
  const walk = (from: string, to: string, depth: number): string | undefined => {
    if (depth > FOLDER_CAPS.depth) return `folders nest deeper than ${FOLDER_CAPS.depth}`;
    mkdirSync(to, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(from)) {
      const f = join(from, name);
      const st = lstatSync(f);
      if (st.isSymbolicLink()) return `${name} is a symbolic link`;
      if (st.isDirectory()) {
        const e = walk(f, join(to, name), depth + 1);
        if (e) return e;
      } else if (st.isFile()) {
        files++;
        bytes += st.size;
        if (files > FOLDER_CAPS.files) return `more than ${FOLDER_CAPS.files} files`;
        if (bytes > FOLDER_CAPS.bytes) return `more than ${FOLDER_CAPS.bytes / 1024 / 1024} MB`;
        copyFileSync(f, join(to, name));
        chmodSync(join(to, name), st.mode & 0o755);
      } else return `${name} is not a regular file`;
    }
    return undefined;
  };
  try {
    return walk(src, dst, 0);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

// ---------- the two sandbox profiles ----------

const DEVICES = `(literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/ptmx") (literal "/dev/dtracehelper") (regex #"^/dev/ttys[0-9]+$") (regex #"^/dev/fd/[0-9]+$")`;

/**
 * VHS, Chrome and ffmpeg. Parameters: OUT (the output folder), VHS_TMP (their temp folder: frames,
 * Chrome's profile and its singleton socket) and SOCK_DIR (the broker's socket). Loopback is allowed
 * because VHS drives Chrome over the DevTools port and Chrome reads ttyd; `(local ip "localhost:*")` is
 * granted only for bind and inbound, since granting it for every network operation lets outbound
 * connections to any address through (tried on macOS 27).
 */
export function recorderProfile(): string {
  return `(version 1)
(allow default)
(deny network*)
(allow network-bind network-inbound (local ip "localhost:*"))
(allow network-outbound (remote ip "localhost:*"))
(allow network-bind network-inbound (local unix-socket (subpath (param "VHS_TMP"))))
(allow network-outbound (remote unix-socket (subpath (param "VHS_TMP"))))
(allow network-outbound (remote unix-socket (subpath (param "SOCK_DIR"))))
(deny appleevent-send)
(deny file-write*)
(allow file-write* (subpath (param "OUT")) (subpath (param "VHS_TMP")) ${DEVICES})
`;
}

/**
 * What the shell may not read, so a tape cannot show the owner's files in a recording: the user's home
 * folders. Inside them it still reads its own folders (always) and `allow`: the tools it runs, when they
 * are installed in a home folder. Real paths.
 */
export interface ShellReads {
  deny: string[];
  allow: string[];
}

/** A path a profile can name as a string: absolute, with no quote, backslash or control character. */
const SBPL_PATH = /^\/[^"\\\u0000-\u001f\u007f]*$/;
const subpath = (p: string) => {
  if (!SBPL_PATH.test(p)) throw new Error(`a sandbox profile cannot name ${JSON.stringify(p)}`);
  return `(subpath "${p}")`;
};

/**
 * ttyd and the shell. Parameters: WORK (the copy of the artifact, the shell's directory) and
 * SHELL_TMP. The only network operation is ttyd's own listening port, bound and accepted on loopback;
 * nothing may connect out, not even to loopback or a Unix socket (DNS included). Nothing in `reads.deny`
 * is read, apart from WORK, SHELL_TMP and `reads.allow` (later rules win). Signals reach only processes
 * of this same sandbox, which is also how the reaper finds them.
 */
export function shellProfile(port: number, reads: ShellReads = { deny: [], allow: [] }): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`not a port: ${port}`);
  const readRules = reads.deny.length ? `(deny file-read* ${reads.deny.map(subpath).join(" ")})\n(allow file-read* (subpath (param "WORK")) (subpath (param "SHELL_TMP"))${reads.allow.map((p) => ` ${subpath(p)}`).join("")})\n` : "";
  return `(version 1)
(allow default)
(deny network*)
(allow network-bind network-inbound (local ip "localhost:${port}"))
(deny appleevent-send)
(deny mach-lookup)
(deny signal (with no-log))
(allow signal (target same-sandbox))
(deny file-write*)
(allow file-write* (subpath (param "WORK")) (subpath (param "SHELL_TMP")) ${DEVICES})
${readRules}`;
}

/**
 * The home folders the shell may not read: the user's, from the system, and HOME when it names another
 * folder; then, of `keep`, those inside one of them. A string says why no profile can be built.
 */
export function shellReads(env: NodeJS.ProcessEnv, keep: string[]): ShellReads | string {
  const deny = new Set<string>();
  let system: string | undefined;
  try {
    system = userInfo().homedir;
  } catch {
    /* no user record */
  }
  for (const h of [system, env.HOME]) {
    if (!h || !isAbsolute(h)) continue;
    let real: string;
    try {
      real = realpathSync(h);
    } catch {
      continue;
    }
    if (real === "/") continue;
    if (!SBPL_PATH.test(real)) return `the home folder ${JSON.stringify(real)} cannot be named in a sandbox profile`;
    deny.add(real);
  }
  const inside = (p: string) => [...deny].some((h) => p === h || p.startsWith(`${h}/`));
  const allow = [...new Set(keep.filter((p) => SBPL_PATH.test(p) && inside(p)))];
  return { deny: [...deny], allow };
}

/** A tool's folder and its install folder (`<prefix>/bin/<tool>`, links resolved), which the shell must still read. */
function toolFolders(bin: string): string[] {
  let real = bin;
  try {
    real = realpathSync(bin);
  } catch {
    /* as given */
  }
  return [dirname(bin), dirname(real), dirname(dirname(real))];
}

// ---------- the tools ----------

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
/** Where go-rod (VHS's browser driver) looks for a browser on macOS; without one it would try to download Chromium. */
const BROWSERS = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"];
const STD_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

interface Tools {
  sandboxExec: string;
  vhs: string;
  ttyd: string;
  ffmpeg: string;
  node: string;
}

function which(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const dirs = [...(env.PATH ?? "").split(delimiter), "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean);
  for (const d of dirs) {
    const f = join(d, name);
    try {
      if (statSync(f).isFile()) return f;
    } catch {
      /* not here */
    }
  }
  return undefined;
}

function findTools(env: NodeJS.ProcessEnv, sandboxExec: string): Tools | string {
  if (process.platform !== "darwin") return "terminal recording needs macOS sandbox-exec; this is not macOS";
  if (!existsSync(sandboxExec)) return `${sandboxExec} is missing`;
  const vhs = which("vhs", env);
  const ttyd = which("ttyd", env);
  const ffmpeg = which("ffmpeg", env);
  const missing = [!vhs && "vhs", !ttyd && "ttyd", !ffmpeg && "ffmpeg"].filter(Boolean);
  if (missing.length) return `${missing.join(", ")} not found (brew install vhs installs them)`;
  if (!BROWSERS.some((b) => existsSync(b))) return "no Chrome, Chromium or Edge in /Applications (VHS would try to download one)";
  if (/\s/.test(process.execPath)) return "the Node path contains a space, so the ttyd wrapper cannot name it";
  return { sandboxExec, vhs: vhs!, ttyd: ttyd!, ffmpeg: ffmpeg!, node: process.execPath };
}

// ---------- the probe ----------

export interface TerminalSandboxHealth {
  ok: boolean;
  detail: string;
  /** Each verdict: only an explicit refusal by the sandbox counts as "denied". */
  probes: Partial<Record<"shellNetwork" | "shellLoopback" | "shellWriteOutside" | "shellReadHome" | "shellSignal" | "recorderNetwork" | "recorderLoopback" | "recorderWriteOutside", "denied" | "allowed" | "unknown">>;
}

const CONNECT = `const s=require("node:net").connect(Number(process.argv[2]),process.argv[1]);s.on("connect",()=>{console.log("CONNECTED");process.exit(0)});s.on("error",e=>{console.log("DENIED "+e.code);process.exit(3)});setTimeout(()=>{console.log("TIMEOUT");process.exit(4)},3000)`;
const WRITE = `try{require("node:fs").writeFileSync(process.argv[1],"x");console.log("WROTE")}catch(e){console.log("DENIED "+e.code);process.exit(3)}`;
/** Lists a folder: only whether it could, never a name or what a file holds. */
const LIST = `try{require("node:fs").readdirSync(process.argv[1]);console.log("LISTED")}catch(e){console.log("DENIED "+e.code);process.exit(3)}`;
const SIGNAL = `try{process.kill(Number(process.argv[1]),0);console.log("SIGNALLED")}catch(e){console.log("DENIED "+e.code);process.exit(3)}`;

function runCapture(cmd: string, args: string[], o: { env: NodeJS.ProcessEnv; cwd: string; timeoutMs: number }): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((res) => {
    const child = spawn(cmd, args, { cwd: o.cwd, env: o.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    trackLive(child);
    let stdout = "";
    let stderr = "";
    child.stdout!.setEncoding("utf8").on("data", (d: string) => (stdout = (stdout + d).slice(-4000)));
    child.stderr!.setEncoding("utf8").on("data", (d: string) => (stderr = (stderr + d).slice(-4000)));
    const t = setTimeout(() => killGroup(child, "SIGKILL"), o.timeoutMs);
    child.on("error", (e) => {
      clearTimeout(t);
      res({ code: null, stdout, stderr: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(t);
      res({ code, stdout, stderr });
    });
  });
}

const verdict = (r: { code: number | null; stdout: string }, success: string): "denied" | "allowed" | "unknown" => (r.stdout.includes(success) && r.code === 0 ? "allowed" : r.code === 3 && /DENIED E(PERM|ACCES)/.test(r.stdout) ? "denied" : "unknown");

/** Passed probes, per sandbox-exec path. */
const healthCache = new Map<string, Promise<TerminalSandboxHealth>>();

/**
 * Prove the two profiles on this machine before anything is recorded, with service-owned commands in
 * a scratch folder: the shell profile must refuse a write outside its folders, a signal to this process
 * (the reaper relies on it), a read of the user's home folder, and a connection to the internet or to a
 * loopback port this process listens on; the recorder profile must refuse the internet and outside
 * writes, and must reach loopback. Only explicit refusals count. Cached for the process once it passes;
 * `fresh` checks again.
 */
export function probeTerminalSandbox(o: { env?: NodeJS.ProcessEnv; tmpRoot?: string; fresh?: boolean; sandboxExec?: string } = {}): Promise<TerminalSandboxHealth> {
  const key = o.sandboxExec ?? SANDBOX_EXEC;
  let h = healthCache.get(key);
  if (!h || o.fresh) {
    h = probe(o, key).then((x) => {
      if (!x.ok) healthCache.delete(key);
      return x;
    });
    healthCache.set(key, h);
  }
  return h;
}

async function probe(o: { env?: NodeJS.ProcessEnv; tmpRoot?: string }, sandboxExec: string): Promise<TerminalSandboxHealth> {
  const probes: TerminalSandboxHealth["probes"] = {};
  const tools = findTools(o.env ?? process.env, sandboxExec);
  if (typeof tools === "string") return { ok: false, detail: tools, probes };
  const root = realpathSync(mkdtempSync(join(o.tmpRoot ?? tmpdir(), "orc-vhs-probe-")));
  const dirs = { work: join(root, "work"), shellTmp: join(root, "shell"), out: join(root, "out"), vhsTmp: join(root, "vhs"), sock: join(root, "sock") };
  for (const d of Object.values(dirs)) mkdirSync(d, { mode: 0o700 });
  const listener = await new Promise<NetServer>((res, rej) => {
    const s = createServer((c) => c.destroy());
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => res(s));
  });
  const port = (listener.address() as { port: number }).port;
  const reads = shellReads(o.env ?? process.env, toolFolders(tools.node));
  if (typeof reads === "string") {
    listener.close();
    rmSync(root, { recursive: true, force: true });
    return { ok: false, detail: reads, probes };
  }
  // The shell profile's own port is one nobody listens on; the probe's listener stands for the service.
  writeFileSync(join(root, "shell.sb"), shellProfile(port === 65535 ? 65534 : port + 1, reads));
  writeFileSync(join(root, "recorder.sb"), recorderProfile());
  const env = { PATH: STD_PATH.join(":"), HOME: o.env?.HOME ?? process.env.HOME ?? "/", TMPDIR: dirs.shellTmp };
  const inShell = (args: string[]) => runCapture(tools.sandboxExec, ["-f", join(root, "shell.sb"), "-D", `WORK=${dirs.work}`, "-D", `SHELL_TMP=${dirs.shellTmp}`, tools.node, ...args], { env, cwd: dirs.work, timeoutMs: 10_000 });
  const inRecorder = (args: string[]) => runCapture(tools.sandboxExec, ["-f", join(root, "recorder.sb"), "-D", `OUT=${dirs.out}`, "-D", `VHS_TMP=${dirs.vhsTmp}`, "-D", `SOCK_DIR=${dirs.sock}`, tools.node, ...args], { env: { ...env, TMPDIR: dirs.vhsTmp }, cwd: dirs.out, timeoutMs: 10_000 });
  const outside = join(root, "outside.txt");
  // In order, stopping at the first wrong answer (so a stand-in that sandboxes nothing never reaches the network).
  type Step = [keyof TerminalSandboxHealth["probes"], "denied" | "allowed", () => Promise<"denied" | "allowed" | "unknown">];
  // The user's home folder: listed, not read, and only to see that it is refused.
  const homeStep: Step[] = reads.deny.slice(0, 1).map((home) => ["shellReadHome", "denied", async () => verdict(await inShell(["-e", LIST, home]), "LISTED")]);
  const steps: Step[] = [
    ["shellWriteOutside", "denied", async () => verdict(await inShell(["-e", WRITE, outside]), "WROTE")],
    ["shellSignal", "denied", async () => verdict(await inShell(["-e", SIGNAL, String(process.pid)]), "SIGNALLED")],
    ...homeStep,
    ["recorderWriteOutside", "denied", async () => verdict(await inRecorder(["-e", WRITE, outside]), "WROTE")],
    ["shellLoopback", "denied", async () => verdict(await inShell(["-e", CONNECT, "127.0.0.1", String(port)]), "CONNECTED")],
    ["recorderLoopback", "allowed", async () => verdict(await inRecorder(["-e", CONNECT, "127.0.0.1", String(port)]), "CONNECTED")],
    ["shellNetwork", "denied", async () => verdict(await inShell(["-e", CONNECT, "1.1.1.1", "443"]), "CONNECTED")],
    ["recorderNetwork", "denied", async () => verdict(await inRecorder(["-e", CONNECT, "1.1.1.1", "443"]), "CONNECTED")],
  ];
  try {
    const inside = await inShell(["-e", WRITE, join(dirs.work, "inside.txt")]);
    if (!existsSync(join(dirs.work, "inside.txt"))) return { ok: false, detail: `the shell sandbox could not run a command or write inside its folder (exit ${inside.code}): ${(inside.stderr || inside.stdout).trim().slice(0, 200) || "no output"}`, probes };
    for (const [k, want, run] of steps) {
      probes[k] = await run();
      if (existsSync(outside)) probes[k] = k.endsWith("WriteOutside") ? "allowed" : probes[k];
      if (probes[k] !== want) return { ok: false, detail: `the sandbox profiles did not behave as required: ${k} ${probes[k]} (want ${want})`, probes };
    }
    return { ok: true, detail: "sandbox-exec verified: the shell cannot reach the network or loopback, write outside its folders, read the home folder or signal the service; the recorder reaches loopback only and writes only to its folders.", probes };
  } finally {
    listener.close();
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------- recording ----------

export interface RecordOptions {
  /** The tape's path in the artifact's folder (`demo/demo.tape`); default the folder's only top-level .tape. */
  tape?: string;
  timeoutMs?: number;
  /** Per output file. */
  maxOutputBytes?: number;
  /** Everything the run writes meanwhile: the outputs, VHS's frames, Chrome's profile, the shell's files. */
  maxDiskBytes?: number;
  /** Where the run's temporary folders go; default the system temp folder. Removed afterwards. */
  tmpRoot?: string;
  /** Where the tools are looked up (PATH) and HOME and LANG come from; default process.env. */
  env?: NodeJS.ProcessEnv;
  /** Default /usr/bin/sandbox-exec. Whatever it is, the probe must prove it sandboxes before anything records. */
  sandboxExec?: string;
  log?: (msg: string) => void;
}

export interface RecordResult {
  webm?: string;
  gif?: string;
  txt?: string;
  /** The sandbox the recording ran in; null when nothing ran. */
  sandbox: "sandbox-exec" | null;
  error?: string;
  /** Why nothing (or not everything) was recorded. "unavailable": no working sandbox or a tool is missing, so use the fallback (hand-written .cast or .ans, labelled as not recorded). */
  reason?: "unavailable" | "invalid-tape" | "failed" | "timeout" | "too-large";
  /**
   * Of a recording: the first line of its transcript with a clear failure signature (transcriptError), when it shows
   * one. Scanned whether or not the tape asked for a transcript.
   */
  errorLine?: string;
  durationMs?: number;
}

/**
 * Clear signs that a command in a recording failed, as a terminal shows them. Explicit and short on purpose: each is
 * printed by a shell, Node, Python, Go or the sandbox only when something went wrong, so a planned CLI's own output
 * does not trip them. A line typed at VHS's prompt ("> ") is the tape's own command, not output, and is skipped.
 */
export const FAILURE_SIGNATURES: readonly { what: string; line: RegExp }[] = [
  { what: "a missing Node module or script", line: /Cannot find module/ },
  { what: "a missing program (bash, zsh)", line: /command not found/i },
  { what: "a missing file", line: /No such file or directory/i },
  { what: "a refusal: a script without its execute bit, or the sandbox", line: /Permission denied|Operation not permitted/i },
  { what: "an uncaught JavaScript error", line: /^(?:Uncaught )?(?:Error|SyntaxError|ReferenceError|TypeError|RangeError)(?: \[[A-Z0-9_]+\])?:/ },
  { what: "a Python traceback", line: /^Traceback \(most recent call last\)/ },
  { what: "a Go panic", line: /^panic: / },
  { what: "a crash", line: /Segmentation fault/i },
  { what: "a non-zero exit the shell printed (a bash job, zsh's printexitvalue)", line: /^\[\d+\][+-]?\s+Exit \d+|^zsh: exit \d+/ },
];
/** VHS's prompt, for bash and zsh: a line starting with it is a typed command. */
const PROMPT_LINE = /^> /;
const ERROR_LINE_CAP = 200;

/**
 * The first line of a recording's transcript with a failure signature, trimmed, or undefined when it shows none.
 * "At the start of a line" means at its first column: an indented "Error:" is a demo's own text.
 */
export function transcriptError(transcript: string): string | undefined {
  for (const raw of transcript.split(/\r?\n/)) {
    const line = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trimEnd();
    if (!PROMPT_LINE.test(line) && FAILURE_SIGNATURES.some((s) => s.line.test(line))) return line.trim().slice(0, ERROR_LINE_CAP);
  }
  return undefined;
}

/** What VHS 0.12 passes to ttyd right after `--port=N`; the broker requires it (another VHS version is refused, not guessed at). */
const TTYD_FIXED = ["--interface", "127.0.0.1"];

/**
 * The wrapper VHS finds as `ttyd`. VHS first asks `ttyd --version`, answered by the real ttyd here; the
 * session itself is handed to the broker (arguments and the shell's prompt), and the wrapper lives as
 * long as the real ttyd does.
 */
function wrapperSource(node: string, ttyd: string, socket: string): string {
  return `#!${node}
// Orchestrator's ttyd wrapper (server/studio/terminal.ts): the real ttyd runs in the shell sandbox.
if (process.argv.length === 3 && process.argv[2] === "--version") {
  const r = require("node:child_process").spawnSync(${JSON.stringify(ttyd)}, ["--version"], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}
const s = require("node:net").connect(${JSON.stringify(socket)});
let code = 1;
s.on("connect", () => s.write(JSON.stringify({ args: process.argv.slice(2), env: { PS1: process.env.PS1, PROMPT: process.env.PROMPT } }) + "\\n"));
s.setEncoding("utf8");
s.on("data", (d) => { const m = /exit (\\d+)/.exec(d); if (m) code = Number(m[1]); });
s.on("close", () => process.exit(code));
s.on("error", () => process.exit(1));
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => { s.destroy(); process.exit(1); });
`;
}

/** The highest process id on macOS. */
const MAX_PID = 99_999;
/** The reaper's exit code when the sandbox did not hold, so it signalled nothing but ttyd. */
const REAPER_REFUSED = 97;
/** How long the cleanup waits for the reaper to end the shell sandbox. */
const REAP_WAIT_MS = 15_000;

/**
 * The reaper, the first process of the shell sandbox: sandbox-exec starts it, it starts the real ttyd,
 * and when the recording ends (the broker asks, its stdin closes, or ttyd exits) it ends every process
 * of this sandbox, detached ones included: a process that double-forked into a session of its own, with
 * no terminal and an empty environment, is still in the sandbox. The profile lets a process signal only
 * processes of its own sandbox, so the ones the reaper can signal are exactly the tape's. It stops them
 * all first, round after round until no new one appears (so none forks away meanwhile), then kills
 * them. Two guards: it signals nothing unless a signal to the service is refused (the sandbox holds),
 * and it never signals a process the service listed before VHS started. It starts ttyd at once, since
 * VHS opens ttyd's page without waiting. A tape can still kill the reaper first; then what it left keeps
 * running, but inside the sandbox (no network, no home folder, no writes outside its removed folders),
 * and the cleanup logs it.
 */
function reaperSource(): string {
  return `"use strict";
// Orchestrator's shell reaper (server/studio/terminal.ts). Arguments: the service's pid, the file listing the
// processes that ran before the recording, the real ttyd, and its arguments.
const [service, beforeFile, ttyd, ...args] = process.argv.slice(2);
const child = require("node:child_process").spawn(ttyd, args, { stdio: ["ignore", "ignore", "inherit"] });
const before = new Set(require("node:fs").readFileSync(beforeFile, "utf8").split("\\n").map(Number).filter((n) => n > 0));
let code = null;
let reaping = false;
function reap(why) {
  if (reaping) return;
  reaping = true;
  let holds = false;
  try { process.kill(Number(service), 0); } catch (e) { holds = e.code === "EPERM"; }
  if (!holds) {
    try { child.kill("SIGKILL"); } catch {}
    process.stderr.write("orchestrator-reaper: the sandbox does not hold; only ttyd was ended\\n");
    process.exit(${REAPER_REFUSED});
  }
  const stopped = new Set();
  for (let round = 0; round < 50; round++) {
    let found = 0;
    for (let pid = 2; pid <= ${MAX_PID}; pid++) {
      if (pid === process.pid || before.has(pid) || stopped.has(pid)) continue;
      try { process.kill(pid, "SIGSTOP"); stopped.add(pid); found++; } catch {}
    }
    if (!found) break;
  }
  for (const pid of stopped) { try { process.kill(pid, "SIGKILL"); } catch {} }
  process.stderr.write("orchestrator-reaper: ended " + stopped.size + " (" + why + ")\\n");
  process.exit(code ?? 0);
}
child.on("exit", (c) => { code = c ?? 1; reap("ttyd exited"); });
child.on("error", () => { code = 1; reap("ttyd did not start"); });
process.stdin.on("data", (d) => { if (String(d).includes("reap")) reap("asked"); });
process.stdin.on("end", () => reap("the service is gone"));
process.stdin.on("error", () => reap("the service is gone"));
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => reap(sig));
`;
}

function folderBytes(dir: string): number {
  let total = 0;
  const walk = (d: string) => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const n of names) {
      const f = join(d, n);
      try {
        const st = lstatSync(f);
        if (st.isDirectory()) walk(f);
        else total += st.size;
      } catch {
        /* removed meanwhile */
      }
    }
  };
  walk(dir);
  return total;
}

/** Every process id on the machine (empty if ps cannot run). */
function processIds(): number[] {
  try {
    return execFileSync("/bin/ps", ["-axo", "pid="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
      .split("\n")
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

/** Kill every process whose command line names `marker` (Chrome and its helpers carry their profile folder). */
function sweep(marker: string) {
  let list = "";
  try {
    list = execFileSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return;
  }
  for (const line of list.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m || !m[2].includes(marker) || Number(m[1]) === process.pid) continue;
    try {
      process.kill(Number(m[1]), "SIGKILL");
    } catch {
      /* gone */
    }
  }
}

const tail = (s: string, n = 600) =>
  s
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .trim()
    .slice(-n);

/**
 * Record `<artifactDir>/<tape>` into `outDir` (created, and empty), sandboxed as described at the top of
 * this file. The artifact's folder is copied first (the working copy) and the tape checked against the
 * copy; the shell starts at the copy's root, so the tape's commands name files by their paths in the
 * artifact. VHS runs in the tape's folder with one argument, a copy of the tape whose Outputs point into
 * `outDir`. The transcript (the tape's, or the service's own when the tape asks for none) is scanned for
 * failures (`errorLine`). Never runs unsandboxed: without a verified sandbox the result is a refusal with
 * reason "unavailable".
 */
export async function recordTape(artifactDir: string, outDir: string, opts: RecordOptions = {}): Promise<RecordResult> {
  const t0 = Date.now();
  const env = opts.env ?? process.env;
  const log = opts.log ?? (() => {});
  const timeoutMs = opts.timeoutMs ?? RECORD_DEFAULTS.timeoutMs;
  const maxOutputBytes = opts.maxOutputBytes ?? RECORD_DEFAULTS.maxOutputBytes;
  const maxDiskBytes = opts.maxDiskBytes ?? RECORD_DEFAULTS.maxDiskBytes;
  const done = (r: Omit<RecordResult, "durationMs">): RecordResult => ({ ...r, durationMs: Date.now() - t0 });

  // The tape, in the artifact's folder.
  let given = opts.tape;
  try {
    if (!given) {
      const tapes = readdirSync(artifactDir).filter((f) => f.endsWith(".tape"));
      if (tapes.length !== 1) return done({ sandbox: null, reason: "invalid-tape", error: tapes.length ? `the folder has ${tapes.length} tapes; name one` : "the folder has no .tape" });
      given = tapes[0];
    }
  } catch (e) {
    return done({ sandbox: null, reason: "invalid-tape", error: `cannot read the artifact's folder: ${e instanceof Error ? e.message : String(e)}` });
  }
  const tapeName = insidePath(given);
  if (!tapeName || !tapeName.endsWith(".tape")) return done({ sandbox: null, reason: "invalid-tape", error: `${given} is not a .tape in the folder` });
  const tapeFolder = posix.dirname(tapeName);

  try {
    mkdirSync(outDir, { recursive: true, mode: 0o700 });
  } catch (e) {
    return done({ sandbox: null, reason: "failed", error: `cannot create the output folder: ${e instanceof Error ? e.message : String(e)}` });
  }
  const out = realpathSync(outDir);
  if (readdirSync(out).length) return done({ sandbox: null, reason: "failed", error: "the output folder is not empty" });
  if (/["`\n\r]/.test(out)) return done({ sandbox: null, reason: "failed", error: "the output folder's path has a quote or a line break" });

  const root = realpathSync(mkdtempSync(join(opts.tmpRoot ?? tmpdir(), "orc-vhs-")));
  if (/["`\n\r]/.test(root)) {
    rmSync(root, { recursive: true, force: true });
    return done({ sandbox: null, reason: "failed", error: "the temporary folder's path has a quote or a line break" });
  }
  const d = { work: join(root, "work"), vhsTmp: join(root, "vhs"), shellTmp: join(root, "shell"), sock: join(root, "sock"), bin: join(root, "bin") };
  for (const x of [d.vhsTmp, d.shellTmp, d.sock, d.bin]) mkdirSync(x, { mode: 0o700 });
  const children: ChildProcess[] = [];
  let broker: NetServer | undefined;
  /** The shell sandbox's reaper (it runs ttyd), once the broker started it. */
  let reaper: ChildProcess | undefined;
  const reap = () => {
    if (reaper && reaper.exitCode === null && reaper.signalCode === null) reaper.stdin?.end("reap\n");
  };
  // The shell's processes go first, through the reaper (they may have left its group and session), then
  // everything this run started, then Chrome's helpers by their profile folder; then the folders.
  const cleanup = async () => {
    if (reaper && reaper.exitCode === null && reaper.signalCode === null) {
      const exited = new Promise<void>((res) => reaper!.once("exit", () => res()));
      reap();
      await Promise.race([exited, new Promise<void>((res) => setTimeout(res, REAP_WAIT_MS).unref())]);
    }
    if (reaper && reaper.signalCode !== null) log(`terminal: the shell's reaper was ended by ${reaper.signalCode} before it finished; a process the tape left may still run, inside the shell sandbox`);
    else if (reaper?.exitCode === REAPER_REFUSED) log("terminal: the shell's reaper found the sandbox did not hold and ended only ttyd");
    for (const c of children) killGroup(c, "SIGKILL");
    sweep(d.vhsTmp);
    broker?.close();
    rmSync(root, { recursive: true, force: true });
  };

  try {
    const copyErr = copyFolder(artifactDir, d.work);
    if (copyErr) return done({ sandbox: null, reason: "invalid-tape", error: `the artifact's files: ${copyErr}` });
    const tapePath = join(d.work, tapeName);
    // VHS's own paths (Source; Output is rewritten below) are relative to the tape, so VHS runs in its folder.
    const vhsDir = join(d.work, tapeFolder);
    let st;
    try {
      st = lstatSync(tapePath);
    } catch {
      return done({ sandbox: null, reason: "invalid-tape", error: `${tapeName} was not found` });
    }
    if (!st.isFile() || st.size > TAPE_CAP) return done({ sandbox: null, reason: "invalid-tape", error: `${tapeName} is not a file of at most ${TAPE_CAP / 1024} KB` });
    const readSource = (rel: string) => {
      try {
        const f = join(vhsDir, rel);
        const s = lstatSync(f);
        return s.isFile() && s.size <= TAPE_CAP ? readFileSync(f, "utf8") : undefined;
      } catch {
        return undefined;
      }
    };
    const check = validateTape(readFileSync(tapePath, "utf8"), { name: tapeName, readSource, outDir: out });
    if (!check.ok) return done({ sandbox: null, reason: "invalid-tape", error: check.errors.join("; ") });

    // Only now the sandbox: a tape is refused for its own faults whether or not this machine can record.
    const sandboxExec = opts.sandboxExec ?? SANDBOX_EXEC;
    const tools = findTools(env, sandboxExec);
    if (typeof tools === "string") return done({ sandbox: null, reason: "unavailable", error: `Not recorded: ${tools}. Use a hand-written .cast or .ans instead.` });
    const health = await probeTerminalSandbox({ env, tmpRoot: opts.tmpRoot, sandboxExec });
    if (!health.ok) return done({ sandbox: null, reason: "unavailable", error: `Not recorded: no working sandbox (${health.detail}). Nothing runs unsandboxed; use a hand-written .cast or .ans instead.` });
    for (const rel of Object.values(check.outputs)) mkdirSync(dirname(join(out, rel!)), { recursive: true, mode: 0o700 });
    // Every recording's transcript is scanned for failures: when the tape asks for none, the service adds its own,
    // in the recorder's temp folder (VHS keeps one Output per type), and removes it with that folder.
    const transcript = check.outputs.txt ? join(out, check.outputs.txt) : join(d.vhsTmp, "transcript.txt");
    const runTape = join(root, "run.tape");
    writeFileSync(runTape, check.outputs.txt ? check.normalized! : `Output ${quoteForTape(transcript)}\n${check.normalized!}`, { mode: 0o600 });
    writeFileSync(join(root, "recorder.sb"), recorderProfile(), { mode: 0o600 });

    // The broker: one ttyd, started in the shell sandbox by its reaper, for the one wrapper that asks.
    const socketPath = join(d.sock, "b.sock");
    const reaperFile = join(d.bin, "reaper.cjs");
    const beforeFile = join(d.bin, "before.txt");
    const reads = shellReads(env, [...toolFolders(tools.node), ...toolFolders(tools.ttyd), d.bin]);
    if (typeof reads === "string") return done({ sandbox: null, reason: "unavailable", error: `Not recorded: ${reads}. Use a hand-written .cast or .ans instead.` });
    const shellPath = [dirname(tools.node), dirname(tools.ttyd), ...STD_PATH].filter((v, i, a) => a.indexOf(v) === i).join(":");
    let brokerError: string | undefined;
    let ttydStderr = "";
    let asked = false;
    broker = createServer((sock: Socket) => {
      // One ttyd per recording: any later connection is refused.
      if (asked) return sock.destroy();
      asked = true;
      let buf = "";
      sock.setEncoding("utf8");
      sock.on("data", (chunk: string) => {
        buf += chunk;
        if (buf.length > 16_384) return sock.destroy();
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        let req: { args?: unknown; env?: { PS1?: unknown; PROMPT?: unknown } };
        try {
          req = JSON.parse(buf.slice(0, nl));
        } catch {
          return sock.destroy();
        }
        const args = Array.isArray(req.args) && req.args.every((a) => typeof a === "string") ? (req.args as string[]) : [];
        const port = Number(/^--port=(\d+)$/.exec(args[0] ?? "")?.[1]);
        const fixed = args.slice(1, 1 + TTYD_FIXED.length).join(" ") === TTYD_FIXED.join(" ");
        if (!Number.isInteger(port) || port < 1 || port > 65535 || !fixed) {
          brokerError = `VHS started ttyd with unexpected arguments (${args.slice(0, 3).join(" ")}…); this VHS version is not supported`;
          return sock.destroy();
        }
        writeFileSync(join(root, "shell.sb"), shellProfile(port, reads), { mode: 0o600 });
        const shellEnv: Record<string, string> = { PATH: shellPath, HOME: env.HOME ?? "/", LANG: env.LANG ?? "en_US.UTF-8", TMPDIR: d.shellTmp, BASH_SILENCE_DEPRECATION_WARNING: "1" };
        for (const k of ["PS1", "PROMPT"] as const) if (typeof req.env?.[k] === "string") shellEnv[k] = req.env[k] as string;
        // The reaper starts ttyd inside the sandbox and ends the whole sandbox afterwards. Not registered with
        // trackLive: killing its group when this process exits would end it before it reaps; it reaps when
        // its stdin, this process's end of the pipe, closes. ttyd and its shell inherit its directory: the
        // working copy's root, so the tape's commands name files by their paths in the artifact.
        const ttyd = spawn(tools.sandboxExec, ["-f", join(root, "shell.sb"), "-D", `WORK=${d.work}`, "-D", `SHELL_TMP=${d.shellTmp}`, tools.node, reaperFile, String(process.pid), beforeFile, tools.ttyd, ...args], { cwd: d.work, env: shellEnv, stdio: ["pipe", "ignore", "pipe"], detached: true });
        reaper = ttyd;
        children.push(ttyd);
        ttyd.stdin!.on("error", () => {});
        ttyd.stderr!.setEncoding("utf8").on("data", (x: string) => (ttydStderr = (ttydStderr + x).slice(-2000)));
        ttyd.on("error", (e) => {
          brokerError = `could not start ttyd: ${e.message}`;
          sock.destroy();
        });
        ttyd.on("exit", (code) => sock.end(`exit ${code ?? 1}\n`));
        sock.on("close", reap);
      });
      sock.on("error", () => {});
    });
    await new Promise<void>((res, rej) => {
      broker!.once("error", rej);
      broker!.listen(socketPath, () => res());
    });
    const wrapper = join(d.bin, "ttyd");
    writeFileSync(wrapper, wrapperSource(tools.node, tools.ttyd, socketPath), { mode: 0o700 });
    writeFileSync(reaperFile, reaperSource(), { mode: 0o600 });
    // Every process running before VHS starts, so before the tape can start any: the reaper never signals these.
    writeFileSync(beforeFile, processIds().join("\n"), { mode: 0o600 });

    // VHS, with one argument, inside the recorder sandbox.
    const vhsEnv: Record<string, string> = {
      PATH: [d.bin, dirname(tools.ffmpeg), ...STD_PATH].filter((v, i, a) => a.indexOf(v) === i).join(":"),
      HOME: env.HOME ?? "/",
      LANG: env.LANG ?? "en_US.UTF-8",
      TMPDIR: d.vhsTmp,
      // Chrome takes its temp folder (its singleton socket) from here on macOS, not from TMPDIR.
      MAC_CHROMIUM_TMPDIR: d.vhsTmp,
      // Chrome's own sandbox cannot start inside sandbox-exec; the recorder profile is its boundary.
      VHS_NO_SANDBOX: "1",
    };
    log(`terminal: recording ${tapeName} in ${root}`);
    const vhs = spawn(tools.sandboxExec, ["-f", join(root, "recorder.sb"), "-D", `OUT=${out}`, "-D", `VHS_TMP=${d.vhsTmp}`, "-D", `SOCK_DIR=${d.sock}`, tools.vhs, runTape], { cwd: vhsDir, env: vhsEnv, stdio: ["ignore", "pipe", "pipe"], detached: true });
    trackLive(vhs);
    children.push(vhs);
    let vhsOut = "";
    vhs.stdout!.setEncoding("utf8").on("data", (x: string) => (vhsOut = (vhsOut + x).slice(-4000)));
    vhs.stderr!.setEncoding("utf8").on("data", (x: string) => (vhsOut = (vhsOut + x).slice(-4000)));
    let stopped: "timeout" | "too-large" | undefined;
    const stop = (why: "timeout" | "too-large") => {
      if (stopped) return;
      stopped = why;
      // The shell's side through its reaper (the cleanup below waits for it); VHS and Chrome at once.
      reap();
      for (const c of children) if (c !== reaper) killGroup(c, "SIGKILL");
      sweep(d.vhsTmp);
    };
    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    const watch = setInterval(() => {
      if (folderBytes(out) + folderBytes(root) > maxDiskBytes) stop("too-large");
    }, 1000);
    const code = await new Promise<number | null>((res) => {
      vhs.on("error", () => res(null));
      vhs.on("close", (c) => res(c));
    });
    clearTimeout(timer);
    clearInterval(watch);

    // A run that did not finish leaves no partial outputs behind.
    const failed = (r: Omit<RecordResult, "durationMs" | "sandbox">) => {
      for (const f of readdirSync(out)) rmSync(join(out, f), { recursive: true, force: true });
      return done({ sandbox: "sandbox-exec", ...r });
    };
    if (stopped === "timeout") return failed({ reason: "timeout", error: `VHS did not finish within ${Math.round(timeoutMs / 1000)} s; it was stopped` });
    if (stopped === "too-large") return failed({ reason: "too-large", error: `the recording wrote more than ${Math.round(maxDiskBytes / 1024 / 1024)} MB; it was stopped` });
    if (code !== 0) return failed({ reason: "failed", error: `VHS failed (exit ${code ?? "?"})${brokerError ? `: ${brokerError}` : ""}: ${tail(vhsOut) || tail(ttydStderr) || "no output"}` });
    const result: RecordResult = { sandbox: "sandbox-exec" };
    for (const [type, rel] of Object.entries(check.outputs) as [OutputType, string][]) {
      const f = join(out, rel);
      let size = -1;
      try {
        const s = lstatSync(f);
        if (s.isFile()) size = s.size;
      } catch {
        /* missing */
      }
      if (size < 0) return failed({ reason: "failed", error: `VHS did not write ${rel}: ${tail(vhsOut) || "no output"}` });
      if (size > maxOutputBytes) return failed({ reason: "too-large", error: `${rel} is ${Math.round(size / 1024 / 1024)} MB, over the ${Math.round(maxOutputBytes / 1024 / 1024)} MB cap; the outputs were removed` });
      result[type] = f;
    }
    // A recording that shows a failure says so, with its first failing line.
    try {
      const st = lstatSync(transcript);
      if (!st.isFile() || st.size > maxOutputBytes) throw new Error(st.isFile() ? "it is too large" : "it is not a file");
      const errorLine = transcriptError(readFileSync(transcript, "utf8"));
      if (errorLine) result.errorLine = errorLine;
    } catch (e) {
      log(`terminal: the transcript of ${tapeName} could not be scanned for failures: ${e instanceof Error ? e.message : String(e)}`);
    }
    return done(result);
  } catch (e) {
    return done({ sandbox: null, reason: "failed", error: e instanceof Error ? e.message : String(e) });
  } finally {
    await cleanup();
  }
}

// ---------- the fallback: hand-written asciicast v3 and .ans frames ----------

/**
 * The escapes a hand-written terminal file may use: SGR colours and styles (`ESC[…m`), cursor moves
 * (`ESC[nA`…`G`, `ESC[n;mH`/`f`, `ESC[nd`), erase in display or line (`ESC[nJ`, `ESC[nK`) and cursor
 * show or hide (`ESC[?25h`/`l`). Everything else (OSC titles, links and clipboard writes, DCS, device
 * reports, mode switches) is refused, as are control characters other than \n, \r, \t and \b.
 */
const ALLOWED_ESCAPE = /^\x1b\[(?:[0-9;:]{0,64}m|\d{0,4}[ABCDEFGd]|\d{0,4}(?:;\d{0,4})?[Hf]|[0-3]?[JK]|\?25[hl])/;

/** The first refused character or escape in `s`, described, or undefined. */
export function refusedEscape(s: string): string | undefined {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x1b) {
      const m = ALLOWED_ESCAPE.exec(s.slice(i, i + 80));
      if (!m) return `the escape ${JSON.stringify(s.slice(i, i + 8))} (only colours, cursor moves, erase and cursor show/hide)`;
      i += m[0].length - 1;
    } else if ((c < 0x20 && c !== 0x0a && c !== 0x0d && c !== 0x09 && c !== 0x08) || c === 0x7f || (c >= 0x80 && c <= 0x9f)) {
      return `the control character U+${c.toString(16).toUpperCase().padStart(4, "0")}`;
    }
  }
  return undefined;
}

const stripEscapes = (s: string) => s.replace(new RegExp(ALLOWED_ESCAPE.source.slice(1), "g"), "");

export type FileCheck<T> = { ok: true; info: T } | { ok: false; error: string };

export interface CastInfo {
  cols: number;
  rows: number;
  /** Seconds, the sum of the intervals. */
  duration: number;
  events: number;
  markers: { time: number; label: string }[];
  title?: string;
}

const isSize = (cols: number, rows: number) => TERMINAL_SIZES.some(([c, r]) => c === cols && r === rows);
const COLOUR = /^#[0-9a-fA-F]{6}$/;

/**
 * An asciicast v3 file (docs.asciinema.org/manual/asciicast/v3): a header line (version 3, term.cols and
 * term.rows from TERMINAL_SIZES), then `[interval, code, data]` lines with codes o, i, m, r and x, and `#`
 * comment lines. Output and input pass `refusedEscape`; at most CAST_CAP bytes and CAST_MAX_SECONDS.
 */
export function validateCast(text: string): FileCheck<CastInfo> {
  const bad = (error: string): FileCheck<CastInfo> => ({ ok: false, error });
  if (Buffer.byteLength(text, "utf8") > CAST_CAP) return bad(`larger than ${CAST_CAP / 1024 / 1024} MB`);
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const first = lines.findIndex((l) => !l.startsWith("#"));
  if (first < 0) return bad("no header line");
  let header: unknown;
  try {
    header = JSON.parse(lines[first]);
  } catch {
    return bad(`line ${first + 1}: the header is not JSON`);
  }
  const h = header as { version?: unknown; term?: { cols?: unknown; rows?: unknown; type?: unknown; theme?: { fg?: unknown; bg?: unknown; palette?: unknown } }; title?: unknown; idle_time_limit?: unknown; timestamp?: unknown; command?: unknown; env?: unknown; tags?: unknown };
  if (typeof h !== "object" || h === null || Array.isArray(h)) return bad("the header is not an object");
  if (h.version !== 3) return bad("the header's version is not 3 (asciicast v3)");
  const cols = h.term?.cols;
  const rows = h.term?.rows;
  if (typeof cols !== "number" || typeof rows !== "number" || !Number.isInteger(cols) || !Number.isInteger(rows)) return bad("the header's term.cols and term.rows must be whole numbers");
  if (!isSize(cols, rows)) return bad(`${cols}×${rows} is not a studio terminal size`);
  if (h.term?.type !== undefined && typeof h.term.type !== "string") return bad("term.type must be a string");
  const theme = h.term?.theme;
  if (theme !== undefined) {
    if (typeof theme !== "object" || theme === null) return bad("term.theme must be an object");
    if (!COLOUR.test(String(theme.fg)) || !COLOUR.test(String(theme.bg))) return bad("term.theme fg and bg must be #rrggbb");
    const pal = String(theme.palette).split(":");
    if (!(pal.length === 8 || pal.length === 16) || !pal.every((p) => COLOUR.test(p))) return bad("term.theme.palette must be 8 or 16 #rrggbb colours joined by ':'");
  }
  if (h.title !== undefined && (typeof h.title !== "string" || h.title.length > 200 || refusedEscape(h.title))) return bad("title must be plain text of at most 200 characters");
  if (h.idle_time_limit !== undefined && (typeof h.idle_time_limit !== "number" || !(h.idle_time_limit > 0))) return bad("idle_time_limit must be a positive number");
  if (h.timestamp !== undefined && (typeof h.timestamp !== "number" || !Number.isInteger(h.timestamp))) return bad("timestamp must be a whole number");
  if (h.command !== undefined && typeof h.command !== "string") return bad("command must be a string");
  if (h.env !== undefined && (typeof h.env !== "object" || h.env === null || Object.values(h.env).some((v) => typeof v !== "string"))) return bad("env must map names to strings");
  if (h.tags !== undefined && (!Array.isArray(h.tags) || h.tags.some((t) => typeof t !== "string"))) return bad("tags must be strings");

  let duration = 0;
  let events = 0;
  const markers: CastInfo["markers"] = [];
  for (let i = first + 1; i < lines.length; i++) {
    const at = `line ${i + 1}`;
    const line = lines[i];
    if (line.startsWith("#")) continue;
    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      return bad(`${at}: not JSON`);
    }
    if (!Array.isArray(ev) || ev.length !== 3) return bad(`${at}: an event is [interval, code, data]`);
    const [interval, code, data] = ev as [unknown, unknown, unknown];
    if (typeof interval !== "number" || !Number.isFinite(interval) || interval < 0) return bad(`${at}: the interval must be a number of seconds, at least 0`);
    if (typeof data !== "string") return bad(`${at}: the data must be a string`);
    duration += interval;
    events++;
    if (code === "o" || code === "i") {
      const why = refusedEscape(data);
      if (why) return bad(`${at}: ${why}`);
    } else if (code === "m") {
      if (data.length > 200 || refusedEscape(data)) return bad(`${at}: a marker label is plain text of at most 200 characters`);
      markers.push({ time: Math.round(duration * 1000) / 1000, label: data });
    } else if (code === "r") {
      const m = /^(\d{1,4})x(\d{1,4})$/.exec(data);
      if (!m || !isSize(Number(m[1]), Number(m[2]))) return bad(`${at}: a resize must be COLSxROWS from the studio sizes`);
    } else if (code === "x") {
      if (!/^\d{1,3}$/.test(data)) return bad(`${at}: an exit status is a number`);
    } else return bad(`${at}: unknown event code ${JSON.stringify(code)} (o, i, m, r or x)`);
  }
  if (duration > CAST_MAX_SECONDS) return bad(`longer than ${CAST_MAX_SECONDS / 60} minutes`);
  return { ok: true, info: { cols, rows, duration: Math.round(duration * 1000) / 1000, events, markers, ...(typeof h.title === "string" ? { title: h.title } : {}) } };
}

export interface AnsInfo {
  lines: number;
  /** The widest line in characters once escapes are removed (code points; a wide character counts as one). */
  width: number;
}

/**
 * A `.ans` frame: one screen of UTF-8 text for a TUI mockup, drawn by the app in a terminal window.
 * Escapes pass `refusedEscape`; at most ANS_CAP bytes, and the text fits `size` (default the largest
 * studio size).
 */
export function validateAnsFrame(text: string, size: { cols: number; rows: number } = { cols: 120, rows: 40 }): FileCheck<AnsInfo> {
  if (Buffer.byteLength(text, "utf8") > ANS_CAP) return { ok: false, error: `larger than ${ANS_CAP / 1024} KB` };
  const why = refusedEscape(text);
  if (why) return { ok: false, error: why };
  const lines = text.replace(/\n$/, "").split("\n");
  if (lines.length > size.rows) return { ok: false, error: `${lines.length} lines, more than ${size.rows} rows` };
  const width = Math.max(0, ...lines.map((l) => Array.from(stripEscapes(l).replace(/\r/g, "")).length));
  if (width > size.cols) return { ok: false, error: `a line is ${width} characters wide, more than ${size.cols} columns` };
  return { ok: true, info: { lines: lines.length, width } };
}

/** Read a hand-written terminal file for validation: a regular file (never a link) within `cap` bytes, as UTF-8. */
export function readTerminalFile(path: string, cap: number): string | { error: string } {
  try {
    const st = lstatSync(path);
    if (!st.isFile()) return { error: "not a regular file" };
    if (st.size > cap) return { error: `larger than ${Math.round(cap / 1024)} KB` };
    const buf = readFileSync(path);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return text;
  } catch (e) {
    return { error: e instanceof TypeError ? "not valid UTF-8" : e instanceof Error ? e.message : String(e) };
  }
}
