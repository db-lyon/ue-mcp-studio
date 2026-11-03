// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DaemonEvent } from "ue-mcp/daemon";
import { ConnectionOverlay, useConnection } from "./ConnectionOverlay";
import { LOST_PAUSE_MS, QUIET_MS, RECONNECT_MS, isRemotePage } from "../connection";

function Harness({ streaming, events }: { streaming: boolean; events: DaemonEvent[] }) {
  return <ConnectionOverlay c={useConnection(streaming, events, false)} />;
}

const stopping = (reason: string): DaemonEvent => ({ id: 1, type: "daemon.stopping", at: new Date().toISOString(), data: { reason } });

let reported: { phase: string }[];
let starts: number;

beforeEach(() => {
  vi.useFakeTimers();
  reported = [];
  starts = 0;
  window.ue = {
    studioWindow: true,
    studio: {
      restarteditor: async () => false,
      enableplugin: async () => false,
      openprojectfolder: async () => false,
      getstatus: async () => JSON.stringify({ node: true, log: "C:/p/Saved/Logs/UE_MCP_Studio.log" }),
      startdaemon: async () => (++starts, true),
      openlog: async () => true,
      setconnectionstate: async (s: string) => (reported.push(JSON.parse(s)), true),
    },
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete window.ue;
});

const advance = async (ms: number) => {
  for (let t = 0; t < ms; t += 1000) await act(async () => void vi.advanceTimersByTime(1000));
};

describe("the panel while ue-mcp is away", () => {
  it("shows nothing connected, says reconnecting after a moment, and tells the window it is in charge", async () => {
    const { rerender } = render(<Harness streaming events={[]} />);
    expect(reported[0]).toMatchObject({ phase: "connected" });
    rerender(<Harness streaming={false} events={[]} />);
    expect(screen.queryByText("Reconnecting to ue-mcp")).toBeNull();
    // A drop shorter than the quiet window, such as a stream through the relay resuming, shows nothing.
    await advance(QUIET_MS - 1000);
    expect(screen.queryByText("Reconnecting to ue-mcp")).toBeNull();
    await advance(2000);
    expect(screen.getByText("Reconnecting to ue-mcp")).toBeTruthy();
    expect(screen.getByText(/No answer for 5s/)).toBeTruthy();
    rerender(<Harness streaming events={[]} />);
    expect(screen.queryByText("Reconnecting to ue-mcp")).toBeNull();
  });

  it("names a restart and its reason, and starts nothing while it waits", async () => {
    const { rerender } = render(<Harness streaming events={[]} />);
    rerender(<Harness streaming events={[stopping("handed off to a newer daemon")]} />);
    rerender(<Harness streaming={false} events={[stopping("handed off to a newer daemon")]} />);
    await advance(20_000);
    expect(screen.getByText("ue-mcp is restarting on a newer version")).toBeTruthy();
    expect(screen.getByText(/so far/)).toBeTruthy();
    expect(starts).toBe(0);
  });

  it("starts ue-mcp itself after a loss, then needs you with Retry and Open log", async () => {
    const { rerender } = render(<Harness streaming events={[]} />);
    rerender(<Harness streaming={false} events={[]} />);
    await advance(RECONNECT_MS + 1000);
    expect(screen.getByText("Lost connection to ue-mcp")).toBeTruthy();
    await advance(LOST_PAUSE_MS);
    expect(starts).toBe(1);
    expect(screen.getByText("Starting ue-mcp (attempt 1 of 3)")).toBeTruthy();
    await advance(3 * 45_000 + 5000 + 15_000 + 2000);
    expect(starts).toBe(3);
    expect(screen.getByText("ue-mcp is not running")).toBeTruthy();
    expect(screen.getByText(/did not start after 3 attempts/)).toBeTruthy();
    expect(screen.getByText("C:/p/Saved/Logs/UE_MCP_Studio.log")).toBeTruthy();
    expect(screen.getByText("Open log")).toBeTruthy();
    expect(reported.map((r) => r.phase)).toEqual(["connected", "reconnecting", "lost", "starting", "starting", "starting", "needsYou"]);
    fireEvent.click(screen.getByText("Retry"));
    await act(async () => void vi.advanceTimersByTime(0));
    expect(starts).toBe(4);
    expect(screen.getByText("Starting ue-mcp (attempt 1 of 3)")).toBeTruthy();
  });

  it("in a paired browser, waits for ue-mcp on the computer and never asks to run a command there", async () => {
    delete window.ue;
    function Remote({ streaming }: { streaming: boolean }) {
      return <ConnectionOverlay c={useConnection(streaming, [], false, async () => ({ type: "started", ok: false, at: Date.now() }), true)} />;
    }
    const { rerender } = render(<Remote streaming />);
    rerender(<Remote streaming={false} />);
    await advance(RECONNECT_MS + LOST_PAUSE_MS + 2000);
    expect(screen.getByText("ue-mcp on your computer is offline")).toBeTruthy();
    expect(screen.getByText(/reconnects by itself/)).toBeTruthy();
    expect(screen.queryByText(/npx/)).toBeNull();
    expect(screen.queryByText(/cannot start ue-mcp/)).toBeNull();
    expect(screen.getByText("Retry")).toBeTruthy();
    // The computer's ue-mcp answers again: the overlay goes without a click.
    rerender(<Remote streaming />);
    await advance(0);
    expect(screen.queryByText("ue-mcp on your computer is offline")).toBeNull();
  });
});

describe("isRemotePage", () => {
  it("is a paired browser only with no host binding and a page not served from this computer", () => {
    expect(isRemotePage(false, "remote.ue-mcp.com")).toBe(true);
    expect(isRemotePage(false, "127.0.0.1")).toBe(false);
    expect(isRemotePage(false, "localhost")).toBe(false);
    expect(isRemotePage(true, "remote.ue-mcp.com")).toBe(false);
  });
});
