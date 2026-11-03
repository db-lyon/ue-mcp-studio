import type { StudioEvent } from "@ue-mcp-studio/extension-api";

/** The daemon feed Studio already reads, passed on to contributions so none opens a stream of its own. */
const listeners = new Set<(e: StudioEvent) => void>();

export function publishEvent(e: StudioEvent): void {
  for (const l of [...listeners]) {
    try {
      l(e);
    } catch (err) {
      console.error("An extension's event listener failed", err);
    }
  }
}

export function subscribeEvent(listener: (e: StudioEvent) => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
