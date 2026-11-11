/**
 * The UE-MCP app's page, built apart from Studio's into dist-app/: the window
 * build compiles it into UE-MCP.exe, so it never ships in the signed /ui/
 * bundle a daemon serves.
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/",
  plugins: [react()],
  build: {
    target: "chrome100",
    outDir: "dist-app",
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: { input: "app.html" },
  },
});
