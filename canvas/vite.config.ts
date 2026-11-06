import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  base: "/canvas/",
  build: { outDir: "../frontend/canvas", emptyOutDir: true },
  server: {
    proxy: {
      "/workspace-assets": "http://127.0.0.1:8080",
      "/api": "http://127.0.0.1:8080",
      "/gallery": "http://127.0.0.1:8080",
    },
  },
});
