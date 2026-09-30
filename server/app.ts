// The local Orchestration service (loaded by main.ts after the Node version check).
//
//   ORCHESTRATION_PORT   API/UI port on 127.0.0.1 (default 5319)
//   ORCHESTRATION_DB     SQLite path (default ~/.orchestration/orchestration.db)
//   ORCHESTRATION_STATIC directory of the built UI to serve (npm start sets it to dist)
//   ORCHESTRATION_DEV_UI extra host:port allowed as Host/Origin (npm run dev sets the Vite address)

import { homedir } from "node:os";
import { join } from "node:path";
import { FakeRuntime } from "./fakeRuntime";
import { createHttpServer } from "./http";
import { Scheduler } from "./scheduler";
import { Store } from "./store";

const port = Number(process.env.ORCHESTRATION_PORT ?? 5319);
const dbPath = process.env.ORCHESTRATION_DB ?? join(homedir(), ".orchestration", "orchestration.db");
const staticDir = process.env.ORCHESTRATION_STATIC;
const devUi = process.env.ORCHESTRATION_DEV_UI;
const log = (msg: string) => console.log(`[orchestration] ${msg}`);

let store: Store;
try {
  store = new Store(dbPath);
} catch (e) {
  log(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
const runtime = new FakeRuntime();
const scheduler = new Scheduler(store, runtime, { log });
const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
if (devUi) allowedHosts.push(devUi, devUi.replace("127.0.0.1", "localhost"));

const server = createHttpServer({ store, scheduler, runtime, startedAt: new Date().toISOString(), allowedHosts, staticDir, log });

server.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EADDRINUSE") log(`Port ${port} is already in use. Another Orchestration service may be running; stop it or set ORCHESTRATION_PORT.`);
  else log(`Server error: ${e.message}`);
  scheduler.stop(); // releases the lease if it was taken
  store.close();
  process.exit(1);
});

server.listen(port, "127.0.0.1", () => {
  log(`Service listening on http://127.0.0.1:${port} (loopback only)`);
  log(`Database: ${dbPath}`);
  log("Runtime: fake (simulated). No agents run in this milestone.");
  if (staticDir) log(`Open http://127.0.0.1:${port}`);
  scheduler.start();
});

let stopping = false;
function shutdown(reason: string) {
  if (stopping) return;
  stopping = true;
  log(`${reason}: stopping scheduler and closing the database`);
  try {
    scheduler.stop();
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
