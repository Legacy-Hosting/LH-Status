import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5175,
    proxy: {
      "/api": "http://127.0.0.1:8082",
      "/health": "http://127.0.0.1:8082",
    },
  },
});
