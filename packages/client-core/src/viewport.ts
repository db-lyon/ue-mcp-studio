/**
 * The live viewport as both clients run it: the routes, the viewer session
 * (join, long-poll the streamer's signals, answer its offer on a WebRTC peer
 * connection, rejoin when the computer forgets the viewer), and what the
 * panel says in each state with its way forward. The clients draw the video
 * (a <video> on the web, an RTCView on the phone) and pass in their
 * RTCPeerConnection; nothing here touches the DOM or React Native.
 */
import {
  PLANS_SITE,
  PRO_PLAN_OFFERED,
  VIEWPORT_CHANGED_EVENT,
  pieFromEvent,
  type IceServer,
  type ViewerMessage,
  type ViewerSignal,
  type ViewerSignals,
  type ViewportAccess,
  type ViewportJoin,
  type ViewportSource,
  type ViewportStatus,
} from "@ue-mcp-studio/shared";
import { requestJson, type Transport } from "./transport.js";
import { pieRunning } from "./viewport-open.js";

/** The HTTP status of a refused call: HttpError here, the web client's ApiError there; both carry status and body. */
const statusOf = (e: unknown): number | null => (e && typeof e === "object" && typeof (e as { status?: unknown }).status === "number" ? (e as { status: number }).status : null);
/** The ViewportStatus a refusal carried, or null. */
const refusalStatus = (e: unknown): ViewportStatus | null => {
  const body = e && typeof e === "object" ? (e as { body?: unknown }).body : undefined;
  const s = body && typeof body === "object" ? (body as { status?: unknown }).status : undefined;
  return s && typeof s === "object" ? (s as ViewportStatus) : null;
};

const V = "/v1/ext/studio/viewport";
const enc = encodeURIComponent;

/** The viewport routes over a Transport. */
export function viewportApi(t: Transport) {
  return {
    viewport: (fresh = false) => requestJson<ViewportStatus>(t, "GET", `${V}${fresh ? "?fresh=1" : ""}`),
    joinViewport: (source: ViewportSource) => requestJson<ViewportJoin>(t, "POST", `${V}/viewers`, { json: { source } }),
    viewportSignals: (viewer: string, after: number, signal?: AbortSignal) =>
      requestJson<ViewerSignals>(t, "GET", `${V}/viewers/${enc(viewer)}/signals?after=${after}`, signal ? { signal } : {}),
    sendViewportSignal: (viewer: string, message: ViewerMessage) => requestJson<unknown>(t, "POST", `${V}/viewers/${enc(viewer)}/signals`, { json: { message } }),
    leaveViewport: (viewer: string) => requestJson<unknown>(t, "DELETE", `${V}/viewers/${enc(viewer)}`),
    enableStreamPlugin: () => requestJson<ViewportStatus>(t, "POST", `${V}/plugin`),
  };
}

export type ViewportApi = ReturnType<typeof viewportApi>;

/** The routes a session needs; the web client passes its own fetch-based ones. */
export type ViewportSessionApi = Pick<ViewportApi, "joinViewport" | "viewportSignals" | "sendViewportSignal" | "leaveViewport">;

/** The parts of RTCPeerConnection a viewer uses, the same in browsers and react-native-webrtc. */
export interface PeerLike {
  setRemoteDescription(d: { type: "offer"; sdp: string }): Promise<void>;
  createAnswer(): Promise<{ type?: string; sdp?: string }>;
  setLocalDescription(d: { type?: string; sdp?: string }): Promise<void>;
  addIceCandidate(c: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null }): Promise<void>;
  addEventListener(type: string, listener: (e: any) => void): void;
  connectionState?: string;
  iceConnectionState?: string;
  /** The stats report (a Map in both), read to see whether video frames arrive; optional for stand-ins. */
  getStats?(): Promise<{ forEach(fn: (s: any) => void): void }>;
  close(): void;
}

export type PeerFactory = (config: { iceServers: IceServer[] }) => PeerLike;

