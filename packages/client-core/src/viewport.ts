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
  type IceServer,
  type ViewerMessage,
  type ViewerSignal,
  type ViewerSignals,
  type ViewportJoin,
  type ViewportSource,
  type ViewportStatus,
} from "@ue-mcp-studio/shared";
import { requestJson, type Transport } from "./transport.js";

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
  | { phase: "failed"; error: string };

export interface ViewportSessionOptions {
  api: ViewportSessionApi;
  peer: PeerFactory;
  source: ViewportSource;
  onPhase: (p: ViewerPhase) => void;
  /** Wait between failed polls; tests shorten it. */
  retryMs?: number;
}

/** Polls in a row that may fail before the viewer says it lost the computer. */
const POLL_FAILURES = 4;

/**
 * One viewer, from join to stop. The streamer offers; the viewer answers. A
 * new offer (PIE restarted) replaces the peer connection; the streamer going
 * back to waiting closes it.
 */
export class ViewportSession {
  private viewer: string | null = null;
  private iceServers: IceServer[] = [];
  private pc: PeerLike | null = null;
  private stopped = false;
  private poll: AbortController | null = null;
  private phase: ViewerPhase["phase"] = "joining";

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
      if (this.stopped) {
        void this.o.api.leaveViewport(j.viewer).catch(() => undefined);
        return false;
      }
      return true;
    } catch (e) {
      const code = statusOf(e);
      const error = e instanceof Error ? e.message : String(e);
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
          this.set({ phase: "refused", error: e instanceof Error ? e.message : String(e), status: refusalStatus(e) });
          return;
        }
        if (++failures >= POLL_FAILURES) {
          this.set({ phase: "failed", error: e instanceof Error ? e.message : String(e) });
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
    pc.addEventListener("icecandidate", (e: { candidate?: { candidate?: string; sdpMid?: string | null; sdpMLineIndex?: number | null } | null }) => {
      const c = e.candidate;
      if (!c?.candidate || this.pc !== pc) return;
      void this.o.api.sendViewportSignal(viewer, { type: "iceCandidate", candidate: { candidate: c.candidate, sdpMid: c.sdpMid ?? null, sdpMLineIndex: c.sdpMLineIndex ?? null } }).catch(() => undefined);
    });
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
      this.set({ phase: "live", stream });
    });
    pc.addEventListener("connectionstatechange", () => {
      if (this.pc !== pc) return;
      if (pc.connectionState === "failed") this.set({ phase: "failed", error: CONNECTION_FAILED });
    });
    try {
      await pc.setRemoteDescription({ type: "offer", sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      if (this.pc !== pc || !answer.sdp) return;
      await this.o.api.sendViewportSignal(viewer, { type: "answer", sdp: answer.sdp });
    } catch (e) {
      if (this.pc === pc) this.set({ phase: "failed", error: e instanceof Error ? e.message : String(e) });
    }
  }

  private closePeer(): void {
    const pc = this.pc;
    this.pc = null;
    try {
      pc?.close();
    } catch {
      // Already closed.
    }
  }
}

/** The peer connection failed: what the panel says. */
export const CONNECTION_FAILED = "The video connection failed. This network may block peer-to-peer video; try again, or from another network.";

/** The tab's name in both clients. */
export const VIEWPORT_TAB = "Viewport";

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
 * What a status that refuses watching says: the plan, the account, or the
 * editor, each with its way forward. Null when nothing stops a viewer.
 * `remote`: the client is a paired device, which cannot sign in for the computer.
 */
export function viewportGate(s: ViewportStatus, o: { remote: boolean }): ViewportNotice | null {
  if (s.access === "signed-out") {
    return o.remote
      ? { tone: "warn", title: "Sign in on the computer", body: "The live viewport needs a ue-mcp account with the Pro plan. Sign in on the computer in Settings > General.", actions: [CHECK] }
      : { tone: "warn", title: "Sign in to watch the viewport", body: "The live viewport needs a ue-mcp account with the Pro plan.", actions: [{ id: "settings", label: "Open Settings", primary: true }, CHECK] };
  }
  if (s.access === "needs-pro") {
    return PRO_PLAN_OFFERED
      ? { tone: "info", title: "The live viewport is part of Pro", body: "Upgrade to watch Play In Editor live on this device while you or the agent playtest.", actions: [{ id: "upgrade", label: "Upgrade to Pro", primary: true }, CHECK] }
      : {
          tone: "info",
          title: "The live viewport is part of Pro",
          body: "Pro is not on sale yet, and the Remote plan does not include the live viewport. Plans are announced on ue-mcp.com.",
          actions: [{ id: "plans", label: "Open ue-mcp.com" }, CHECK],
        };
  }
  if (s.access === "unreachable") return { tone: "warn", title: "Could not check the plan", body: "Studio could not reach your ue-mcp account to check that it has Pro.", actions: [{ ...CHECK, primary: true }] };
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
      return { tone: "bad", title: "The stream stopped", body: p.error, actions: [{ id: "watch", label: "Try again", primary: true }] };
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
 * indicator and card: the agent's viewport.changed, and the editor coming or
 * going. Nothing polls.
 */
export function asksViewportAgain(type: string): boolean {
  return type === VIEWPORT_CHANGED_EVENT || type === "editor.connected" || type === "editor.disconnected";
}

/** Play In Editor runs, or the stream is live or armed: the composer bar shows its PIE indicator. */
export function pieLive(s: ViewportStatus | null | undefined): boolean {
  if (!s) return false;
  return s.pie === true || s.streamer || s.bridge?.streaming === true || s.bridge?.armed === true;
}

/** The plan or the account stands in the way: the chat says so with the Viewport's own words and way forward. */
export function viewportAccessGate(s: ViewportStatus | null | undefined, o: { remote: boolean }): ViewportNotice | null {
  return s && s.access !== "ok" ? viewportGate(s, o) : null;
}

/** The composer bar's indicator (utilityLabel "viewport" names it): what its tooltip or accessibility hint says. */
export function pieLiveTitle(s: ViewportStatus | null | undefined, o: { remote: boolean }): string {
  const gate = viewportAccessGate(s, o);
  return gate ? `Play In Editor is running. ${gate.title}.` : "Play In Editor is running. Watch it live.";
}

/** The button on the chat's Play In Editor card. */
export const WATCH_LIVE = "Watch live";
/** The viewport opened over the chat: its title. */
export const VIEWPORT_MODAL_TITLE = "Play In Editor";

/**
 * The chat's Play In Editor card: what it says. `current` is the newest such
 * card in the thread, the only one that follows PIE; the ones before it say
 * only that PIE started. `gate` is the plan or account refusal, with its way
 * forward, drawn in place of Watch live.
 */
export interface PieCardView {
  title: string;
  live: boolean;
  gate: ViewportNotice | null;
}

export function pieCard(s: ViewportStatus | null | undefined, o: { remote: boolean; current: boolean }): PieCardView {
  const gate = viewportAccessGate(s, o);
  if (!o.current || !s) return { title: "Play In Editor started", live: false, gate };
  return pieLive(s) ? { title: "Play In Editor is running", live: true, gate } : { title: "Play In Editor stopped", live: false, gate };
}
