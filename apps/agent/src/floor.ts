/**
 * The oldest ue-mcp Studio runs on (package.json ueMcpExtension.ueMcp). A
 * ue-mcp that checks this refuses to load Studio; an older one loads it, and
 * Studio refuses itself: it registers only GET /refusal, which says why, and
 * POST /refusal/update, which installs a ue-mcp that meets the floor.
 */
import type { DaemonExtensionApi } from "ue-mcp/daemon";
import { isNewer, type StudioRefusal } from "@ue-mcp-studio/shared";
import { Updater } from "./updates.js";

/** Why Studio cannot run on this ue-mcp, or null when it can. UE_MCP_EXTENSION_FLOOR=warn runs it anyway, as ue-mcp does. */
export function floorRefusal(floor: string | undefined, daemonVersion: string, env: NodeJS.ProcessEnv = process.env): StudioRefusal | null {
  if (!floor || !isNewer(floor, daemonVersion)) return null;
  if (env.UE_MCP_EXTENSION_FLOOR === "warn") return null;
  return { needs: floor, have: daemonVersion };
}

type Apply = (version: string) => Promise<{ ok: boolean; error?: string }>;

/**
 * Studio on a ue-mcp below its floor: the refusal routes and nothing else.
 * The update runs the target release's own CLI, never this daemon's apply,
 * which is the older ue-mcp's updater.
 */
export function registerRefusal(api: DaemonExtensionApi, refusal: StudioRefusal, apply: Apply = (v) => new Updater(api, "0.0.0").applyUeMcp(v)): void {
  api.log.warn(`Studio needs ue-mcp ${refusal.needs} or later; this is ${refusal.have}. Not started.`);
  api.route("GET", "/refusal", () => ({ body: refusal }));
  let running: Promise<{ ok: boolean; error?: string }> | null = null;
  api.route("POST", "/refusal/update", async (req) => {
    const version = String((req.body as { version?: unknown } | undefined)?.version ?? "");
    if (running) return { status: 409, body: { ok: false, error: "an update is already running" } };
    running = apply(version);
    try {
      const r = await running;
      return r.ok ? { body: { ok: true, version } } : { status: 500, body: { ok: false, error: r.error } };
    } finally {
      running = null;
    }
  });
}