/**
 * Where a viewer is: joining, waiting for the streamer (no PIE yet),
 * connecting to it, live, refused (the join was turned down: `status` says
 * why), ended (the editor or the computer ended it), or failed.
 */
export type ViewerPhase =
  | { phase: "joining" }
  | { phase: "waiting" }
  | { phase: "connecting" }
  | { phase: "live"; stream: unknown }
  | { phase: "refused"; error: string; status: ViewportStatus | null }
  | { phase: "ended"; reason: string }
  /** `needsPro`: a direct connection failed, and the relay server that would get through is Pro's. */
  | { phase: "failed"; error: string; needsPro?: boolean };

export interface ViewportSessionOptions {
  api: ViewportSessionApi;
  peer: PeerFactory;
  source: ViewportSource;
  onPhase: (p: ViewerPhase) => void;
  /** Wait between failed polls; tests shorten it. */
  retryMs?: number;
  /** How long the peer connection may take to connect once the answer is delivered; tests shorten it. */
  connectMs?: number;
  /** How long a connected peer may go without decoding a video frame; tests shorten it. */
  framesMs?: number;
}

/** Polls in a row that may fail before the viewer says it lost the computer. */
const POLL_FAILURES = 4;
/** Tries at delivering the answer, which a dropped request must not lose. */
const ANSWER_TRIES = 3;
const CONNECT_MS = 20_000;
const FRAMES_MS = 12_000;
const FRAMES_CHECK_MS = 1_000;

/**
 * A request this client cut short: its own stop, or the transport's head or
 * idle deadline. The message is the runtime's ("signal is aborted without
 * reason" on React Native and Chromium), never something to show.
 */
export function isAbort(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const { name, message } = e as { name?: unknown; message?: unknown };
  return name === "AbortError" || (typeof message === "string" && /\babort(ed)?\b/i.test(message));
}

/** What the panel says for a failed request: its own message, or for one cut short, that the computer stopped answering. */
const failureText = (e: unknown): string => (isAbort(e) ? LOST_COMPUTER : e instanceof Error ? e.message : String(e));

type OutCandidate = { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null };

/**
 * One viewer, from join to stop. The streamer offers; the viewer answers. A
 * new offer (PIE restarted) replaces the peer connection; the streamer going
 * back to waiting closes it.
 */
export class ViewportSession {
  private viewer: string | null = null;
  private iceServers: IceServer[] = [];
  /** The account's standing as the join reported it: "ok" is Pro, which the relay server needs. */
  private access: ViewportAccess | undefined;
  private pc: PeerLike | null = null;
  private stopped = false;
  private poll: AbortController | null = null;
  private phase: ViewerPhase["phase"] = "joining";
  /** The current peer's deadlines (connect, first frame), cleared when it closes. */
  private timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(private readonly o: ViewportSessionOptions) {}

  start(): void {
    void this.run();
  }

