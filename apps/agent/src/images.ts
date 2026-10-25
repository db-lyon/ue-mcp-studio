/**
 * Images the model is shown: a file read_file opens, a screenshot an editor
 * call wrote, an image the user attached. Each goes out sized for every
 * provider Studio drives, so a large one is shrunk rather than refused.
 *
 * The limits, from the providers' documentation:
 * - Anthropic: 5 MB per image, base64; 8000 px a side, and 2000 px once a
 *   request carries more than 20 images; at most 32 MB a request. Detail past
 *   2576 px on the long edge is scaled away on its side.
 * - OpenAI: high detail fits an image into 2048 px; 50 MB a request.
 * - Gemini: 20 MB a request with images inline.
 * A long conversation resends every image it has seen, so each is kept to
 * 2000 px and about 1.5 MB.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { PNG } from "pngjs";
import * as jpeg from "jpeg-js";
import { GifReader } from "omggif";

/** The longest side an image is ever sent at. */
export const MAX_IMAGE_EDGE = 2000;

let chosenEdge: () => number = () => MAX_IMAGE_EDGE;
/** Where the longest side comes from: the project's Image size setting. */
export function setImageEdge(edge: () => number): void {
  chosenEdge = edge;
}
/** The longest side an image is sent at now. */
export const imageEdge = (): number => Math.min(MAX_IMAGE_EDGE, chosenEdge());
/** The most bytes one image is sent as. */
export const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;
/** The largest file read_file decodes, so a stray huge file cannot take the daemon's memory. */
export const MAX_IMAGE_FILE_BYTES = 200 * 1024 * 1024;

export const IMAGE_EXTENSIONS: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** An image ready for a model, and what it was made from. */
export interface ToolImage {
  mediaType: string;
  /** base64 */
  data: string;
  width: number;
  height: number;
  /** The file it came from, when there was one. */
  source?: string;
  /** The original's size, when it was shrunk or re-encoded. */
  original?: { mediaType: string; width: number; height: number; bytes: number };
}

/** An image's type from its first bytes, or null when it is none of the four. */
export function sniffImage(buf: Uint8Array): string | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return "image/gif";
  if (buf.length >= 12 && ascii(buf, 0, 4) === "RIFF" && ascii(buf, 8, 4) === "WEBP") return "image/webp";
  return null;
}

const ascii = (b: Uint8Array, at: number, n: number): string => String.fromCharCode(...b.subarray(at, at + n));

interface Rgba {
  width: number;
  height: number;
  data: Uint8Array;
}

/** The WebP decoder's code: beside the bundle in a release, from the package when run from source. */
function webpWasm(): Buffer {
  const beside = new URL("./webp_dec.wasm", import.meta.url);
  if (fs.existsSync(beside)) return fs.readFileSync(beside);
  return fs.readFileSync(createRequire(import.meta.url).resolve("@jsquash/webp/codec/dec/webp_dec.wasm"));
}

let webpReady: Promise<(buf: ArrayBuffer) => Promise<{ width: number; height: number; data: Uint8ClampedArray }>> | null = null;
const webpDecoder = () => (webpReady ??= (async () => {
  const mod = await import("@jsquash/webp/decode.js");
  await mod.init(await WebAssembly.compile(new Uint8Array(webpWasm())));
  return mod.default;
})());

/** An image decoded to RGBA. GIF: its first frame. */
export async function decodeImage(buf: Buffer, mediaType: string): Promise<Rgba> {
  if (mediaType === "image/png") {
    const png = PNG.sync.read(buf);
    return { width: png.width, height: png.height, data: png.data };
  }
  if (mediaType === "image/jpeg") {
    const j = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 400, maxMemoryUsageInMB: 2048 });
    return { width: j.width, height: j.height, data: j.data };
  }
  if (mediaType === "image/gif") {
    const g = new GifReader(buf);
    const data = new Uint8Array(g.width * g.height * 4);
    g.decodeAndBlitFrameRGBA(0, data);
    return { width: g.width, height: g.height, data };
  }
  if (mediaType === "image/webp") {
    const decode = await webpDecoder();
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    const img = await decode(ab);
    return { width: img.width, height: img.height, data: new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength) };
  }
  throw new Error(`cannot decode ${mediaType}`);
}

/** The size an image is sent at: its own, or scaled to fit MAX_IMAGE_EDGE. */
export function fitSize(width: number, height: number, edge = MAX_IMAGE_EDGE): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= edge) return { width, height };
  const k = edge / long;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

