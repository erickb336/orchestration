// The local Orchestration service (loaded by main.ts after the Node version check).
//
//   ORCHESTRATION_PORT   API/UI port on 127.0.0.1 (default 5319)
//   ORCHESTRATION_DB     SQLite path (default ~/.orchestration/orchestration.db)
//   ORCHESTRATION_STATIC directory of the built UI to serve (npm start sets it to dist)
//   ORCHESTRATION_DEV_UI extra host:port allowed as Host/Origin (npm run dev sets the Vite address)
//   ORCHESTRATION_RUNTIME "fake" (default, simulated) or "real" (Claude and Codex agents run here)

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { buildEmptyProject } from "../src/domain/seed";
import type { ProviderId } from "../src/domain/types";
import type { GitHubHost } from "./github";
import { createHttpServer } from "./http";
import { FakeAdapter, defaultFakeConfig } from "./runtimes/fake";
import type { RuntimeAdapter } from "./runtimes/types";
import { Scheduler } from "./scheduler";
import { Store } from "./store";
import { WorkspaceManager } from "./workspaces";

const port = Number(process.env.ORCHESTRATION_PORT ?? 5319);
const dbPath = process.env.ORCHESTRATION_DB ?? join(homedir(), ".orchestration", "orchestration.db");
const staticDir = process.env.ORCHESTRATION_STATIC;
const devUi = process.env.ORCHESTRATION_DEV_UI;
const log = (msg: string) => console.log(`[orchestration] ${msg}`);
const mode = process.env.ORCHESTRATION_RUNTIME === "real" ? "real" : "fake";
if (process.env.ORCHESTRATION_RUNTIME && !["real", "fake"].includes(process.env.ORCHESTRATION_RUNTIME)) {
  log(`Unknown ORCHESTRATION_RUNTIME "${process.env.ORCHESTRATION_RUNTIME}"; use "fake" or "real".`);
  process.exit(1);
}

let store: Store;
try {
  store = new Store(dbPath, mode === "real" ? () => buildEmptyProject() : undefined);
} catch (e) {
  log(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
const fakeConfig = defaultFakeConfig();
let adapters: Record<ProviderId, RuntimeAdapter>;
let workspaces: WorkspaceManager | undefined;
let github: GitHubHost | undefined;
/** True when Claude workers run with shell access: the app then cannot claim that only the service reaches GitHub. */
let workerShell = false;
if (mode === "real") {
  // Loaded only in real mode, so the simulated service never loads provider SDKs.
  const [{ ClaudeAdapter }, { CodexAdapter }] = await Promise.all([import("./runtimes/claude"), import("./runtimes/codex")]);
  const claude = new ClaudeAdapter({ log });
  adapters = { claude, codex: new CodexAdapter({ log }) };
  workerShell = claude.allowShell;
  workspaces = new WorkspaceManager(join(dirname(dbPath), "worktrees"));
  // Pull-request delivery uses the user's own gh sign-in, from an empty directory the service owns.
  // Nothing is contacted until the user switches the delivery mode to pull requests.
  const { GhCliHost } = await import("./github");
  github = new GhCliHost({ cwd: join(dirname(dbPath), "gh-neutral") });
} else {
  const catalog = store.read().state.project.catalog;
  adapters = { claude: new FakeAdapter("claude", fakeConfig, catalog.claude), codex: new FakeAdapter("codex", fakeConfig, catalog.codex) };
}
// Fake runtime: no `github` is passed, so the scheduler uses its simulated host and contacts nothing.
const scheduler = new Scheduler(store, adapters, { log, workspaces, github, workerShell });
const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
if (devUi) allowedHosts.push(devUi, devUi.replace("127.0.0.1", "localhost"));

const server = createHttpServer({
  store,
  scheduler,
  fakeConfig: mode === "fake" ? fakeConfig : undefined,
  workspaces,
  startedAt: new Date().toISOString(),
  allowedHosts,
  staticDir,
  log,
});


server.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EADDRINUSE") log(`Port ${port} is already in use. Another Orchestration service may be running; stop it or set ORCHESTRATION_PORT.`);
  else log(`Server error: ${e.message}`);
  void scheduler.stop(); // releases the lease if it was taken
  store.close();
  process.exit(1);
});

server.listen(port, "127.0.0.1", () => {
  log(`Service listening on http://127.0.0.1:${port} (loopback only)`);
  log(`Database: ${dbPath}`);
  if (mode === "real") {
    log("Runtime: REAL. Claude and Codex agents run on this machine in isolated git worktrees and may incur usage costs.");
    log(`Worktrees: ${workspaces!.root}`);
  } else log("Runtime: fake (simulated). No agent runs. Set ORCHESTRATION_RUNTIME=real to run Claude and Codex.");
  if (staticDir) log(`Open http://127.0.0.1:${port}`);
  scheduler.start();
});

let stopping = false;
function shutdown(reason: string) {
  if (stopping) return;
  stopping = true;
  log(`${reason}: stopping scheduler and closing the database`);
  try {
    void scheduler.stop();
    server.close();
    server.closeAllConnections();
    store.close();
  } finally {
    process.exit(reason === "uncaughtException" ? 1 : 0);
  }
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGHUP", () => shutdown("SIGHUP"));
process.on("uncaughtException", (e) => {
  log(`Unexpected error: ${e.stack ?? e.message}`);
  shutdown("uncaughtException");
});
