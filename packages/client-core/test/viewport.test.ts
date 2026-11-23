/** The live viewport's viewer: the session against fake routes and a fake peer connection, and what the panel says in each state. */
import { describe, expect, it } from "vitest";
import type { ViewerSignal, ViewportStatus } from "@ue-mcp-studio/shared";
import { HttpError } from "../src/transport.js";
import {
  CONNECTION_FAILED,
  CONNECTION_FAILED_DIRECT,
  CONNECTION_FAILED_NEEDS_PRO,
  LOST_COMPUTER,
  connectionFailed,
  NO_VIDEO,
  ViewportSession,
  isAbort,
  viewerNotice,
  viewportGate,
  type PeerLike,
  type ViewerPhase,
  type ViewportSessionApi,
} from "../src/viewport.js";
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
    // ICE connects a moment after the answer, as a real peer does.
    setTimeout(() => this.connect(), 0);
    return { type: "answer", sdp: `answer to ${this.remote}` };
  }
  connect() {
    this.connectionState = "connected";
    this.emit("connectionstatechange", {});
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

  it("goes live with the video's stream when the audio comes in a stream of its own, and adds the audio to it", async () => {
    // Pixel Streaming 2 sends its audio and video in two streams, and the audio's track event can come last.
    class FakeStream {
      tracks: unknown[];
      constructor(readonly id: string, ...tracks: unknown[]) {
        this.tracks = tracks;
      }
      getTracks() {
        return this.tracks;
      }
      addTrack(t: unknown) {
        this.tracks.push(t);
      }
    }
    const audioTrack = { kind: "audio" };
    const videoTrack = { kind: "video" };
    const audio = new FakeStream("audio", audioTrack);
    const video = new FakeStream("video", videoTrack);
    for (const order of [["audio", "video"], ["video", "audio"]]) {
      const lateAudio = { kind: "audio", id: order[0] };
      class TwoStreamPeer extends FakePeer {
        async setLocalDescription() {
          for (const k of order) {
            if (k === "audio") this.emit("track", { track: audioTrack, streams: [audio] });
            else this.emit("track", { track: videoTrack, streams: [video] });
          }
          this.emit("track", { track: lateAudio, streams: [new FakeStream("audio2", lateAudio)] });
        }
      }
      const phases: ViewerPhase[] = [];
      const f = fakeApi([[{ type: "offer", sdp: "o" }]]);
      const s = new ViewportSession({ api: f.api, source: "pie", onPhase: (p) => phases.push(p), peer: () => new TwoStreamPeer() });
      s.start();
      await until(() => phases.some((p) => p.phase === "live"));
      const lives = phases.filter((p) => p.phase === "live");
      expect(lives.every((p) => p.phase === "live" && p.stream === video)).toBe(true);
      expect(video.tracks).toContain(audioTrack);
      expect(video.tracks).toContain(lateAudio);
      s.stop();
      video.tracks = [videoTrack];
    }
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

  it("sends the answer before any of its candidates, then the candidates one at a time in the order they came", async () => {
    // Candidates fire during setLocalDescription and after; the answer's request is slow, as through the relay.
    class Gathering extends FakePeer {
      async setLocalDescription() {
        this.emit("icecandidate", { candidate: { candidate: "c1", sdpMid: "0", sdpMLineIndex: 0 } });
        this.emit("icecandidate", { candidate: { candidate: "c2", sdpMid: "0", sdpMLineIndex: 0 } });
        this.emit("track", { track: { kind: "video" }, streams: [{ id: "s" }] });
        setTimeout(() => this.emit("icecandidate", { candidate: { candidate: "c3", sdpMid: "0", sdpMLineIndex: 0 } }), 5);
        setTimeout(() => this.emit("icecandidate", { candidate: { candidate: "c4", sdpMid: "0", sdpMLineIndex: 0 } }), 60);
      }
    }
    const order: string[] = [];
    let inFlight = 0;
    let overlapped = false;
    const f = fakeApi([[{ type: "offer", sdp: "o" }]]);
    const api: ViewportSessionApi = {
      ...f.api,
      sendViewportSignal: async (_v, m) => {
        if (++inFlight > 1) overlapped = true;
        await new Promise((r) => setTimeout(r, m.type === "answer" ? 40 : 3));
        order.push(m.type === "answer" ? "answer" : m.candidate.candidate);
        inFlight--;
      },
    };
    const s = new ViewportSession({ api, source: "pie", onPhase: () => undefined, peer: () => new Gathering() });
    s.start();
    await until(() => order.length === 5);
    expect(order).toEqual(["answer", "c1", "c2", "c3", "c4"]);
    expect(overlapped).toBe(false);
    s.stop();
  });

  it("never shows an abort: a cut-short poll is retried, and a stop mid-poll says nothing", async () => {
    const abortError = () => Object.assign(new Error("signal is aborted without reason"), { name: "AbortError" });
    expect(isAbort(abortError())).toBe(true);
    expect(isAbort(new HttpError(500, "boom"))).toBe(false);

    // One cut-short poll, then the signals: the viewer goes live and never says failed.
    const phases: ViewerPhase[] = [];
    const f = fakeApi([[{ type: "offer", sdp: "o" }]]);
    let polls = 0;
    const api: ViewportSessionApi = {
      ...f.api,
      viewportSignals: async (v, after, signal) => {
        if (++polls === 1) throw abortError();
        return f.api.viewportSignals(v, after, signal);
      },
    };
    const s = new ViewportSession({ api, source: "pie", onPhase: (p) => phases.push(p), peer: () => new FakePeer(), retryMs: 1 });
    s.start();
    await until(() => phases.some((p) => p.phase === "live"));
    expect(phases.some((p) => p.phase === "failed")).toBe(false);

    // Stopped while a poll is held: the abort that stop causes is never a phase.
    const before = phases.length;
    s.stop();
    await new Promise((r) => setTimeout(r, 20));
    expect(phases.length).toBe(before);

    // Polls cut short again and again: the panel says the computer stopped answering, never the runtime's words.
    const lost: ViewerPhase[] = [];
    const dead: ViewportSessionApi = { ...fakeApi([]).api, viewportSignals: async () => Promise.reject(abortError()) };
    new ViewportSession({ api: dead, source: "pie", onPhase: (p) => lost.push(p), peer: () => new FakePeer(), retryMs: 1 }).start();
    await until(() => lost.at(-1)?.phase === "failed");
    expect(lost.at(-1)).toEqual({ phase: "failed", error: LOST_COMPUTER });
  });

  it("sends the answer again when its request is cut short", async () => {
    const sent: string[] = [];
    let tries = 0;
    const f = fakeApi([[{ type: "offer", sdp: "o" }]]);
    const phases: ViewerPhase[] = [];
    const api: ViewportSessionApi = {
      ...f.api,
      sendViewportSignal: async (_v, m) => {
        if (m.type === "answer" && ++tries === 1) throw Object.assign(new Error("signal is aborted without reason"), { name: "AbortError" });
        sent.push(m.type);
      },
    };
    const s = new ViewportSession({ api, source: "pie", onPhase: (p) => phases.push(p), peer: () => new FakePeer(), retryMs: 1 });
    s.start();
    await until(() => sent.includes("iceCandidate") && phases.some((p) => p.phase === "live"));
    expect(tries).toBe(2);
    expect(sent).toEqual(["answer", "iceCandidate"]);
    expect(phases.some((p) => p.phase === "failed")).toBe(false);
    s.stop();
  });

  it("gives up on a connection that never connects, and says whether the relay was tried", async () => {
    class Stuck extends FakePeer {
      connect() {}
    }
    const stun = { urls: "stun:stun.example:3478" };
    const turn = { urls: ["turn:turn.example:3478?transport=udp"], username: "u", credential: "c" };
    for (const [iceServers, access, expected] of [
      [[stun], "needs-pro", { phase: "failed", error: CONNECTION_FAILED_NEEDS_PRO, needsPro: true }],
      [[stun], "ok", { phase: "failed", error: CONNECTION_FAILED_DIRECT }],
      [[stun, turn], "ok", { phase: "failed", error: CONNECTION_FAILED }],
    ] as const) {
      const phases: ViewerPhase[] = [];
      const f = fakeApi([[{ type: "offer", sdp: "o" }]], { join: async () => ({ viewer: "v", iceServers: iceServers as never, status: { access } as ViewportStatus }) });
      const peers: Stuck[] = [];
      const s = new ViewportSession({ api: f.api, source: "pie", onPhase: (p) => phases.push(p), peer: () => (peers.push(new Stuck()), peers.at(-1)!), connectMs: 20 });
      s.start();
      await until(() => phases.at(-1)?.phase === "failed");
      expect(phases.at(-1)).toEqual(expected);
      // Never live: a track without a connection is a black screen.
      expect(phases.some((p) => p.phase === "live")).toBe(false);
      expect(peers[0].closed).toBe(true);
      s.stop();
    }
  });

  it("says so when the connection carries no video, and stays live when frames arrive", async () => {
    const stats = (frames: number) => async () => new Map([["v", { type: "inbound-rtp", kind: "video", framesDecoded: frames }]]);
    class Silent extends FakePeer {
      getStats = stats(0);
    }
    const phases: ViewerPhase[] = [];
    const s = new ViewportSession({ api: fakeApi([[{ type: "offer", sdp: "o" }]]).api, source: "pie", onPhase: (p) => phases.push(p), peer: () => new Silent(), framesMs: 30 });
    s.start();
    await until(() => phases.at(-1)?.phase === "failed");
    expect(phases.at(-1)).toEqual({ phase: "failed", error: NO_VIDEO });
    s.stop();

    class Playing extends FakePeer {
      getStats = stats(3);
    }
    const ok: ViewerPhase[] = [];
    const t = new ViewportSession({ api: fakeApi([[{ type: "offer", sdp: "o" }]]).api, source: "pie", onPhase: (p) => ok.push(p), peer: () => new Playing(), framesMs: 30 });
    t.start();
    await until(() => ok.some((p) => p.phase === "live"));
    await new Promise((r) => setTimeout(r, 80));
    expect(ok.at(-1)?.phase).toBe("live");
    t.stop();
  });
});

describe("what the viewport panel says", () => {
  const status = (s: Partial<ViewportStatus>): ViewportStatus => ({ access: "ok", editor: "ready", streamer: false, source: null, viewers: 0, ...s });

  it("never leaves a gate without a way forward", () => {
    const states: Array<Partial<ViewportStatus>> = [
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
    // Watching is free on every plan: no account state stops a viewer.
    for (const access of ["signed-out", "needs-pro", "unreachable"] as const) expect(viewportGate(status({ access }), { remote: true })).toBeNull();
  });

  it("points an account without Pro at the plans page when a direct connection fails, and offers the level viewport while waiting for PIE", () => {
    const failed = viewerNotice(connectionFailed(false, "needs-pro"), "pie", { remote: true })!;
    expect(failed.title).toBe("Could not connect directly");
    expect(failed.body).toMatch(/different network/);
    expect(failed.body).toMatch(/Pro plan/);
    expect(failed.actions.map((a) => a.id)).toEqual(["watch", "plans"]);
    expect(viewerNotice(connectionFailed(false, "ok"), "pie", { remote: true })!.actions.map((a) => a.id)).toEqual(["watch"]);
    expect(viewerNotice(connectionFailed(true, "ok"), "pie", { remote: true })!.body).toBe(CONNECTION_FAILED);
    expect(viewerNotice({ phase: "waiting" }, "pie", { remote: true })!.actions.map((a) => a.id)).toEqual(["level-viewport"]);
  });

  it("lands an old Viewport tab link on Chat", () => {
    expect(parseLocation("#/viewport")).toEqual({ tab: "Chat", session: null, section: null });
    expect(parseLocation("#/viewport/anything").tab).toBe("Chat");
    expect(formatLocation(parseLocation("#/viewport"))).toBe("#/chat");
  });
});
