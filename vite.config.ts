import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

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
    // Agent worktrees live under .claude/worktrees and carry their own copies of every test.
    exclude: [...configDefaults.exclude, ".claude/**"],
  },
});
