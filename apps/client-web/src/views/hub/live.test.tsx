// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import type { ViewportStatus } from "@ue-mcp-studio/shared";
import type { PeerFactory, PlayingRun } from "@ue-mcp-studio/client-core";

const status = (s: Partial<ViewportStatus> = {}): ViewportStatus => ({ access: "ok", editor: "ready", streamer: false, source: null, viewers: 0, pie: true, ...s });

const m = vi.hoisted(() => ({
  viewport: vi.fn(),
  joinViewport: vi.fn(),
  viewportSignals: vi.fn(),
  sendViewportSignal: vi.fn(),
  leaveViewport: vi.fn(),
}));
vi.mock("../../api", () => ({ api: m }));
import { HubLiveProvider, HubViewer, ViewportButton, useHubViewer } from "./live";

/** A peer that answers and goes live at once with a stand-in stream. */
const peer: PeerFactory = () => {
  const on = new Map<string, (e: unknown) => void>();
  const pc = {
    connectionState: "new",
    addEventListener: (t: string, f: (e: unknown) => void) => on.set(t, f),
    setRemoteDescription: async () => undefined,
    createAnswer: async () => ({ type: "answer", sdp: "a" }),
    setLocalDescription: async () => {
      setTimeout(() => {
        const stream = { getTracks: () => [] };
        on.get("track")?.({ track: { kind: "video" }, streams: [stream] });
        pc.connectionState = "connected";
        on.get("connectionstatechange")?.({});
      }, 0);
    },
    addIceCandidate: async () => undefined,
    close: () => undefined,
  };
  return pc;
};

const RUN: PlayingRun = { runId: "r1", checkId: "script:/Game/T/Door", name: "Door opens" };

function Card({ running, id }: { running: PlayingRun | null; id: string }) {
  const viewer = useHubViewer(running);
  return <div data-testid={id}><HubViewer viewer={viewer} /></div>;
}

/** Two screens' cards under one provider, and switches for the run and for one screen. */
function Harness({ start = false, two = false }: { start?: boolean; two?: boolean }) {
  const [playing, setPlaying] = useState(start);
  const [shown, setShown] = useState(true);
  return (
    <HubLiveProvider peer={peer}>
      <button onClick={() => setPlaying((p) => !p)}>toggle</button>
      <button onClick={() => setShown((s) => !s)}>screen</button>
      {shown && <Card id="a" running={playing ? RUN : null} />}
      {two && <Card id="b" running={playing ? RUN : null} />}
      <ViewportButton relevant={playing} />
    </HubLiveProvider>
  );
}

/** A streamer that is up: the first poll brings its offer. `pie: false` keeps it waiting for Play In Editor. */
function streamer(pie = true) {
  let first = true;
  m.viewportSignals.mockImplementation((_v: string, _after: number, signal?: AbortSignal) => {
    if (first) {
      first = false;
      return Promise.resolve(pie ? { signals: [{ type: "streamer", connected: true }, { type: "offer", sdp: "o" }], next: 2 } : { signals: [{ type: "streamer", connected: false }], next: 1 });
    }
    return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  });
}

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  m.viewport.mockResolvedValue(status());
  m.joinViewport.mockResolvedValue({ viewer: "v1", iceServers: [], status: status() });
  streamer();
  m.sendViewportSignal.mockResolvedValue({});
  m.leaveViewport.mockResolvedValue({});
});
afterEach(() => cleanup());

const watch = (id = "a") => fireEvent.click(within(screen.getByTestId(id)).getByRole("button", { name: "Watch" }));

describe("the hub's Viewport card", () => {
  it("is not on the screen while none of its checks runs, and comes and goes with the run", async () => {
    render(<Harness />);
    await act(async () => undefined);
    expect(screen.queryByRole("region", { name: "Viewport" })).toBeNull();
    fireEvent.click(screen.getByText("toggle"));
    await screen.findByRole("region", { name: "Viewport" });
    expect(m.joinViewport).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("toggle"));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Viewport" })).toBeNull());
  });

  it("marks the screen's check running now, collapsed, without connecting", async () => {
    render(<Harness start />);
    await screen.findByText("Running now");
    expect(screen.getByText("Door opens")).toBeTruthy();
    await act(async () => undefined);
    expect(m.joinViewport).not.toHaveBeenCalled();
  });

  it("expands to the live picture, every card on one viewer", async () => {
    render(<Harness start two />);
    watch();
    await waitFor(() => expect(screen.getAllByLabelText("Play In Editor, live")).toHaveLength(2));
    expect(m.joinViewport).toHaveBeenCalledTimes(1);
  });

  it("shows the waiting notice, not a black box, when Play In Editor is not running", async () => {
    m.viewport.mockResolvedValue(status({ pie: false }));
    streamer(false);
    render(<Harness start />);
    watch();
    await screen.findByText("Waiting for Play In Editor");
    expect(screen.queryByLabelText("Play In Editor, live")).toBeNull();
    // The hub shows Play In Editor only: no source switch.
    expect(screen.queryByRole("button", { name: "Show the level viewport" })).toBeNull();
  });

  it("explains a gate with its ways forward, and does not join", async () => {
    m.viewport.mockResolvedValue(status({ editor: "plugin-off", pie: false }));
    render(<Harness start />);
    watch();
    await screen.findByText("Pixel Streaming 2 is off");
    expect(screen.getByRole("button", { name: "Enable Pixel Streaming 2" })).toBeTruthy();
    expect(m.joinViewport).not.toHaveBeenCalled();
  });

  it("keeps the viewer when a screen goes and comes back, and leaves only after the grace period once hidden", async () => {
    render(<Harness start />);
    watch();
    await waitFor(() => screen.getByLabelText("Play In Editor, live"));
    fireEvent.click(screen.getByText("screen"));
    fireEvent.click(screen.getByText("screen"));
    // Expanded is the hub's: the screen comes back expanded, on the same viewer.
    await waitFor(() => screen.getByLabelText("Play In Editor, live"));
    expect(m.joinViewport).toHaveBeenCalledTimes(1);
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole("button", { name: "Hide" }));
      expect(screen.queryByLabelText("Play In Editor, live")).toBeNull();
      expect(m.leaveViewport).not.toHaveBeenCalled();
      await act(async () => {
        vi.advanceTimersByTime(16_000);
      });
      expect(m.leaveViewport).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens the full viewer on the same viewer, from the card or a row's Viewport button", async () => {
    render(<Harness start />);
    watch();
    await waitFor(() => screen.getByLabelText("Play In Editor, live"));
    fireEvent.click(within(screen.getByRole("region", { name: "Viewport" })).getAllByRole("button", { name: "Open Play In Editor" })[0]);
    const dialog = await screen.findByRole("dialog", { name: "Play In Editor" });
    expect(dialog.querySelector("video")).not.toBeNull();
    expect(m.joinViewport).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Close"));
    fireEvent.click(screen.getByRole("button", { name: /^Viewport$/ }));
    await screen.findByRole("dialog", { name: "Play In Editor" });
    expect(m.joinViewport).toHaveBeenCalledTimes(1);
  });

  it("hides a row's Viewport button when nothing plays and PIE is not running", async () => {
    m.viewport.mockResolvedValue(status({ pie: false }));
    render(<Harness />);
    await act(async () => undefined);
    expect(screen.queryByRole("button", { name: /^Viewport$/ })).toBeNull();
  });
});
