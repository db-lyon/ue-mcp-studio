/**
 * The live viewport's routes, under /v1/ext/studio/viewport:
 *
 *   GET    /viewport                         ViewportStatus (?fresh=1 asks the gateway for the plan again)
 *   POST   /viewport/viewers                 join: starts the stream, or arms it for the next PIE
 *   GET    /viewport/viewers/:id/signals     the streamer's offer and candidates, long-polled
 *   POST   /viewport/viewers/:id/signals     the viewer's answer and candidates
 *   DELETE /viewport/viewers/:id             leave; the last viewer out stops the stream
 *   POST   /viewport/plugin                  enable Pixel Streaming 2 in the .uproject
 *
 * Every route but the status needs the Pro plan, asked of the gateway with the
 * account's token, so a client that skips its own gate is still refused. A
 * paired device reaches these through the sealed relay like any other Studio
 * route; the media never does.
 *
 * The editor side is ue-mcp's stream_start, stream_stop and stream_status,
 * found under whichever category this ue-mcp has them (pie, then editor).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ActionResult, DaemonExtensionApi } from "ue-mcp/daemon";
import {
  DEFAULT_ICE_SERVERS,
  VIEWPORT_POLL_WAIT_MS,
  VIEWPORT_SOURCES,
  VIEWPORT_VIEWER_TTL_MS,
  hasProPlan,
  iceServersOf,
  isViewerMessage,
  type AccountUsage,
  type IceServer,
  type ViewportAccess,
  type ViewportBridgeStatus,
  type ViewportEditorState,
  type ViewportJoin,
  type ViewportSource,
  type ViewportStatus,
} from "@ue-mcp-studio/shared";
import { fetchAccountUsage, type FetchLike } from "../account-usage.js";
import { SignallingServer } from "./signalling.js";

/** What one stream action answered. */
export type BridgeAnswer =
  | { kind: "ok"; data: Record<string, unknown> }
  | { kind: "missing" }
  | { kind: "no-editor" }
  | { kind: "error"; error: string };

/** The editor's streamer, through ue-mcp. */
export interface StreamBridge {
  status(): Promise<BridgeAnswer>;
  start(args: Record<string, unknown>): Promise<BridgeAnswer>;
  stop(): Promise<BridgeAnswer>;
  enablePlugin(): Promise<BridgeAnswer>;
}

/** The categories the stream actions may be under, in the order they are tried. */
export const STREAM_CATEGORIES = ["pie", "editor"] as const;
/** The plugin the stream needs, as its .uplugin names it. */
export const STREAM_PLUGIN = "PixelStreaming2";
/** The streamer id Studio's signalling gives the editor. */
export const STREAMER_ID = "studio";

const UNKNOWN_ACTION = /unknown (action|method|category)|invalid (enum|action)|not a valid action|no such action|is not one of/i;
const NO_EDITOR = /not connected|no editor|editor is not running|bridge (is )?(down|closed|unavailable)|ECONNREFUSED/i;

function textOf(r: ActionResult): string {
  return r.content.map((c) => c.text ?? "").join("\n").trim();
}

function parseResult(text: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : { result: v };
  } catch {
    return { text };
  }
}

/** The stream actions over api.callAction, the category found on first use and kept. */
export function actionBridge(api: Pick<DaemonExtensionApi, "callAction" | "editors">): StreamBridge {
  let category: string | null = null;
  const connected = (): boolean => {
    try {
      return api.editors().some((e) => e.connected);
    } catch {
      return true;
    }
  };
  const call = async (action: string, args: Record<string, unknown> = {}): Promise<BridgeAnswer> => {
    if (!connected()) return { kind: "no-editor" };
    for (const c of category ? [category] : STREAM_CATEGORIES) {
      let r: ActionResult;
      try {
        r = await api.callAction(c, action, args);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (UNKNOWN_ACTION.test(msg)) continue;
        return NO_EDITOR.test(msg) ? { kind: "no-editor" } : { kind: "error", error: msg };
      }
      const text = textOf(r);
      if (r.isError && UNKNOWN_ACTION.test(text)) continue;
      category = c;
      if (r.isError) return NO_EDITOR.test(text) ? { kind: "no-editor" } : { kind: "error", error: text || `${c}(${action}) failed.` };
      return { kind: "ok", data: parseResult(text) };
    }
    category = null;
    return { kind: "missing" };
  };
  return {
    status: () => call("stream_status"),
    start: (args) => call("stream_start", args),
    stop: () => call("stream_stop"),
    enablePlugin: async () => {
      if (!connected()) return { kind: "no-editor" };
      const r = await api.callAction("project", "enable_plugin", { pluginName: STREAM_PLUGIN }).catch((e: unknown) => ({ isError: true, content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }] }));
      const text = textOf(r);
      return r.isError ? { kind: "error", error: text || "enable_plugin failed." } : { kind: "ok", data: parseResult(text) };
    },
  };
}

