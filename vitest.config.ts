import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

// Studio reads the user's own instruction file and skills from the home folder: tests get one of their own.
export default defineConfig({
  // pi-claude-code ships as TypeScript source; the durable harness imports it by this name (scripts/bundle-agent.mjs does the same).
  resolve: { alias: { "studio-pi-claude-code": path.join(root, "node_modules", "@earendil-works", "pi-claude-code", "src", "provider.ts") } },
  test: {
    env: { STUDIO_USER_HOME: path.join(os.tmpdir(), "studio-test-home") },
    server: { deps: { inline: [/pi-claude-code/] } },
  },
});
