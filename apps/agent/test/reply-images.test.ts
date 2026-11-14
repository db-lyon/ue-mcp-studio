/**
 * The images a reply shows: what the daemon reads of each from its header
 * (type, size, frames) and the poster it makes of the first frame, for GIF,
 * animated and still WebP, PNG and JPEG.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import * as jpeg from "jpeg-js";
import { GifWriter } from "omggif";
import { POSTER_MAX_BYTES, POSTER_MIN_BYTES, replyImagePaths } from "@ue-mcp-studio/shared";
import { decodeImage, imageFacts, makePoster, webpFirstFrame } from "../src/images.js";
import { imageInfoOf, posterFor, replyImages } from "../src/reply-images.js";
import { AgentRunner } from "../src/runner.js";
import { SessionStore } from "../src/sessions.js";
import type { ModelProvider } from "../src/providers.js";
import type { AgentHost } from "../src/tools.js";
import { jpegBytes, pngBytes } from "./image-fixtures.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-reply-img-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A GIF of `frames` frames of noise, so it does not compress away. */
function animatedGif(width: number, height: number, frames: number): Buffer {
  const buf = Buffer.alloc(width * height * frames * 2 + 4096);
  const w = new GifWriter(buf, width, height, { loop: 0, palette: [0x101010, 0xe8720c, 0x3a3d45, 0xffffff] });
  let seed = 7;
  const noise = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 16) & 3;
  for (let f = 0; f < frames; f++) w.addFrame(0, 0, width, height, Array.from({ length: width * height }, noise), { delay: 10 });
  return buf.subarray(0, w.end());
}

async function encoder() {
  const req = createRequire(import.meta.url);
  const enc = await import("@jsquash/webp/encode.js");
  await enc.init(await WebAssembly.compile(new Uint8Array(fs.readFileSync(req.resolve("@jsquash/webp/codec/enc/webp_enc.wasm")))));
  return enc.default;
}

/** A still WebP of one colour; with alpha below 255 it carries an ALPH chunk. */
async function stillWebp(width: number, height: number, rgba: [number, number, number, number]): Promise<Buffer> {
  const encode = await encoder();
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
  return Buffer.from(await encode({ data, width, height, colorSpace: "srgb" } as ImageData, { quality: 80 }));
}

const chunk = (id: string, body: Buffer): Buffer => {
  const head = Buffer.alloc(8);
  head.write(id, 0, "ascii");
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body, body.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
};

/** The frame chunks (ALPH, VP8 or VP8L) of a still WebP, as an ANMF frame carries them. */
function frameData(still: Buffer): Buffer {
  const out: Buffer[] = [];
  for (let i = 12; i + 8 <= still.length; ) {
    const id = still.toString("ascii", i, i + 4);
    const size = still.readUInt32LE(i + 4);
    if (id !== "VP8X") out.push(chunk(id, still.subarray(i + 8, i + 8 + size)));
    i += 8 + size + (size & 1);
  }
  return Buffer.concat(out);
}

