// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import type { ViewportStatus } from "@ue-mcp-studio/shared";
import type { HubLiveVariant, PeerFactory } from "@ue-mcp-studio/client-core";

const status = (s: Partial<ViewportStatus> = {}): ViewportStatus => ({ access: "ok", editor: "ready", streamer: false, source: null, viewers: 0, pie: true, ...s });

const m = vi.hoisted(() => ({
  viewport: vi.fn(),
  joinViewport: vi.fn(),
  viewportSignals: vi.fn(),
  sendViewportSignal: vi.fn(),
  leaveViewport: vi.fn(),
}));
vi.mock("../../api", () => ({ api: m }));
import { HubLive, HubLiveProvider, ViewportButton, useHubLive } from "./live";

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

function Place({ playing, variant = "panel" }: { playing: boolean; variant?: HubLiveVariant }) {
  const live = useHubLive(playing, variant);
  return <div data-testid={`place-${variant}`}><HubLive live={live} /></div>;
}

/** Two placements under one provider, and switches for each. */
function Harness({ start = true, tile = false }: { start?: boolean; tile?: boolean }) {
  const [playing, setPlaying] = useState(start);
  const [shown, setShown] = useState(true);
  return (
    <HubLiveProvider peer={peer}>
      <button onClick={() => setPlaying((p) => !p)}>toggle</button>
      <button onClick={() => setShown((s) => !s)}>screen</button>
      {shown && <Place playing={playing} />}
      {tile && <Place playing={playing} variant="tile" />}
      <ViewportButton relevant={playing} />
    </HubLiveProvider>
  );
}

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  m.viewport.mockResolvedValue(status());
  m.joinViewport.mockResolvedValue({ viewer: "v1", iceServers: [], status: status() });
  let first = true;
  m.viewportSignals.mockImplementation((_v: string, _after: number, signal?: AbortSignal) => {
    if (first) {
      first = false;
      return Promise.resolve({ signals: [{ type: "streamer", connected: true }, { type: "offer", sdp: "o" }], next: 2 });
    }
    return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  });
  m.sendViewportSignal.mockResolvedValue({});
  m.leaveViewport.mockResolvedValue({});
});
afterEach(() => cleanup());

describe("the hub's live viewport", () => {
  it("shows nothing and joins nothing while nothing on screen plays", async () => {
    render(<Harness start={false} tile />);
    await act(async () => undefined);
    expect(screen.queryByLabelText("Play In Editor, live")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(m.joinViewport).not.toHaveBeenCalled();
  });

  it("goes live while the run plays, every placement on one viewer", async () => {
    render(<Harness tile />);
    await waitFor(() => expect(screen.getAllByLabelText("Play In Editor, live")).toHaveLength(2));
    expect(m.joinViewport).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText("Live")).toHaveLength(2);
  });

  it("keeps the viewer when a screen goes and comes back, without joining again", async () => {
    render(<Harness />);
    await waitFor(() => screen.getByLabelText("Play In Editor, live"));
    fireEvent.click(screen.getByText("screen"));
    expect(screen.queryByLabelText("Play In Editor, live")).toBeNull();
    fireEvent.click(screen.getByText("screen"));
    await waitFor(() => screen.getByLabelText("Play In Editor, live"));
    expect(m.joinViewport).toHaveBeenCalledTimes(1);
    expect(m.leaveViewport).not.toHaveBeenCalled();
  });

  it("is gone once the run ends, with no frame kept to show", async () => {
    render(<Harness />);
    await waitFor(() => screen.getByLabelText("Play In Editor, live"));
    fireEvent.click(screen.getByText("toggle"));
    expect(screen.queryByLabelText("Play In Editor, live")).toBeNull();
    expect(screen.queryByText("Run ended")).toBeNull();
  });

  it("opens the full viewer on the same viewer, from the picture or the Viewport button", async () => {
    render(<Harness />);
    await waitFor(() => screen.getByLabelText("Play In Editor, live"));
    fireEvent.click(screen.getByRole("button", { name: "Open Play In Editor" }));
    const dialog = await screen.findByRole("dialog", { name: "Play In Editor" });
    expect(dialog.querySelector("video")).not.toBeNull();
    expect(m.joinViewport).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Close"));
    fireEvent.click(screen.getByRole("button", { name: /Viewport/ }));
    await screen.findByRole("dialog", { name: "Play In Editor" });
    expect(m.joinViewport).toHaveBeenCalledTimes(1);
  });

  it("explains a gate on a panel only, and does not join", async () => {
    m.viewport.mockResolvedValue(status({ editor: "no-editor", pie: false }));
    render(<Harness tile />);
    await screen.findByText("The editor is not running");
    expect(screen.getByRole("button", { name: "Start editor" })).toBeTruthy();
    expect(screen.getByTestId("place-tile").textContent).toBe("");
    expect(m.joinViewport).not.toHaveBeenCalled();
  });

  it("hides the Viewport button when nothing plays and PIE is not running", async () => {
    m.viewport.mockResolvedValue(status({ pie: false }));
    render(<Harness start={false} />);
    await act(async () => undefined);
    expect(screen.queryByRole("button", { name: /Viewport/ })).toBeNull();
  });
});
