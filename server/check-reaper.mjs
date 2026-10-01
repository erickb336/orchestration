#!/usr/bin/env node
// The service's own wrapper around a check command. It never takes a shell string:
// everything after "--" is the argv it starts, as given.
//
//   node check-reaper.mjs [--pid-file <path>] -- <program> [args...]
//
// Its job is to make sure nothing the command started outlives the run, and that the command's exit
// status comes from nowhere the command can write. Two processes do it:
//   - This process, the reaper, starts a leader (`check-reaper.mjs --leader`) detached, so the leader
//     heads a new process group of its own; the command and everything it starts live in that group.
//     The reaper never joins it. It waits for the leader's one-line report of the command's exit, sent
//     on a pipe only the leader holds (fd 3), then ends the group (SIGTERM, a short grace, SIGKILL)
//     while the leader is still alive, so the group id is still the leader's own, and exits with
//     the command's exit code, or 128 plus the signal number. A leader that dies without
//     reporting (killed by the command, say) is a failure: the reaper exits 128 plus that signal.
//   - The leader starts the command in the group, passes its output through, reports the exit, tells
//     the reaper when every holder of the output pipes is gone, and then waits to be killed with the
//     group. When the reaper is gone (its end of the control pipe on the leader's stdin closes), the
//     leader kills the group itself, so a reaper ended by SIGKILL still takes the command with it.
//   - SIGTERM, SIGINT and SIGHUP to the reaper go to the group; SIGKILL follows after five seconds.
//   - When the reaper's parent is gone (it was re-parented), the group is ended the same way.
// Nothing here reads stdin as input, and the command never inherits it.

import { spawn } from "node:child_process";
import { writeFileSync, writeSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
let pidFile;
let leaderMode = false;
let i = 0;
for (; i < args.length; i++) {
  if (args[i] === "--") {
    i++;
    break;
  }
  if (args[i] === "--pid-file") pidFile = args[++i];
  else if (args[i] === "--leader") leaderMode = true;
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

const SIGNUM = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGABRT: 6, SIGKILL: 9, SIGSEGV: 11, SIGTERM: 15 };
/** What a shell would report: the exit code, or 128 plus the signal number. */
const exitStatus = (code, signal) => (signal ? 128 + (SIGNUM[signal] ?? 0) : typeof code === "number" ? code : 1);
/** Leftovers get this long after SIGTERM before SIGKILL, once the command itself has exited. */
const LEFTOVER_GRACE_MS = 1500;
const KILL_AFTER_MS = 5000;

function signalGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal);
  } catch {
    /* no such group: every member is gone */
  }
}

/** Flush our own output pipes, then resolve: nothing written so far is lost to a SIGKILL that follows. */
function flushed() {
  return Promise.all([new Promise((r) => process.stdout.write("", () => r())), new Promise((r) => process.stderr.write("", () => r()))]);
}

if (leaderMode) leader();
else reaper();

// ---------- the leader: heads the command's process group ----------

function leader() {
  // The output passes through this process: a leftover that inherited the pipes keeps them open, and
  // the child's "close" (every holder gone) tells the two cases apart.
  const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => process.stdout.write(d));
  child.stderr.on("data", (d) => process.stderr.write(d));
  let reported = false;
  let ending = false;
  const report = (line) => {
    try {
      writeSync(3, `${JSON.stringify(line)}\n`);
    } catch {
      /* the reaper is gone: the stdin watch ends the group */
    }
  };
  /** Ask the whole group (this process included) to stop; SIGKILL follows. */
  const endGroup = (signal) => {
    if (ending) return;
    ending = true;
    signalGroup(process.pid, signal);
    setTimeout(() => signalGroup(process.pid, "SIGKILL"), KILL_AFTER_MS).unref();
  };
  child.on("error", (e) => {
    process.stderr.write(`check-reaper: could not start ${argv[0]}: ${e.message}\n`);
    reported = true;
    report({ code: 127, signal: null });
    report({ closed: true });
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
    reported = true;
    void flushed().then(() => report({ code, signal }));
  });
  child.on("close", () => {
    void flushed().then(() => report({ closed: true }));
  });
  for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    // Before the report, a signal is a request to stop the command. After it, the reaper is ending the
    // group: this process stays until the SIGKILL that ends every member.
    process.on(s, () => {
      if (!reported) endGroup(s);
    });
  }
  // The reaper holds the other end of stdin and never writes: end of file means the reaper is gone.
  process.stdin.on("end", () => endGroup("SIGTERM"));
  process.stdin.on("error", () => endGroup("SIGTERM"));
  process.stdin.resume();
}

