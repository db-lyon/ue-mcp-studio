import type { DaemonExtensionApi } from "ue-mcp/daemon";
import { STUDIO_AGENT_API_VERSION, STUDIO_UI_API_VERSION } from "@ue-mcp-studio/extension-api";
import type { StudioAbout } from "@ue-mcp-studio/shared";

/** GET /v1/ext/studio/about: the versions in play, including the extension API this Studio offers. */
export function studioAbout(agentVersion: string, api: Pick<DaemonExtensionApi, "version" | "projectDir" | "ui">): StudioAbout {
  return {
    agentVersion,
    daemonVersion: api.version,
    uiVersion: api.ui.active()?.version ?? null,
    projectDir: api.projectDir,
    extensionApi: { agent: STUDIO_AGENT_API_VERSION, ui: STUDIO_UI_API_VERSION },
  };
}