  /** Leave: the computer stops the stream when this was the last viewer. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.poll?.abort();
    this.closePeer();
    if (this.viewer) void this.o.api.leaveViewport(this.viewer).catch(() => undefined);
  }

  private set(p: ViewerPhase): void {
    if (this.stopped) return;
    this.phase = p.phase;
    this.o.onPhase(p);
  }

  private async join(): Promise<boolean> {
    this.set({ phase: "joining" });
    try {
      const j = await this.o.api.joinViewport(this.o.source);
      this.viewer = j.viewer;
      this.iceServers = j.iceServers;
      this.access = j.status?.access;
      if (this.stopped) {
        void this.o.api.leaveViewport(j.viewer).catch(() => undefined);
        return false;
      }
      return true;
    } catch (e) {
      if (this.stopped) return false;
      const code = statusOf(e);
      const error = failureText(e);
      this.set(code !== null && code !== 404 ? { phase: "refused", error, status: refusalStatus(e) } : { phase: "failed", error });
      return false;
    }
  }

  private async run(): Promise<void> {
    if (!(await this.join())) return;
    let after = 0;
    let failures = 0;
    let rejoined = false;
    while (!this.stopped) {
      this.poll = new AbortController();
      let r: ViewerSignals;
      try {
        r = await this.o.api.viewportSignals(this.viewer!, after, this.poll.signal);
        failures = 0;
      } catch (e) {
        if (this.stopped) return;
        // The computer forgot this viewer (ue-mcp restarted, or it went idle): join again, once in a row.
        if (statusOf(e) === 404 && !rejoined) {
          rejoined = true;
          this.closePeer();
          after = 0;
          if (!(await this.join())) return;
          continue;
        }
        if (statusOf(e) === 403 || statusOf(e) === 503) {
          this.set({ phase: "refused", error: failureText(e), status: refusalStatus(e) });
          return;
        }
        // A poll cut short (the transport's deadline, a dropped request) is retried like any other failure.
        if (++failures >= POLL_FAILURES) {
          this.set({ phase: "failed", error: failureText(e) });
          return;
        }
        await new Promise((x) => setTimeout(x, this.o.retryMs ?? 1500));
        continue;
      }
      rejoined = false;
      after = r.next;
      for (const s of r.signals) {
        if (this.stopped) return;
        await this.handle(s);
      }
    }
  }

  private async handle(s: ViewerSignal): Promise<void> {
    switch (s.type) {
      case "streamer":
        if (!s.connected) {
          this.closePeer();
          this.set({ phase: "waiting" });
        } else if (this.phase !== "live") this.set({ phase: "connecting" });
        return;
      case "offer":
        await this.answer(s.sdp);
        return;
      case "iceCandidate":
        await this.pc?.addIceCandidate(s.candidate).catch(() => undefined);
        return;
      case "ended":
        this.closePeer();
        this.set({ phase: "ended", reason: s.reason });
        this.stopped = true;
        return;
    }
  }

  private async answer(sdp: string): Promise<void> {
    this.closePeer();
    this.set({ phase: "connecting" });
    const pc = this.o.peer({ iceServers: this.iceServers });
    this.pc = pc;
    const viewer = this.viewer!;
    const relayed = this.iceServers.some((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]).some((u) => /^turns?:/i.test(u)));
    const fail = (why: string | ViewerPhase): void => {
      if (this.pc !== pc) return;
      this.closePeer();
      this.set(typeof why === "string" ? { phase: "failed", error: why } : why);
    };

    // The streamer rejects a candidate that reaches it before the answer ("the remote description was
    // null"), and each signal is its own request, which the relay may deliver in any order. So the
    // viewer's candidates wait until the answer is delivered, then go one at a time, in order.
    let delivered: Promise<boolean> | null = null;
    const early: OutCandidate[] = [];
    const sendCandidate = (candidate: OutCandidate): void => {
      delivered = delivered!.then(async (ok) => {
        if (!ok || this.pc !== pc) return ok;
        await this.o.api.sendViewportSignal(viewer, { type: "iceCandidate", candidate }).catch(() => undefined);
        return true;
      });
    };
    pc.addEventListener("icecandidate", (e: { candidate?: { candidate?: string; sdpMid?: string | null; sdpMLineIndex?: number | null } | null }) => {
      const c = e.candidate;
      if (!c?.candidate || this.pc !== pc) return;
      const candidate = { candidate: c.candidate, sdpMid: c.sdpMid ?? null, sdpMLineIndex: c.sdpMLineIndex ?? null };
      if (delivered) sendCandidate(candidate);
      else early.push(candidate);
    });

    // Live once the connection is up and the video's track is in: a track arrives with the offer,
    // long before any frame, and going live on it alone drew a black screen.
    let connected = false;
    const goLive = (): void => {
      if (this.pc !== pc || !connected || !video || this.phase === "live") return;
      this.set({ phase: "live", stream: video });
      this.watchFrames(pc, fail);
    };
    // Pixel Streaming 2 sends its video and its audio in two streams. The panel draws one, so the
    // video's stream is the one that goes live, and an audio track from another stream joins it.
    let video: { addTrack?: (t: unknown) => void; getTracks?: () => unknown[] } | null = null;
    const others: unknown[] = [];
    const join = (track: unknown): void => {
      if (!video || video.getTracks?.().includes(track)) return;
      try {
        video.addTrack?.(track);
      } catch {
        // Video without that sound is still worth showing.
      }
    };
    pc.addEventListener("track", (e: { track?: { kind?: string }; streams?: unknown[] }) => {
      if (this.pc !== pc) return;
      const stream = e.streams?.[0] as typeof video | undefined;
      if (e.track && e.track.kind !== "video") {
        if (video) join(e.track);
        else others.push(e.track);
        return;
      }
      if (!stream) return;
      video = stream;
      for (const t of others.splice(0)) join(t);
      if (this.phase === "live") this.set({ phase: "live", stream });
      else goLive();
    });
    const onState = (): void => {
      if (this.pc !== pc) return;
      const c = pc.connectionState;
      const ice = pc.iceConnectionState;
      if (c === "failed" || ice === "failed") fail(connectionFailed(relayed, this.access));
      else if (c === "connected" || ice === "connected" || ice === "completed") {
        connected = true;
        goLive();
      }
    };
    pc.addEventListener("connectionstatechange", onState);
    pc.addEventListener("iceconnectionstatechange", onState);

    let answer: { type?: string; sdp?: string };
    try {
      await pc.setRemoteDescription({ type: "offer", sdp });
      answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
    } catch (e) {
      if (this.pc === pc && !this.stopped) fail(failureText(e));
      return;
    }
    if (this.pc !== pc || !answer.sdp) return;
    // Not awaited: the streamer's candidates, next in the queue, go on the peer meanwhile.
    delivered = this.deliverAnswer(pc, viewer, answer.sdp, fail);
    for (const c of early.splice(0)) sendCandidate(c);
    void delivered.then((ok) => {
      if (!ok || this.pc !== pc) return;
      this.after(this.o.connectMs ?? CONNECT_MS, () => {
        if (!connected) fail(connectionFailed(relayed, this.access));
      });
    });
  }

  /** Send the answer, again after a request that was cut short or dropped; false when it never got there. */
  private async deliverAnswer(pc: PeerLike, viewer: string, sdp: string, fail: (why: string) => void): Promise<boolean> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.o.api.sendViewportSignal(viewer, { type: "answer", sdp });
        return true;
      } catch (e) {
        if (this.pc !== pc || this.stopped) return false;
        // Refused (the viewer is gone, the plan lapsed): the next poll says so and rejoins or stops.
        if (statusOf(e) !== null) return false;
        if (attempt >= ANSWER_TRIES) {
          fail(failureText(e));
          return false;
        }
        await new Promise((x) => setTimeout(x, this.o.retryMs ?? 1500));
      }
    }
  }

  /**
   * After going live, wait for the first decoded video frame. A connection
   * that carries none in FRAMES_MS ends with a message instead of a black
   * screen. A peer without getStats is trusted.
   */
  private watchFrames(pc: PeerLike, fail: (why: string) => void): void {
    if (typeof pc.getStats !== "function") return;
    const deadline = Date.now() + (this.o.framesMs ?? FRAMES_MS);
    const check = async (): Promise<void> => {
      if (this.pc !== pc) return;
      let frames = 0;
      try {
        const report = await pc.getStats!();
        report.forEach((s: { type?: string; kind?: string; mediaType?: string; framesDecoded?: number; framesReceived?: number }) => {
          if (s?.type === "inbound-rtp" && (s.kind ?? s.mediaType) === "video") frames += Number(s.framesDecoded ?? s.framesReceived ?? 0);
        });
      } catch {
        return;
      }
      if (this.pc !== pc || frames > 0) return;
      if (Date.now() >= deadline) fail(NO_VIDEO);
      else this.after(FRAMES_CHECK_MS, () => void check());
    };
    this.after(Math.min(FRAMES_CHECK_MS, this.o.framesMs ?? FRAMES_MS), () => void check());
  }

  /** A timer on the current peer, cleared when it closes. */
  private after(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  private closePeer(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    const pc = this.pc;
    this.pc = null;
    try {
      pc?.close();
    } catch {
      // Already closed.
    }
  }
}

