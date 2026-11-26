/**
 * The Arrangement and the Clips window it pops out, kept in step over a
 * BroadcastChannel: both are pages of the same origin in Studio's window. The
 * Arrangement says which clip is picked and where an added clip goes; the
 * window picks, adds and opens clips through it, so every edit still goes
 * through the Arrangement's own edit path and the daemon's answer.
 */
import type { InstanceKind } from "@ue-mcp-studio/shared";

/** The hash the Clips window opens at; main.tsx draws it instead of Studio. */
export const CLIPS_WINDOW_HASH = "#/clips-window";
const CHANNEL = "ue-mcp-studio.arrangement";

export interface ClipRef {
  kind: InstanceKind;
  target: string;
  name?: string;
}

export type SyncMessage =
  /** The Arrangement's side: the clip picked, where Add puts a clip, and a changed set (the window reads Clips again). */
  | { t: "state"; picked: ClipRef | null; addsTo: string; version: number }
  /** The Arrangement asks a window that is open to say so, or to close. */
  | { t: "ping" }
  | { t: "close" }
  /** The window's side. */
  | { t: "hello" }
  | { t: "bye" }
  | { t: "pick"; clip: ClipRef | null }
  | { t: "add"; clip: ClipRef }
  | { t: "open"; clip: ClipRef };

/** The channel, or null where the page has none (jsdom without it, a very old engine). */
export function openSync(onMessage: (m: SyncMessage) => void): { post: (m: SyncMessage) => void; close: () => void } | null {
  if (typeof BroadcastChannel === "undefined") return null;
  const ch = new BroadcastChannel(CHANNEL);
  ch.onmessage = (e: MessageEvent) => {
    const m = e.data as SyncMessage | null;
    if (m && typeof m === "object" && typeof m.t === "string") onMessage(m);
  };
  return {
    post: (m) => {
      try {
        ch.postMessage(m);
      } catch {
        // Closed while the page unloads.
      }
    },
    close: () => ch.close(),
  };
}

/**
 * Whether the page runs in a host that opens a pop-out as a window of its own
 * with the page's sign-in: Studio's window does. The editor's panel and a
 * plain browser keep Clips in the drawer.
 */
export const canPopOut = (): boolean => !!window.ue?.studioWindow;

/** Open the Clips window, or bring it forward; null when the host refused. */
export function popOutClips(): Window | null {
  const url = `${location.pathname}${location.search}${CLIPS_WINDOW_HASH}`;
  return window.open(url, "ue-mcp-studio-clips", "popup,width=380,height=760");
}
