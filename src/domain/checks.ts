// ORC-013 §6: the project's own checks, run by the service. Pure functions over the state: the
// configuration and its validation (commands come only from the user's settings, as argv vectors,
// never a shell string, and only programs on an allowlist run), the suggestions read from files at
// the trusted base, what a Checks step checks and when an earlier run is reused, the findings a run
// becomes, the repair rounds after failing final checks, and the check evidence a change has.
//
// The allowlist catches mistakes and obvious misuse. It is not a security boundary: `npm test` runs
// whatever the test script says, and the change under test can edit that. The sandbox (server/checks.ts)
// and the protected inputs bound what that can do.

import { matchGlob } from "./delivery";
import * as F from "./findings";
import { CODE_REVIEW_PRINCIPLES, REPAIR_PRINCIPLES, SECURITY_REVIEW_PRINCIPLES } from "./internalFlows";
import * as M from "./model";
import { downstreamOf, instantiate, toDef, validatePipeline } from "./pipeline";
import { SECRET_NAME } from "./secrets";
import {
  ControlError,
  type Artifact,
  type Attempt,
  type CheckCommand,
  type CheckEvidence,
  type CheckRunRecord,
  type ChecksConfig,
  type ChecksHealth,
  type Finding,
  type FindingDecision,
  type LandedFlag,
  type State,
  type Step,
  type StepDef,
  type Task,
} from "./types";

// ---------- configuration and validation (§6.1) ----------

/** Programs a check command may start: a bare name, or the two wrapper scripts. No paths, no shells, no network tools. */
export const CHECK_PROGRAMS = [
  "npm", "pnpm", "yarn", "bun", "node", "deno", "make", "just", "cargo", "go",
  "python", "python3", "pytest", "uv", "poetry", "tox", "ruby", "bundle", "rake", "mix", "dotnet", "swift",
  "xcodebuild", "./gradlew", "./mvnw", "gradle", "mvn", "tsc", "eslint", "ruff", "mypy", "vitest", "jest",
];
export const MAX_CHECK_COMMANDS = 8;
export const MAX_PREPARE_COMMANDS = 2;
export const MAX_ARGV = 32;
export const MAX_ARG_LENGTH = 400;
export const MAX_LABEL = 60;
export const MAX_PROTECTED_INPUTS = 30;
export const MAX_PASS_ENV = 20;
/** At most two repair rounds after failing final checks (§6.7). */
export const MAX_CHECK_ROUNDS = 2;
const ID_RE = /^[a-z][a-z0-9-]{0,23}$/;
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
/** Prepare subcommands that download dependencies: they may use the network, so they must never run install scripts. */
const INSTALL_SUBCOMMANDS = new Set(["ci", "install", "i"]);
/** Prepare subcommands that run the install scripts of what was already downloaded, offline, in the throwaway copy. */
const REBUILD_SUBCOMMANDS = new Set(["rebuild"]);
const PREPARE_SUBCOMMANDS = new Set([...INSTALL_SUBCOMMANDS, ...REBUILD_SUBCOMMANDS]);
const CHECK_SUBCOMMANDS = new Set(["test", "t", "run", "run-script"]);
const INTERPRETERS = new Set(["node", "deno", "python", "python3", "ruby"]);
/** Inline-code and preload flags: a check may run a program in the repository, never code typed into the settings. */
const INLINE_FLAGS = ["-e", "--eval", "-p", "--print", "-c", "-r", "--require", "--import", "--loader", "--experimental-loader"];
/** Short flags whose value is attached (`-Werror`, `-Ilib`): not a cluster of single-letter flags. */
const ATTACHED_VALUE: Record<string, RegExp> = { python: /^-[WX]/, python3: /^-[WX]/, ruby: /^-[CEFIKTW0x]/, node: /^-C/ };
/**
 * Flags that take the NEXT argument as their value when nothing is attached (review finding L11):
 * `python -W x -c …`, `ruby -I lib -e …`, `node --input-type module -e …`. The value is skipped, so
 * the scan reaches the inline flag behind it instead of taking the value for the script's name.
 */
const PY_SEPARATE = ["-W", "-X", "--check-hash-based-pycs"];
const NODE_SEPARATE = [
  "-C", "--conditions", "--input-type", "--env-file", "--env-file-if-exists", "--title", "--unhandled-rejections", "--stack-trace-limit", "--experimental-default-type", "--dns-result-order", "--watch-path",
  "--test-name-pattern", "--test-reporter", "--test-reporter-destination", "--test-skip-pattern", "--test-shard", "--disable-warning", "--redirect-warnings", "--openssl-config", "--icu-data-dir", "--tls-cipher-list",
  "--tls-keylog", "--secure-heap", "--secure-heap-min", "--heapsnapshot-signal", "--diagnostic-dir", "--report-directory", "--report-dir", "--report-filename", "--report-signal", "--max-http-header-size",
  "--inspect-port", "--trace-event-categories", "--trace-event-file-pattern", "--cpu-prof-dir", "--cpu-prof-name", "--cpu-prof-interval", "--heap-prof-dir", "--heap-prof-name", "--heap-prof-interval",
  "--snapshot-blob", "--build-snapshot-config", "--experimental-sea-config", "--localstorage-file", "--run", "--experimental-config-file", "--trace-require-module", "--v8-pool-size",
];
const SEPARATE_VALUE: Record<string, Set<string>> = { python: new Set(PY_SEPARATE), python3: new Set(PY_SEPARATE), ruby: new Set(["-C", "-E", "-F", "-I", "-K", "--encoding", "--external-encoding", "--internal-encoding", "--dump", "--backtrace-limit", "--crash-report"]), node: new Set(NODE_SEPARATE) };
/**
 * The only commands the network is given to (review finding H1: repository code never runs while the
 * network is on): dependency downloads by npm, pnpm and yarn with every hook that runs repository code
 * switched off. Each entry lists what the command must carry; any flag of an inner list satisfies it.
 * bun is not here: bun install has hooks beyond lifecycle scripts (bunfig.toml) that could not be
 * ruled out, so its installs run offline. Every other prepare command (pip, uv, poetry, bundle,
 * gradle, mix, swift, cargo, go, make, …) runs offline too; the user prefetches in their own environment.
 */
