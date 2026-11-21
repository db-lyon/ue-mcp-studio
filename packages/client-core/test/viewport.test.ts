/** The live viewport's viewer: the session against fake routes and a fake peer connection, and what the panel says in each state. */
import { describe, expect, it } from "vitest";
import type { ViewerSignal, ViewportStatus } from "@ue-mcp-studio/shared";
import { HttpError } from "../src/transport.js";
import { ViewportSession, viewerNotice, viewportGate, type PeerLike, type ViewerPhase, type ViewportSessionApi } from "../src/viewport.js";
import { formatLocation, parseLocation } from "../src/location.js";

class FakePeer implements PeerLike {
  listeners = new Map<string, Array<(e: any) => void>>();
  remote: string | null = null;
  candidates: string[] = [];
  closed = false;
  connectionState = "new";
  async setRemoteDescription(d: { sdp: string }) {
    this.remote = d.sdp;
  }
  async createAnswer() {
    return { type: "answer", sdp: `answer to ${this.remote}` };
  }
  async setLocalDescription() {
    this.emit("icecandidate", { candidate: { candidate: "candidate:viewer", sdpMid: "0", sdpMLineIndex: 0 } });
    this.emit("track", { streams: [{ id: `stream for ${this.remote}` }] });
  }
  async addIceCandidate(c: { candidate: string }) {
    this.candidates.push(c.candidate);
  }
  addEventListener(type: string, l: (e: any) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), l]);
  }
  emit(type: string, e: unknown) {
    for (const l of this.listeners.get(type) ?? []) l(e);
  }
  close() {
    this.closed = true;
  }
}

/** Routes that hand out queued batches of signals, one per poll, then hold. */
function fakeApi(batches: ViewerSignal[][], o: { join?: () => Promise<{ viewer: string; iceServers: []; status: ViewportStatus }> } = {}) {
  const sent: unknown[] = [];
  const left: string[] = [];
  let joins = 0;
  const api: ViewportSessionApi = {
    joinViewport: async () => (joins++, o.join ? o.join() : { viewer: `v${joins}`, iceServers: [], status: {} as ViewportStatus }),
    viewportSignals: async (_v, after, signal) => {
      const b = batches.shift();
      if (b) return { signals: b, next: after + b.length };
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve()));
      throw new Error("aborted");
    },
    sendViewportSignal: async (_v, m) => void sent.push(m),
    leaveViewport: async (v) => void left.push(v),
  };
  return { api, sent, left, joins: () => joins };
}

const until = async (f: () => boolean) => {
  for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(f()).toBe(true);
};

