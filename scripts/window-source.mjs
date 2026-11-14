/**
 * The Linux window's source, as the extension carries it in window-src/. A release
 * is built on Windows and carries no Linux binary, so the agent builds studio-window
 * from these files on the user's machine (apps/agent/src/linux-window-build.ts): on
 * first install, and after every self-update, for that version. The layout under
 * src/ is the repository's, so main.cpp's "../json.h" includes resolve as they do here.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** Every file the Linux window compiles, relative to apps/window. */
export const WINDOW_SOURCE = [
  "src/linux/main.cpp",
  "src/connection.h",
  "src/json.h",
  "src/location.h",
  "src/toast.h",
  "src/update.h",
  "src/job.h",
];

/** Copy the Linux window's source from the repository into `<ext>/window-src`. */
export function copyWindowSource(root, ext) {
  const from = path.join(root, "apps", "window");
  const to = path.join(ext, "window-src");
  for (const file of WINDOW_SOURCE) {
    const src = path.join(from, file);
    if (!fs.existsSync(src)) throw new Error(`the Linux window's source is missing ${file}`);
    fs.mkdirSync(path.dirname(path.join(to, file)), { recursive: true });
    fs.copyFileSync(src, path.join(to, file));
  }
}