export const NETWORK_INSTALL_FLAGS: Record<string, string[][]> = {
  npm: [["--ignore-scripts", "--ignore-scripts=true"]],
  pnpm: [
    ["--ignore-scripts", "--ignore-scripts=true"],
    ["--ignore-pnpmfile", "--ignore-pnpmfile=true"],
  ],
  // Yarn 1 takes --ignore-scripts; Yarn Berry has no such flag and takes --mode=skip-build.
  yarn: [["--ignore-scripts", "--mode=skip-build"]],
};
/** Flags that switch those protections back on. Refused wherever they appear next to an install that may use the network (L11: contradicting flags). */
const CONTRADICTING_FLAG = /^--(no-ignore-scripts|ignore-scripts=(?!true$).*|no-ignore-pnpmfile|ignore-pnpmfile=(?!true$).*|mode=(?!skip-build$).*)$/;
export const NETWORK_RULE = "downloads the network may be used for: npm, pnpm, yarn installs only; other setup commands run offline";
/** Names a check environment never takes from the settings (§6.6 sets or drops them itself). */
const RESERVED_ENV = new Set(["PATH", "HOME", "NODE_OPTIONS", "LD_PRELOAD"]);
/** Prefixes a check environment never takes from the settings, whatever the case (L11): package-manager configuration. */
export const BLOCKED_ENV_PREFIXES = ["NPM_CONFIG_", "YARN_", "PNPM_"];
export const blockedEnvName = (n: string) => BLOCKED_ENV_PREFIXES.some((p) => n.toUpperCase().startsWith(p));

const inRange = (n: unknown, lo: number, hi: number) => typeof n === "number" && Number.isInteger(n) && n >= lo && n <= hi;

/** A package manager's download command (`npm ci`, `pnpm install`, …). */
export const isInstall = (argv: string[]) => PACKAGE_MANAGERS.has(argv[0]) && INSTALL_SUBCOMMANDS.has(argv[1] ?? "");
/** A package manager's offline "run the install scripts" command (`npm rebuild`, …). */
export const isRebuild = (argv: string[]) => PACKAGE_MANAGERS.has(argv[0]) && REBUILD_SUBCOMMANDS.has(argv[1] ?? "");
/** The flags an install carries that switch a protection off again (`--no-ignore-scripts`, `--ignore-scripts=false`, `--mode=update-lockfile`, …). */
export const contradictingFlags = (argv: string[]) => argv.slice(1).filter((a) => CONTRADICTING_FLAG.test(a));
/** The protections an install lacks: one list of alternatives per missing requirement. */
export const missingInstallFlags = (argv: string[]) => (NETWORK_INSTALL_FLAGS[argv[0]] ?? []).filter((alternatives) => !alternatives.some((f) => argv.includes(f)));

/**
 * Why a prepare command is refused the network, or undefined when it is on the allowlist with every
 * protection in place. The runner refuses the network on this alone (the command then runs offline);
 * the validator turns a flags problem into an error the user can fix.
 */
export function networkRefusal(argv: string[]): string | undefined {
  if (!isInstall(argv)) return `${NETWORK_RULE}.`;
  const program = argv[0];
  if (!NETWORK_INSTALL_FLAGS[program]) return `${program} installs run offline: ${program} has hooks beyond install scripts that cannot be switched off, so ${NETWORK_RULE}.`;
  const contradicting = contradictingFlags(argv);
  if (contradicting.length) return `${contradicting.join(" ")} would let repository code run while the network is on.`;
  const missing = missingInstallFlags(argv);
  if (missing.length) return `an install that may use the network must carry ${missing.map((m) => m.map((f) => `"${f}"`).join(" or ")).join(" and ")}.`;
  return undefined;
}

/** The install as the runner starts it (H1): contradicting flags dropped and every missing protection appended, whatever the settings say. */
export function hardenedInstall(argv: string[]): string[] {
  if (!isInstall(argv) || !NETWORK_INSTALL_FLAGS[argv[0]]) return argv;
  const kept = argv.filter((a, i) => i === 0 || !CONTRADICTING_FLAG.test(a));
  return [...kept, ...missingInstallFlags(kept).map((m) => m[0])];
}

/**
 * Yarn runs repository JavaScript from its own configuration, whatever the scripts setting: `.yarnrc.yml`
 * `plugins` and `yarnPath`, and Yarn 1's `.yarnrc` `yarn-path`. A yarn install in a copy that has any of
 * these is refused the network. The files are read from the copy the install runs in, just before it
 * runs, because that is what yarn itself reads there; the trusted base says nothing about the copy.
 */
export function yarnrcRefusal(files: { yarnrcYml?: string; yarnrc?: string }): string | undefined {
  const yml = files.yarnrcYml ?? "";
  const keys = ["plugins", "yarnPath"].filter((k) => new RegExp(`^${k}\\s*:`, "m").test(yml));
  if (keys.length) return `.yarnrc.yml sets ${keys.join(" and ")}, which runs repository JavaScript; the install runs offline.`;
  if (/^\s*yarn-path\b/m.test(files.yarnrc ?? "")) return ".yarnrc sets yarn-path, which runs repository JavaScript; the install runs offline.";
  return undefined;
}

/**
 * Why a command is not allowed, or undefined. Shared by the whole configuration's validation and the
 * editor. `networked`: prepare commands may use the network, so an install must not run scripts.
 */
