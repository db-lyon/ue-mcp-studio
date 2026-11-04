/**
 * A PNG's pixels without a canvas, for the phone: 8-bit grey, grey and alpha,
 * RGB or RGBA, not interlaced, which is what Unreal's thumbnail export writes.
 * Anything else is null.
 */
import { unzlibSync } from "fflate";

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let n = 0;
  for (const ch of clean) {
    acc = (acc << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (acc >> bits) & 255;
    }
  }
  return out.subarray(0, n);
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

/** RGBA pixels of an 8-bit, non-interlaced PNG; null for any other picture. */
export function decodePng(bytes: Uint8Array): Uint8ClampedArray | null {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 33 || sig.some((b, i) => bytes[i] !== b)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  let type = -1;
  const idat: Uint8Array[] = [];
  for (let p = 8; p + 8 <= bytes.length; ) {
    const len = view.getUint32(p);
    const name = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
    const data = bytes.subarray(p + 8, p + 8 + len);
    if (name === "IHDR") {
      width = view.getUint32(p + 8);
      height = view.getUint32(p + 12);
      if (data[8] !== 8 || data[12] !== 0) return null;
      type = data[9];
    } else if (name === "IDAT") idat.push(data);
    else if (name === "IEND") break;
    p += 12 + len;
  }
  const ch = CHANNELS[type];
  if (!ch || !width || !height || !idat.length) return null;
  const joined = new Uint8Array(idat.reduce((n, d) => n + d.length, 0));
  let at = 0;
  for (const d of idat) {
    joined.set(d, at);
    at += d.length;
  }
  let raw: Uint8Array;
  try {
    raw = unzlibSync(joined);
  } catch {
    return null;
  }
  const stride = width * ch;
  if (raw.length < (stride + 1) * height) return null;
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? px[row + x - ch] : 0;
      const b = y > 0 ? px[row - stride + x] : 0;
      const c = x >= ch && y > 0 ? px[row - stride + x - ch] : 0;
      const v = raw[src + x];
      let pred = 0;
      if (f === 1) pred = a;
      else if (f === 2) pred = b;
      else if (f === 3) pred = (a + b) >> 1;
      else if (f === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[row + x] = (v + pred) & 255;
    }
  }
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, o = 0; i < px.length; i += ch, o += 4) {
    const grey = ch <= 2;
    out[o] = px[i];
    out[o + 1] = grey ? px[i] : px[i + 1];
    out[o + 2] = grey ? px[i] : px[i + 2];
    out[o + 3] = ch === 4 ? px[i + 3] : ch === 2 ? px[i + 1] : 255;
  }
  return out;
}
