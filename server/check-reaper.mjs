#!/usr/bin/env node
// ORC-013 §6.5.2: the service's own wrapper around a check command. It never takes a shell string:
// everything after "--" is the argv it starts, as given.
//
//   node check-reaper.mjs [--pid-file <path>] [--status-file <path>] -- <program> [args...]
//
// Its job is to make sure nothing the command started outlives the run:
//   - The command runs in this process's own process group when this process leads one (the service
//     and the Codex sandbox both start it detached), so a kill of the group by whoever started it reaches
//     every descendant. When it does not lead a group, the command gets a group of its own.
//   - SIGTERM, SIGINT and SIGHUP are forwarded to that group; SIGKILL follows after five seconds.
//   - When the parent is gone (this process was re-parented), the group is killed the same way. Stdin
//     is not used for this: under the Codex sandbox it is at end of file from the start.
//   - When the command exits, whatever it left in the group gets SIGTERM, a short grace, then SIGKILL
//     (review finding M3: a child that traps SIGTERM must not survive). The command's output is passed
//     through this process, so a leftover that still holds the output pipe is seen as such.
//   - The exit code is the command's; a command ended by a signal exits 128 plus the signal number.
//     When this process leads the group, the final SIGKILL ends this process too, so the code is written
//     to the status file first (as JSON: {"code":0} or {"signal":"SIGTERM"}); the runner reads it.
// It reads nothing, and never inherits stdin into the command.

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
let pidFile;
let statusFile;
let i = 0;
for (; i < args.length; i++) {
  if (args[i] === "--") {
    i++;
    break;
  }
  if (args[i] === "--pid-file") pidFile = args[++i];
  else if (args[i] === "--status-file") statusFile = args[++i];
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
// The output passes through this process: a leftover that inherited the pipes keeps them open, and
// the child's "close" (every holder gone) tells the two cases apart.
const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"], detached: !leader && process.platform !== "win32" });
child.stdout.on("data", (d) => process.stdout.write(d));
child.stderr.on("data", (d) => process.stderr.write(d));
const SIGNALS = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };
/** Leftovers get this long after SIGTERM before SIGKILL, once the command itself has exited. */
const LEFTOVER_GRACE_MS = 1500;

let exiting = false;

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

/** Flush our own output pipes, then resolve: nothing written so far is lost to the SIGKILL that follows. */
function flushed() {
  return Promise.all([new Promise((r) => process.stdout.write("", () => r())), new Promise((r) => process.stderr.write("", () => r()))]);
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

let exit;
let closed = false;
child.on("close", () => {
  closed = true;
});
child.on("exit", (code, signal) => {
  exit = { code, signal };
  exiting = true;
  // Anything the command left behind in the group is asked to stop; if it still holds the output pipe
  // after the grace (or ignores the signal), it is killed. When this process leads the group, that
  // final kill ends this process too, so the command's result is written down first.
  groupKill("SIGTERM");
  const finish = async () => {
    const status = signal ? 128 + (SIGNALS[signal] ?? 0) : (code ?? 1);
    if (statusFile) {
      try {
        writeFileSync(statusFile, JSON.stringify(exit));
      } catch {
        /* the runner then records what it sees */
      }
    }
    await flushed();
    // Kills every remaining member of the group; when this process leads it, this process too (the
    // status file carries the code). Otherwise the exit that follows reports the code itself.
    groupKill("SIGKILL");
    process.exit(status);
  };
  if (closed) void finish();
  else {
    const t = setTimeout(() => void finish(), LEFTOVER_GRACE_MS);
    child.once("close", () => {
      clearTimeout(t);
      void finish();
    });
  }
});

for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(s, () => {
    // Our own SIGTERM to the group after the command exited is not a request to stop.
    if (!exiting) endGroup(s);
  });
}
// An orphan is re-parented (to pid 1, or a subreaper): the service or the sandbox that started this run is gone.
const parent = process.ppid;
const watch = setInterval(() => {
  if (process.ppid !== parent && !exiting) endGroup("SIGTERM");
}, 500);
watch.unref();