export function validateCommand(c: CheckCommand, o: { networked?: boolean } = {}): string | undefined {
  if (typeof c.id !== "string" || !ID_RE.test(c.id)) return `A command id is lowercase letters, digits and hyphens (at most 24 characters), starting with a letter; "${String(c.id).slice(0, 30)}" is not.`;
  if (typeof c.label !== "string" || !c.label.trim() || c.label.length > MAX_LABEL) return `${c.id}: the label is 1–${MAX_LABEL} characters.`;
  if (c.kind !== "prepare" && c.kind !== "check") return `${c.id}: the kind is "prepare" or "check".`;
  if (!Array.isArray(c.argv) || c.argv.length === 0 || c.argv.length > MAX_ARGV) return `${c.id}: the command is 1–${MAX_ARGV} arguments.`;
  for (const a of c.argv) {
    if (typeof a !== "string" || a.length === 0 || a.length > MAX_ARG_LENGTH) return `${c.id}: every argument is 1–${MAX_ARG_LENGTH} characters.`;
    if (/[\0\n\r]/.test(a)) return `${c.id}: an argument cannot contain a newline or NUL.`;
  }
  if (c.timeoutMinutes !== undefined && !inRange(c.timeoutMinutes, 1, 60)) return `${c.id}: the time limit is 1–60 minutes.`;
  const program = c.argv[0];
  if (!CHECK_PROGRAMS.includes(program)) return `${c.id}: "${program}" is not one of the programs checks may run (${CHECK_PROGRAMS.join(", ")}). Use the bare program name; shells, paths, curl, npx, git and gh are never allowed.`;
  if (PACKAGE_MANAGERS.has(program)) {
    const sub = c.argv[1] ?? "";
    if (c.kind === "prepare" && !PREPARE_SUBCOMMANDS.has(sub)) return `${c.id}: a prepare command with ${program} is "${program} ci", "${program} install", "${program} i" or "${program} rebuild".`;
    if (c.kind === "check" && !CHECK_SUBCOMMANDS.has(sub)) return `${c.id}: a check with ${program} is "${program} test", "${program} run <script>" or "${program} run-script <script>"; "${program} ${sub}" is not allowed.`;
    // H1: an install that may use the network never runs the repository's install scripts (they could
    // reach this machine's own control API). Scripts that are needed run offline in a "rebuild" step.
    // bun and everything that is not npm, pnpm or yarn simply run offline (the runner refuses the network).
    if (c.kind === "prepare" && o.networked && isInstall(c.argv) && NETWORK_INSTALL_FLAGS[program]) {
      const why = networkRefusal(c.argv);
      if (why) return `${c.id}: ${why} Repository code must not run while the network is on; scripts your project needs can run offline afterwards in a separate "${program} rebuild" prepare command.`;
    }
  }
  if (INTERPRETERS.has(program)) {
    if (program === "deno" && c.argv[1] === "eval") return `${c.id}: deno eval runs inline code; run a script or module from the repository instead.`;
    const attached = ATTACHED_VALUE[program];
    const separate = SEPARATE_VALUE[program];
    for (let i = 1; i < c.argv.length; i++) {
      const a = c.argv[i];
      // What follows "--", "-m <module>" or the script's own name belongs to the script, not the interpreter.
      if (a === "--" || a === "-m" || !a.startsWith("-")) break;
      // A flag whose value is the next argument: the value is neither a flag nor the script.
      if (separate?.has(a)) {
        i++;
        continue;
      }
      const flag = a.split("=")[0];
      const refuse = () => `${c.id}: ${program} may not run inline code or preload modules (${a}); run a script or module from the repository instead.`;
      if (INLINE_FLAGS.includes(flag)) return refuse();
      if (a.startsWith("--")) continue;
      if (attached?.test(a)) continue;
      // A short flag, alone, in a cluster, or with its value attached (-cprint(1), -e1, -pe, -rfoo).
      if (/[epcr]/.test(a.slice(1))) return refuse();
    }
  }
  return undefined;
}

/** Why a whole configuration is refused, or undefined. `acknowledged`: the user confirmed "no sandbox" for this save or earlier. */
export function validateChecks(cfg: ChecksConfig, opts: { acknowledged?: boolean } = {}): string | undefined {
  if (!Array.isArray(cfg.commands)) return "Commands must be a list.";
  if (cfg.commands.length > MAX_CHECK_COMMANDS) return `At most ${MAX_CHECK_COMMANDS} commands.`;
  const ids = new Set<string>();
  let seenCheck = false;
  let prepares = 0;
  for (const c of cfg.commands) {
    const why = validateCommand(c, { networked: cfg.prepareNetwork === true });
    if (why) return why;
    if (ids.has(c.id)) return `Two commands have the id "${c.id}".`;
    ids.add(c.id);
    if (c.kind === "prepare") {
      prepares++;
      if (seenCheck) return `${c.id}: prepare commands come before the checks.`;
    } else seenCheck = true;
  }
  if (prepares > MAX_PREPARE_COMMANDS) return `At most ${MAX_PREPARE_COMMANDS} prepare commands.`;
  if (cfg.sandbox !== "codex" && cfg.sandbox !== "none") return 'The sandbox is "codex" or "none".';
  if (cfg.sandbox === "none" && !opts.acknowledged) return 'Running without a sandbox needs your explicit confirmation ("acknowledgeUnsandboxed").';
  if (typeof cfg.enabled !== "boolean" || typeof cfg.prepareNetwork !== "boolean") return "enabled and prepareNetwork are booleans.";
  if (!inRange(cfg.commandTimeoutMinutes, 1, 60)) return "The time limit per command is 1–60 minutes.";
  if (!inRange(cfg.runTimeoutMinutes, 1, 120)) return "The time limit per run is 1–120 minutes.";
  if (!inRange(cfg.maxConcurrent, 1, 3)) return "Runs at once is 1–3.";
  if (!Array.isArray(cfg.protectedInputs) || cfg.protectedInputs.length > MAX_PROTECTED_INPUTS) return `At most ${MAX_PROTECTED_INPUTS} protected inputs.`;
  for (const g of cfg.protectedInputs) if (typeof g !== "string" || !g.trim() || g.length > 200 || /[\0\n]/.test(g)) return "A protected input is a path pattern of 1–200 characters.";
  if (!Array.isArray(cfg.passEnv) || cfg.passEnv.length > MAX_PASS_ENV) return `At most ${MAX_PASS_ENV} variable names.`;
  for (const n of cfg.passEnv) {
    if (typeof n !== "string" || !ENV_NAME_RE.test(n)) return `"${String(n).slice(0, 40)}" is not a variable name (uppercase letters, digits and underscores).`;
    if (SECRET_NAME.test(n)) return `${n} looks like a secret and is never passed to a check.`;
    if (RESERVED_ENV.has(n) || n.toUpperCase().startsWith("DYLD_")) return `${n} is set by the service itself and cannot be passed through.`;
    // L11: package-manager configuration (NPM_CONFIG_*, YARN_*, PNPM_*) could switch install scripts back on, whatever the case of the name.
    if (blockedEnvName(n)) return `${n} configures a package manager and cannot be passed through.`;
  }
  return undefined;
}

// ---------- suggestions from the repository (§6.2) ----------

export interface RepoFile {
  path: string;
  text: string;
}

const CHECK_SCRIPTS = ["typecheck", "lint", "test", "build"];

