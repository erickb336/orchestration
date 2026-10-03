// Terminal demos and TUIs (ORC-029 pass 3, unit 3c; docs/design/ORC-029-pass3-design.md §3c, and the container
// recorder in docs/design/ORC-029-pass4-design.md).
//
// A designer writes a VHS `.tape` and a script that prints the planned output of a CLI that does not exist yet. The
// service checks the tape here (validateTape: the tape rules), then records it with VHS (a fixed argument list, never
// `vhs publish`) in a Docker container (container.ts):
//
//   - The container has no network, a read-only root, no privileges and its own devices (no terminal of the host).
//   - It mounts two folders of a stage folder the service makes for the recording, and nothing else: a copy of the
//     whole artifact version at /work, and an empty output folder at /out.
//   - Before anything records, a probe proves all of it on this machine, with service-owned commands.
//
// The shell starts at the copy's root, so paths in the tape's commands are relative to the artifact's root, as in its
// manifest (`node demo/trips.js`). VHS itself runs in the tape's folder: its own `Output` and `Source` paths are
// relative to the tape, as VHS has them. The tape's shell and VHS run as one user, so the shell can write to the
// output folder too: only the outputs the tape declared leave it, each a regular file within the cap.
//
// After recording, the transcript is scanned for clear failure signatures (FAILURE_SIGNATURES), so a demo that shows
// an error is not passed off as a clean recording.
//
// Without Docker, the recorder's image or a passing probe, nothing is recorded: terminal demos fall back to
// hand-written asciicast v3 files and `.ans` frames, validated here and labelled as not recorded.
//
// The capture of evidence in a project's own environment (docs/design/project-environment.md, unit E2) records no
// VHS: the tape's typed commands (tapeSession) go into a pseudo-terminal in the project's container, and the service
// records what the terminal shows as an asciicast v2 file (recordSession, CastRecorder), with only the escapes the
// app's player draws. No language and no recorder runs in the project's image: Docker's own terminal does the work.

import { chmodSync, copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, posix } from "node:path";
import { OUT, WORK, containerArgs, containerName, defaultRecorderRoot, dockerEnv, makeStage, probeRecorder, removeStage, startRecording, type RunningContainer } from "./container";

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

// ---------- recording ----------

export interface RecordOptions {
  /** The tape's path in the artifact's folder (`demo/demo.tape`); default the folder's only top-level .tape. */
  tape?: string;
  timeoutMs?: number;
  /** Per output file. */
  maxOutputBytes?: number;
  /** Everything the run writes to its folders meanwhile: the copy and the outputs. Its temporary files stay in the container's tmpfs. */
  maxDiskBytes?: number;
  /**
   * Where the run's stage folder goes: the copy Docker mounts and the output folder. Docker must see it (Colima shares
   * only the home folder), and the probe proves it does. Default defaultRecorderRoot(). The stage is removed afterwards.
   */
  tmpRoot?: string;
  /** Where docker is looked up (PATH), and its configuration (HOME, DOCKER_HOST, DOCKER_CONTEXT); default process.env. */
  env?: NodeJS.ProcessEnv;
  /** The docker command; default the one on PATH. Whatever it is, the probe must prove the container before anything records. */
  docker?: string;
  /** Default RECORDER_IMAGE. */
  image?: string;
  log?: (msg: string) => void;
}

