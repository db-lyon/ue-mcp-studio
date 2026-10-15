/**
 * Images the model is shown: read from disk or an editor call, sized for
 * every provider, and carried through each provider's request format.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import type { ActionResult } from "ue-mcp/daemon";
import { MAX_IMAGE_BYTES, MAX_IMAGE_EDGE, decodeImage, downscale, fitSize, prepareImage, sniffImage, toolResultContent } from "../src/images.js";
import { readFile } from "../src/local-tools.js";
import { resultImages } from "../src/tools.js";
import { toChatRequest } from "../src/openai-compat.js";
import { toResponsesRequest } from "../src/responses.js";
import { requestBody, type MessageParam } from "../src/providers.js";
import { gifBytes, jpegBytes, pngBytes } from "./image-fixtures.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-img-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function webpBytes(width: number, height: number): Promise<Buffer> {
  const req = createRequire(import.meta.url);
  const enc = await import("@jsquash/webp/encode.js");
  await enc.init(await WebAssembly.compile(new Uint8Array(fs.readFileSync(req.resolve("@jsquash/webp/codec/enc/webp_enc.wasm")))));
  const data = new Uint8ClampedArray(width * height * 4).fill(180);
  return Buffer.from(await enc.default({ data, width, height, colorSpace: "srgb" } as ImageData, { quality: 80 }));
}

describe("image headers", () => {
  it("knows PNG, JPEG, GIF and WebP by their bytes, and decodes each to its size", async () => {
    const webp = await webpBytes(33, 17);
    const cases: Array<[Buffer, string]> = [[pngBytes(40, 20), "image/png"], [jpegBytes(41, 21), "image/jpeg"], [gifBytes(42, 22), "image/gif"], [webp, "image/webp"]];
    const sizes = [[40, 20], [41, 21], [42, 22], [33, 17]];
    for (const [i, [buf, type]] of cases.entries()) {
      expect(sniffImage(buf)).toBe(type);
      const img = await decodeImage(buf, type);
      expect([img.width, img.height, img.data.length]).toEqual([sizes[i][0], sizes[i][1], sizes[i][0] * sizes[i][1] * 4]);
    }
    expect(sniffImage(Buffer.from("not an image at all"))).toBeNull();
  });
});

describe("sizing for the providers", () => {
  it("fits the long edge to the limit and keeps the aspect", () => {
    expect(fitSize(3840, 2160)).toEqual({ width: MAX_IMAGE_EDGE, height: 1125 });
    expect(fitSize(1000, 4000)).toEqual({ width: 500, height: MAX_IMAGE_EDGE });
    expect(fitSize(800, 600)).toEqual({ width: 800, height: 600 });
  });

  it("averages the area each output pixel covers", () => {
    const src = { width: 2, height: 1, data: new Uint8Array([0, 0, 0, 255, 200, 100, 50, 255]) };
    expect(Array.from(downscale(src, 1, 1).data)).toEqual([100, 50, 25, 255]);
  });

  it("sends a small image as it is", async () => {
    const buf = pngBytes(64, 32);
    const img = await prepareImage(buf, "image/png");
    expect(img.original).toBeUndefined();
    expect(Buffer.from(img.data, "base64").equals(buf)).toBe(true);
  });

  it("shrinks and re-encodes a large screenshot instead of refusing it", async () => {
    const buf = pngBytes(3000, 1700, { noise: true });
    expect(buf.length).toBeGreaterThan(MAX_IMAGE_BYTES);
    const img = await prepareImage(buf, "image/png", "C:/shots/big.png");
    expect(img.mediaType).toBe("image/jpeg");
    expect([img.width, img.height]).toEqual([2000, 1133]);
    expect(Buffer.from(img.data, "base64").length).toBeLessThanOrEqual(MAX_IMAGE_BYTES);
    expect(img.original).toEqual({ mediaType: "image/png", width: 3000, height: 1700, bytes: buf.length });
  }, 30_000);

  it("keeps transparency as PNG when it has to shrink one", async () => {
    const img = await prepareImage(pngBytes(2400, 100, { alpha: 128 }), "image/png");
    expect(img.mediaType).toBe("image/png");
    expect(img.width).toBe(2000);
  });
});

describe("read_file on an image", () => {
  it("returns the image for the model with a line on what it is", async () => {
    fs.writeFileSync(path.join(dir, "shot.png"), pngBytes(30, 10));
    const r = await readFile(dir, { path: "shot.png" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("PNG image, 30x10");
    expect(r.images).toHaveLength(1);
    expect(r.images![0]).toMatchObject({ mediaType: "image/png", width: 30, height: 10, source: path.join(dir, "shot.png") });
  });

  it("knows an image by its bytes, whatever its name", async () => {
    fs.writeFileSync(path.join(dir, "capture.bin"), jpegBytes(8, 8));
    const r = await readFile(dir, { path: "capture.bin" });
    expect(r.images?.[0].mediaType).toBe("image/jpeg");
  });

  it("says a damaged image could not be decoded", async () => {
    fs.writeFileSync(path.join(dir, "bad.png"), Buffer.concat([pngBytes(4, 4).subarray(0, 30), Buffer.alloc(10)]));
    const r = await readFile(dir, { path: "bad.png" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("could not be decoded");
  });
});

describe("images an editor call wrote", () => {
  const result = (o: unknown): ActionResult => ({ isError: false, content: [{ type: "text", text: JSON.stringify(o) }] });

  it("go to the model when the result names a file the call wrote", async () => {
    const since = Date.now();
    fs.writeFileSync(path.join(dir, "viewport.png"), pngBytes(16, 9));
    const images = await resultImages(dir, result({ success: true, capture: { filename: path.join(dir, "viewport.png") } }), since);
    expect(images.map((i) => [i.width, i.height])).toEqual([[16, 9]]);
  });

  it("resolve a path relative to the project", async () => {
    fs.mkdirSync(path.join(dir, "Saved"));
    fs.writeFileSync(path.join(dir, "Saved", "s.png"), pngBytes(4, 4));
    expect(await resultImages(dir, result({ path: "Saved/s.png" }), Date.now() - 100)).toHaveLength(1);
  });

  it("leave out an image the result only mentions, written before the call", async () => {
    const file = path.join(dir, "old.png");
    fs.writeFileSync(file, pngBytes(4, 4));
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(file, past, past);
    expect(await resultImages(dir, result({ path: file }), Date.now())).toEqual([]);
  });

  it("take image content the result carries itself", async () => {
    const r: ActionResult = { isError: false, content: [{ type: "text", text: "ok" }, { type: "image", data: pngBytes(3, 3).toString("base64"), mimeType: "image/png" } as never] };
    expect(await resultImages(dir, r, Date.now())).toHaveLength(1);
  });
});

describe("every provider's request", () => {
  const img = { mediaType: "image/png", data: pngBytes(2, 2).toString("base64"), width: 2, height: 2 };
  const messages: MessageParam[] = [
    { role: "user", content: "look at the shot" },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "a.png" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: toolResultContent("a.png: PNG image", [img]) as never }] },
  ];
  const req = { sessionId: "s", model: "m", system: [{ type: "text" as const, text: "sys" }], tools: [], messages };

  it("Messages (Anthropic key, gateway): the image sits in the tool result", () => {
    const body = requestBody({ ...req, model: "claude-opus-5-5" });
    const tr = (body.messages[2].content as Array<{ content: Array<{ type: string; source?: { media_type: string } }> }>)[0].content;
    expect(tr.map((b) => b.type)).toEqual(["text", "image"]);
    expect(tr[1].source?.media_type).toBe("image/png");
  });

  it("Chat Completions (OpenAI and Google keys): the tool message has the text, a user message after it the image", () => {
    const msgs = toChatRequest(req).messages as Array<{ role: string; content: unknown }>;
    const at = msgs.findIndex((m) => m.role === "tool");
    expect(msgs[at].content).toBe("a.png: PNG image");
    const next = msgs[at + 1].content as Array<{ type: string; image_url?: { url: string } }>;
    expect(msgs[at + 1].role).toBe("user");
    expect(next.map((p) => p.type)).toEqual(["text", "image_url"]);
    expect(next[1].image_url?.url).toBe(`data:image/png;base64,${img.data}`);
  });

  it("Responses (ChatGPT sign-in): the output has the text, an input image follows it", () => {
    const input = toResponsesRequest(req).input as Array<{ type?: string; role?: string; output?: string; content?: Array<{ type: string; image_url?: string }> }>;
    const out = input.findIndex((i) => i.type === "function_call_output");
    expect(input[out].output).toBe("a.png: PNG image");
    expect(input[out + 1].role).toBe("user");
    expect(input[out + 1].content!.map((p) => p.type)).toEqual(["input_text", "input_image"]);
    expect(input[out + 1].content![1].image_url).toBe(`data:image/png;base64,${img.data}`);
  });
});