/** Commands suggested from the repository's own files (package.json, lockfiles, Cargo.toml, go.mod, pyproject.toml). Nothing is applied. */
export function suggestChecks(files: RepoFile[]): CheckCommand[] {
  const file = (p: string) => files.find((f) => f.path === p);
  const out: CheckCommand[] = [];
  const pkg = file("package.json");
  if (pkg) {
    let scripts: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(pkg.text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const s = (parsed as { scripts?: unknown }).scripts;
        if (s && typeof s === "object" && !Array.isArray(s)) scripts = s as Record<string, unknown>;
      }
    } catch {
      /* not JSON: no scripts */
    }
    const pm = file("pnpm-lock.yaml") ? "pnpm" : file("yarn.lock") ? "yarn" : file("bun.lock") || file("bun.lockb") ? "bun" : "npm";
    // Installs never run install scripts or pnpmfiles (H1); a project that needs scripts adds an offline "rebuild" step. bun installs run offline.
    const install: Record<string, string[]> = { npm: ["npm", "ci", "--ignore-scripts"], pnpm: ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts", "--ignore-pnpmfile"], yarn: ["yarn", "install", "--immutable", "--mode=skip-build"], bun: ["bun", "install", "--frozen-lockfile", "--ignore-scripts"] };
    if (pm !== "npm" || file("package-lock.json")) out.push({ id: "install", label: "Install dependencies", kind: "prepare", argv: install[pm] });
    for (const name of CHECK_SCRIPTS) {
      if (typeof scripts[name] !== "string") continue;
      out.push({ id: name, label: name, kind: "check", argv: name === "test" ? [pm, "test"] : [pm, "run", name] });
    }
  }
  if (file("Cargo.toml")) out.push({ id: "cargo-build", label: "cargo build", kind: "check", argv: ["cargo", "build"] }, { id: "cargo-test", label: "cargo test", kind: "check", argv: ["cargo", "test"] });
  if (file("go.mod")) out.push({ id: "go-vet", label: "go vet", kind: "check", argv: ["go", "vet", "./..."] }, { id: "go-test", label: "go test", kind: "check", argv: ["go", "test", "./..."] });
  const py = file("pyproject.toml");
  if (py && /\[tool\.pytest|pytest/.test(py.text)) out.push({ id: "pytest", label: "pytest", kind: "check", argv: ["python3", "-m", "pytest"] });
  return out.slice(0, MAX_CHECK_COMMANDS);
}

// ---------- what a Checks step runs (§6.4) ----------

export type PlannedCommand = { id: string; label: string; kind: "prepare" | "check"; argv: string[]; timeoutMs: number; offline?: true; offlineReason?: string };

/**
 * The commands a step runs: every prepare command, and the checks its `only` names (all of them without
 * `only`). A prepare command that is not an allowlisted download is marked offline with the reason (H1);
 * the runner decides the rest (yarn's own configuration) just before the command runs.
 */
export function commandsFor(cfg: ChecksConfig, st: Pick<StepDef, "checks">): PlannedCommand[] {
  const only = st.checks?.only?.length ? new Set(st.checks.only) : undefined;
  return cfg.commands
    .filter((c) => c.kind === "prepare" || !only || only.has(c.id))
    .map((c) => {
      // Flags the runner re-adds are not a reason; a program that is not an allowlisted installer is.
      const why = c.kind === "prepare" && !isRebuild(c.argv) ? networkRefusal(hardenedInstall(c.argv)) : undefined;
      const offline = c.kind === "prepare" && (isRebuild(c.argv) || !!why);
      return { id: c.id, label: c.label, kind: c.kind, argv: [...c.argv], timeoutMs: (c.timeoutMinutes ?? cfg.commandTimeoutMinutes) * 60_000, ...(offline ? { offline: true as const } : {}), ...(why ? { offlineReason: why } : {}) };
    });
}

/** The ids of the configured check commands (the ones a step's `only` may name). */
export const configuredCheckIds = (cfg: ChecksConfig | undefined) => (cfg?.commands ?? []).filter((c) => c.kind === "check").map((c) => c.id);

/** Ids a step's `only` names that are not configured checks (M2: such a step runs nothing and must never count as passing). */
export function missingChecks(cfg: ChecksConfig, st: Pick<StepDef, "checks">): string[] {
  const ids = new Set(configuredCheckIds(cfg));
  return (st.checks?.only ?? []).filter((id) => !ids.has(id));
}

/** Are checks on with at least one check command? Off, every Checks step skips. */
export const checksOn = (cfg: ChecksConfig | undefined) => !!cfg?.enabled && cfg.commands.some((c) => c.kind === "check");

/**
 * The checks sandbox is not ready (§6.5.4): Checks steps wait, labelled, and nothing falls back to
 * running without a sandbox. Never held with sandbox "none", which the user chose explicitly.
 */
export function checksHeld(s: State): boolean {
  const cfg = s.project.checks;
  if (!checksOn(cfg) || cfg.sandbox !== "codex") return false;
  const h = s.project.checksHealth;
  return !h || h.sandbox !== "codex" || h.status !== "ready";
}

export const HELD_LABEL = "Waiting: the checks sandbox is not available (Settings → Checks)";

/** The commit a Checks step checks: the task's check target, else the newest accepted code-change input with a commit. */
export function checkTargetOf(s: State, t: Task, st: Step): { artifactId: string; ref: string } | undefined {
  if (t.checkTarget) return { artifactId: "", ref: t.checkTarget.sha };
  let best: Artifact | undefined;
  for (const i of M.consumedInputs(s, t, st)) {
    const art = s.artifacts.find((x) => x.id === i.artifactId);
    if (art?.kind === "code-change" && art.ref && (!best || art.createdAt > best.createdAt)) best = art;
  }
  return best ? { artifactId: best.id, ref: best.ref!.split(" ")[0] } : undefined;
}

const sha12 = (sha: string) => sha.slice(0, 12);
/** A code-change artifact names its commit by a 12-character prefix; a check record holds the full SHA. Both name one commit. */
export const sameSha = (a: string, b: string) => a === b || (a.length >= 12 && b.length >= 12 && (a.startsWith(b) || b.startsWith(a)));

/**
 * An earlier run of this task that a Final checks step can repeat instead of running again: the newest
 * completed service run whose accepted check results are for exactly this commit, the current settings
 * revision and the same commands. Only the same SHA and revision count; nothing older is reused.
 */
export function reusableRun(s: State, t: Task, st: Step, targetSha: string): { attempt: Attempt; artifact: Artifact } | undefined {
  const cfg = s.project.checks;
  const wanted = commandsFor(cfg, st).map((c) => c.id).sort().join(",");
  let best: { attempt: Attempt; artifact: Artifact } | undefined;
  for (const art of s.artifacts) {
    if (art.taskId !== t.id || art.kind !== "check-results" || !art.checkRun || art.author === "user") continue;
    const run = art.checkRun;
    if (!sameSha(run.sha, targetSha) || run.configRev !== cfg.rev) continue;
    if (run.results.map((r) => r.id).sort().join(",") !== wanted) continue;
    const attempt = s.attempts.find((a) => a.id === art.attemptId);
    if (!attempt || attempt.outcome !== "completed") continue;
    if (!best || art.createdAt > best.artifact.createdAt) best = { attempt, artifact: art };
  }
  return best;
}

// ---------- from results to findings (§6.7) ----------

/** FNV-1a over the text, twice, as 12 hex characters: the carry-forward identity of a check finding (pure, no crypto). */
function hash12(text: string): string {
  const fnv = (input: string) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  };
  const a = fnv(text);
  return `${a}${fnv(`${text}|${a}`).slice(0, 4)}`;
}