// ---------- the reaper: waits, ends the group, reports ----------

function reaper() {
  const self = fileURLToPath(import.meta.url);
  const w = spawn(process.execPath, [self, "--leader", ...(pidFile ? ["--pid-file", pidFile] : []), "--", ...argv], {
    // stdin: the control pipe (kept open, never written). stdout and stderr: ours, passed through.
    // fd 3: the report pipe, which only the leader holds.
    stdio: ["pipe", "inherit", "inherit", "pipe"],
    detached: process.platform !== "win32",
  });
  let report;
  let done = false;
  let ending = false;
  let leftoverTimer;
  const finish = (status) => {
    if (done) return;
    done = true;
    clearTimeout(leftoverTimer);
    // Kills every remaining member of the group, the leader included; the leader is alive until now, so
    // the id is still its group's.
    signalGroup(w.pid, "SIGKILL");
    process.exit(status);
  };
  const endGroup = (signal) => {
    if (ending || done) return;
    ending = true;
    signalGroup(w.pid, signal);
    setTimeout(() => signalGroup(w.pid, "SIGKILL"), KILL_AFTER_MS).unref();
  };
  w.on("error", (e) => {
    process.stderr.write(`check-reaper: could not start the leader: ${e.message}\n`);
    process.exit(127);
  });
  const lines = createInterface({ input: w.stdio[3] });
  lines.on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    if (!report && ("code" in msg || "signal" in msg)) {
      report = { code: typeof msg.code === "number" ? msg.code : null, signal: typeof msg.signal === "string" ? msg.signal : null };
      // Anything the command left behind in the group is asked to stop; if it still holds the output
      // pipes after the grace (or ignores the signal), it is killed.
      signalGroup(w.pid, "SIGTERM");
      leftoverTimer = setTimeout(() => finish(exitStatus(report.code, report.signal)), LEFTOVER_GRACE_MS);
    } else if (report && msg.closed === true) finish(exitStatus(report.code, report.signal));
  });
  let leaderExit;
  w.on("exit", (code, signal) => {
    leaderExit = { code, signal };
  });
  // The report pipe closes once the leader is gone; a line it wrote just before is still delivered first.
  lines.on("close", () => {
    if (done) return;
    if (report) return finish(exitStatus(report.code, report.signal));
    const how = leaderExit?.signal ? `was killed (${leaderExit.signal})` : `ended (exit ${leaderExit?.code ?? "?"})`;
    try {
      // Synchronous: nothing is lost to the exit that follows.
      writeSync(2, `check-reaper: the check process was killed: the command's leader ${how} before it reported an exit status\n`);
    } catch {
      /* no stderr */
    }
    signalGroup(w.pid, "SIGKILL");
    process.exit(leaderExit?.signal ? exitStatus(null, leaderExit.signal) : leaderExit?.code === 0 ? 1 : (leaderExit?.code ?? 1));
  });
  for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(s, () => endGroup(s));
  // An orphan is re-parented (to pid 1, or a subreaper): the service or the sandbox that started this run is gone.
  const parent = process.ppid;
  const watch = setInterval(() => {
    if (process.ppid !== parent) endGroup("SIGTERM");
  }, 500);
  watch.unref();
}
