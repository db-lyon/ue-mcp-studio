/** Videos in the chat: the limits route, the compress route against a fake encoder, the encoder's arithmetic, and uploads sent in parts. */
import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DaemonExtensionApi } from "ue-mcp/daemon";
import { VIDEO_PLAY_BYTES, VIDEO_PLAY_PAID_BYTES, isVideo, videoOfferText, videoVerdict, type Attachment } from "@ue-mcp-studio/shared";
import { AttachmentStore } from "../src/attachments.js";
import { registerVideoRoutes } from "../src/video-routes.js";
import { durationOf, videoBitrate, widthFor } from "../src/video.js";

type Reply = { status?: number; body?: unknown };
type Handler = (req: { params: Record<string, string>; body?: unknown }) => Reply | Promise<Reply>;

let dir: string;
let store: AttachmentStore;
let routes: Map<string, Handler>;
let encodes: number;

function setup(o: { paid: boolean; ffmpeg: string | null; fail?: string }) {
  routes = new Map();
  encodes = 0;
  const api = { route: (m: string, p: string, h: Handler) => void routes.set(`${m} ${p}`, h) } as unknown as DaemonExtensionApi;
  registerVideoRoutes(api, {
    attachments: store,
    paid: async () => o.paid,
    ffmpeg: () => o.ffmpeg,
    compress: async (_src, dest, bytes) => {
      encodes++;
      if (o.fail) return { ok: false, error: o.fail };
      fs.writeFileSync(dest, Buffer.alloc(Math.min(bytes, 1000), 7));
      return { ok: true, bytes: Math.min(bytes, 1000) };
    },
  });
}

const video = (size: number): Attachment & { path: string } => store.keep("s1", "clip.mp4", "video/mp4", Buffer.alloc(size, 1));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-video-"));
  store = new AttachmentStore(dir);
});

describe("the video limits", () => {
  it("plays 4 MB for everyone and 20 MB on a paid plan, and says whether it can compress", async () => {
    setup({ paid: false, ffmpeg: null });
    expect((await routes.get("GET /video")!({ params: {} })).body).toEqual({ limit: VIDEO_PLAY_BYTES, paid: false, compress: false });
    setup({ paid: true, ffmpeg: "ffmpeg" });
    expect((await routes.get("GET /video")!({ params: {} })).body).toEqual({ limit: VIDEO_PLAY_PAID_BYTES, paid: true, compress: true });
  });

  it("never leaves a dead end: past the limit it offers a smaller copy, and the upgrade where a plan plays it", () => {
    const free = { limit: VIDEO_PLAY_BYTES, paid: false, compress: true };
    expect(videoVerdict(3 * 1024 * 1024, free)).toEqual({ kind: "play" });
    expect(videoVerdict(10 * 1024 * 1024, free)).toEqual({ kind: "offer", upgrade: true });
    expect(videoVerdict(30 * 1024 * 1024, free)).toEqual({ kind: "offer", upgrade: false });
    const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;
    expect(videoOfferText(10 * 1048576, free, mb)).toContain("Compress it");
    expect(videoOfferText(10 * 1048576, { ...free, compress: false }, mb)).toContain("winget install ffmpeg");
  });

  it("knows a video by its type, or by its name when the type is missing", () => {
    expect(isVideo({ type: "video/mp4", name: "a" })).toBe(true);
    expect(isVideo({ type: "", name: "a.MOV" })).toBe(true);
    expect(isVideo({ type: "application/octet-stream", name: "a.webm" })).toBe(true);
    expect(isVideo({ type: "image/png", name: "a.mp4" })).toBe(false);
  });
});

describe("POST .../compress", () => {
  it("keeps a smaller copy as one of the session's files, and answers the same copy when asked again", async () => {
    setup({ paid: false, ffmpeg: "ffmpeg" });
    const a = video(5000);
    const first = await routes.get("POST /sessions/:id/attachments/:aid/compress")!({ params: { id: "s1", aid: a.id } });
    expect(first.status).toBe(201);
    const copy = first.body as Attachment;
    expect(copy).toMatchObject({ name: "clip.small.mp4", type: "video/mp4" });
    expect(store.get("s1", copy.id)).not.toBeNull();
    const again = await routes.get("POST /sessions/:id/attachments/:aid/compress")!({ params: { id: "s1", aid: a.id } });
    expect(again.body).toEqual(copy);
    expect(encodes).toBe(1);
  });

  it("passes on what the encoder said when it cannot, and refuses what is not a video", async () => {
    setup({ paid: false, ffmpeg: null, fail: "No video encoder: install ffmpeg" });
    const a = video(5000);
    const r = await routes.get("POST /sessions/:id/attachments/:aid/compress")!({ params: { id: "s1", aid: a.id } });
    expect(r).toMatchObject({ status: 422, body: { error: expect.stringContaining("install ffmpeg") } });
    const text = store.keep("s1", "a.txt", "text/plain", Buffer.from("hi"));
    expect((await routes.get("POST /sessions/:id/attachments/:aid/compress")!({ params: { id: "s1", aid: text.id } })).status).toBe(415);
  });
});

describe("the encoder's arithmetic", () => {
  it("reads the length from ffmpeg's report and picks a rate and width that fit", () => {
    expect(durationOf("  Duration: 00:01:02.50, start: 0.000000, bitrate: 900 kb/s")).toBeCloseTo(62.5);
    expect(durationOf("no length here")).toBeNull();
    const bps = videoBitrate(4 * 1024 * 1024, 60);
    expect(((bps + 64_000) * 60) / 8).toBeLessThan(4 * 1024 * 1024);
    expect(widthFor(bps)).toBe(640);
    expect(videoBitrate(1024, 3600)).toBe(80_000);
  });
});

describe("uploads in parts", () => {
  it("gathers the parts in order into one file, and refuses a part out of order", () => {
    const whole = Buffer.from("0123456789abcdef");
    const b64 = (b: Buffer) => b.toString("base64");
    const part = (i: number, last: boolean, bytes: Buffer) => store.save("s1", { name: "big.mp4", type: "video/mp4", data: b64(bytes), part: { id: "upload-1", index: i, last } });
    expect(part(0, false, whole.subarray(0, 6))).toBeNull();
    expect(part(1, false, whole.subarray(6, 12))).toBeNull();
    const a = part(2, true, whole.subarray(12))!;
    expect(a).toMatchObject({ name: "big.mp4", size: 16, type: "video/mp4" });
    expect(fs.readFileSync(a.path).equals(whole)).toBe(true);
    expect(() => store.save("s1", { name: "x.mp4", type: "video/mp4", data: b64(whole), part: { id: "upload-2", index: 3, last: true } })).toThrow(/out of order/);
  });
});