export function checkFindingKey(file: string | undefined, title: string, severity: Finding["severity"] = "error"): string {
  return hash12(`check|${severity}|${file ?? ""}|${title.toLowerCase().replace(/\s+/g, " ").trim()}`);
}

const tail = (text: string, n: number) => (text.length > n ? text.slice(text.length - n) : text);
const minutes = (ms: number) => `${Math.max(1, Math.round(ms / 60_000))} minute${Math.round(ms / 60_000) === 1 ? "" : "s"}`;

/** Findings a check run becomes: one auto-fix error per failing or timed-out check; a failed prepare and touched inputs need a decision. */
export function findingsFromRun(record: CheckRunRecord, commands: { id: string; timeoutMs: number }[] = []): Finding[] {
  const out: Finding[] = [];
  const add = (f: Omit<Finding, "id" | "key" | "source">) => out.push({ id: `F${out.length + 1}`, key: checkFindingKey(f.file, f.title, f.severity), source: "check", ...f });
  for (const r of record.results) {
    if (r.status === "passed" || r.status === "not-run") continue;
    const limit = commands.find((c) => c.id === r.id)?.timeoutMs;
    if (r.kind === "prepare") {
      add({
        severity: "error",
        action: "ask-user",
        title: `Preparing the checks failed (${r.label}, ${r.status === "timed-out" ? "timed out" : `exit ${r.exitCode ?? "?"}`})`,
        detail: tail(r.excerpt, 1200),
        why: "Installing dependencies failed. That is often the environment, not the change: decide whether to fix the change or the check setup.",
        checkId: r.id,
      });
      continue;
    }
    if (r.status === "timed-out") add({ severity: "error", action: "auto-fix", title: `${r.label} did not finish within ${limit ? minutes(limit) : "its time limit"}`, detail: tail(r.excerpt, 1200), checkId: r.id });
    else add({ severity: "error", action: "auto-fix", title: `${r.label} failed (exit ${r.exitCode ?? "?"})`, detail: tail(r.excerpt, 1200), checkId: r.id });
  }
  if (record.touchedInputs.length) {
    add({
      severity: "warning",
      action: "ask-user",
      title: `The change edits files the checks depend on: ${record.touchedInputs.slice(0, 5).join(", ")}${record.touchedInputs.length > 5 ? ` and ${record.touchedInputs.length - 5} more` : ""}`,
      detail: "Protected check inputs were changed. A passing result may mean less than before.",
      file: record.touchedInputs[0],
      why: "A passing result may mean less than before. Confirm these edits are intended.",
    });
  }
  return out;
}

/** The protected inputs a change touched: its changed paths matched against the settings' patterns (at most 20). */
export function touchedInputs(cfg: ChecksConfig, changedPaths: string[]): string[] {
  return changedPaths.filter((p) => cfg.protectedInputs.some((g) => matchGlob(g, p))).slice(0, 20);
}

export const allPassed = (record: Pick<CheckRunRecord, "results">) => record.results.every((r) => r.status === "passed");
export const failedResults = (record: Pick<CheckRunRecord, "results">) => record.results.filter((r) => r.status !== "passed" && r.status !== "not-run");

const seconds = (ms: number) => `${Math.max(1, Math.round(ms / 1000))} s`;

/** One line per command: "Checks on abc123 (settings r3, sandboxed): ✓ typecheck 12 s · ✗ test exit 1, 34 s · – build not run". */
export function runSummary(record: CheckRunRecord): string {
  const how = [record.sandbox === "codex" ? "sandboxed" : "no sandbox", ...(record.simulated ? ["simulated"] : []), ...(record.reusedFrom ? [`same as ${record.reusedFrom}`] : [])].join(", ");
  const parts = record.results.map((r) => {
    if (r.status === "passed") return `✓ ${r.label} ${seconds(r.durationMs)}`;
    if (r.status === "failed") return `✗ ${r.label} exit ${r.exitCode ?? "?"}, ${seconds(r.durationMs)}`;
    if (r.status === "timed-out") return `✗ ${r.label} timed out after ${seconds(r.durationMs)}`;
    return `– ${r.label} not run`;
  });
  return `Checks on ${sha12(record.sha)} (settings r${record.configRev}, ${how}): ${parts.join(" · ") || "no commands"}`;
}

// ---------- the Final checks decision and check rounds (§6.7) ----------

/**
 * Open the one decision on a Final checks step whose run did not pass, routed as the project is set.
 * Mutates the draft. The same failure (task, step, commit) never gets a second open decision.
 */
export function openFinalChecksDecision(s: State, t: Task, st: Step, art: Artifact, now: string): FindingDecision {
  const run = art.checkRun!;
  const failing = failedResults(run).map((r) => r.label);
  const key = hash12(`final-checks|${t.id}|${st.id}|${run.sha}`);
  const existing = s.decisions.find((d) => d.kind === "final-checks" && d.taskId === t.id && d.key === key && d.status === "open");
  if (existing) return existing;
  const title = `Checks failed on the final change ${sha12(run.sha)}: ${failing.join(", ") || "no command passed"}`;
  const d: FindingDecision = {
    id: M.nextId(s, "fd"),
    taskId: t.id,
    artifactId: art.id,
    findingId: "final",
    key,
    kind: "final-checks",
    finding: {
      source: "check",
      severity: "error",
      title,
      detail: failedResults(run).map((r) => `${r.label}: ${r.status === "timed-out" ? "timed out" : `exit ${r.exitCode ?? "?"}`}`).join("; "),
      why: `Only you can accept failing checks. A repair round (at most ${MAX_CHECK_ROUNDS}) fixes the change and checks it again.`,
    },
    routedTo: s.project.triage.askUserBy,
    routedAt: now,
    status: "open",
    usedBy: [],
    createdAt: now,
  };
  s.decisions.push(d);
  M.event(s, now, "system", "decision", `${d.id}: ${title}. A decision is needed (${d.routedTo === "lead" ? "the lead" : "you"}): a repair round, or accept the failing checks (only you can)`, t.id);
  return d;
}

