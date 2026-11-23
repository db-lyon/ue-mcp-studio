/** The live viewport's gate and the bar's Live button: a remote client only, while Play In Editor runs. */
import { describe, expect, it } from "vitest";
import type { ViewportStatus } from "@ue-mcp-studio/shared";
import { LIVE_BUTTON, liveButtonHint, pieRunning, showsViewportButton, viewportAllowed } from "../src/viewport-open.js";

const status = (s: Partial<ViewportStatus> = {}): ViewportStatus => ({ access: "ok", editor: "ready", streamer: false, source: null, viewers: 0, ...s });

describe("the live viewport", () => {
  it("is a remote client's only", () => {
    expect(viewportAllowed(true)).toBe(true);
    expect(viewportAllowed(false)).toBe(false);
  });

  it("reads Play In Editor as running from pie, or a streamer up for it", () => {
    expect(pieRunning(null)).toBe(false);
    expect(pieRunning(status())).toBe(false);
    expect(pieRunning(status({ pie: true }))).toBe(true);
    expect(pieRunning(status({ streamer: true, source: "pie" }))).toBe(true);
    expect(pieRunning(status({ streamer: true, source: "level_viewport" }))).toBe(false);
    // Armed for the next PIE: nothing to watch yet.
    expect(pieRunning(status({ bridge: { available: true, pluginEnabled: true, streaming: false, armed: true } }))).toBe(false);
  });

  it("offers a card's Viewport by the same rule", () => {
    expect(showsViewportButton({ relevant: false, status: status({ pie: true }) })).toBe(true);
    expect(showsViewportButton({ relevant: true, status: null })).toBe(true);
    expect(showsViewportButton({ relevant: false, status: status() })).toBe(false);
  });

  it("names the running check in the Live button's hint when there is one", () => {
    expect(LIVE_BUTTON).toBe("Live");
    expect(liveButtonHint()).toBe("Watch Play In Editor live");
    expect(liveButtonHint("Door opens")).toBe("Watch Door opens live in Play In Editor");
  });
});
