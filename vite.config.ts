import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Loopback only: the control UI must not be reachable from other hosts.
export default defineConfig({
  plugins: [react()],
  server: { host: "127.0.0.1", port: 5317, strictPort: true },
  preview: { host: "127.0.0.1", port: 5318 },
});