/** The blocked Final checks step a decision is about, or why it cannot be acted on. */
function blockedStepOf(s: State, d: FindingDecision): { t: Task; st: Step; art: Artifact } | string {
  const t = s.tasks.find((x) => x.id === d.taskId);
  if (!t) return `Unknown task ${d.taskId}`;
  if (t.lifecycle === "done" || t.lifecycle === "cancelled") return `${t.id} is ${t.lifecycle}.`;
  const art = s.artifacts.find((a) => a.id === d.artifactId);
  const st = art && t.steps.find((x) => x.id === art.stepId);
  if (!art || !st || st.role !== "checks") return `${d.id} does not belong to a Checks step of ${t.id}.`;
  if (st.state !== "blocked") return `${st.id} is not waiting for a decision (it is ${st.state}).`;
  return { t, st, art };
}

/**
 * Add a repair round after a blocked Final checks step (§6.7): a coder fixes the failing checks, a
 * reviewer reads the fix, and a Final checks step runs again. The blocked step becomes done with its
 * failing result on the record; everything downstream also waits for the round. Mutates the draft.
 * Returns why it was refused, or undefined.
 */
export function addCheckRound(s: State, t: Task, st: Step, now: string, actor: "lead" | "user"): string | undefined {
  const rounds = t.checkRounds ?? 0;
  if (rounds >= MAX_CHECK_ROUNDS) return `${MAX_CHECK_ROUNDS} check rounds were already added to ${t.id}; only you can accept failing checks, or edit the change yourself.`;
  if (st.role !== "checks" || st.state !== "blocked") return `${st.id} is not a blocked Checks step.`;
  const out = st.outputs[0];
  const art = M.acceptedOutput(s, t, st.id, out?.name ?? "") ?? s.artifacts.filter((a) => a.taskId === t.id && a.stepId === st.id).pop();
  const failing = art?.checkRun ? failedResults(art.checkRun).map((r) => r.label).join(", ") : "checks";
  const k = rounds + 1;
  const fixId = `${st.id}-r${k}-fix`;
  const reviewId = `${st.id}-r${k}-review`;
  const securityId = `${st.id}-r${k}-security`;
  const checksId = `${st.id}-r${k}-checks`;
  if (t.steps.some((x) => x.id === fixId || x.id === reviewId || x.id === securityId || x.id === checksId)) return `Round ${k} of ${st.id} already exists.`;
  const codeInputs = st.inputs.filter((r) => t.steps.find((x) => x.id === r.step)?.outputs.find((o) => o.name === r.output)?.kind === "code-change");
  const results = { step: st.id, output: out.name };
  // ORC-024: the round's steps carry the same principles as a flow's repair and reviews; dispatch adds "attack the premise" to a fix after a round that failed the same way.
  const defs: StepDef[] = [
    { id: fixId, purpose: `Fix the failing checks (round ${k}): ${failing}`, role: "coder", dependsOn: [st.id], inputs: [...codeInputs, results], outputs: [{ name: "change", kind: "code-change" }, { name: "handoff", kind: "handoff" }], principles: [...REPAIR_PRINCIPLES] },
    { id: reviewId, purpose: `Code review of the fix (round ${k})`, role: "code_reviewer", dependsOn: [fixId], inputs: [{ step: fixId, output: "change" }, { step: fixId, output: "handoff" }, results], outputs: [{ name: "findings", kind: "review-findings" }], principles: [...CODE_REVIEW_PRINCIPLES] },
    // ORC-021: a security review beside every code review, the check rounds included.
    { id: securityId, purpose: `Security review of the fix (round ${k})`, role: "security_reviewer", dependsOn: [fixId], inputs: [{ step: fixId, output: "change" }, { step: fixId, output: "handoff" }, results], outputs: [{ name: "findings", kind: "review-findings" }], principles: [...SECURITY_REVIEW_PRINCIPLES] },
    { id: checksId, purpose: `Final checks (round ${k})`, role: "checks", dependsOn: [reviewId, securityId], inputs: [...codeInputs, { step: fixId, output: "change" }], outputs: [{ name: "final", kind: "check-results" }], checks: { onFail: "block" } },
  ];
  const before = structuredClone(t.steps);
  // Only what comes after the blocked step is rewired (the steps that depend on it, directly or not).
  const downstream = downstreamOf(t.steps.map(toDef), [st.id]);
  const at = t.steps.indexOf(st);
  st.state = "done";
  st.blockedReason = undefined;
  // ORC-016 (steps 2–3 review, finding 6): a round's step ids start above any revision they had before, so no earlier run can report into them.
  const copies: Step[] = instantiate(defs).map((c) => ({ ...c, revision: M.nextRevisionFor(s, t, c.id), state: t.hold ? "paused" : "pending" }));
  t.steps.splice(at + 1, 0, ...copies);
  for (const d of t.steps) {
    if (!downstream.has(d.id)) continue;
    if (d.dependsOn.includes(st.id)) d.dependsOn = [...new Set([...d.dependsOn, checksId])];
    const extra = d.inputs.filter((r) => r.step === st.id).map((r) => ({ step: checksId, output: r.output }));
    if (d.inputs.some((r) => t.steps.find((x) => x.id === r.step)?.outputs.find((o) => o.name === r.output)?.kind === "code-change")) extra.push({ step: fixId, output: "change" });
    if (extra.length) d.inputs = [...d.inputs, ...extra.filter((e) => !d.inputs.some((r) => r.step === e.step && r.output === e.output))];
  }
  const issues = validatePipeline(t.steps.map(toDef), { checkTarget: !!t.checkTarget }).filter((i) => i.severity === "error");
  if (issues.length) {
    t.steps = before;
    M.event(s, now, "system", "blocked", `Could not add check round ${k} after ${st.id}: ${issues[0].message}`, t.id);
    return `The round could not be added: ${issues[0].message}`;
  }
  t.checkRounds = k;
  t.pipelineRev += 1;
  t.pipelineHistory.push({ rev: t.pipelineRev, at: now, author: actor, reason: `Check round ${k} after ${st.id} failed: ${failing}`, steps: t.steps.map(toDef) });
  t.updatedAt = now;
  M.event(s, now, actor, "pipeline", `Pipeline r${t.pipelineRev}: check round ${k} after ${st.id} failed (${failing}); ${fixId} fixes it, ${reviewId} reviews the fix, ${checksId} checks again`, t.id);
  return undefined;
}

