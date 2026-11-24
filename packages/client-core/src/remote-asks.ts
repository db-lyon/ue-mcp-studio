/**
 * What a paired device says and offers where a change is refused to it: an
 * update, a plugin change, a model key or sign-in. The change itself stays on
 * the computer; the device sends a request (POST /remote-asks) and the
 * computer shows it with a way to open the screen that makes the change.
 */
import type { RemoteAskKind } from "@ue-mcp-studio/shared";
import type { SettingsSection } from "./settings-status.js";

/** The button on a paired device. */
export const ASK_BUTTON: Record<RemoteAskKind, string> = {
  update: "Ask the computer to update",
  plugins: "Ask the computer to change plugins",
  models: "Ask the computer to set this up",
};

/** After the request went out. */
export const ASK_SENT = "Asked. It shows on the computer, where the change is made.";

/** When the request did not reach the computer. */
export const askFailed = (reason: string): string => `The computer was not asked: ${reason}`;

/** The notice on the computer, naming the project the device is paired with. */
export const askNotice = (what: RemoteAskKind, project: string): string =>
  ({
    update: `A paired device asks you to update ${project}.`,
    plugins: `A paired device asks you to change the plugins of ${project}.`,
    models: `A paired device asks you to connect a model for ${project}.`,
  })[what];

/** The notice's button, and where in Studio it goes: a tab or a settings section. */
export const ASK_OPEN: Record<RemoteAskKind, { label: string; tab: "Settings"; section?: SettingsSection }> = {
  update: { label: "Open Updates", tab: "Settings", section: "general" },
  plugins: { label: "Open Plugins", tab: "Settings", section: "plugins" },
  models: { label: "Open Models", tab: "Settings", section: "models" },
};
