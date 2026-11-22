/**
 * The live viewport: Play In Editor (or the level viewport) watched live from
 * the phone or a paired browser. The editor streams with Unreal's Pixel
 * Streaming 2 plugin, started and stopped through ue-mcp's stream_start,
 * stream_stop and stream_status actions. The agent runs the signalling server
 * the editor's streamer connects to on localhost, and a viewer reaches it
 * through Studio's routes (/v1/ext/studio/viewport/...): directly on the
 * computer, through the end-to-end sealed relay from a paired device. The
 * media itself goes peer to peer over WebRTC, so the relay carries only the
 * few kilobytes of SDP and ICE. A TURN server is the fallback for networks
 * where peer to peer fails; none is configured by default.
 *
 * Part of the Pro plan, enforced by the agent on every viewer route.
 */

/** What the editor streams: Play In Editor (armed until the next PIE starts when none runs), or the level editor's viewport. */
export type ViewportSource = "pie" | "level_viewport";
export const VIEWPORT_SOURCES: readonly ViewportSource[] = ["pie", "level_viewport"];

/** The plan id the live viewport needs. */
export const VIEWPORT_PLAN_ID = "pro";

/** An RTCIceServer, as both the editor's streamer and the viewer take it. */
export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/**
 * STUN only: enough on the computer's own network and behind many home
 * routers, not behind carrier-grade NAT (most mobile data) or a symmetric NAT,
 * which need a TURN relay. A TURN server goes in viewport.json in the agent's
 * data dir (iceServers) or UE_MCP_STUDIO_ICE_SERVERS.
 */
export const DEFAULT_ICE_SERVERS: readonly IceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

/**
 * Whether the account gets Studio's TURN relay server, which watching from
 * another network needs: "ok" (a live Pro plan), or why not. "signed-out" (no
 * ue-mcp account on the computer), "needs-pro" (signed in without Pro),
 * "unreachable" (the gateway did not answer, so the plan is unknown).
 * Watching itself is open to every account; the video then goes directly.
 */
export type ViewportAccess = "ok" | "signed-out" | "needs-pro" | "unreachable";

/**
 * What the editor can do: "ready", "no-editor" (no editor connected),
 * "no-actions" (this ue-mcp has no stream actions), "plugin-off" (Pixel
 * Streaming 2 is not enabled in the project), "plugin-restart" (enabled, and
 * the editor has not restarted since), "unavailable" (the engine cannot
 * stream; `detail` says why).
 */
export type ViewportEditorState = "ready" | "no-editor" | "no-actions" | "plugin-off" | "plugin-restart" | "unavailable";

/** stream_status as the editor answered it. */
export interface ViewportBridgeStatus {
  available: boolean;
  pluginEnabled: boolean;
  streaming: boolean;
  armed: boolean;
}

/** GET /v1/ext/studio/viewport. `?fresh=1` asks the gateway again instead of the cached plan. */
export interface ViewportStatus {
  access: ViewportAccess;
  editor: ViewportEditorState;
  /** The editor's stream_status, when it answered one. */
  bridge?: ViewportBridgeStatus;
  /** The editor's streamer is connected to Studio's signalling now. */
  streamer: boolean;
  /** What the stream shows while any viewer watches. */
  source: ViewportSource | null;
  viewers: number;
  /**
   * Play In Editor is running, as far as Studio knows: from the calls Studio
   * and other clients make, the editor's answer when it connects, and the
   * streamer coming and going. Answered for every account, Pro or not. Absent
   * from a Studio older than 0.1.42.
   */
  pie?: boolean;
  /** The editor's own words for "unavailable", or the error from the last call. */
  detail?: string;
}

/**
 * The event the agent publishes (as the daemon names it) when what GET
 * /viewport answers may have changed: PIE started or stopped, a viewer came or
 * went, the streamer connected or left. A client asks the status again then;
 * nothing polls.
 */