export interface RecordResult {
  webm?: string;
  gif?: string;
  txt?: string;
  /** Where the recording ran: the recorder's container; null when nothing ran. */
  sandbox: "container" | null;
  error?: string;
  /** Why nothing (or not everything) was recorded. "unavailable": Docker, the image or a passing probe is missing, so use the fallback (hand-written .cast or .ans, labelled as not recorded). */
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
 * printed by a shell, Node, Python, Go or the container only when something went wrong, so a planned CLI's own output
 * does not trip them. A line typed at VHS's prompt ("> ") is the tape's own command, not output, and is skipped.
 */
export const FAILURE_SIGNATURES: readonly { what: string; line: RegExp }[] = [
  { what: "a missing Node module or script", line: /Cannot find module/ },
  { what: "a missing program (bash, zsh)", line: /command not found/i },
  { what: "a missing file", line: /No such file or directory/i },
  { what: "a refusal: a script without its execute bit, or the container", line: /Permission denied|Operation not permitted/i },
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

const tail = (s: string, n = 600) =>
  s
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .trim()
    .slice(-n);

/** The transcript the service adds, in the output folder, when the tape asks for none. Never copied out. */
const OWN_TRANSCRIPT = ".orchestrator-transcript.txt";
/** How long the container may outlive the service's own timeout before it ends itself (when the service is gone). */
const CONTAINER_GRACE_S = 15;

/**
 * A file the container wrote in the stage's output folder, read only as a regular file inside it: no folder on its way
 * and not the file itself may be a link (the tape's shell can write there too). Its path, or why not.
 */
function stagedOutput(stageOut: string, rel: string, maxBytes: number): { path: string } | { error: string; tooLarge?: true } {
  const f = join(stageOut, rel);
  try {
    const folders = posix.dirname(rel).split("/").filter((p) => p !== ".");
    for (let i = 1; i <= folders.length; i++) {
      if (!lstatSync(join(stageOut, ...folders.slice(0, i))).isDirectory()) return { error: `${rel}: a folder on its way is a link, or not a folder` };
    }
    const st = lstatSync(f);
    if (!st.isFile()) return { error: `${rel} is not a regular file` };
    if (st.size > maxBytes) return { error: `${rel} is ${Math.round(st.size / 1024 / 1024)} MB, over the ${Math.round(maxBytes / 1024 / 1024)} MB cap`, tooLarge: true };
    return { path: f };
  } catch {
    return { error: `VHS did not write ${rel}` };
  }
}

/**
 * Record `<artifactDir>/<tape>` into `outDir` (created, and empty), in the recorder's container (container.ts). The
 * artifact's folder is copied into a new stage folder (its `work/`), and the tape is checked against the copy. The
 * container mounts the copy at /work and the stage's empty `out/` at /out, and nothing else. VHS runs in the tape's
 * folder and reads the tape from stdin, with every Output pointed into /out; the tape's shell starts at /work, so the
 * tape's commands name files by their paths in the artifact. When VHS is done, only the outputs the tape declared are
 * copied to `outDir`, each a regular file within the cap. The transcript (the tape's, or the service's own when the
 * tape asks for none) is scanned for failures (`errorLine`). Never runs outside the container: without Docker, the
 * image or a passing probe, the result is a refusal with reason "unavailable".
 */
export async function recordTape(artifactDir: string, outDir: string, opts: RecordOptions = {}): Promise<RecordResult> {
  const t0 = Date.now();
  const env = opts.env ?? process.env;
  const log = opts.log ?? (() => {});
  const timeoutMs = opts.timeoutMs ?? RECORD_DEFAULTS.timeoutMs;
  const maxOutputBytes = opts.maxOutputBytes ?? RECORD_DEFAULTS.maxOutputBytes;
  const maxDiskBytes = opts.maxDiskBytes ?? RECORD_DEFAULTS.maxDiskBytes;
  const root = opts.tmpRoot ?? defaultRecorderRoot();
  const done = (r: Omit<RecordResult, "durationMs">): RecordResult => ({ ...r, durationMs: Date.now() - t0 });
  const unavailable = (why: string, unsandboxed = false): RecordResult => done({ sandbox: null, reason: "unavailable", error: `Not recorded: ${why}. ${unsandboxed ? "Nothing runs unsandboxed; use" : "Use"} a hand-written .cast or .ans instead.` });

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

  let stage: ReturnType<typeof makeStage>;
  try {
    stage = makeStage(root, "orc-rec-");
  } catch (e) {
    return unavailable(`the recorder cannot make its folder in ${root} (${e instanceof Error ? e.message : String(e)})`);
  }
  let container: RunningContainer | undefined;
  try {
    const copyErr = copyFolder(artifactDir, stage.work);
    if (copyErr) return done({ sandbox: null, reason: "invalid-tape", error: `the artifact's files: ${copyErr}` });
    const tapePath = join(stage.work, tapeName);
    // VHS's own paths (Source; Output is rewritten below) are relative to the tape, so VHS runs in its folder.
    const vhsDir = join(stage.work, tapeFolder);
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
    // Outputs point into the container's output folder.
    const check = validateTape(readFileSync(tapePath, "utf8"), { name: tapeName, readSource, outDir: OUT });
    if (!check.ok) return done({ sandbox: null, reason: "invalid-tape", error: check.errors.join("; ") });

    // Only now the container: a tape is refused for its own faults whether or not this machine can record.
    if (check.shell !== "bash") return unavailable(`the recorder has bash only, and this tape sets ${check.shell} (Set Shell bash records)`);
    const health = await probeRecorder({ docker: opts.docker, env, image: opts.image, root });
    if (!health.ok || !health.docker) return unavailable(health.detail, true);
    for (const rel of Object.values(check.outputs)) mkdirSync(dirname(join(stage.out, rel!)), { recursive: true, mode: 0o700 });
    // Every recording's transcript is scanned for failures: when the tape asks for none, the service adds its own
    // (VHS keeps one Output per type), and it is never copied out.
    const transcriptRel = check.outputs.txt ?? OWN_TRANSCRIPT;
    const tape = check.outputs.txt ? check.normalized! : `Output "${posix.join(OUT, OWN_TRANSCRIPT)}"\n${check.normalized!}`;

    const name = containerName("rec");
    const denv = dockerEnv(env);
    const command = ["/usr/bin/timeout", "--kill-after=5", String(Math.ceil(timeoutMs / 1000) + CONTAINER_GRACE_S), "/usr/bin/vhs", "-"];
    const args = containerArgs({ name, work: stage.work, out: stage.out, workdir: tapeFolder === "." ? WORK : posix.join(WORK, tapeFolder), command, image: opts.image, stdin: true });
    log(`terminal: recording ${tapeName} in the container ${name} (one recording at a time)`);
    // One recording at a time in this service; the time limit counts from the container's start, not from its turn.
    const run = startRecording(health.docker, args, { env: denv, name, stdin: tape, timeoutMs });
    container = run;
    let stopped: "too-large" | undefined;
    const watch = setInterval(() => {
      if (stopped || folderBytes(stage.dir) <= maxDiskBytes) return;
      stopped = "too-large";
      void run.stop();
    }, 1000);
    const { code, output, timedOut } = await run.done;
    clearInterval(watch);

    if (timedOut) return done({ sandbox: "container", reason: "timeout", error: `VHS did not finish within ${Math.round(timeoutMs / 1000)} s; it was stopped` });
    if (stopped === "too-large") return done({ sandbox: "container", reason: "too-large", error: `the recording wrote more than ${Math.round(maxDiskBytes / 1024 / 1024)} MB; it was stopped` });
    if (code === 124) return done({ sandbox: "container", reason: "timeout", error: "VHS did not finish within its time; the container stopped it (exit 124)" });
    if (code !== 0) return done({ sandbox: "container", reason: "failed", error: `VHS failed (exit ${code ?? "?"}): ${tail(output) || "no output"}` });

    // Only the declared outputs leave the stage, and only once all of them are there.
    const found: [OutputType, string, string][] = [];
    for (const [type, rel] of Object.entries(check.outputs) as [OutputType, string][]) {
      const f = stagedOutput(stage.out, rel, maxOutputBytes);
      if ("error" in f) return done({ sandbox: "container", reason: f.tooLarge ? "too-large" : "failed", error: f.tooLarge ? `${f.error}; nothing was kept` : `${f.error}: ${tail(output) || "no output"}` });
      found.push([type, rel, f.path]);
    }
    const result: RecordResult = { sandbox: "container" };
    for (const [type, rel, from] of found) {
      const to = join(out, rel);
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
      copyFileSync(from, to);
      result[type] = to;
    }
    // A recording that shows a failure says so, with its first failing line.
    const transcript = stagedOutput(stage.out, transcriptRel, maxOutputBytes);
    if ("error" in transcript) log(`terminal: the transcript of ${tapeName} could not be scanned for failures: ${transcript.error}`);
    else {
      const errorLine = transcriptError(readFileSync(transcript.path, "utf8"));
      if (errorLine) result.errorLine = errorLine;
    }
    return done(result);
  } catch (e) {
    // Nothing half-made stays behind.
    for (const f of readdirSync(out)) rmSync(join(out, f), { recursive: true, force: true });
    return done({ sandbox: null, reason: "failed", error: e instanceof Error ? e.message : String(e) });
  } finally {
    const removal = await container?.remove();
    if (removal && !removal.gone) log(`terminal: ${removal.reason}`);
    // The recorded CLI may have left a folder no one can read: removeStage opens it up. What stays, the sweep retries.
    const left = removeStage(stage.dir);
    if (left) log(`terminal: the stage folder ${stage.dir} stays: ${left}`);
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
 * An asciicast file. Version 3 (docs.asciinema.org/manual/asciicast/v3), the studio's hand-written files: a header
 * line (version 3, term.cols and term.rows from TERMINAL_SIZES), then `[interval, code, data]` lines with codes o, i,
 * m, r and x, and `#` comment lines. Version 2 (asciicast v2), the recordings of the capture of evidence (unit E2): a
 * header (version 2, width and height from TERMINAL_SIZES), then `[time, code, data]` lines, the time in seconds
 * since the start and never going back, with codes o, i, m and r. Output and input pass `refusedEscape`; at most
 * CAST_CAP bytes and CAST_MAX_SECONDS.
 */
export function validateCast(text: string, version: 2 | 3 = 3): FileCheck<CastInfo> {
  const bad = (error: string): FileCheck<CastInfo> => ({ ok: false, error });
  if (Buffer.byteLength(text, "utf8") > CAST_CAP) return bad(`larger than ${CAST_CAP / 1024 / 1024} MB`);
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const first = version === 3 ? lines.findIndex((l) => !l.startsWith("#")) : lines.length ? 0 : -1;
  if (first < 0) return bad("no header line");
  let header: unknown;
  try {
    header = JSON.parse(lines[first]);
  } catch {
    return bad(`line ${first + 1}: the header is not JSON`);
  }
  type Theme = { fg?: unknown; bg?: unknown; palette?: unknown };
  const h = header as { version?: unknown; term?: { cols?: unknown; rows?: unknown; type?: unknown; theme?: Theme }; width?: unknown; height?: unknown; theme?: Theme; duration?: unknown; title?: unknown; idle_time_limit?: unknown; timestamp?: unknown; command?: unknown; env?: unknown; tags?: unknown };
  if (typeof h !== "object" || h === null || Array.isArray(h)) return bad("the header is not an object");
  if (h.version !== version) return bad(`the header's version is not ${version} (asciicast v${version})`);
  const cols = version === 3 ? h.term?.cols : h.width;
  const rows = version === 3 ? h.term?.rows : h.height;
  if (typeof cols !== "number" || typeof rows !== "number" || !Number.isInteger(cols) || !Number.isInteger(rows)) return bad(version === 3 ? "the header's term.cols and term.rows must be whole numbers" : "the header's width and height must be whole numbers");
  if (!isSize(cols, rows)) return bad(`${cols}×${rows} is not a studio terminal size`);
  if (h.term?.type !== undefined && typeof h.term.type !== "string") return bad("term.type must be a string");
  if (version === 2 && h.duration !== undefined && (typeof h.duration !== "number" || !(h.duration >= 0))) return bad("duration must be a number of seconds");
  const theme = version === 3 ? h.term?.theme : h.theme;
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
    if (version === 3 && line.startsWith("#")) continue;
    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      return bad(`${at}: not JSON`);
    }
    if (!Array.isArray(ev) || ev.length !== 3) return bad(`${at}: an event is [${version === 3 ? "interval" : "time"}, code, data]`);
    const [interval, code, data] = ev as [unknown, unknown, unknown];
    if (typeof interval !== "number" || !Number.isFinite(interval) || interval < 0) return bad(`${at}: the ${version === 3 ? "interval" : "time"} must be a number of seconds, at least 0`);
    if (typeof data !== "string") return bad(`${at}: the data must be a string`);
    if (version === 2 && interval < duration) return bad(`${at}: the time goes back (${interval} after ${duration})`);
    duration = version === 3 ? duration + interval : interval;
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
    } else if (code === "x" && version === 3) {
      if (!/^\d{1,3}$/.test(data)) return bad(`${at}: an exit status is a number`);
    } else return bad(`${at}: unknown event code ${JSON.stringify(code)} (${version === 3 ? "o, i, m, r or x" : "o, i, m or r"})`);
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

// ---------- typed commands in a pseudo-terminal: the capture of evidence in a project's environment (unit E2) ----------

/** VHS 0.12's defaults (the typing speed, Wait's time limit and pattern), and the session's own limits. */
export const SESSION_DEFAULTS = { typingMs: 50, waitTimeoutMs: 15_000, waitPattern: ">$", readyMs: 15_000, settleMs: 500 };
/** The shell's prompt in a session: VHS's own, so transcriptError skips the typed commands as it does in VHS's transcripts. */
export const SESSION_PROMPT = "> ";

/** One step of a tape in a session: keys with the pause after each, a pause, a Wait for output, or Hide and Show. */
export type TapeAction =
  | { kind: "keys"; keys: string[]; delayMs: number }
  | { kind: "sleep"; ms: number }
  | { kind: "wait"; pattern: string; scope: "line" | "screen"; timeoutMs: number }
  | { kind: "hide" }
  | { kind: "show" };

export interface TapeSession {
  actions: TapeAction[];
  size: { cols: number; rows: number };
}

/** The bytes a terminal sends for each key VHS names. */
const KEYS: Record<string, string> = { Enter: "\r", Space: " ", Backspace: "\x7f", Delete: "\x1b[3~", Insert: "\x1b[2~", Tab: "\t", Escape: "\x1b", Up: "\x1b[A", Down: "\x1b[B", Right: "\x1b[C", Left: "\x1b[D", PageUp: "\x1b[5~", PageDown: "\x1b[6~", End: "\x1b[F" };
/** Commands that type nothing in a session: the outputs, VHS's own scrolling, and Require (a missing program shows in the transcript). */
const TYPES_NOTHING = new Set(["Output", "ScrollUp", "ScrollDown", "Require"]);
const MAX_REPEAT = 100;

/** A VHS duration in milliseconds: "500ms", "2s", "1m", or a number of seconds. */
function durationMs(t: string): number | undefined {
  const m = /^(\d{1,6}(?:\.\d{1,3})?|\.\d{1,3})(ms|s|m)?$/.exec(t);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Math.round(m[2] === "ms" ? n : m[2] === "m" ? n * 60_000 : n * 1000);
}

/**
 * Why a Wait pattern is refused, or undefined. The service runs it on a session's output, so only patterns that cannot
 * backtrack for long: no groups (so no nested repeats) and no back-references, at most three repeats, at most 100
 * characters.
 */
export function waitPatternRefusal(p: string): string | undefined {
  if (p.length > 100) return "longer than 100 characters";
  if (/[()]/.test(p)) return "groups are not allowed";
  if (/\\[1-9k]/.test(p)) return "back-references are not allowed";
  if ((p.match(/(?<!\\)[*+?{]/g) ?? []).length > 3) return "more than three repeats";
  try {
    new RegExp(p);
  } catch {
    return "not a regular expression";
  }
  return undefined;
}

/** A key with modifiers (`Ctrl+C`, `Alt+b`, `Shift+Tab`, `Ctrl+Alt+d`), as the bytes a terminal sends; undefined when it is none. */
function chord(parts: string[]): string | undefined {
  const [mod, ...rest] = parts;
  if (!rest.length) return undefined;
  if (mod === "Alt") {
    const inner = rest.length > 1 ? chord(rest) : (KEYS[rest[0]] ?? (rest[0].length === 1 ? rest[0] : undefined));
    return inner === undefined ? undefined : `\x1b${inner}`;
  }
  if (mod === "Shift") {
    if (rest.length !== 1) return undefined;
    if (rest[0] === "Tab") return "\x1b[Z";
    return rest[0].length === 1 ? rest[0].toUpperCase() : KEYS[rest[0]];
  }
  if (mod === "Ctrl") {
    if (rest[0] === "Alt") {
      const inner = chord(["Ctrl", ...rest.slice(1)]);
      return inner === undefined ? undefined : `\x1b${inner}`;
    }
    if (rest.length !== 1 || rest[0].length !== 1) return undefined;
    const c = rest[0].toUpperCase();
    return /^[A-Z@[\\\]^_]$/.test(c) ? String.fromCharCode(c.charCodeAt(0) - 64) : undefined;
  }
  return undefined;
}

/**
 * The steps of a tape (one validateTape accepted) in a session: what is typed, with VHS's pauses, Sleep, Wait (on the
 * last line or the whole screen), Hide and Show, with each Source read in place. The look of a VHS recording (Set
 * Theme, FontSize and the like) and its Outputs type nothing. Errors name what a session cannot do as VHS does.
 */
export function tapeSession(text: string, o: { name?: string; readSource?: (rel: string) => string | undefined } = {}): { ok: true; session: TapeSession } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const actions: TapeAction[] = [];
  let typingMs = SESSION_DEFAULTS.typingMs;
  let waitTimeoutMs = SESSION_DEFAULTS.waitTimeoutMs;
  let waitPattern = SESSION_DEFAULTS.waitPattern;
  let cols: number | undefined;
  let rows: number | undefined;
  const walk = (src: string, file: string, sourced: boolean) => {
    src.split(/\r?\n/).forEach((raw, idx) => {
      const at = `${file}:${idx + 1}`;
      const line = raw.trim();
      if (!line || line.startsWith("#")) return;
      const toks = tokenize(line, /^Wait\b/.test(line));
      if (typeof toks === "string" || !toks.length) {
        errors.push(`${at}: ${typeof toks === "string" ? toks : "empty"}`);
        return;
      }
      const head = toks[0].text;
      const kw = keywordOf(toks[0]);
      const args = toks.slice(1);
      // "Type@100ms", "Enter@1s", "Wait+Screen@10s": the speed or time limit after "@".
      const speed = /@([^@+\s]+)$/.exec(head)?.[1];
      const speedMs = speed === undefined ? undefined : durationMs(speed);
      if (speed !== undefined && speedMs === undefined) {
        errors.push(`${at}: "@${speed}" is not a duration`);
        return;
      }
      const body = speed === undefined ? head : head.slice(0, -speed.length - 1);
      if (kw === "Set") {
        const setting = args[0]?.text ?? "";
        const value = args.slice(1).map((t) => t.text).join(" ");
        if (setting === "TypingSpeed" || setting === "WaitTimeout") {
          const ms = durationMs(value);
          if (ms === undefined) errors.push(`${at}: Set ${setting} takes a duration`);
          else if (setting === "TypingSpeed") typingMs = Math.min(ms, 5000);
          else waitTimeoutMs = ms;
        } else if (setting === "WaitPattern") {
          const p = value.length > 1 && value.startsWith("/") && value.endsWith("/") ? value.slice(1, -1) : value;
          const why = waitPatternRefusal(p);
          if (why) errors.push(`${at}: Set WaitPattern: ${why}`);
          else waitPattern = p;
        } else if (setting === "Columns") cols = Number(value);
        else if (setting === "Rows") rows = Number(value);
        return;
      }
      if (kw === "Source") {
        const rel = args[0]?.text ?? "";
        const inner = sourced ? undefined : o.readSource?.(rel);
        if (inner === undefined) errors.push(`${at}: Source ${rel} could not be read`);
        else walk(inner, rel, true);
        return;
      }
      if (TYPES_NOTHING.has(kw)) return;
      if (kw === "Hide" || kw === "Show") {
        actions.push({ kind: kw === "Hide" ? "hide" : "show" });
        return;
      }
      if (kw === "Sleep") {
        const ms = durationMs(args[0]?.text ?? "");
        if (ms === undefined || args.length !== 1) errors.push(`${at}: Sleep takes a duration`);
        else actions.push({ kind: "sleep", ms });
        return;
      }
      if (kw === "Type") {
        if (!args.length || args.some((t) => !t.quoted)) errors.push(`${at}: Type takes a quoted string`);
        else {
          const typed = args.map((t) => t.text).join("");
          if (typed) actions.push({ kind: "keys", keys: Array.from(typed), delayMs: speedMs ?? typingMs });
        }
        return;
      }
      if (kw === "Wait") {
        const scope = /^Wait\+Screen$/.test(body) ? "screen" : /^Wait(\+Line)?$/.test(body) ? "line" : undefined;
        const pattern = args.length ? args[0].text : waitPattern;
        const why = waitPatternRefusal(pattern);
        if (!scope) errors.push(`${at}: Wait takes +Screen or +Line`);
        else if (args.length > 1 || (args.length === 1 && !args[0].quoted)) errors.push(`${at}: Wait takes one /pattern/`);
        else if (why) errors.push(`${at}: Wait /${pattern.slice(0, 40)}/: ${why}`);
        else actions.push({ kind: "wait", pattern, scope, timeoutMs: speedMs ?? waitTimeoutMs });
        return;
      }
      // A key, or a key with modifiers, typed `count` times.
      const bytes = body.includes("+") ? chord(body.split("+")) : KEYS[body];
      if (bytes === undefined) {
        errors.push(`${at}: ${body.slice(0, 30)} cannot be typed in a session`);
        return;
      }
      const count = args.length ? Number(args[0].text) : 1;
      if (args.length > 1 || !Number.isInteger(count) || count < 1 || count > MAX_REPEAT) {
        errors.push(`${at}: ${body} takes a count from 1 to ${MAX_REPEAT}`);
        return;
      }
      actions.push({ kind: "keys", keys: Array.from({ length: count }, () => bytes), delayMs: speedMs ?? typingMs });
    });
  };
  walk(text, o.name ?? "tape", false);
  if (cols === undefined || rows === undefined || !isSize(cols, rows)) errors.push(`${o.name ?? "tape"}: declare Set Columns and Set Rows (${TERMINAL_SIZES.map(([c, r]) => `${c}×${r}`).join(", ")})`);
  return errors.length ? { ok: false, errors } : { ok: true, session: { actions, size: { cols: cols!, rows: rows! } } };
}

/** Where the escape at `i` ends (s[i] is ESC): an index, or undefined when the text ends first. */
function escapeEnd(s: string, i: number): number | undefined {
  const n = s[i + 1];
  if (n === undefined) return undefined;
  if (n === "[") {
    let j = i + 2;
    while (j < s.length && s.charCodeAt(j) >= 0x30 && s.charCodeAt(j) <= 0x3f) j++;
    while (j < s.length && s.charCodeAt(j) >= 0x20 && s.charCodeAt(j) <= 0x2f) j++;
    if (j >= s.length) return undefined;
    const f = s.charCodeAt(j);
    // A malformed sequence ends where it stopped being one; what follows is text.
    return f >= 0x40 && f <= 0x7e ? j + 1 : j;
  }
  if (n === "]" || n === "P" || n === "X" || n === "^" || n === "_") {
    // OSC (titles, links, the clipboard), DCS, SOS, PM and APC: to BEL (OSC) or the string terminator ESC \.
    for (let j = i + 2; j < s.length; j++) {
      if (n === "]" && s[j] === "\x07") return j + 1;
      if (s[j] === "\x1b") {
        if (j + 1 >= s.length) return undefined;
        return s[j + 1] === "\\" ? j + 2 : j;
      }
    }
    return undefined;
  }
  // ESC, intermediates and a final byte (a character set, say), or ESC and one character.
  let j = i + 1;
  while (j < s.length && s.charCodeAt(j) >= 0x20 && s.charCodeAt(j) <= 0x2f) j++;
  return j >= s.length ? undefined : j + 1;
}

/**
 * Terminal output as a cast keeps it: the text and the escapes the app's player draws (refusedEscape's list), without
 * any other escape (titles, modes, bracketed paste, device queries) or control character but \n, \r, \t and \b.
 * `rest`: an escape cut by the end of the text, for the next chunk.
 */
export function sanitizeOutput(s: string): { clean: string; rest: string } {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 0x1b) {
      const m = ALLOWED_ESCAPE.exec(s.slice(i, i + 80));
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
      const end = escapeEnd(s, i);
      if (end === undefined) return { clean: out, rest: s.slice(i) };
      i = end;
      continue;
    }
    if (c === 0x0a || c === 0x0d || c === 0x09 || c === 0x08 || (c >= 0x20 && c !== 0x7f && !(c >= 0x80 && c <= 0x9f))) out += s[i];
    i++;
  }
  return { clean: out, rest: "" };
}

/**
 * What a terminal shows, line by line, from sanitized output: text, carriage returns, backspaces, tabs, and the
 * erases and cursor moves within a line. For a session's transcript and its Waits. Moves between lines are not
 * followed, so a full-screen program's transcript is approximate; its cast is exact. As in a terminal, the cursor
 * stops at the last column and text wraps there, so a line holds at most `cols` characters and the screen at most
 * `maxLines` lines of them, whatever the output (pass 6 review finding 2).
 */
export class LineScreen {
  private lines: string[] = [];
  private cur: string[] = [];
  private col = 0;
  constructor(
    private readonly cols: number,
    private readonly maxLines = 20_000,
  ) {}
  write(s: string) {
    const last = this.cols - 1;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === "\x1b") {
        const m = /^\x1b\[([0-9;:?]*)([A-Za-z])/.exec(s.slice(i, i + 80));
        if (!m) continue;
        const n = parseInt(m[1] || "0", 10) || 0;
        if (m[2] === "K") {
          if (n === 0) this.cur.length = Math.min(this.cur.length, this.col);
          else if (n === 2) this.cur = [];
          else for (let k = 0; k < Math.min(this.col, this.cur.length); k++) this.cur[k] = " ";
        } else if (m[2] === "C") this.col = Math.min(last, this.col + Math.max(1, n));
        else if (m[2] === "D") this.col = Math.max(0, Math.min(last, this.col) - Math.max(1, n));
        else if (m[2] === "G") this.col = Math.min(last, Math.max(0, (n || 1) - 1));
        else if (m[2] === "J" && n >= 2 && this.cur.length) this.newline();
        i += m[0].length - 1;
      } else if (ch === "\n") this.newline();
      else if (ch === "\r") this.col = 0;
      else if (ch === "\b") this.col = Math.max(0, Math.min(last, this.col) - 1);
      else if (ch === "\t") this.col = Math.min(last, (Math.floor(this.col / 8) + 1) * 8);
      else {
        // A character outside the BMP (an emoji) is two code units: it takes two columns and is never cut at the wrap.
        const code = ch.charCodeAt(0);
        const wide = code >= 0xd800 && code <= 0xdbff && /[\udc00-\udfff]/.test(s[i + 1] ?? "");
        if (this.col + (wide ? 2 : 1) > this.cols) this.newline();
        while (this.cur.length < this.col) this.cur.push(" ");
        this.cur[this.col++] = wide ? s.slice(i, i + 2) : ch;
        if (wide) {
          this.cur[this.col++] = "";
          i++;
        }
      }
    }
  }
  private newline() {
    this.lines.push(this.cur.join("").trimEnd());
    if (this.lines.length > this.maxLines) this.lines.shift();
    this.cur = [];
    this.col = 0;
  }
  /** The last line that is not blank, trimmed at its end. */
  lastLine(): string {
    const now = this.cur.join("").trimEnd();
    if (now) return now;
    for (let k = this.lines.length - 1; k >= Math.max(0, this.lines.length - 50); k--) if (this.lines[k]) return this.lines[k];
    return "";
  }
  /** The last `rows` lines. */
  tail(rows: number): string {
    return [...this.lines.slice(-rows), this.cur.join("").trimEnd()].slice(-rows).join("\n");
  }
  text(): string {
    return [...this.lines, this.cur.join("").trimEnd()].join("\n");
  }
}

