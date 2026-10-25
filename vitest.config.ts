import * as os from "node:os";
import * as path from "node:path";
import { defineConfig } from "vitest/config";

// Studio reads the user's own instruction file and skills from the home folder: tests get one of their own.
export default defineConfig({
  test: { env: { STUDIO_USER_HOME: path.join(os.tmpdir(), "studio-test-home") } },
});
