/** A pairing code's clock: shared by the web client's and the app's /remote reply. */
import type { RemotePairing } from "@ue-mcp-studio/shared";

/** Whether a pairing code has run out, by its expiry. A code without one never reads as expired. */
export function pairingExpired(p: RemotePairing, now: number): boolean {
  return !!p.expiresAt && Date.parse(p.expiresAt) <= now;
}

/** How long a code has left, as "9:41". */
export function timeLeft(p: RemotePairing, now: number): string | null {
  if (!p.expiresAt) return null;
  const s = Math.max(0, Math.ceil((Date.parse(p.expiresAt) - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
