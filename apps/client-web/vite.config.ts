/**
 * Built to static files under /ui/, which is where the daemon serves them.
 *
 * `npm run dev` proxies /v1 to the daemon of STUDIO_PROJECT (a .uproject path)
 * and adds its bearer token, read from the daemon's discovery file, so the page
 * needs no login while developing. The Origin header is dropped on the way,
 * because the daemon refuses any origin but its own.
 */
import * as path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readLiveDiscovery } from "ue-mcp/daemon";

function daemonProxy() {
  const project = process.env.STUDIO_PROJECT;
  if (!project) return undefined;
  const d = readLiveDiscovery(path.dirname(path.resolve(project)));
  if (!d) {
    console.warn(`[studio] no daemon running for ${project}; start one with: npx ue-mcp daemon start "${project}"`);
    return undefined;
  }
  return {
    "/v1": {
      target: `http://127.0.0.1:${d.port}`,
      changeOrigin: true,
      headers: { authorization: `Bearer ${d.token}` },
      configure: (proxy: { on(e: string, f: (req: { removeHeader(n: string): void }) => void): void }) => {
        proxy.on("proxyReq", (req) => req.removeHeader("origin"));
      },
    },
  };
}

export default defineConfig({
  base: "/ui/",
  plugins: [react()],
  build: {
    // UE 5.7 and 5.8 ship Chromium 128; 5.4 to 5.6 are unverified, so stay conservative.
    target: "chrome90",
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
  },
  server: { proxy: daemonProxy() },
});
