/**
 * The Viewport button both clients put beside what plays in the editor (a
 * run in the Playtest Hub, a playtest card in the chat): it opens the full
 * live viewer. One rule for when it shows, and its words, so every place
 * agrees.
 */
import type { ViewportStatus } from "@ue-mcp-studio/shared";

/** The button's label. */
export const VIEWPORT_BUTTON = "Viewport";
/** Its tooltip or accessibility hint. */
export const VIEWPORT_BUTTON_HINT = "Watch Play In Editor live";

/**
 * Whether the button shows: the thing beside it is involved in a run playing
 * now, or Play In Editor runs anyway (started by hand or by the agent). A
 * stream only armed for the next PIE does not count: nothing would show yet.
 */
export function showsViewportButton(o: { relevant: boolean; status: ViewportStatus | null | undefined }): boolean {
  return o.relevant || o.status?.pie === true || o.status?.streamer === true;
}
