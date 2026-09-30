// Production-style local run: serve the built UI and API from one loopback port.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

if (!existsSync("dist/index.html")) {
  console.error("The UI is not built. Run `npm run build` first (npm start does this for you).");
  process.exit(1);
}
// One process (not the tsx CLI wrapper), so stopping or killing it cannot leave an orphaned service.
const child = spawn(process.execPath, ["--import", "tsx", "server/main.ts"], {
  stdio: "inherit",
  env: { ...process.env, ORCHESTRATION_STATIC: "dist" },
});
const forward = (sig) => child.kill(sig);
process.on("SIGINT", forward);
process.on("SIGTERM", forward);
child.on("exit", (code) => process.exit(code ?? 0));
