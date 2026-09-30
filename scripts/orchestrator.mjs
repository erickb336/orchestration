#!/usr/bin/env node
// `orchestrator` (also `npm run setup` and `npm start`): guided setup, one-command start, and status.
//
//   orchestrator setup     answer a few questions once; saved to ~/.orchestration/launcher.json
//   orchestrator [start]   build, start the service with your saved answers, open the browser
//   orchestrator status    what is saved and which credentials are found (never their values)
//
// Start options: --demo or --real (override the saved choice), --port <n>, --no-open.

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ANTHROPIC_RULE,
  CLOUD_FLAGS,
  DEFAULT_PORT,
  KEYCHAIN,
  codexOnlyCommands,
  loadSettings,
  parseArgs,
  resolveClaude,
  saveSettings,
  serviceEnv,
  settingsPath,
} from "./launcher.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SETTINGS = settingsPath(homedir());
const isMac = process.platform === "darwin";
const say = (line = "") => process.stdout.write(line + "\n");

function readKeychain(service) {
  if (!isMac) return undefined;
  const r = spawnSync("security", ["find-generic-password", "-a", userInfo().username, "-s", service, "-w"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

function codexStatus() {
  const bin = join(ROOT, "node_modules", ".bin", "codex");
  if (!existsSync(bin)) return { ok: false, text: "Codex: not installed yet (run `npm install`)." };
  const r = spawnSync(bin, ["login", "status"], { encoding: "utf8", cwd: ROOT });
  const text = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n")[0] || "unknown";
  return { ok: r.status === 0 && /logged in/i.test(text), text: `Codex: ${text}.`, bin };
}

// ---------------------------------------------------------------------------------------------
// setup

/**
 * Line-by-line answers from stdin, in the terminal's normal (cooked) mode. Works when answers are
 * piped in, and pauses while a program that needs the terminal runs (codex login, claude
 * setup-token, the macOS password prompt), so it never reads their input.
 */
function answers() {
  const queue = [];
  const waiters = [];
  let buf = "";
  let ended = false;
  const deliver = (line) => {
    const w = waiters.shift();
    if (w) w(line);
    else queue.push(line);
  };
  const onData = (chunk) => {
    buf += chunk;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      deliver(buf.slice(0, i).replace(/\r$/, ""));
      buf = buf.slice(i + 1);
    }
  };
  const onEnd = () => {
    ended = true;
    if (buf) deliver(buf);
    buf = "";
    while (waiters.length) waiters.shift()(null);
  };
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", onData);
  process.stdin.on("end", onEnd);
  return {
    next: () => (queue.length ? Promise.resolve(queue.shift()) : ended ? Promise.resolve(null) : new Promise((r) => waiters.push(r))),
    /** Run a program that uses the terminal, without reading its input. */
    handOver: (fn) => {
      process.stdin.pause();
      try {
        return fn();
      } finally {
        if (!ended) process.stdin.resume();
      }
    },
    close: () => {
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.pause();
    },
  };
}

async function setup() {
  const rl = answers();
  const ask = async (q, def) => {
    process.stdout.write(def ? `${q} [${def}] ` : `${q} `);
    const line = await rl.next();
    if (line === null) process.stdout.write("\n");
    const a = (line ?? "").trim();
    return a || def || "";
  };
  const yes = async (q, def = "y") => /^y/i.test(await ask(`${q} (y/n)`, def));
  const choose = async (q, options) => {
    say(q);
    options.forEach((o, i) => say(`  ${i + 1}. ${o.label}`));
    for (;;) {
      const a = await ask("Choose a number:", "1");
      const o = options[Number(a) - 1];
      if (o) return o.value;
      say("Please answer with one of the numbers above.");
    }
  };

  say("Orchestrator setup. Your answers are saved to " + SETTINGS + " (never a password, key or token).\n");

  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
    say(`Node.js 22.13 or newer is needed; this is ${process.versions.node}. Install a newer Node.js, then run setup again.`);
    rl.close();
    process.exitCode = 1;
    return;
  }
  if (spawnSync("git", ["--version"]).status !== 0) say("Warning: git was not found. Orchestrator needs git to work on a repository.");
  if (!existsSync(join(ROOT, "node_modules"))) {
    if (await yes("Dependencies are not installed. Run `npm install` now?")) {
      const r = rl.handOver(() => spawnSync("npm", ["install"], { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" }));
      if (r.status !== 0) {
        say("npm install failed; fix the error above and run setup again.");
        rl.close();
        process.exitCode = 1;
        return;
      }
    }
  }

  const previous = loadSettings(SETTINGS) ?? {};
  const runtime = await choose("\nHow do you want to run it?", [
    { label: "Real agents: Claude and/or Codex work on your repositories", value: "real" },
    { label: "Demo: a sample project with simulated runs (no agents, no cost)", value: "fake" },
  ]);
  let claude = previous.claude ?? "none";

  if (runtime === "real") {
    say("");
    let codex = codexStatus();
    say(codex.text);
    if (!codex.ok && codex.bin && (await yes("Sign Codex in now? This opens `codex login` (your ChatGPT sign-in, no extra cost).", "y"))) {
      rl.handOver(() => spawnSync(codex.bin, ["login"], { cwd: ROOT, stdio: "inherit" }));
      codex = codexStatus();
      say(codex.text);
    }

    claude = await choose("\nHow should Claude sign in?", [
      { label: "Codex only: don't use Claude (no extra cost; Codex becomes the lead and every role's default)", value: "none" },
      { label: "Anthropic API key (billed per use, separately from any subscription)", value: "api-key" },
      { label: "My own Claude subscription token (personal use; opt-in)", value: "subscription" },
      { label: "Cloud credentials already set in my terminal (Bedrock, Vertex, Foundry, or Claude Platform on AWS)", value: "cloud" },
    ]);

    if (claude === "subscription") {
      say("\n" + ANTHROPIC_RULE);
      if (!(await yes("Use your own subscription token anyway?", "n"))) claude = "none";
    }
    if (claude === "api-key" || claude === "subscription") await storeSecret(claude, yes, rl);
    if (claude === "cloud" && !CLOUD_FLAGS.some((f) => process.env[f])) {
      say(`None of ${CLOUD_FLAGS.join(", ")} is set in this terminal. Set it (and its credentials) in your shell profile before starting.`);
    }
  }

  const saved = saveSettings(SETTINGS, { ...previous, runtime, claude, codexDefaultsAppliedTo: claude === "none" ? previous.codexDefaultsAppliedTo : undefined });
  say(`\nSaved: ${runtime === "real" ? "real agents" : "demo"}${runtime === "real" ? `, Claude: ${describe(saved.claude)}` : ""}.`);

  if (await yes("\nMake the `orchestrator` command available from any folder? This runs `npm link`.", "n")) {
    const r = rl.handOver(() => spawnSync("npm", ["link"], { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" }));
    say(r.status === 0 ? "Done: run `orchestrator` from anywhere." : "npm link failed; you can still start with `npm start` in this folder.");
  }
  rl.close();
  say("\nStart it with `npm start` in this folder" + " (or `orchestrator`, if you linked it). In the app, the Overview's Get started list takes you through connecting a repository and writing your vision.");
}

async function storeSecret(choice, yes, rl) {
  const item = KEYCHAIN[choice];
  if (choice === "subscription") {
    const hasCli = spawnSync("claude", ["--version"], { encoding: "utf8" }).status === 0;
    say(hasCli ? "Create the token with `claude setup-token` (in another terminal, or now below)." : "Install Claude Code first (https://claude.ai/install.sh), then create the token with `claude setup-token`.");
    if (hasCli && (await yes("Run `claude setup-token` now?", "y"))) rl.handOver(() => spawnSync("claude", ["setup-token"], { stdio: "inherit" }));
  }
  if (process.env[item.variable]) {
    say(`${item.variable} is already set in this terminal; it is used at start.`);
    return;
  }
  if (!isMac) {
    say(`Set ${item.variable} in your shell profile (for example ~/.zshrc) so each start finds it.`);
    return;
  }
  if (await yes(`Store it in your macOS Keychain now? You type it into macOS's own hidden prompt; Orchestrator never sees or saves it.`, "y")) {
    say(`Paste the ${choice === "subscription" ? "token" : "key"} at the macOS prompt below (twice). Nothing is shown as you type.`);
    const r = rl.handOver(() => spawnSync("security", ["add-generic-password", "-U", "-a", userInfo().username, "-s", item.service, "-l", `Orchestrator ${item.variable}`, "-w"], { stdio: "inherit" }));
    say(r.status === 0 ? "Stored in your Keychain. macOS may ask once, at start, whether Orchestrator may read it." : "It was not stored; you can run setup again, or set the variable in your shell profile.");
  } else say(`Then set ${item.variable} in your shell profile (for example ~/.zshrc) so each start finds it.`);
}

const describe = (c) => ({ none: "not used (Codex only)", "api-key": "API key", subscription: "your own subscription token", cloud: "cloud credentials" })[c] ?? "not set up";

// ---------------------------------------------------------------------------------------------
// start

async function start(opts) {
  if (!existsSync(join(ROOT, "node_modules"))) {
    say("Dependencies are not installed. Run `npm run setup` (or `npm install`) first.");
    process.exitCode = 1;
    return;
  }
  const settings = loadSettings(SETTINGS);
  const env = { ...process.env };
  if (opts.runtime) env.ORCHESTRATION_RUNTIME = opts.runtime;
  if (opts.port) env.ORCHESTRATION_PORT = String(opts.port);
  const runtime = env.ORCHESTRATION_RUNTIME ?? settings?.runtime ?? "fake";
  const claude = runtime === "real" && settings?.claude ? resolveClaude(settings.claude, env, readKeychain) : undefined;
  const childEnv = serviceEnv(settings, env, claude);
  const port = Number(childEnv.ORCHESTRATION_PORT);
  const url = `http://127.0.0.1:${port}`;

  say(settings ? `Starting ${runtime === "real" ? "with real agents" : "the demo"} (saved answers: ${SETTINGS}).` : "Starting the demo. Run `npm run setup` to use real agents and save your choices.");
  if (claude) say(claude.note);
  if (runtime === "real") say(codexStatus().text);

  const build = spawnSync("npm", ["run", "build", "--silent"], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"], shell: process.platform === "win32" });
  if (build.status !== 0) {
    say("The build failed (see above); nothing was started.");
    process.exitCode = 1;
    return;
  }

  // One process (not the tsx CLI wrapper), so stopping it cannot leave an orphaned service.
  const child = spawn(process.execPath, ["--import", "tsx", "server/main.ts"], { cwd: ROOT, stdio: "inherit", env: childEnv });
  const forward = (sig) => child.kill(sig);
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);
  child.on("exit", (code) => process.exit(code ?? 0));

  if (!(await waitForService(url, child))) return;
  if (runtime === "real" && settings?.claude === "none") await applyCodexOnly(url, settings, childEnv);
  say(`\nOrchestrator is running at ${url}. Press Ctrl-C to stop it.`);
  if (opts.open) openBrowser(url);
}

async function waitForService(url, child) {
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) return false;
    try {
      const r = await fetch(url + "/api/health");
      if (r.ok) return true;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  say(`The service did not answer at ${url} within 30 s; see its output above.`);
  return false;
}

/** Codex only: make Codex the lead and every role's default, once per database. */
async function applyCodexOnly(url, settings, env) {
  const db = env.ORCHESTRATION_DB ?? join(homedir(), ".orchestration", "orchestration.db");
  if (settings.codexDefaultsAppliedTo === db) return;
  try {
    for (const c of codexOnlyCommands()) {
      const r = await fetch(url + "/api/commands", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Orchestration-Client": "1" },
        body: JSON.stringify({ name: c.name, args: c.args, idempotencyKey: `launcher-codex-only-${c.name}-${c.args.role ?? ""}-${Date.now()}` }),
      });
      if (!r.ok) throw new Error(`${c.name}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    }
    saveSettings(SETTINGS, { ...settings, codexDefaultsAppliedTo: db });
    say("Codex is now the lead and every role's default (Codex only). You can change this in Settings.");
  } catch (e) {
    say(`Could not set Codex as the default everywhere (${e instanceof Error ? e.message : String(e)}). Set it in Settings → Model defaults.`);
  }
}

function openBrowser(url) {
  const cmd = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  const p = spawn(cmd[0], cmd[1], { stdio: "ignore", detached: true });
  p.on("error", () => say(`Open ${url} in your browser.`));
  p.unref();
}

// ---------------------------------------------------------------------------------------------
// status

function status() {
  const settings = loadSettings(SETTINGS);
  if (!settings) say(`No saved answers yet (${SETTINGS}). Run \`npm run setup\`.`);
  else {
    say(`Saved answers (${SETTINGS}):`);
    say(`  Runs: ${settings.runtime === "real" ? "real agents" : "demo"}`);
    say(`  Claude: ${describe(settings.claude)}`);
    say(`  Port: ${settings.port ?? DEFAULT_PORT}`);
  }
  if (settings?.claude) say(resolveClaude(settings.claude, process.env, readKeychain).note);
  say(codexStatus().text);
}

function help() {
  say(`Usage: orchestrator [command] [options]

Commands:
  setup     Answer a few questions once; saved to ${SETTINGS}
  start     Build and start with your saved answers, then open the browser (the default)
  status    Show what is saved and which credentials are found (never their values)
  help      Show this help

Start options:
  --demo | --real   Override the saved choice for this start
  --port <n>        Serve on another port (default ${DEFAULT_PORT})
  --no-open         Do not open the browser`);
}

// ---------------------------------------------------------------------------------------------

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (e) {
  say(e instanceof Error ? e.message : String(e));
  process.exit(2);
}
if (opts.help || opts.command === "help") help();
else if (opts.command === "setup") await setup();
else if (opts.command === "status") status();
else await start(opts);
