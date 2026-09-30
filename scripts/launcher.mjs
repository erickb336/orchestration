// Launcher logic shared by `orchestrator setup`, `start` and `status`. Pure functions here (the CLI in
// orchestrator.mjs does the prompting and the processes), so they can be tested without a terminal.
//
// Saved answers live in ~/.orchestration/launcher.json and never contain a secret. A Claude API key or
// subscription token comes from the environment, or on macOS from the Keychain, read at start and
// handed only to the service process as an environment variable.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const CLAUDE_CHOICES = ["api-key", "subscription", "cloud", "none"];
export const RUNTIMES = ["real", "fake"];
export const DEFAULT_PORT = 5319;
export const ROLES = ["lead", "designer", "coder", "code_reviewer", "ux_reviewer"];

/** Keychain items (service names) for each Claude choice that needs a secret. */
export const KEYCHAIN = {
  "api-key": { service: "orchestrator.anthropic-api-key", variable: "ANTHROPIC_API_KEY" },
  subscription: { service: "orchestrator.claude-oauth-token", variable: "CLAUDE_CODE_OAUTH_TOKEN" },
};

export const CLOUD_FLAGS = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_ANTHROPIC_AWS"];

export const ANTHROPIC_RULE =
  'Anthropic\'s Agent SDK docs say: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK." They do not say whether a subscriber may use their own token in their own tool. Using it is your decision.';

export function settingsPath(home) {
  return join(home, ".orchestration", "launcher.json");
}

/** Validate saved answers. Unknown or malformed values are dropped, never guessed. */
export function validateSettings(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  const out = { version: 1 };
  if (RUNTIMES.includes(s.runtime)) out.runtime = s.runtime;
  if (CLAUDE_CHOICES.includes(s.claude)) out.claude = s.claude;
  if (Number.isInteger(s.port) && s.port > 0 && s.port < 65536) out.port = s.port;
  if (typeof s.codexDefaultsAppliedTo === "string") out.codexDefaultsAppliedTo = s.codexDefaultsAppliedTo;
  return out;
}

export function loadSettings(path) {
  if (!existsSync(path)) return null;
  try {
    return validateSettings(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

export function saveSettings(path, settings) {
  const clean = validateSettings(settings);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(clean, null, 2) + "\n", { mode: 0o600 });
  return clean;
}

const has = (v) => typeof v === "string" && v.trim() !== "" && v !== "0" && v.toLowerCase() !== "false";

/**
 * How Claude will sign in. An explicit environment variable always wins; the Keychain (macOS) is the
 * fallback. Returns the variables to add to the service environment and a plain description with no
 * secret in it. `readKeychain(service)` returns the stored value or undefined.
 */
export function resolveClaude(choice, env, readKeychain) {
  if (choice === "none") return { add: {}, ok: true, note: "Claude: not used (Codex only)." };
  if (choice === "cloud") {
    const flag = CLOUD_FLAGS.find((f) => has(env[f]));
    return flag
      ? { add: {}, ok: true, note: `Claude: cloud credentials (${flag}).` }
      : { add: {}, ok: false, note: `Claude: cloud credentials chosen, but none of ${CLOUD_FLAGS.join(", ")} is set in this terminal.` };
  }
  const item = KEYCHAIN[choice];
  if (!item) return { add: {}, ok: false, note: "Claude: not set up. Run `npm run setup`." };
  const add = choice === "subscription" ? { ORCHESTRATION_CLAUDE_AUTH: "subscription" } : {};
  if (has(env[item.variable])) return { add, ok: true, note: `Claude: ${label(choice)} from ${item.variable} in this terminal.` };
  const stored = readKeychain ? readKeychain(item.service) : undefined;
  if (has(stored)) return { add: { ...add, [item.variable]: stored.trim() }, ok: true, note: `Claude: ${label(choice)} from your macOS Keychain.` };
  return {
    add,
    ok: false,
    note: `Claude: ${label(choice)} chosen, but ${item.variable} is not set and nothing is stored in the Keychain. Run \`npm run setup\` again, or set ${item.variable}.`,
  };
}

const label = (choice) => (choice === "subscription" ? "your own subscription token (personal use)" : "API key");

/**
 * The environment for the service process. Explicit variables in `env` win over saved answers; the
 * subscription switch is only ever added for the subscription choice, never inherited by accident.
 */
export function serviceEnv(settings, env, claude) {
  const s = settings ?? {};
  const out = { ...env, ORCHESTRATION_STATIC: "dist" };
  out.ORCHESTRATION_RUNTIME = env.ORCHESTRATION_RUNTIME ?? s.runtime ?? "fake";
  out.ORCHESTRATION_PORT = env.ORCHESTRATION_PORT ?? String(s.port ?? DEFAULT_PORT);
  if (out.ORCHESTRATION_RUNTIME === "real" && claude) {
    for (const [k, v] of Object.entries(claude.add)) if (!has(env[k])) out[k] = v;
  }
  return out;
}

/** Commands that make Codex the lead and every role's default (the "Codex only" choice), applied once. */
export function codexOnlyCommands() {
  const selection = { provider: "codex", model: "auto" };
  return [
    { name: "setLeadSelection", args: { selection } },
    { name: "setProjectDefault", args: { selection } },
    ...ROLES.map((role) => ({ name: "setRoleDefault", args: { role, selection } })),
  ];
}

export function parseArgs(argv) {
  const out = { command: "start", open: true, port: undefined, runtime: undefined, help: false };
  const rest = [...argv];
  if (rest[0] && !rest[0].startsWith("-")) out.command = rest.shift();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--no-open") out.open = false;
    else if (a === "--demo") out.runtime = "fake";
    else if (a === "--real") out.runtime = "real";
    else if (a === "--port") out.port = Number(rest[++i]);
    else if (a === "-h" || a === "--help") out.help = true;
    else throw new Error(`Unknown option ${a}. Try \`orchestrator help\`.`);
  }
  if (out.port !== undefined && !(Number.isInteger(out.port) && out.port > 0 && out.port < 65536)) throw new Error("--port needs a number between 1 and 65535.");
  if (!["setup", "start", "status", "help"].includes(out.command)) throw new Error(`Unknown command "${out.command}". Try \`orchestrator help\`.`);
  return out;
}
