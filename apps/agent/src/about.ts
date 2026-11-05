import * as os from "node:os";
import type { DaemonExtensionApi } from "ue-mcp/daemon";
import { STUDIO_AGENT_API_VERSION, STUDIO_UI_API_VERSION } from "@ue-mcp-studio/extension-api";
import type { StudioAbout } from "@ue-mcp-studio/shared";
import { projectName } from "./window.js";

/** The name the relay lists this project under, and paired devices show: "<project> on <computer>". */
export const relayName = (projectDir: string): string => `${projectName(projectDir)} on ${os.hostname()}`;

/** GET /v1/ext/studio/about: the versions in play, including the extension API this Studio offers. */
export function studioAbout(agentVersion: string, api: Pick<DaemonExtensionApi, "version" | "projectDir" | "ui">): StudioAbout {
  return {
    agentVersion,
    daemonVersion: api.version,
    uiVersion: api.ui.active()?.version ?? null,
    projectDir: api.projectDir,
    name: relayName(api.projectDir),
    extensionApi: { agent: STUDIO_AGENT_API_VERSION, ui: STUDIO_UI_API_VERSION },
  };
}