/** The peer connection failed or never connected, with Studio's relay server in the ICE servers. */
export const CONNECTION_FAILED = "The video could not connect, even through Studio's relay server. Check this device's connection.";
/** The same for a Pro account whose relay server could not be had: only a direct connection was tried. */
export const CONNECTION_FAILED_DIRECT =
  "The video could not connect directly to the computer, and Studio's relay server is unavailable right now. Direct connections usually work only from the computer's network. Try again in a moment.";
/** The same for an account without Pro (under the title "Could not connect directly"): the relay server is Pro's. */
export const CONNECTION_FAILED_NEEDS_PRO = PRO_PLAN_OFFERED
  ? "This device is probably on a different network from the computer. Watching across networks goes through Studio's relay server, which needs the Pro plan."
  : "This device is probably on a different network from the computer. Watching across networks goes through Studio's relay server, which needs the Pro plan. Pro is not on sale yet.";

/** What a failed connection says, by whether the relay server was offered and whether the account has Pro. */
export function connectionFailed(relayed: boolean, access: ViewportAccess | undefined): Extract<ViewerPhase, { phase: "failed" }> {
  if (relayed) return { phase: "failed", error: CONNECTION_FAILED };
  if (access === "ok") return { phase: "failed", error: CONNECTION_FAILED_DIRECT };
  return { phase: "failed", error: CONNECTION_FAILED_NEEDS_PRO, needsPro: true };
}
/** Connected, but no video frame arrived. */
export const NO_VIDEO = "The connection opened, but no video arrived from the editor. If this keeps happening, restart Play In Editor.";
/** Requests to the computer were cut short or dropped. */
export const LOST_COMPUTER = "The computer stopped answering. Check that it is online.";