/**
 * The user's decision on failing final checks (§6.7): "fix" adds a repair round; "accept" (the user
 * only) ends the step with the failing result on the record, flagged on the landed item. Mutates the draft.
 */
export function decideFinalChecks(s: State, d: FindingDecision, decision: "fix" | "accept" | "follow-up" | "reopen", why: string | undefined, now: string) {
  if (decision === "follow-up") throw new ControlError("Failing final checks are fixed in a repair round or accepted; they cannot become a follow-up task.");
  if (decision === "reopen") throw new ControlError("A decision on final checks cannot be reopened; retry or rerun the step instead.");
  if (d.status !== "open") throw new ControlError(`${d.id} is decided (${d.status}).`);
  const found = blockedStepOf(s, d);
  if (typeof found === "string") throw new ControlError(found);
  const { t, st, art } = found;
  if (decision === "fix") {
    const refused = addCheckRound(s, t, st, now, "user");
    if (refused) throw new ControlError(refused);
    d.status = "fix";
  } else {
    st.state = "done";
    st.blockedReason = undefined;
    d.status = "accept";
    const failing = art.checkRun ? failedResults(art.checkRun).map((r) => r.label).join(", ") : "checks";
    M.event(s, now, "user", "decision", `You accepted failing checks on ${sha12(art.checkRun?.sha ?? "")} (${failing})${why ? `: ${why}` : ""}; the landed item is flagged`, t.id);
  }
  d.decidedBy = "user";
  d.decidedAt = now;
  delete d.suggestion;
  delete d.leadRunId;
  if (why) d.why = why;
  else delete d.why;
  t.updatedAt = now;
}

/**
 * The lead's decision on failing final checks (§4.4): "fix" adds a repair round while rounds are left,
 * else the decision goes to the user; "ask-user" hands it over; "accept" is never the lead's. Returns
 * the note for the lead's reply when the entry was refused or handed over.
 */
export function leadDecidesFinalChecks(s: State, d: FindingDecision, kind: "fix" | "accept" | "follow-up" | "ask-user", why: string, leadRunId: string, now: string): string | undefined {
  if (kind === "accept") return `Decision ${d.id}: refused; only the user can accept failing checks`;
  if (kind === "follow-up") return `Decision ${d.id}: refused; failing final checks take a repair round ("fix") or go to the user ("ask-user")`;
  const handOver = (note: string) => {
    d.routedTo = "user";
    d.routedAt = now;
    d.why = why;
    d.leadRunId = leadRunId;
    M.event(s, now, "lead", "decision", `${d.id} sent to you by the lead: ${note}`, d.taskId);
    return undefined;
  };
  if (kind === "ask-user") return handOver(why.slice(0, 200));
  const found = blockedStepOf(s, d);
  if (typeof found === "string") return `Decision ${d.id}: ${found}`;
  const refused = addCheckRound(s, found.t, found.st, now, "lead");
  if (refused) return handOver(`${refused.slice(0, 200)} (the lead asked for a fix: ${why.slice(0, 150)})`);
  d.status = "fix";
  d.decidedBy = "lead";
  d.decidedAt = now;
  d.leadRunId = leadRunId;
  d.why = why;
  M.event(s, now, "lead", "decision", `${d.id}: fix — a check round was added to ${d.taskId}: ${why.slice(0, 200)}`, d.taskId);
  return undefined;
}

// ---------- evidence (§6.9) ----------

/** Failing final checks the user accepted on this task, if any. */
export function acceptedFailingChecks(s: State, taskId: string): FindingDecision | undefined {
  return s.decisions.find((d) => d.kind === "final-checks" && d.taskId === taskId && d.status === "accept");
}

/**
 * The service-check evidence a commit has under the current settings: the newest accepted check
 * results for exactly that commit and settings revision, from any task. Passing, or accepted by the
 * user, is ok; anything else says why not.
 */
export function checkEvidence(s: State, sha: string): CheckEvidence {
  const cfg = s.project.checks;
  const h = sha12(sha);
  if (!checksOn(cfg)) return { ok: false, forSha: sha, reason: "Checks are off for this project." };
  let best: Artifact | undefined;
  let older = false;
  for (const art of s.artifacts) {
    if (art.kind !== "check-results" || !art.checkRun || !sameSha(art.checkRun.sha, sha)) continue;
    if (art.checkRun.configRev !== cfg.rev) {
      older = true;
      continue;
    }
    if (!best || art.createdAt > best.createdAt) best = art;
  }
  if (!best) return { ok: false, forSha: sha, reason: older ? `The check settings changed after the last run on ${h}.` : `No service checks ran on ${h}.` };
  const run = best.checkRun!;
  const base = { forSha: sha, configRev: run.configRev, attemptId: best.attemptId, taskId: best.taskId, sandbox: run.sandbox };
  const failing = failedResults(run);
  // M2: evidence means every configured check passed on this commit, not only the ones a step chose to run.
  const missing = configuredCheckIds(cfg).filter((id) => run.results.find((r) => r.id === id)?.status !== "passed" && !failing.some((r) => r.id === id));
  // Review finding M6: a check that did not run is judged before any acceptance. Accepting failures
  // covers the failures the user saw, never checks that never ran.
  if (missing.length) return { ok: false, ...base, reason: `The run on ${h} did not run every configured check (missing: ${missing.join(", ")}).` };
  const unresolved = F.unresolved(s, best);
  // ORC-025: the record's `simulated` flag labels a demo run; the text carries no suffix.
  if (!failing.length && unresolved === 0) return { ok: true, ...base, reason: `${run.results.filter((r) => r.kind === "check").map((r) => r.label).join(", ") || "The checks"} passed on ${h}${run.sandbox === "codex" ? "" : " (no sandbox)"}.` };
  const accepted = s.decisions.find((d) => d.kind === "final-checks" && d.artifactId === best!.id && d.status === "accept");
  if (accepted) return { ok: true, ...base, acceptedByUser: true, reason: `You accepted failing checks on ${h} (${failing.map((r) => r.label).join(", ")}).` };
  if (failing.length) return { ok: false, ...base, reason: `${failing.map((r) => r.label).join(", ")} failed on ${h}.` };
  return { ok: false, ...base, reason: `${unresolved} finding${unresolved === 1 ? "" : "s"} of the check run on ${h} need${unresolved === 1 ? "s" : ""} a decision.` };
}

