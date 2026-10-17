// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DaemonEvent, DaemonHealth } from "ue-mcp/daemon";
import type { BusyState } from "@ue-mcp-studio/shared";
import { EditorBanner, formatElapsed, operationLine, stepFailed } from "./EditorBanner";
import type { DaemonState } from "../state";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const health = (connected: boolean) => ({ editors: [{ name: "Vale", connected, port: 9877, pid: 1, lastDisconnect: null }] }) as unknown as DaemonHealth;
const daemon = (connected: boolean, events: DaemonEvent[] = []): DaemonState => ({ health: health(connected), error: null, streaming: true, events, refresh: () => {} });

function stubFetch(busy: BusyState) {
  const posted: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posted.push(url);
      return new Response(JSON.stringify(url.endsWith("/busy/stop") ? { stopped: ["s1"] } : { op: "start", steps: [{ step: "editor.start_editor", ok: true }] }));
    }
    return new Response(JSON.stringify(busy));
  }));
  return posted;
}

describe("the editor banner", () => {
  it("names each step of an editor operation", () => {
    expect(operationLine({ op: "rebuild", step: "editor.stop_editor" })).toEqual({ title: "Rebuilding the project", step: "closing the editor (step 1 of 3)" });
    expect(operationLine({ op: "rebuild", step: "connect" })).toEqual({ title: "Rebuilding the project", step: "waiting for the editor to connect" });
    expect(operationLine({ op: "restart", step: "editor.restart_editor" })).toEqual({ title: "Restarting the editor", step: "restarting the editor" });
  });

  it("says why the last operation did not bring the editor back, beside the Start (#1384)", async () => {
    stubFetch({ now: Date.now(), calls: [], failure: { op: "rebuild", step: "project.build", reason: "Build failed: ValeJourneyCaravan.cpp(169,10): error C4458", at: Date.now() } });
    render(<EditorBanner daemon={daemon(false)} />);
    await screen.findByText("The rebuild did not bring the editor back (building the C++).");
    expect(screen.getByText(/error C4458/)).toBeTruthy();
    expect(screen.getByText("Start")).toBeTruthy();
  });

  it("counts a start step an older daemon marked ok over success: false as failed", () => {
    expect(stepFailed({ ok: true, result: JSON.stringify({ success: false, message: "not ready" }, null, 2) })).toBe(true);
    expect(stepFailed({ ok: true, result: JSON.stringify({ success: true, results: [{ success: false }] }) })).toBe(false);
    expect(stepFailed({ ok: false })).toBe(true);
  });

  it("formats the elapsed time", () => {
    expect(formatElapsed(7_400)).toBe("0:07");
    expect(formatElapsed(62_000)).toBe("1:02");
    expect(formatElapsed(3_723_000)).toBe("1:02:03");
  });

  it("shows the call the editor is busy with, its time, and a Stop that stops the turn", async () => {
    const now = Date.now();
    const posted = stubFetch({ now, calls: [{ id: 1, category: "editor", action: "execute_python", startedAt: now - 12_000, source: "studio", sessionId: "s1", stopped: false }] });
    render(<EditorBanner daemon={daemon(true)} />);
    await screen.findByText("Editor busy:");
    expect(screen.getByText("editor(execute_python)")).toBeTruthy();
    expect(screen.getByText("0:12")).toBeTruthy();
    fireEvent.click(screen.getByText("Stop"));
    await waitFor(() => expect(posted).toEqual(["/v1/ext/studio/busy/stop"]));
  });

  it("follows the daemon's busy events, and says a stopped call is still finishing", async () => {
    const now = Date.now();
    stubFetch({ now, calls: [] });
    const event = (calls: BusyState["calls"], id: number): DaemonEvent => ({ id, type: "studio.busy.changed", at: "", data: { now, calls } as unknown as Record<string, unknown> });
    const { rerender, container } = render(<EditorBanner daemon={daemon(true)} />);
    await waitFor(() => expect(container.textContent).toBe(""));
    rerender(<EditorBanner daemon={daemon(true, [event([{ id: 2, category: "pcg", action: "generate", startedAt: now - 5_000, source: "studio", sessionId: "s1", stopped: true }], 1)])} />);
    await screen.findByText("Stopped.");
    expect(screen.getByText("The editor is finishing pcg(generate).")).toBeTruthy();
    expect(screen.queryByText("Stop")).toBeNull();
  });

  it("does not call a short call busy, and has no Stop for another client's call", async () => {
    const now = Date.now();
    stubFetch({ now, calls: [{ id: 3, category: "level", action: "get_outliner", startedAt: now - 100, source: "client", client: "cursor", stopped: false }] });
    const { container } = render(<EditorBanner daemon={daemon(true)} />);
    await new Promise((r) => setTimeout(r, 50));
    expect(container.textContent).toBe("");
    cleanup();
    stubFetch({ now, calls: [{ id: 3, category: "level", action: "get_outliner", startedAt: now - 3_000, source: "client", client: "cursor", stopped: false }] });
    render(<EditorBanner daemon={daemon(true)} />);
    await screen.findByText("Editor busy:");
    expect(screen.getByText("from cursor", { exact: false })).toBeTruthy();
    expect(screen.queryByText("Stop")).toBeNull();
  });

  it("offers Start when the editor is not running", async () => {
    const posted = stubFetch({ now: Date.now(), calls: [] });
    render(<EditorBanner daemon={daemon(false)} />);
    fireEvent.click(await screen.findByText("Start"));
    await waitFor(() => expect(posted).toEqual(["/v1/editor/start"]));
    expect(screen.getByText("Editor not running")).toBeTruthy();
  });

  it("shows a rebuild step by step with its time, and no Start while the editor is down for it", async () => {
    const now = Date.now();
    stubFetch({ now, calls: [], operation: { op: "rebuild", step: "project.build", startedAt: now - 75_000, stepStartedAt: now - 70_000 } });
    render(<EditorBanner daemon={daemon(false)} />);
    await screen.findByText("Rebuilding the project:");
    expect(screen.getByText("building the C++ (step 2 of 3)", { exact: false })).toBeTruthy();
    expect(screen.getByText("1:15")).toBeTruthy();
    expect(screen.queryByText("Start")).toBeNull();
    expect(screen.queryByText("Editor not running")).toBeNull();
  });

  it("folds into a chip that opens the banner and its Start, at phone width", async () => {
    const posted = stubFetch({ now: Date.now(), calls: [] });
    render(<EditorBanner daemon={daemon(false)} compact />);
    const chip = await screen.findByText("Editor off");
    expect(screen.queryByText("Start")).toBeNull();
    fireEvent.click(chip);
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByText("Start"));
    await waitFor(() => expect(posted.some((u) => u.includes("/editor/start"))).toBe(true));
  });

  it("shows no chip while the editor is connected and idle", async () => {
    stubFetch({ now: Date.now(), calls: [] });
    const { container } = render(<EditorBanner daemon={daemon(true)} compact />);
    await waitFor(() => expect(container.querySelector(".editor-chip")).toBeNull());
  });
});
