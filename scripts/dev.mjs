// Development: run the service (restarts on change) and the Vite UI together.
import { spawn } from "node:child_process";

const env = { ...process.env, ORCHESTRATION_DEV_UI: "127.0.0.1:5317" };
const run = (args) => spawn(process.execPath, args, { stdio: "inherit", env });
const children = [
  run(["node_modules/tsx/dist/cli.mjs", "watch", "--clear-screen=false", "server/main.ts"]),
  run(["node_modules/vite/bin/vite.js"]),
];
const stop = () => {
  for (const c of children) c.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
// If either process ends, stop both so a half-running dev setup is never mistaken for a working one.
for (const c of children) c.on("exit", stop);
