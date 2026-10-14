/**
 * Studio's own window is a separate exe, and an update replaces only the page
 * inside it. When the window is an older build than the Studio it shows, ask
 * the daemon to open the window again: the new build takes over from the old
 * one (apps/window, claimInstance). Once per page, so a launch that cannot
 * replace it does not repeat.
 */
import { api } from "./api";
import { native } from "./native";

const TRIED = "studio.windowReplace";
let started = false;

export async function replaceStaleWindow(): Promise<boolean> {
  if (started || !window.ue?.studioWindow || !native().getstatus) return false;
  started = true;
  try {
    if (sessionStorage.getItem(TRIED)) return false;
  } catch {
    // No storage: still try, the old page goes away with the old window.
  }
  const status = JSON.parse((await native().getstatus!()) || "{}") as { windowVersion?: string };
  const { agentVersion } = await api.about();
  if (!status.windowVersion || !agentVersion || status.windowVersion === agentVersion) return false;
  try {
    sessionStorage.setItem(TRIED, agentVersion);
  } catch {
    // As above.
  }
  await api.openWindow();
  return true;
}
