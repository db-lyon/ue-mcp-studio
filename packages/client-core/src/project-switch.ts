/**
 * Switching project on a paired device. The drawer's head names the open
 * project as the relay lists it ("Vale on NIMBA1") with a control that goes to
 * every project on every paired computer: the relay's list in a paired browser,
 * the app's Projects screen on a phone. Studio on the computer is one project
 * and draws none of it.
 */

export const SWITCH_PROJECT = "Switch project";
export const SWITCH_PROJECT_LABEL = "Switch project: every project on your paired computers";

/** The relay's project list, from a paired browser's page on the relay's origin. */
export function projectListUrl(relayOrigin: string): string {
  return `${relayOrigin.replace(/\/+$/, "")}/?list`;
}
