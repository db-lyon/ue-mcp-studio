// STUB: owned by composer
import type { Pill, PillActions } from "./pill-providers";

/** The pill row above the composer; nothing while there are no pills. */
export function PillRow({ pills }: { pills: Pill[]; actions: PillActions; onClear: () => void }) {
  if (pills.length === 0) return null;
  return null;
}
