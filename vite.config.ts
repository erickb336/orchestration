import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

/** Tests that start a real Chrome, a Docker recording or a capture of evidence: slow, and heavy on CPU and memory (Colima has 2 CPUs and 2 GB). */
const HEAVY_TESTS = [
  "server/environment/environment.docker.test.ts",
  "server/http.browser.test.ts",
  "server/studio/container.test.ts",
  "server/studio/escape.test.ts",
  "server/studio/evidence.container.test.ts",
  "server/studio/evidence.scheduler.test.ts",
  "server/studio/media.test.ts",
  "server/studio/runs.test.ts",
  "server/studio/shots.test.ts",
  "server/studio/terminal.test.ts",
];

// Loopback only: the control UI must not be reachable from other hosts.
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5317,
    strictPort: true,
    // No CORS: other local pages must not read the proxied API.
    cors: false,
    // The UI talks to the local service (npm run dev starts both).
    proxy: { "/api": { target: `http://127.0.0.1:${process.env.ORCHESTRATION_PORT ?? 5319}` } },
  },
  preview: { host: "127.0.0.1", port: 5318 },
  test: {
    // Agent worktrees live under .claude/worktrees and carry their own copies of every test; evidence/ holds the trials' throwaway projects.
    exclude: [...configDefaults.exclude, ".claude/**", "evidence/**"],
    projects: [
      // Half the cores: many unit tests start git and service processes of their own, and one worker per core
      // oversubscribed the machine (load 14 on 10 cores) until timing tests missed their 5 s limit.
      { extends: true, test: { name: "unit", exclude: [...configDefaults.exclude, ".claude/**", "evidence/**", ...HEAVY_TESTS], maxWorkers: "50%" } },
      // After the unit tests, one file at a time, so they never starve the unit tests' 5 s limits (or each other).
      { extends: true, test: { name: "heavy", include: HEAVY_TESTS, fileParallelism: false, sequence: { groupOrder: 1 } } },
    ],
  },
});
