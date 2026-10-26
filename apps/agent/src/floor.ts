/**
 * The oldest ue-mcp Studio runs on (package.json ueMcpExtension.ueMcp). A
 * ue-mcp that checks this refuses to load Studio; an older one loads it, and
 * Studio refuses itself: it registers only GET /refusal, which says why.
 */
import type { DaemonExtensionApi } from "ue-mcp/daemon";
import { isNewer, type StudioRefusal } from "@ue-mcp-studio/shared";

/** Why Studio cannot run on this ue-mcp, or null when it can. UE_MCP_EXTENSION_FLOOR=warn runs it anyway, as ue-mcp does. */
export function floorRefusal(floor: string | undefined, daemonVersion: string, env: NodeJS.ProcessEnv = process.env): StudioRefusal | null {
  if (!floor || !isNewer(floor, daemonVersion)) return null;
  if (env.UE_MCP_EXTENSION_FLOOR === "warn") return null;
  return { needs: floor, have: daemonVersion };
}

/** Studio on a ue-mcp below its floor: the refusal route and nothing else. */
export function registerRefusal(api: DaemonExtensionApi, refusal: StudioRefusal): void {
  api.log.warn(`Studio needs ue-mcp ${refusal.needs} or later; this is ${refusal.have}. Not started.`);
  api.route("GET", "/refusal", () => ({ body: refusal }));
}