/**
 * Flags for a landed item (§6.9): checks the user accepted failing, and no check evidence for the landed
 * change while checks are on. Both can hold (review M6): an acceptance never covers a check that did not run.
 */
export function landedCheckFlags(s: State, t: Task, changeSha: string | undefined): LandedFlag[] {
  const out: LandedFlag[] = [];
  if (acceptedFailingChecks(s, t.id)) out.push("checks-accepted-failing");
  if (checksOn(s.project.checks) && (!changeSha || !checkEvidence(s, changeSha).ok)) out.push("checks-not-run");
  return out;
}

// ---------- the user's settings (§9) ----------

export type ChecksInput = Omit<ChecksConfig, "rev">;

const argvText = (c: CheckCommand) => `${c.id}: ${c.argv.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(" ")}`;

/**
 * The only way the check commands change (Q1): the user's command. Validates, bumps the settings
 * revision, asks for a sandbox probe when checks are switched on or the sandbox changes, and stops
 * active check runs whose settings changed so they run again with the new ones. The event lists every
 * command's exact argv.
 */
export function setChecks(state: State, input: ChecksInput, acknowledgeUnsandboxed: boolean, now: string): State {
  const prev = state.project.checks;
  const next: ChecksConfig = {
    enabled: input.enabled,
    rev: prev.rev,
    commands: input.commands.map((c) => ({ id: c.id, label: c.label, kind: c.kind, argv: [...c.argv], ...(c.timeoutMinutes !== undefined ? { timeoutMinutes: c.timeoutMinutes } : {}) })),
    sandbox: input.sandbox,
    prepareNetwork: input.prepareNetwork,
    commandTimeoutMinutes: input.commandTimeoutMinutes,
    runTimeoutMinutes: input.runTimeoutMinutes,
    maxConcurrent: input.maxConcurrent,
    protectedInputs: [...input.protectedInputs],
    passEnv: [...input.passEnv],
  };
  const why = validateChecks(next, { acknowledged: acknowledgeUnsandboxed || prev.sandbox === "none" });
  if (why) throw new ControlError(why);
  if (JSON.stringify(next) === JSON.stringify(prev)) return state;
  const s = structuredClone(state);
  next.rev = prev.rev + 1;
  s.project.checks = next;
  const runsChanged = ["commands", "sandbox", "prepareNetwork", "commandTimeoutMinutes", "runTimeoutMinutes", "protectedInputs", "passEnv"].some((k) => JSON.stringify(prev[k as keyof ChecksConfig]) !== JSON.stringify(next[k as keyof ChecksConfig]));
  if ((next.enabled && !prev.enabled) || next.sandbox !== prev.sandbox) {
    s.project.checksHealth = { sandbox: next.sandbox, status: "unverified", detail: "The sandbox has not been checked with these settings yet.", checkedAt: now, ...(s.project.checksHealth?.sandbox === next.sandbox ? s.project.checksHealth : {}), recheck: true, requestedAt: now };
  }
  const stopped = runsChanged ? M.stopServiceRuns(s, now) : 0;
  const what = !next.enabled ? "off" : `on (settings r${next.rev}, ${next.sandbox === "codex" ? "Codex sandbox" : "NO SANDBOX, as you confirmed"}, ${next.commands.length} command${next.commands.length === 1 ? "" : "s"}${next.commands.length ? `: ${next.commands.map(argvText).join("; ")}` : ""})`;
  M.event(s, now, "user", "config", `Checks ${what}${next.enabled && next.sandbox === "codex" && next.enabled !== prev.enabled ? "; the sandbox is checked before any run" : ""}${stopped ? `; ${stopped} check run${stopped === 1 ? "" : "s"} stopped to run again with the new settings` : ""}`);
  return s;
}

/** Probe the sandbox now (the user's "Check again"). */
export function recheckChecks(state: State, now: string): State {
  const s = structuredClone(state);
  const cfg = s.project.checks;
  s.project.checksHealth = { sandbox: cfg.sandbox, status: "unverified", detail: "Checking…", checkedAt: now, ...(s.project.checksHealth?.sandbox === cfg.sandbox ? s.project.checksHealth : {}), recheck: true, requestedAt: now };
  M.event(s, now, "user", "config", `Checks sandbox (${cfg.sandbox === "codex" ? "Codex" : "none"}): check requested`);
  return s;
}

/**
 * The service's probe result (observed state, written only by the service). `startedAt`: when the
 * probe began; a "Check again" asked for after that (L5) is kept, so the newer request still runs.
 */
export function reportChecksHealth(state: State, health: ChecksHealth, now: string, o: { startedAt?: string } = {}): State {
  const s = structuredClone(state);
  const prev = s.project.checksHealth;
  const { recheck: _drop, requestedAt: _drop2, ...clean } = health;
  void _drop;
  void _drop2;
  const newerRequest = !!prev?.recheck && !!o.startedAt && (prev.requestedAt ?? prev.checkedAt) > o.startedAt;
  s.project.checksHealth = { ...clean, ...(newerRequest ? { recheck: true as const, ...(prev!.requestedAt ? { requestedAt: prev!.requestedAt } : {}) } : {}) };
  if (!prev || prev.status !== health.status || prev.sandbox !== health.sandbox) {
    M.event(s, now, "system", "config", `Checks sandbox (${health.sandbox === "codex" ? "Codex" : "none"}): ${health.status}${health.detail ? ` — ${health.detail}` : ""}${health.status !== "ready" && health.sandbox === "codex" ? ". Check steps wait until it is ready" : ""}`);
  }
  return s;
}

/** Is a probe due (§6.5.4): checks on, and no result, a requested recheck, a different sandbox than probed, or a result older than six hours. */
export function probeDue(s: State, nowMs: number): boolean {
  const cfg = s.project.checks;
  if (!checksOn(cfg)) return false;
  const h = s.project.checksHealth;
  if (!h || h.recheck || h.sandbox !== cfg.sandbox) return true;
  return nowMs - Date.parse(h.checkedAt) > 6 * 60 * 60_000;
}