/** A way forward the panel offers, drawn as a button. */
export type ViewportActionId = "check" | "plans" | "upgrade" | "settings" | "start-editor" | "restart-editor" | "enable-plugin" | "level-viewport" | "pie" | "watch";

export interface ViewportAction {
  id: ViewportActionId;
  label: string;
  primary?: boolean;
}

/** What the panel says when it is not showing video: a title, a line or two, and what to do. */
export interface ViewportNotice {
  tone: "info" | "warn" | "bad";
  title: string;
  body: string;
  actions: ViewportAction[];
  /** Waiting on something that will happen on its own (a spinner beside the title). */
  busy?: boolean;
}

const CHECK: ViewportAction = { id: "check", label: "Check again" };

/**
 * What a status that stops watching says: the editor's state, with its way
 * forward. Null when nothing stops a viewer. Watching is open to every
 * account; only the relay server is Pro's (connectionFailed).
 * `remote`: the client is a paired device, which cannot open the computer's Settings.
 */
export function viewportGate(s: ViewportStatus, o: { remote: boolean }): ViewportNotice | null {
  switch (s.editor) {
    case "no-editor":
      return { tone: "warn", title: "The editor is not running", body: "Start it to watch Play In Editor here.", actions: [{ id: "start-editor", label: "Start editor", primary: true }, CHECK] };
    case "no-actions":
      return { tone: "warn", title: "This ue-mcp cannot stream", body: "Viewport streaming needs a newer ue-mcp. Update it in Settings > General on the computer.", actions: o.remote ? [CHECK] : [{ id: "settings", label: "Open Settings", primary: true }, CHECK] };
    case "plugin-off":
      return {
        tone: "warn",
        title: "Pixel Streaming 2 is off",
        body: "The editor streams through Unreal's Pixel Streaming 2 plugin, which this project does not enable. Enabling it adds it to the .uproject and takes effect after the editor restarts.",
        actions: [{ id: "enable-plugin", label: "Enable Pixel Streaming 2", primary: true }, CHECK],
      };
    case "plugin-restart":
      return { tone: "warn", title: "Restart the editor", body: "Pixel Streaming 2 is enabled in the .uproject and loads when the editor restarts. Save your work first.", actions: [{ id: "restart-editor", label: "Restart editor", primary: true }, CHECK] };
    case "unavailable":
      return { tone: "bad", title: "The editor cannot stream", body: s.detail ?? "Pixel Streaming 2 is not available in this editor.", actions: [CHECK] };
    default:
      return null;
  }
}