describe("the viewer session", () => {
  it("waits for the streamer, answers its offer, sends its candidates, takes the streamer's, and goes live", async () => {
    const peers: FakePeer[] = [];
    const phases: ViewerPhase[] = [];
    const f = fakeApi([
      [{ type: "streamer", connected: false }],
      [{ type: "streamer", connected: true }, { type: "offer", sdp: "offer-1" }, { type: "iceCandidate", candidate: { candidate: "candidate:editor" } }],
    ]);
    const s = new ViewportSession({ api: f.api, source: "pie", onPhase: (p) => phases.push(p), peer: () => (peers.push(new FakePeer()), peers.at(-1)!) });
    s.start();
    await until(() => phases.some((p) => p.phase === "live") && peers[0]?.candidates.length === 1);
    expect(phases.map((p) => p.phase).slice(0, 3)).toEqual(["joining", "waiting", "connecting"]);
    expect(f.sent).toContainEqual({ type: "answer", sdp: "answer to offer-1" });
    expect(f.sent).toContainEqual({ type: "iceCandidate", candidate: { candidate: "candidate:viewer", sdpMid: "0", sdpMLineIndex: 0 } });
    expect(peers[0].candidates).toEqual(["candidate:editor"]);
    s.stop();
    expect(peers[0].closed).toBe(true);
    expect(f.left).toEqual(["v1"]);
  });

  it("closes the peer when PIE stops and answers the next offer on a new one", async () => {
    const peers: FakePeer[] = [];
    const phases: ViewerPhase[] = [];
    const f = fakeApi([[{ type: "offer", sdp: "a" }], [{ type: "streamer", connected: false }], [{ type: "offer", sdp: "b" }]]);
    const s = new ViewportSession({ api: f.api, source: "pie", onPhase: (p) => phases.push(p), peer: () => (peers.push(new FakePeer()), peers.at(-1)!) });
    s.start();
    await until(() => peers.length === 2 && phases.at(-1)?.phase === "live");
    expect(peers[0].closed).toBe(true);
    expect(phases.map((p) => p.phase)).toContain("waiting");
    s.stop();
  });

  it("says why a join was refused, and joins again once when the computer forgets the viewer", async () => {
    const needsPro = { access: "needs-pro", editor: "ready", streamer: false, source: null, viewers: 0 } as ViewportStatus;
    const phases: ViewerPhase[] = [];
    const refused = fakeApi([], { join: async () => Promise.reject(new HttpError(403, "Needs Pro", { status: needsPro })) });
    new ViewportSession({ api: refused.api, source: "pie", onPhase: (p) => phases.push(p), peer: () => new FakePeer() }).start();
    await until(() => phases.at(-1)?.phase === "refused");
    expect(phases.at(-1)).toEqual({ phase: "refused", error: "Needs Pro", status: needsPro });

    let polls = 0;
    const f = fakeApi([]);
    const api: ViewportSessionApi = {
      ...f.api,
      viewportSignals: async (v, after, signal) => {
        if (++polls === 1) throw new HttpError(404, "gone");
        return f.api.viewportSignals(v, after, signal);
      },
    };
    const s = new ViewportSession({ api, source: "pie", onPhase: () => undefined, peer: () => new FakePeer() });
    s.start();
    await until(() => f.joins() === 2);
    s.stop();
    expect(f.left).toEqual(["v2"]);
  });

  it("stops on an ended signal and says so", async () => {
    const phases: ViewerPhase[] = [];
    const f = fakeApi([[{ type: "ended", reason: "Stopped in the editor." }]]);
    new ViewportSession({ api: f.api, source: "pie", onPhase: (p) => phases.push(p), peer: () => new FakePeer() }).start();
    await until(() => phases.at(-1)?.phase === "ended");
    expect(viewerNotice(phases.at(-1)!, "pie", { remote: true })).toMatchObject({ title: "The stream ended", body: "Stopped in the editor.", actions: [{ id: "watch" }] });
  });
});

describe("what the viewport panel says", () => {
  const status = (s: Partial<ViewportStatus>): ViewportStatus => ({ access: "ok", editor: "ready", streamer: false, source: null, viewers: 0, ...s });

  it("never leaves a gate without a way forward", () => {
    const states: Array<Partial<ViewportStatus>> = [
      { access: "signed-out" },
      { access: "needs-pro" },
      { access: "unreachable" },
      { editor: "no-editor" },
      { editor: "no-actions" },
      { editor: "plugin-off" },
      { editor: "plugin-restart" },
      { editor: "unavailable", detail: "No encoder." },
    ];
    for (const remote of [false, true]) {
      for (const s of states) {
        const n = viewportGate(status(s), { remote });
        expect(n, JSON.stringify(s)).not.toBeNull();
        expect(n!.actions.length, JSON.stringify(s)).toBeGreaterThan(0);
        expect(`${n!.title} ${n!.body}`).not.toMatch(/—/);
      }
    }
    expect(viewportGate(status({}), { remote: false })).toBeNull();
  });

  it("points a free account at the plans page while Pro is not on sale, and offers the level viewport while waiting for PIE", () => {
    const pro = viewportGate(status({ access: "needs-pro" }), { remote: true })!;
    expect(pro.actions.map((a) => a.id)).toEqual(["plans", "check"]);
    expect(pro.body).toMatch(/not on sale yet/);
    expect(viewerNotice({ phase: "waiting" }, "pie", { remote: true })!.actions.map((a) => a.id)).toEqual(["level-viewport"]);
    expect(viewportGate(status({ access: "signed-out" }), { remote: true })!.actions.map((a) => a.id)).toEqual(["check"]);
  });

  it("keeps the tab in the location", () => {
    expect(parseLocation("#/viewport").tab).toBe("Viewport");
    expect(formatLocation({ tab: "Viewport", session: null, section: null })).toBe("#/viewport");
  });
});