/** stream_status's answer; a field it leaves out reads as the permissive value, except streaming and armed. */
export function bridgeStatusOf(data: Record<string, unknown>): ViewportBridgeStatus {
  return {
    available: data.available !== false,
    pluginEnabled: data.pluginEnabled !== false,
    streaming: data.streaming === true,
    armed: data.armed === true,
  };
}

const ACCESS_OK_TTL_MS = 3 * 60_000;
const ACCESS_NO_TTL_MS = 30_000;

/** Whether the signed-in account holds Pro, asked of the gateway and kept a while. */
export class ViewportAccessCheck {
  private cached: { value: ViewportAccess; at: number } | null = null;
  private pending: Promise<ViewportAccess> | null = null;

  constructor(
    private readonly o: {
      token: () => Promise<string | null>;
      gatewayUrl: () => string;
      fetch?: FetchLike;
      now?: () => number;
    },
  ) {}

  async get(fresh = false): Promise<ViewportAccess> {
    const now = this.now();
    if (!fresh && this.cached && now - this.cached.at < (this.cached.value === "ok" ? ACCESS_OK_TTL_MS : ACCESS_NO_TTL_MS)) return this.cached.value;
    this.pending ??= this.ask()
      .then((value) => {
        this.cached = { value, at: this.now() };
        return value;
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  private async ask(): Promise<ViewportAccess> {
    let token: string | null;
    try {
      token = await this.o.token();
    } catch {
      token = null;
    }
    if (!token) return "signed-out";
    try {
      const res = await fetchAccountUsage(this.o.gatewayUrl(), token, this.o.fetch, AbortSignal.timeout(10_000));
      if (res.status === 401) return "signed-out";
      if (!res.ok) return "unreachable";
      return hasProPlan((await res.json()) as AccountUsage, new Date(this.now())) ? "ok" : "needs-pro";
    } catch {
      return "unreachable";
    }
  }
}

/** viewport.json in the agent's data dir: the TURN slot and the stream's settings, none of them required. */
export interface ViewportConfig {
  iceServers?: IceServer[];
  stream?: { resolution?: string; fps?: number; maxBitrateKbps?: number; codec?: string };
}

export function readViewportConfig(dataDir: string, env: NodeJS.ProcessEnv = process.env): { iceServers: IceServer[]; stream: Record<string, unknown> } {
  let file: ViewportConfig = {};
  try {
    file = JSON.parse(fs.readFileSync(path.join(dataDir, "viewport.json"), "utf-8")) as ViewportConfig;
  } catch {
    // Not there: STUN only, the editor's own stream settings.
  }
  let fromEnv: IceServer[] = [];
  try {
    fromEnv = env.UE_MCP_STUDIO_ICE_SERVERS ? iceServersOf(JSON.parse(env.UE_MCP_STUDIO_ICE_SERVERS)) : [];
  } catch {
    fromEnv = [];
  }
  const extra = [...iceServersOf(file.iceServers), ...fromEnv];
  const s = file.stream ?? {};
  const stream: Record<string, unknown> = {};
  if (typeof s.resolution === "string" && /^\d{2,5}x\d{2,5}$/.test(s.resolution)) stream.resolution = s.resolution;
  if (typeof s.fps === "number" && s.fps > 0 && s.fps <= 240) stream.fps = s.fps;
  if (typeof s.maxBitrateKbps === "number" && s.maxBitrateKbps > 0) stream.maxBitrateKbps = s.maxBitrateKbps;
  if (typeof s.codec === "string" && /^(H264|VP8|VP9|AV1)$/i.test(s.codec)) stream.codec = s.codec;
  return { iceServers: [...DEFAULT_ICE_SERVERS, ...extra], stream };
}

export interface ViewportRouteOptions {
  access: Pick<ViewportAccessCheck, "get">;
  bridge: StreamBridge;
  /** ICE servers and stream settings, read on each join. */
  config?: () => { iceServers: IceServer[]; stream: Record<string, unknown> };
  signalling?: SignallingServer;
  log?: (message: string) => void;
  now?: () => number;
  /** How long after the last viewer leaves the stream stops. */
  stopGraceMs?: number;
  pollWaitMs?: number;
  viewerTtlMs?: number;
  /** How often idle viewers are dropped and the plan is checked while anyone watches. */
  sweepMs?: number;
}

const REFUSED: Record<Exclude<ViewportAccess, "ok">, string> = {
  "signed-out": "The live viewport needs a ue-mcp account with the Pro plan. Sign in on the computer in Settings > General.",
  "needs-pro": "The live viewport is part of the Pro plan, which this account does not have.",
  unreachable: "Studio could not reach your ue-mcp account to check the plan. Check again in a moment.",
};

export function registerViewport(api: Pick<DaemonExtensionApi, "route">, o: ViewportRouteOptions): { dispose(): void } {
  const now = o.now ?? Date.now;
  const config = o.config ?? (() => ({ iceServers: [...DEFAULT_ICE_SERVERS], stream: {} }));
  const signalling = o.signalling ?? new SignallingServer({ iceServers: () => config().iceServers, log: o.log, now });
  const grace = o.stopGraceMs ?? 5_000;
  const waitMs = o.pollWaitMs ?? VIEWPORT_POLL_WAIT_MS;
  const ttl = o.viewerTtlMs ?? VIEWPORT_VIEWER_TTL_MS;
  let source: ViewportSource | null = null;
  let stopTimer: ReturnType<typeof setTimeout> | null = null;
  /** Enabled through /viewport/plugin; the editor has not restarted since. */
  let pluginPending = false;
  let lastError: string | undefined;

  const editorState = async (): Promise<{ editor: ViewportEditorState; bridge?: ViewportBridgeStatus; detail?: string }> => {
    const a = await o.bridge.status();
    if (a.kind === "no-editor") return { editor: "no-editor" };
    if (a.kind === "missing") return { editor: "no-actions" };
    if (a.kind === "error") return { editor: "unavailable", detail: a.error };
    const bridge = bridgeStatusOf(a.data);
    if (bridge.pluginEnabled) pluginPending = false;
    const detail = typeof a.data.reason === "string" ? a.data.reason : typeof a.data.detail === "string" ? a.data.detail : undefined;
    if (!bridge.pluginEnabled) return { editor: pluginPending ? "plugin-restart" : "plugin-off", bridge };
    if (!bridge.available) return { editor: "unavailable", bridge, ...(detail ? { detail } : {}) };
    return { editor: "ready", bridge };
  };

  const status = async (fresh = false, known?: Awaited<ReturnType<typeof editorState>>): Promise<ViewportStatus> => {
    const access = await o.access.get(fresh);
    const e = known ?? (access === "ok" ? await editorState() : { editor: "ready" as const });
    const detail = e.detail ?? (e.editor === "ready" ? lastError : undefined);
    return {
      access,
      editor: e.editor,
      ...(e.bridge ? { bridge: e.bridge } : {}),
      streamer: signalling.streamerConnected(),
      source,
      viewers: signalling.viewerCount(),
      ...(detail ? { detail } : {}),
    };
  };

  const stopStream = async (): Promise<void> => {
    stopTimer = null;
    if (signalling.viewerCount() > 0 || source === null) return;
    source = null;
    const r = await o.bridge.stop();
    if (r.kind === "error") o.log?.(`viewport: stream_stop failed: ${r.error}`);
  };

  const left = (): void => {
    if (signalling.viewerCount() > 0 || stopTimer) return;
    stopTimer = setTimeout(() => void stopStream(), grace);
    stopTimer.unref?.();
  };

  const endAll = (reason: string): void => {
    for (const id of signalling.viewerIds()) signalling.removeViewer(id, reason);
    left();
  };

  // Viewers that stopped polling (a phone locked, a tab closed) leave; a lapsed plan ends everyone.
  const sweep = setInterval(() => {
    for (const id of signalling.idleViewers(now() - ttl)) signalling.removeViewer(id);
    if (signalling.viewerCount() === 0) {
      left();
      return;
    }
    void o.access.get().then((a) => {
      if (a !== "ok" && a !== "unreachable") endAll(REFUSED[a]);
    });
  }, o.sweepMs ?? 5_000);
  sweep.unref?.();

  /** The refusal for a route that needs Pro, or null when the account has it. */
  const gate = async (): Promise<{ status: number; body: { error: string; status: ViewportStatus } } | null> => {
    const access = await o.access.get();
    if (access === "ok") return null;
    return { status: access === "unreachable" ? 503 : 403, body: { error: REFUSED[access], status: await status() } };
  };

  api.route("GET", "/viewport", async (req) => ({ body: await status(req.query.fresh === "1") }));

  api.route("POST", "/viewport/viewers", async (req) => {
    const refused = await gate();
    if (refused) return refused;
    const asked = (req.body as { source?: unknown } | undefined)?.source;
    const want: ViewportSource = VIEWPORT_SOURCES.includes(asked as ViewportSource) ? (asked as ViewportSource) : "pie";
    const e = await editorState();
    if (e.editor !== "ready") {
      const s = await status(false, e);
      return { status: 409, body: { error: s.detail ?? "The editor cannot stream yet.", status: s } };
    }
    let url: string;
    try {
      url = await signalling.start();
    } catch (err) {
      return { status: 500, body: { error: `Studio could not open its signalling port: ${err instanceof Error ? err.message : String(err)}` } };
    }
    if (stopTimer) {
      clearTimeout(stopTimer);
      stopTimer = null;
    }
    const cfg = config();
    // Start when nothing streams, the source changes, or the editor lost the stream (it restarted).
    const lost = !signalling.streamerConnected() && !(e.bridge?.streaming || e.bridge?.armed);
    if (source !== want || lost) {
      const r = await o.bridge.start({ signallingUrl: url, streamerId: STREAMER_ID, source: want, ...cfg.stream });
      if (r.kind !== "ok") {
        const error = r.kind === "error" ? r.error : r.kind === "missing" ? "This ue-mcp cannot stream the viewport." : "The editor is not running.";
        lastError = error;
        if (signalling.viewerCount() === 0) left();
        return { status: 502, body: { error, status: await status() } };
      }
      lastError = undefined;
      source = want;
    }
    const viewer = signalling.addViewer();
    const join: ViewportJoin = { viewer, iceServers: cfg.iceServers, status: await status(false, e) };
    return { status: 201, body: join };
  });

  api.route("GET", "/viewport/viewers/:id/signals", async (req) => {
    const refused = await gate();
    if (refused) {
      signalling.removeViewer(req.params.id);
      left();
      return refused;
    }
    const after = Number(req.query.after ?? 0);
    const r = await signalling.poll(req.params.id, Number.isFinite(after) && after >= 0 ? after : 0, waitMs);
    if (!r) return { status: 404, body: { error: "This viewer is not watching any more." } };
    return { body: r };
  });

  api.route("POST", "/viewport/viewers/:id/signals", async (req) => {
    const refused = await gate();
    if (refused) return refused;
    const message = (req.body as { message?: unknown } | undefined)?.message;
    if (!isViewerMessage(message)) return { status: 400, body: { error: "body must be { message: an answer or an iceCandidate }" } };
    if (!signalling.fromViewer(req.params.id, message)) return { status: 404, body: { error: "This viewer is not watching any more." } };
    return { status: 204 };
  });

  api.route("DELETE", "/viewport/viewers/:id", (req) => {
    signalling.removeViewer(req.params.id);
    left();
    return { status: 204 };
  });

  api.route("POST", "/viewport/plugin", async () => {
    const refused = await gate();
    if (refused) return refused;
    const r = await o.bridge.enablePlugin();
    if (r.kind === "no-editor") return { status: 409, body: { error: "The editor is not running.", status: await status() } };
    if (r.kind !== "ok") return { status: 502, body: { error: r.kind === "error" ? r.error : "This ue-mcp cannot enable plugins." } };
    pluginPending = true;
    return { body: await status() };
  });

  return {
    dispose: () => {
      clearInterval(sweep);
      if (stopTimer) clearTimeout(stopTimer);
      if (source !== null) void o.bridge.stop().catch(() => undefined);
      signalling.close();
    },
  };
}