/** Shrink by averaging each output pixel's area of the source, weighting colour by alpha. */
export function downscale(src: Rgba, width: number, height: number): Rgba {
  if (width === src.width && height === src.height) return src;
  const out = new Uint8Array(width * height * 4);
  const sx = src.width / width;
  const sy = src.height / height;
  for (let oy = 0; oy < height; oy++) {
    const y0 = Math.floor(oy * sy);
    const y1 = Math.max(y0 + 1, Math.min(src.height, Math.floor((oy + 1) * sy)));
    for (let ox = 0; ox < width; ox++) {
      const x0 = Math.floor(ox * sx);
      const x1 = Math.max(x0 + 1, Math.min(src.width, Math.floor((ox + 1) * sx)));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        let i = (y * src.width + x0) * 4;
        for (let x = x0; x < x1; x++, i += 4) {
          const al = src.data[i + 3];
          r += src.data[i] * al;
          g += src.data[i + 1] * al;
          b += src.data[i + 2] * al;
          a += al;
          n++;
        }
      }
      const o = (oy * width + ox) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round(a / n);
    }
  }
  return { width, height, data: out };
}

const hasAlpha = (img: Rgba): boolean => {
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] !== 255) return true;
  return false;
};

/** RGBA as PNG when it has transparency, JPEG otherwise. */
function encode(img: Rgba, alpha: boolean, quality: number): { mediaType: string; bytes: Buffer } {
  if (alpha) {
    const png = new PNG({ width: img.width, height: img.height });
    png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
    return { mediaType: "image/png", bytes: PNG.sync.write(png, { colorType: 6 }) };
  }
  return { mediaType: "image/jpeg", bytes: jpeg.encode({ width: img.width, height: img.height, data: img.data }, quality).data };
}

/**
 * An image as a model is sent it. One within imageEdge() and
 * MAX_IMAGE_BYTES goes as it is; a larger one is scaled down and re-encoded,
 * smaller and at lower quality until it fits.
 */
export async function prepareImage(buf: Buffer, mediaType: string, source?: string): Promise<ToolImage> {
  // Decoded even when it goes as it is: a broken image in the history would fail every request after it.
  const full = await decodeImage(buf, mediaType);
  if (full.width < 1 || full.height < 1) throw new Error("the image has no pixels");
  const most = imageEdge();
  if (Math.max(full.width, full.height) <= most && buf.length <= MAX_IMAGE_BYTES) {
    return { mediaType, data: buf.toString("base64"), width: full.width, height: full.height, ...(source ? { source } : {}) };
  }
  const alpha = hasAlpha(full);
  let edge = Math.min(most, Math.max(full.width, full.height));
  for (;;) {
    const fit = fitSize(full.width, full.height, edge);
    const img = downscale(full, fit.width, fit.height);
    for (const quality of alpha ? [0] : [85, 70, 55]) {
      const out = encode(img, alpha, quality);
      if (out.bytes.length <= MAX_IMAGE_BYTES || edge <= 256) {
        return {
          mediaType: out.mediaType,
          data: out.bytes.toString("base64"),
          width: img.width,
          height: img.height,
          ...(source ? { source } : {}),
          original: { mediaType, width: full.width, height: full.height, bytes: buf.length },
        };
      }
    }
    edge = Math.floor(edge * 0.75);
  }
}

const kind = (mediaType: string): string => mediaType.replace("image/", "").toUpperCase();
const mb = (n: number): string => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** One line on an image the model is about to see: what the file is, and how it is shown. */
export function describeImage(img: ToolImage, file: string, bytes: number): string {
  const o = img.original;
  if (!o) return `${file}: ${kind(img.mediaType)} image, ${img.width}x${img.height}, ${mb(bytes)}. The image follows.`;
  return `${file}: ${kind(o.mediaType)} image, ${o.width}x${o.height}, ${mb(o.bytes)}. It follows as a ${img.width}x${img.height} ${kind(img.mediaType)}, scaled to fit the model's image limits.`;
}

/** The file name an image is kept under for the panel, with the extension of what it is now. */
export function keptName(img: ToolImage, fallback = "image"): string {
  const base = img.source ? path.basename(img.source).replace(/\.[^.]+$/, "") : fallback;
  const ext = img.mediaType === "image/jpeg" ? ".jpg" : `.${img.mediaType.replace("image/", "")}`;
  return `${base}${ext}`;
}

/** An image as a Messages content block. */
export function imageBlock(img: ToolImage): { type: "image"; source: { type: "base64"; media_type: string; data: string } } {
  return { type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } };
}

/** A tool result's content in the Messages form: the text alone, or the text and its images. */
export function toolResultContent(text: string, images?: ToolImage[]): string | Array<{ type: "text"; text: string } | ReturnType<typeof imageBlock>> {
  if (!images?.length) return text;
  return [{ type: "text", text }, ...images.map(imageBlock)];
}
