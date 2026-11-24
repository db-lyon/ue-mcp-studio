/**
 * The ways into the full live viewer both clients offer, and the rules for
 * when they show: the Live button in the top bar while Play In Editor runs,
 * and the Viewport button on a playtest card in the chat. One rule for when
 * each shows, and their words, so every place agrees.
 */
import type { ViewportStatus } from "@ue-mcp-studio/shared";

/**
 * Whether this client offers the live viewport at all. It is for a paired
 * browser and the Android app, away from the computer; Studio on the computer
 * itself (the editor's panel, Studio's window, a browser there) shows none,
 * since the editor is in front of the person. The phone is always remote.
 */
export function viewportAllowed(remote: boolean): boolean {
  return remote;
}

/**
 * Play In Editor runs, as far as Studio knows: GET /viewport's `pie`, with a
 * pie.* event applied (withPie), or a streamer up for Play In Editor. A
 * stream only armed for the next PIE does not count: nothing would show yet.
 * The one rule every client reads.
 */
export function pieRunning(s: ViewportStatus | null | undefined): boolean {
  return s?.pie === true || (s?.streamer === true && s.source !== "level_viewport");
}

/** The playtest card's button's label. */
export const VIEWPORT_BUTTON = "Viewport";
/** Its tooltip or accessibility hint. */
export const VIEWPORT_BUTTON_HINT = "Watch Play In Editor live";

/**
 * Whether a playtest card's Viewport button shows: its run plays now, or
 * Play In Editor runs anyway (started by hand or by the agent).
 */
export function showsViewportButton(o: { relevant: boolean; status: ViewportStatus | null | undefined }): boolean {
  return o.relevant || pieRunning(o.status);
}

/** The top bar's button while Play In Editor runs. */
export const LIVE_BUTTON = "Live";

/** The Live button's tooltip and accessible name: the check that runs, when the client knows it. */
export function liveButtonHint(check?: string | null): string {
  return check ? `Watch ${check} live in Play In Editor` : VIEWPORT_BUTTON_HINT;
}
