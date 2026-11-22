/**
 * The live viewport for the visual QA harness: each gate with its way
 * forward, and a viewer waiting for Play In Editor. No streamer runs here, so
 * the live video itself is covered by the client-core session tests.
 */
import type { ViewportStatus } from "@ue-mcp-studio/shared";
import type { Scenario } from "./fixtures";

const status = (s: Partial<ViewportStatus>): ViewportStatus => ({ access: "ok", editor: "ready", streamer: false, source: null, viewers: 0, ...s });

const viewport = (title: string, s: Partial<ViewportStatus>, o: Partial<Scenario> = {}): Scenario => ({
  title,
  hash: "#/viewport",
  index: { playtests: [], listed: true },
  get: (p) => (p === "/v1/ext/studio/viewport" ? status(s) : undefined),
  ...o,
});

export const VIEWPORT_SCENARIOS: Record<string, Scenario> = {
  "viewport-no-editor": viewport("Viewport with no editor running: Start editor", { editor: "no-editor" }),
  "viewport-plugin-off": viewport("Viewport in a project without Pixel Streaming 2: Enable it", { editor: "plugin-off", bridge: { available: true, pluginEnabled: false, streaming: false, armed: false } }),
  "viewport-plugin-restart": viewport("Pixel Streaming 2 enabled, waiting for the editor to restart", { editor: "plugin-restart", bridge: { available: true, pluginEnabled: false, streaming: false, armed: false } }),
  "viewport-no-actions": viewport("Viewport on a ue-mcp without the stream actions: update it", { editor: "no-actions" }),
  "viewport-waiting": viewport("Watching, armed for the next Play In Editor: the level viewport instead", {}, {
    post: (p) => (p === "/v1/ext/studio/viewport/viewers" ? { status: 201, body: { viewer: "v1", iceServers: [{ urls: "stun:stun.l.google.com:19302" }], status: status({ source: "pie", viewers: 1, bridge: { available: true, pluginEnabled: true, streaming: false, armed: true } }) } } : undefined),
    get: (p, url) => {
      if (p === "/v1/ext/studio/viewport") return status({});
      if (p === "/v1/ext/studio/viewport/viewers/v1/signals" && url.searchParams.get("after") === "0") return { signals: [{ type: "streamer", connected: false }], next: 1 };
      return undefined;
    },
    holdGet: /\/viewport\/viewers\/v1\/signals\?after=[1-9]/,
  }),
};
