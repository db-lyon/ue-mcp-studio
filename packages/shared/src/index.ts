/**
 * Types the Studio agent and UI share. The daemon's own types come from
 * `ue-mcp/daemon`; these are Studio's routes on top of it.
 */

/** Name the agent registers its routes under: /v1/ext/studio/... */
export const EXTENSION_NAME = "studio";

/** GET /v1/ext/studio/about */
export interface StudioAbout {
  agentVersion: string;
  daemonVersion: string;
  /** Version of the UI bundle the daemon is serving, or null. */
  uiVersion: string | null;
  projectDir: string;
}

/** GET and PUT /v1/ext/studio/config: ue-mcp.yml as text. */
export interface StudioConfigFile {
  path: string;
  exists: boolean;
  text: string;
}
export * from "./account.js";