export const VIEWPORT_CHANGED_EVENT = "studio.viewport.changed";

/**
 * What a daemon event says about Play In Editor: running (true), stopped
 * (false), or nothing (null). ue-mcp's daemon (extension feature "events.pie")
 * publishes pie.started, pie.paused, pie.resumed and pie.ended whenever a
 * session changes, including one the user started with the editor's own Play
 * button, and the current state each time an editor attaches. An older daemon
 * never sends them.
 */
export function pieFromEvent(type: string): boolean | null {
  if (type === "pie.started" || type === "pie.paused" || type === "pie.resumed") return true;
  if (type === "pie.ended") return false;
  return null;
}

/** POST /v1/ext/studio/viewport/viewers. */
export interface ViewportJoinRequest {
  source?: ViewportSource;
}

/** The answer to a join: the viewer's id for the other routes, and the ICE servers its peer connection uses. */
export interface ViewportJoin {
  viewer: string;
  iceServers: IceServer[];
  status: ViewportStatus;
}

/** A join or a signal refused: the reason and, for a gate, the status that says what to do. */
export interface ViewportRefusal {
  error: string;
  status?: ViewportStatus;
}

/** An ICE candidate as RTCIceCandidate.toJSON() gives it. */
export interface IceCandidateInit {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

/**
 * What the agent passes to a viewer: the streamer's offer and candidates, the
 * streamer coming or going (PIE starting and stopping), and the end of the
 * viewer (stopped from the editor, or the plan lapsed).
 */
export type ViewerSignal =
  | { type: "offer"; sdp: string }
  | { type: "iceCandidate"; candidate: IceCandidateInit }
  | { type: "streamer"; connected: boolean }
  | { type: "ended"; reason: string };

/** What a viewer sends: its answer and candidates. */
export type ViewerMessage = { type: "answer"; sdp: string } | { type: "iceCandidate"; candidate: IceCandidateInit };

/**
 * GET /v1/ext/studio/viewport/viewers/:id/signals?after=<seq>: the signals
 * after `after`, held up to VIEWPORT_POLL_WAIT_MS while there are none. `next`
 * is the `after` for the next poll.
 */
export interface ViewerSignals {
  signals: ViewerSignal[];
  next: number;
}

/** How long a signals poll waits for something to say. */
export const VIEWPORT_POLL_WAIT_MS = 15_000;
/** A viewer that has not polled or signalled for this long is gone. */
export const VIEWPORT_VIEWER_TTL_MS = 40_000;

/** Whether a body is a message a viewer may send. */
export function isViewerMessage(v: unknown): v is ViewerMessage {
  if (!v || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  if (m.type === "answer") return typeof m.sdp === "string" && m.sdp.length > 0 && m.sdp.length < 64_000;
  if (m.type === "iceCandidate") {
    const c = m.candidate as Record<string, unknown> | null | undefined;
    return !!c && typeof c === "object" && typeof c.candidate === "string" && c.candidate.length < 2_000;
  }
  return false;
}

/** ICE servers from configuration: an array of RTCIceServer-shaped objects; anything else is dropped. */
export function iceServersOf(v: unknown): IceServer[] {
  if (!Array.isArray(v)) return [];
  const out: IceServer[] = [];
  for (const s of v) {
    if (!s || typeof s !== "object") continue;
    const r = s as Record<string, unknown>;
    const urls = typeof r.urls === "string" ? r.urls : Array.isArray(r.urls) && r.urls.every((u) => typeof u === "string") ? (r.urls as string[]) : null;
    if (!urls || (Array.isArray(urls) && urls.length === 0)) continue;
    if (![urls].flat().every((u) => /^(stun|stuns|turn|turns):/i.test(u))) continue;
    out.push({ urls, ...(typeof r.username === "string" ? { username: r.username } : {}), ...(typeof r.credential === "string" ? { credential: r.credential } : {}) });
  }
  return out;
}
