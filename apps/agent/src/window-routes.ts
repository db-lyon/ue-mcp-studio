/**
 * Studio's window and what the editor is busy with, under /v1/ext/studio:
 *
 *   POST /window      open Studio's own window for this project (WindowRequest), or focus it
 *   GET  /busy        the editor calls in flight (BusyState)
 *   POST /busy/stop   stop the turns waiting on them
 *
 * Changes to the busy state arrive on the event stream as studio.busy.changed.
 */
import * as os from "node:os";
import * as path from "node:path";
import { discoveryPath, readDiscovery, type DaemonExtensionApi } from "ue-mcp/daemon";
import type { BusyTracker } from "./busy.js";
import { openInSystemBrowser, openWindow, parseWindowRequest, spawnDetached, type WindowHost } from "./window.js";

export function registerWindowRoutes(
  api: Pick<DaemonExtensionApi, "route">,
  o: { busy: BusyTracker; stopSession: (sessionId: string) => void; window: () => WindowHost },
): void {
  api.route("GET", "/busy", () => ({ body: o.busy.state() }));
  api.route("POST", "/busy/stop", () => ({ body: { stopped: o.busy.stop(o.stopSession) } }));
  api.route("POST", "/window", (req) => {
    const parsed = parseWindowRequest(req.body);
    if (typeof parsed === "string") return { status: 400, body: { error: parsed } };
    const launch = openWindow(o.window(), parsed);
    return { status: launch.opened === "none" ? 503 : 200, body: launch };
  });
}

/** The window host for the daemon this extension runs in. */
export function daemonWindowHost(api: DaemonExtensionApi, packageDir: string, version: string): WindowHost {
  return {
    platform: process.platform,
    packageDir,
    runDir: path.join(os.homedir(), ".ue-mcp", "studio", "window"),
    version,
    projectDir: api.projectDir,
    discoveryFile: discoveryPath(api.projectDir),
    stateFile: path.join(api.dataDir, "window-placement.txt"),
    nodePath: process.execPath,
    ueMcpPackage: `ue-mcp@${api.version}`,
    editors: () => api.editors(),
    uiUrl: () => {
      const d = readDiscovery(api.projectDir);
      return d ? `http://127.0.0.1:${d.port}/ui/?token=${d.token}` : null;
    },
    spawn: spawnDetached,
    openUrl: openInSystemBrowser,
  };
}