/**
 * An asciicast v2 recording of a session, made as its output arrives: one "o" event per chunk (sanitized; an escape
 * cut by a chunk's end waits for the next), its time in seconds since the start. While hidden (the tape's Hide), output
 * is seen (Waits read it) but not recorded. Recording stops at `maxBytes` (tooLarge).
 */
export class CastRecorder {
  /** What the recording shows (its transcript), and what the terminal showed (for Waits, hidden output included). */
  readonly shown: LineScreen;
  readonly all: LineScreen;
  hidden = false;
  tooLarge = false;
  private readonly events: string[] = [];
  private readonly header: string;
  private bytes: number;
  private pending = "";
  private last = 0;
  private readonly decoder = new TextDecoder("utf-8");
  constructor(private readonly o: { cols: number; rows: number; startedAt: number; title?: string; maxBytes?: number }) {
    const title = o.title?.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, 200);
    this.header = JSON.stringify({ version: 2, width: o.cols, height: o.rows, timestamp: Math.floor(o.startedAt / 1000), env: { TERM: "xterm-256color", SHELL: "bash" }, ...(title ? { title } : {}) });
    this.bytes = Buffer.byteLength(this.header) + 1;
    this.shown = new LineScreen(o.cols);
    this.all = new LineScreen(o.cols, 500);
  }
  output(chunk: Uint8Array | string, atMs: number) {
    const { clean, rest } = sanitizeOutput(this.pending + (typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true })));
    // An escape that never ends (a runaway title) is dropped rather than held for ever.
    this.pending = rest.length > 4096 ? "" : rest;
    if (!clean) return;
    this.all.write(clean);
    if (this.hidden || this.tooLarge) return;
    const t = Math.max(this.last, Math.max(0, Math.round(atMs - this.o.startedAt)) / 1000);
    const line = JSON.stringify([t, "o", clean]);
    const size = Buffer.byteLength(line) + 1;
    if (this.bytes + size > (this.o.maxBytes ?? CAST_CAP)) {
      this.tooLarge = true;
      return;
    }
    this.events.push(line);
    this.bytes += size;
    this.last = t;
    this.shown.write(clean);
  }
  cast(): string {
    return `${[this.header, ...this.events].join("\n")}\n`;
  }
  transcript(): string {
    return `${this.shown.text().trimEnd()}\n`;
  }
}

