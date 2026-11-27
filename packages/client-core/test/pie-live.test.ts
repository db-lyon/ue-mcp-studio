/** The chat's way into the live viewport: when Play In Editor reads as live, what the Play In Editor card says, and where the card goes in a thread. */
import { describe, expect, it } from "vitest";
import type { ToolCallRecord, TranscriptEntry, ViewportStatus } from "@ue-mcp-studio/shared";
import { asksViewportAgain, pieCard, pieFromEvent, withPie } from "../src/viewport.js";
import { pieRunning } from "../src/viewport-open.js";
import { mainTimeline, startsPie } from "../src/chat-model.js";

const status = (s: Partial<ViewportStatus> = {}): ViewportStatus => ({ access: "ok", editor: "ready", streamer: false, source: null, viewers: 0, ...s });
const call = (category: string, method: string, args: Record<string, unknown>, outcome: ToolCallRecord["outcome"] = "done", id = `${category}.${method}`): TranscriptEntry => ({
  kind: "tool",
  call: { id, name: "ue_mcp", input: { action: "call", category, method, args }, outcome, startedAt: "" },
});

describe("Play In Editor live", () => {
  it("reads live while PIE runs or its stream is up, not while a stream is only armed", () => {
    expect(pieRunning(null)).toBe(false);
    expect(pieRunning(status())).toBe(false);
    expect(pieRunning(status({ pie: true }))).toBe(true);
    expect(pieRunning(status({ streamer: true }))).toBe(true);
    expect(pieRunning(status({ bridge: { available: true, pluginEnabled: true, streaming: false, armed: true } }))).toBe(false);
    // Watching is free: an account without Pro reads it the same way.
    expect(pieRunning(status({ access: "needs-pro", pie: true }))).toBe(true);
  });

  it("moves at once on the daemon's pie events, however PIE was started", () => {
    expect(["pie.started", "pie.paused", "pie.resumed"].map(pieFromEvent)).toEqual([true, true, true]);
    expect(pieFromEvent("pie.ended")).toBe(false);
    expect(pieFromEvent("editor.connected")).toBeNull();
    const idle = status({ pie: false });
    expect(pieRunning(withPie(idle, true))).toBe(true);
    expect(withPie(idle, false)).toBe(idle);
    expect(withPie(null, true)).toBeNull();
  });

  it("asks again after the agent's viewport event and the editor coming or going, nothing else", () => {
    expect(["studio.viewport.changed", "editor.connected", "editor.disconnected"].every(asksViewportAgain)).toBe(true);
    expect(asksViewportAgain("studio.session.changed")).toBe(false);
  });
});

describe("the Play In Editor card", () => {
  it("follows PIE only on the newest card", () => {
    expect(pieCard(status({ pie: true }), { current: true })).toEqual({ title: "Play In Editor is running", live: true });
    expect(pieCard(status(), { current: true })).toEqual({ title: "Play In Editor stopped", live: false });
    expect(pieCard(status({ pie: true }), { current: false })).toEqual({ title: "Play In Editor started", live: false });
    // Watching is free on every plan: an account without Pro gets the same card.
    expect(pieCard(status({ access: "needs-pro", pie: true }), { current: true })).toEqual({ title: "Play In Editor is running", live: true });
  });
});

describe("where the card goes", () => {
  it("knows the calls that start PIE", () => {
    expect(startsPie(call("editor", "play_in_editor", { pieAction: "start" }))).toBe(true);
    expect(startsPie(call("editor", "play_in_editor", { pieAction: "status" }))).toBe(false);
    expect(startsPie(call("editor", "play_in_editor", { pieAction: "start" }, "error"))).toBe(false);
    expect(startsPie(call("editor", "play_in_editor_ignore_blueprint_errors", {}))).toBe(true);
    expect(startsPie(call("pie", "replay_run", {}))).toBe(true);
    expect(startsPie(call("pie", "replay_run", { mode: "manual" }))).toBe(false);
  });

  it("puts the card after what started PIE, breaks the run of steps there, and marks the newest", () => {
    const items = mainTimeline([
      call("level", "list_actors", {}, "done", "a"),
      call("editor", "play_in_editor", { pieAction: "start" }, "done", "b"),
      call("pie", "inject_input", {}, "done", "c"),
      call("editor", "play_in_editor", { pieAction: "start" }, "done", "d"),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["steps", "pie", "steps", "pie"]);
    expect(items.filter((i) => i.kind === "pie").map((i) => (i.kind === "pie" ? [i.key, i.current] : null))).toEqual([["call:b", false], ["call:d", true]]);
  });
});
