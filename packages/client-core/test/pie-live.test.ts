/** The chat's way into the live viewport: when the PIE indicator shows, what the Play In Editor card says, and where the card goes in a thread. */
import { describe, expect, it } from "vitest";
import type { QaRun, ToolCallRecord, TranscriptEntry, ViewportStatus } from "@ue-mcp-studio/shared";
import { asksViewportAgain, pieCard, pieFromEvent, pieLive, pieLiveTitle, viewportGate, withPie } from "../src/viewport.js";
import { mainTimeline, startsPie } from "../src/chat-model.js";

const status = (s: Partial<ViewportStatus> = {}): ViewportStatus => ({ access: "ok", editor: "ready", streamer: false, source: null, viewers: 0, ...s });
const call = (category: string, method: string, args: Record<string, unknown>, outcome: ToolCallRecord["outcome"] = "done", id = `${category}.${method}`): TranscriptEntry => ({
  kind: "tool",
  call: { id, name: "ue_mcp", input: { action: "call", category, method, args }, outcome, startedAt: "" },
});
const qa = (over: Partial<QaRun>): TranscriptEntry => ({ kind: "qa", run: { runId: "r1", script: "s", scriptName: "s", state: "running", steps: [], awaiting: [], lastSeq: 0, summary: { total: 0, passed: 0, failed: 0, skipped: 0, pending: 0, awaiting: 0 }, resultsPath: null, sessionId: "x", toolUseId: null, seenAt: "", ...over } });

describe("the PIE indicator", () => {
  it("shows while PIE runs or the stream is live or armed, and not otherwise", () => {
    expect(pieLive(null)).toBe(false);
    expect(pieLive(status())).toBe(false);
    expect(pieLive(status({ pie: true }))).toBe(true);
    expect(pieLive(status({ streamer: true }))).toBe(true);
    expect(pieLive(status({ bridge: { available: true, pluginEnabled: true, streaming: false, armed: true } }))).toBe(true);
    // Without Pro the editor is not asked, and the agent's own PIE state still answers.
    expect(pieLive(status({ access: "needs-pro", pie: true }))).toBe(true);
  });

  it("says Pro is needed in the Viewport's own words for an account without it", () => {
    const s = status({ access: "needs-pro", pie: true });
    expect(pieLiveTitle(s, { remote: false })).toBe(`Play In Editor is running. ${viewportGate(s, { remote: false })!.title}.`);
    expect(pieLiveTitle(status({ pie: true }), { remote: false })).toBe("Play In Editor is running. Watch it live.");
  });

  it("moves at once on the daemon's pie events, however PIE was started", () => {
    expect(["pie.started", "pie.paused", "pie.resumed"].map(pieFromEvent)).toEqual([true, true, true]);
    expect(pieFromEvent("pie.ended")).toBe(false);
    expect(pieFromEvent("editor.connected")).toBeNull();
    const idle = status({ pie: false });
    expect(pieLive(withPie(idle, true))).toBe(true);
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
    expect(pieCard(status({ pie: true }), { remote: false, current: true })).toEqual({ title: "Play In Editor is running", live: true, gate: null });
    expect(pieCard(status(), { remote: false, current: true })).toEqual({ title: "Play In Editor stopped", live: false, gate: null });
    expect(pieCard(status({ pie: true }), { remote: false, current: false })).toEqual({ title: "Play In Editor started", live: false, gate: null });
  });

  it("carries the Viewport's refusal and way forward for an account without Pro, and not an editor gate", () => {
    const s = status({ access: "needs-pro", pie: true });
    expect(pieCard(s, { remote: true, current: true }).gate).toEqual(viewportGate(s, { remote: true }));
    // An editor that cannot stream is the dialog's to explain: the card still offers Watch live.
    expect(pieCard(status({ pie: true, editor: "plugin-off" }), { remote: false, current: true }).gate).toBeNull();
  });
});

describe("where the card goes", () => {
  it("knows the calls and runs that start PIE", () => {
    expect(startsPie(call("editor", "play_in_editor", { pieAction: "start" }))).toBe(true);
    expect(startsPie(call("editor", "play_in_editor", { pieAction: "status" }))).toBe(false);
    expect(startsPie(call("editor", "play_in_editor", { pieAction: "start" }, "error"))).toBe(false);
    expect(startsPie(call("editor", "play_in_editor_ignore_blueprint_errors", {}))).toBe(true);
    expect(startsPie(call("pie", "script_run", { script: "/Game/T" }))).toBe(true);
    expect(startsPie(call("pie", "script_run", { script: "/Game/T", mode: "manual" }))).toBe(false);
    expect(startsPie(qa({}))).toBe(true);
    expect(startsPie(qa({ state: "draft" }))).toBe(false);
    expect(startsPie(qa({ manual: true }))).toBe(false);
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
