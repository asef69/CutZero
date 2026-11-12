import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const backend = process.env.CUTZERO_BACKEND ?? "http://127.0.0.1:8000";

export default defineConfig({
  // A static host under a sub-path (GitHub Pages serves /CutZero/) sets VITE_BASE at build time.
  base: process.env.VITE_BASE ?? "/",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": backend,
      "/ws": { target: backend.replace(/^http/, "ws"), ws: true },
    },
  },
  worker: { format: "es" },
});