/** What the panel says for a viewer that is not live, or null while it is. */
export function viewerNotice(p: ViewerPhase, source: ViewportSource, o: { remote: boolean }): ViewportNotice | null {
  switch (p.phase) {
    case "joining":
      return { tone: "info", title: "Starting the stream", body: "", actions: [], busy: true };
    case "waiting":
      return source === "pie"
        ? { tone: "info", title: "Waiting for Play In Editor", body: "The game shows here when you or the agent start Play In Editor.", actions: [{ id: "level-viewport", label: "Show the level viewport" }], busy: true }
        : { tone: "info", title: "Waiting for the editor", body: "The level viewport shows here once the editor starts streaming.", actions: [{ id: "pie", label: "Show Play In Editor" }], busy: true };
    case "connecting":
      return { tone: "info", title: "Connecting", body: "", actions: [], busy: true };
    case "live":
      return null;
    case "refused":
      return (p.status && viewportGate(p.status, o)) ?? { tone: "bad", title: "The stream did not start", body: p.error, actions: [{ id: "watch", label: "Try again", primary: true }] };
    case "ended":
      return { tone: "info", title: "The stream ended", body: p.reason, actions: [{ id: "watch", label: "Watch again", primary: true }] };
    case "failed":
      return {
        tone: "bad",
        title: p.needsPro ? "Could not connect directly" : "The stream stopped",
        body: p.error,
        actions: [{ id: "watch", label: "Try again", primary: true }, ...(p.needsPro ? [PRO_PLAN_OFFERED ? { id: "upgrade" as const, label: "Upgrade to Pro" } : { id: "plans" as const, label: "Open ue-mcp.com" }] : [])],
      };
  }
}

/** The source switch's choices. */
export const VIEWPORT_SOURCE_CHOICES: ReadonlyArray<{ id: ViewportSource; name: string }> = [
  { id: "pie", name: "Play In Editor" },
  { id: "level_viewport", name: "Level viewport" },
];

/** Under the live video. */
export const VIEWPORT_VIEW_ONLY = "View only. Input from this device does not reach the game.";

/** Where "Open ue-mcp.com" goes. */
export const VIEWPORT_PLANS_URL = PLANS_SITE;

/**
 * The events after which a client asks GET /viewport again for the chat's
 * Play In Editor card and playtest cards: the agent's viewport.changed, and
 * the editor coming or going. Nothing polls.
 */
export function asksViewportAgain(type: string): boolean {
  return type === VIEWPORT_CHANGED_EVENT || type === "editor.connected" || type === "editor.disconnected";
}

/** Both clients read the daemon's pie.* events through this one rule. */
export { pieFromEvent };

/**
 * The status with what a pie.* event said (pieFromEvent) applied, so the
 * cards move before GET /viewport answers again. Against a daemon older
 * than those events the status comes from GET /viewport alone.
 */
export function withPie(s: ViewportStatus | null, pie: boolean): ViewportStatus | null {
  return s && s.pie !== pie ? { ...s, pie } : s;
}

/** The button on the chat's Play In Editor card. */
export const WATCH_LIVE = "Watch live";
/** The viewport opened over the chat: its title. */
export const VIEWPORT_MODAL_TITLE = "Play In Editor";

/**
 * The chat's Play In Editor card: what it says. `current` is the newest such
 * card in the thread, the only one that follows PIE; the ones before it say
 * only that PIE started.
 */
export interface PieCardView {
  title: string;
  live: boolean;
}

export function pieCard(s: ViewportStatus | null | undefined, o: { current: boolean }): PieCardView {
  if (!o.current || !s) return { title: "Play In Editor started", live: false };
  // The same rule as the bar's Live button (pieRunning), so the two never disagree.
  return pieRunning(s) ? { title: "Play In Editor is running", live: true } : { title: "Play In Editor stopped", live: false };
}