/** A session's pseudo-terminal: what is typed goes in, and what the terminal shows comes out. */
export interface SessionStream {
  write(data: string): unknown;
  on(event: "data", l: (d: Buffer | string) => void): unknown;
  on(event: "end" | "close" | "error", l: () => void): unknown;
  off(event: "data", l: (d: Buffer | string) => void): unknown;
  off(event: "end" | "close" | "error", l: () => void): unknown;
}

export interface SessionResult {
  /** recorded: the tape ran to its end (or the shell ended first: `ended`). */
  status: "recorded" | "failed" | "timeout" | "too-large";
  error?: string;
  /** The asciicast v2 text, and the transcript of what it shows. */
  cast: string;
  transcript: string;
  durationMs: number;
  /** The shell ended before the tape did (the tape typed exit, say). */
  ended?: true;
}

/**
 * Type a tape into a session's terminal and record it (CastRecorder): wait for the shell's first prompt, then each
 * step with VHS's pauses, then a short settle for the last output. Stops at `timeoutMs`, at `maxBytes` of recording, on
 * `signal`, or when a Wait does not match in time. Never throws; the caller ends the container.
 */
export async function recordSession(o: { stream: SessionStream; session: TapeSession; title?: string; timeoutMs: number; maxBytes?: number; readyMs?: number; settleMs?: number; signal?: AbortSignal; now?: () => number }): Promise<SessionResult> {
  const now = o.now ?? Date.now;
  const t0 = now();
  const { cols, rows } = o.session.size;
  const rec = new CastRecorder({ cols, rows, startedAt: t0, ...(o.title ? { title: o.title } : {}), ...(o.maxBytes ? { maxBytes: o.maxBytes } : {}) });
  let ended = false;
  let stopped: { status: Exclude<SessionResult["status"], "recorded">; error: string } | undefined;
  const sleepers = new Set<() => void>();
  const wakeAll = () => {
    for (const s of [...sleepers]) s();
  };
  const halt = (status: Exclude<SessionResult["status"], "recorded">, error: string) => {
    stopped ??= { status, error };
    wakeAll();
  };
  const pause = (ms: number) =>
    new Promise<void>((res) => {
      if (stopped || ended) return res();
      const done = () => {
        clearTimeout(t);
        sleepers.delete(done);
        res();
      };
      const t = setTimeout(done, ms);
      sleepers.add(done);
    });
  /** Check `test` every 50 ms for up to `ms`; false when the time ran out, or the session stopped or ended first. */
  const until = async (test: () => boolean, ms: number) => {
    const deadline = now() + ms;
    for (;;) {
      if (test()) return true;
      if (stopped || ended || now() >= deadline) return false;
      await pause(50);
    }
  };
  const onData = (d: Buffer | string) => {
    rec.output(d, now());
    if (rec.tooLarge) halt("too-large", `the session wrote more than ${Math.round((o.maxBytes ?? CAST_CAP) / 1024)} KB of recording`);
  };
  const onEnd = () => {
    ended = true;
    wakeAll();
  };
  o.stream.on("data", onData);
  for (const e of ["end", "close", "error"] as const) o.stream.on(e, onEnd);
  const timer = setTimeout(() => halt("timeout", `the session did not finish within ${Math.round(o.timeoutMs / 1000)} s`), o.timeoutMs);
  const onAbort = () => halt("failed", "the capture was stopped");
  o.signal?.addEventListener("abort", onAbort);
  if (o.signal?.aborted) onAbort();
  try {
    const prompt = new RegExp(SESSION_DEFAULTS.waitPattern);
    const readyMs = o.readyMs ?? SESSION_DEFAULTS.readyMs;
    if (!(await until(() => prompt.test(rec.all.lastLine()), readyMs)) && !stopped) halt("failed", ended ? "the shell ended before its first prompt" : `the shell showed no prompt within ${Math.round(readyMs / 1000)} s`);
    for (const a of o.session.actions) {
      if (stopped || ended) break;
      if (a.kind === "keys") {
        for (const k of a.keys) {
          if (stopped || ended) break;
          o.stream.write(k);
          await pause(a.delayMs);
        }
      } else if (a.kind === "sleep") await pause(a.ms);
      else if (a.kind === "hide") rec.hidden = true;
      else if (a.kind === "show") rec.hidden = false;
      else {
        const re = new RegExp(a.pattern);
        const seen = () => re.test(a.scope === "line" ? rec.all.lastLine().slice(-512) : rec.all.tail(rows).slice(-rows * (cols + 1) * 2));
        if (!(await until(seen, a.timeoutMs)) && !stopped && !ended) halt("failed", `Wait /${a.pattern}/ did not match within ${Math.round(a.timeoutMs / 1000)} s`);
      }
    }
    if (!stopped && !ended) await pause(o.settleMs ?? SESSION_DEFAULTS.settleMs);
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener("abort", onAbort);
    o.stream.off("data", onData);
    for (const e of ["end", "close", "error"] as const) o.stream.off(e, onEnd);
  }
  return { status: stopped?.status ?? "recorded", ...(stopped ? { error: stopped.error } : {}), cast: rec.cast(), transcript: rec.transcript(), durationMs: now() - t0, ...(ended ? { ended: true as const } : {}) };
}