/** An animated WebP of the given stills, each a full-canvas frame. */
function animatedWebp(width: number, height: number, stills: Buffer[], alpha: boolean): Buffer {
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x02 | (alpha ? 0x10 : 0);
  vp8x.writeUIntLE(width - 1, 4, 3);
  vp8x.writeUIntLE(height - 1, 7, 3);
  const anim = Buffer.alloc(6);
  const frames = stills.map((s) => {
    const head = Buffer.alloc(16);
    head.writeUIntLE(width - 1, 6, 3);
    head.writeUIntLE(height - 1, 9, 3);
    head.writeUIntLE(100, 12, 3);
    return chunk("ANMF", Buffer.concat([head, frameData(s)]));
  });
  const body = Buffer.concat([Buffer.from("WEBP"), chunk("VP8X", vp8x), chunk("ANIM", anim), ...frames]);
  const riff = Buffer.alloc(8);
  riff.write("RIFF", 0, "ascii");
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

/** A PNG with an acTL chunk, as an animated PNG starts: only its header matters here. */
function apngHeader(width: number, height: number, frames: number): Buffer {
  const png = pngBytes(width, height);
  const actl = Buffer.alloc(20);
  actl.writeUInt32BE(8, 0);
  actl.write("acTL", 4, "ascii");
  actl.writeUInt32BE(frames, 8);
  actl.writeUInt32BE(0, 12);
  // IHDR is 8 + 25 bytes from the signature.
  return Buffer.concat([png.subarray(0, 33), actl, png.subarray(33)]);
}

describe("what an image's header says", () => {
  it("reads a GIF's size and frames, and calls more than one frame animated", () => {
    expect(imageFacts(animatedGif(720, 366, 6))).toEqual({ type: "image/gif", width: 720, height: 366, frames: 6, animated: true });
    expect(imageFacts(animatedGif(32, 16, 1))).toEqual({ type: "image/gif", width: 32, height: 16, frames: 1, animated: false });
  });

  it("reads a PNG's IHDR, and an animated PNG's frame count from acTL", () => {
    expect(imageFacts(pngBytes(640, 360))).toEqual({ type: "image/png", width: 640, height: 360, frames: 1, animated: false });
    expect(imageFacts(apngHeader(64, 32, 12))).toEqual({ type: "image/png", width: 64, height: 32, frames: 12, animated: true });
  });

  it("reads a JPEG's frame header", () => {
    expect(imageFacts(jpegBytes(1280, 720))).toEqual({ type: "image/jpeg", width: 1280, height: 720, frames: 1, animated: false });
  });

  it("reads a still WebP and an animated one with its frames", async () => {
    const red = await stillWebp(90, 40, [220, 30, 30, 255]);
    const blue = await stillWebp(90, 40, [30, 30, 220, 255]);
    expect(imageFacts(red)).toEqual({ type: "image/webp", width: 90, height: 40, frames: 1, animated: false });
    expect(imageFacts(animatedWebp(90, 40, [red, blue, red], false))).toEqual({ type: "image/webp", width: 90, height: 40, frames: 3, animated: true });
  });

  it("gives null for what is no image or is cut short", () => {
    expect(imageFacts(Buffer.from("plain text, not a picture"))).toBeNull();
    expect(imageFacts(pngBytes(10, 10).subarray(0, 12))).toBeNull();
  });
});

describe("posters", () => {
  const sizeOf = (b: Buffer) => {
    const d = jpeg.decode(b);
    return [d.width, d.height];
  };

  it("makes a GIF's first frame a JPEG within the poster's edge and bytes", async () => {
    // Noise needs more than the bytes allow at 480, so it comes out smaller, its aspect kept.
    const poster = await makePoster(animatedGif(720, 366, 4), "image/gif", 480, POSTER_MAX_BYTES);
    const [w, h] = sizeOf(poster);
    expect(w).toBeLessThan(480);
    expect(w / h).toBeCloseTo(720 / 366, 1);
    expect(poster.length).toBeLessThanOrEqual(POSTER_MAX_BYTES);
  });

  it("makes an animated WebP's first frame, alpha laid on the dark tile", async () => {
    const red = await stillWebp(60, 30, [220, 30, 30, 128]);
    const blue = await stillWebp(60, 30, [30, 30, 220, 128]);
    const anim = animatedWebp(60, 30, [red, blue], true);
    const first = webpFirstFrame(anim);
    expect(first).not.toBeNull();
    const decoded = await decodeImage(anim, "image/webp");
    expect([decoded.width, decoded.height]).toEqual([60, 30]);
    // The first frame is the red one.
    expect(decoded.data[0]).toBeGreaterThan(decoded.data[2]);
    const poster = await makePoster(anim, "image/webp", 480, POSTER_MAX_BYTES);
    const px = jpeg.decode(poster);
    expect([px.width, px.height]).toEqual([60, 30]);
    expect(px.data[3]).toBe(255);
    expect(px.data[0]).toBeGreaterThan(px.data[2]);
    expect(px.data[0]).toBeLessThan(200);
  });

  it("makes a PNG's and a JPEG's, shrinking a large noisy one until it fits", async () => {
    const noisy = await makePoster(pngBytes(1600, 900, { noise: true }), "image/png", 480, POSTER_MAX_BYTES);
    expect(noisy.length).toBeLessThanOrEqual(POSTER_MAX_BYTES);
    expect(sizeOf(noisy)[0]).toBeLessThanOrEqual(480);
    expect(sizeOf(await makePoster(jpegBytes(1280, 720), "image/jpeg", 480, POSTER_MAX_BYTES))).toEqual([480, 270]);
  });

  it("keeps a poster by the file's path, size and time, so a changed file gets a new one", async () => {
    const file = path.join(dir, "cap.gif");
    const kept = path.join(dir, "posters");
    fs.writeFileSync(file, animatedGif(200, 100, 3));
    const first = await posterFor(file, kept);
    expect(fs.readdirSync(kept)).toHaveLength(1);
    expect(Buffer.compare(await posterFor(file, kept), first)).toBe(0);
    fs.writeFileSync(file, animatedGif(300, 100, 3));
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    const second = await posterFor(file, kept);
    expect(sizeOf(second)).toEqual([300, 100]);
    expect(fs.readdirSync(kept)).toHaveLength(2);
  });
});

describe("the images a reply shows", () => {
  it("finds each project image in the markdown once, and leaves web images out", () => {
    const text = [
      "![Charge attack](Saved/Captures/ChargeAttack_Sequence.gif)",
      "![again](Saved/Captures/ChargeAttack_Sequence.gif \"title\")",
      "![spaced](<Saved/My Shots/a b.png>)",
      "![web](https://example.com/x.png)",
      "![escaped](Saved/Shots/a%20c.jpg)",
      "[not an image](Saved/x.png)",
    ].join("\n");
    expect(replyImagePaths(text)).toEqual(["Saved/Captures/ChargeAttack_Sequence.gif", "Saved/My Shots/a b.png", "Saved/Shots/a c.jpg"]);
  });

  it("sends what each readable one is, a poster for a large one, and nothing for a missing one", async () => {
    const project = path.join(dir, "Game");
    fs.mkdirSync(path.join(project, "Saved", "Captures"), { recursive: true });
    const big = animatedGif(720, 366, 8);
    expect(big.length).toBeGreaterThanOrEqual(POSTER_MIN_BYTES);
    fs.writeFileSync(path.join(project, "Saved", "Captures", "run.gif"), big);
    fs.writeFileSync(path.join(project, "Saved", "Captures", "small.png"), pngBytes(64, 32));
    const kept = path.join(dir, "posters");
    const images = replyImages("![run](Saved/Captures/run.gif)\n![small](Saved/Captures/small.png)\n![gone](Saved/missing.jpg)", { projectDir: project, home: dir }, kept);
    expect(images).toEqual({
      "Saved/Captures/run.gif": { type: "image/gif", width: 720, height: 366, bytes: big.length, frames: 8, animated: true, poster: true },
      "Saved/Captures/small.png": { type: "image/png", width: 64, height: 32, bytes: fs.statSync(path.join(project, "Saved", "Captures", "small.png")).size, frames: 1, animated: false },
    });
    expect(replyImages("No pictures here.", { projectDir: project, home: dir }, kept)).toBeUndefined();
    // The poster was started with the reply: asking for it now is answered from the folder.
    await expect.poll(() => (fs.existsSync(kept) ? fs.readdirSync(kept).length : 0)).toBe(1);
    expect(imageInfoOf(path.join(project, "Saved", "missing.jpg"))).toBeNull();
  });

  it("goes out with the reply's transcript entry, as it is kept and as it is published", async () => {
    const project = path.join(dir, "Game");
    fs.mkdirSync(path.join(project, "Saved"), { recursive: true });
    fs.writeFileSync(path.join(project, "Saved", "shot.jpg"), jpegBytes(320, 180));
    const published: Array<{ type: string; data?: Record<string, unknown> }> = [];
    const host = {
      projectDir: project,
      dataDir: path.join(dir, "data"),
      log: { info() {}, warn() {} },
      events: { publish: (type: string, data?: Record<string, unknown>) => void published.push({ type, data }), subscribe: () => () => {} },
      callAction: async () => ({ isError: false, content: [{ type: "text", text: "{}" }] }),
      editors: () => [],
      editorOperation: async (op: string) => ({ op, steps: [] }),
      setBusy() {},
    } as unknown as AgentHost;
    const store = new SessionStore(path.join(dir, "data"));
    const model = { run: async () => ({ content: [{ type: "text", text: "Here it is.\n![The shot](Saved/shot.jpg)", citations: null }], stopReason: "end_turn" }) } as unknown as ModelProvider;
    const r = new AgentRunner({ host, store, provider: () => model, model: () => "claude-opus-5-5", replyImages: (text) => replyImages(text, { projectDir: project, home: dir }) });
    const s = store.create();
    await r.send(s.id, "show me");
    const reply = store.get(s.id)!.transcript.find((e) => e.kind === "assistant");
    const info = { type: "image/jpeg", width: 320, height: 180, bytes: fs.statSync(path.join(project, "Saved", "shot.jpg")).size, frames: 1, animated: false };
    expect(reply).toMatchObject({ kind: "assistant", images: { "Saved/shot.jpg": info } });
    const added = published.filter((e) => e.type === "transcript.added").map((e) => e.data?.entry as { kind: string; images?: unknown });
    expect(added.find((e) => e.kind === "assistant")?.images).toEqual({ "Saved/shot.jpg": info });
  });
});
