/** A pairing code's clock: shared by the web client's and the app's /remote reply. */
import type { RemotePairing } from "@ue-mcp-studio/shared";

/** Whether a pairing code has run out, by its expiry. A code without one never reads as expired. */
export function pairingExpired(p: RemotePairing, now: number): boolean {
  return !!p.expiresAt && Date.parse(p.expiresAt) <= now;
}

/** The lock screen's Enter, greyed until the PIN is long enough, says why. */
export const PIN_TOO_SHORT = "At least 4 digits.";
/** Where a forgotten PIN is cleared: only on the computer, which unpairs every device with it. */
export const PIN_FORGOT_WHERE = "Forgot the PIN? In Studio on the computer, open Settings > Remote control and choose Forgot PIN. It unpairs every device.";
/** A device removed for wrong PINs, in a browser: pairing again needs a fresh link from the computer. */
export const PAIR_AGAIN_STEPS = "To pair this browser again, choose New code under Settings > Remote control in Studio on the computer, then open its link here or paste it below.";
export const PAIR_LINK_INVALID = "That is not a pairing link from this relay. Copy the link under the new code in Studio on the computer.";

/**
 * A pasted pairing link, when it is one for this relay (`origin`): its /pair
 * page with the code, the computer's key and the secret in the fragment. Null
 * for anything else, so a paste never sends the browser somewhere else.
 */
export function pairingLinkOn(text: string, origin: string): string | null {
  // Matched by hand: React Native's URL is not a full one.
  const m = /^(https?:\/\/[^/?#\s]+)\/pair\/?#([^.#\s]+)\.([^.#\s]+)\.([^.#\s]+)$/i.exec(text.trim());
  if (!m || m[1].toLowerCase() !== origin.replace(/\/+$/, "").toLowerCase()) return null;
  return `${origin.replace(/\/+$/, "")}/pair#${m[2]}.${m[3]}.${m[4]}`;
}

/** How long a code has left, as "9:41". */
export function timeLeft(p: RemotePairing, now: number): string | null {
  if (!p.expiresAt) return null;
  const s = Math.max(0, Math.ceil((Date.parse(p.expiresAt) - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
