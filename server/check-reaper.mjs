#!/usr/bin/env node
// ORC-013 §6.5.2: the service's own wrapper around a check command. It never takes a shell string:
// everything after "--" is the argv it starts, as given.
//
//   node check-reaper.mjs [--pid-file <path>] -- <program> [args...]
//
// Its job is to make sure nothing the command started outlives the run:
//   - The command runs in this process's own process group when this process leads one (the service
//     and the Codex sandbox both start it detached), so a kill of the group by whoever started it reaches
//     every descendant. When it does not lead a group, the command gets a group of its own.
//   - SIGTERM, SIGINT and SIGHUP are forwarded to that group; SIGKILL follows after five seconds.
//   - When the parent is gone (this process was re-parented), the group is killed the same way. Stdin
//     is not used for this: under the Codex sandbox it is at end of file from the start.
//   - The exit code is the command's; a command ended by a signal exits 128 plus the signal number.
// It reads nothing, prints nothing of its own, and never inherits stdin into the command.

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
let pidFile;
let i = 0;
for (; i < args.length; i++) {
  if (args[i] === "--") {
    i++;
    break;
  }
  if (args[i] === "--pid-file") pidFile = args[++i];
  else {
    process.stderr.write(`check-reaper: unknown option ${args[i]}\n`);
    process.exit(2);
  }
}
const argv = args.slice(i);
if (!argv.length) {
  process.stderr.write("check-reaper: nothing to run (use: check-reaper.mjs -- <program> [args...])\n");
  process.exit(2);
}

/** Do we lead a process group of our own? (A group's id is its leader's pid.) */
function leadsGroup() {
  try {
    process.kill(-process.pid, 0);
    return true;
  } catch {
    return false;
  }
}

const leader = process.platform !== "win32" && leadsGroup();
const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "inherit", "inherit"], detached: !leader && process.platform !== "win32" });
const SIGNALS = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };

function groupKill(signal) {
  const target = leader ? -process.pid : child.pid ? -child.pid : undefined;
  if (target === undefined) return;
  try {
    process.kill(target, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

let ending = false;
function endGroup(signal) {
  if (ending) return;
  ending = true;
  groupKill(signal);
  const t = setTimeout(() => groupKill("SIGKILL"), 5000);
  t.unref();
}

child.on("error", (e) => {
  process.stderr.write(`check-reaper: could not start ${argv[0]}: ${e.message}\n`);
  process.exit(127);
});
child.on("spawn", () => {
  if (pidFile) {
    try {
      writeFileSync(pidFile, String(child.pid));
    } catch {
      /* the probe reads it; a check never asks for it */
    }
  }
});
child.on("exit", (code, signal) => {
  // Anything the command left behind in the group is asked to stop (this process handles the signal
  // itself and exits right away). Whatever ignores it still holds the output pipe, so the run's own
  // time limit ends it: the group is killed by whoever started this process.
  groupKill("SIGTERM");
  process.exit(signal ? 128 + (SIGNALS[signal] ?? 0) : (code ?? 1));
});

for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(s, () => endGroup(s));
// An orphan is re-parented (to pid 1, or a subreaper): the service or the sandbox that started this run is gone.
const parent = process.ppid;
const watch = setInterval(() => {
  if (process.ppid !== parent) endGroup("SIGTERM");
}, 500);
watch.unref();
