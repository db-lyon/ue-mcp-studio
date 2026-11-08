/**
 * Studio's mark as files: a dark rounded tile with an orange dot, drawn the
 * way studio-window.exe draws it at run time (makeIcon in apps/window/src/host.h).
 * The window build writes the exe icon from it.
 */
import * as zlib from "node:zlib";

/** RGBA rows of the mark, `size` pixels square. */
export function mark(size) {
  const px = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2, dot = size * 0.26, tile = size * 0.5, radius = size * 0.18;
  const clamp = (v) => Math.min(1, Math.max(0, v));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const qx = Math.max(Math.abs(x - c) - (tile - radius), 0), qy = Math.max(Math.abs(y - c) - (tile - radius), 0);
      const tileA = clamp(radius - Math.hypot(qx, qy) + 0.5);
      const dotA = clamp(dot - Math.hypot(x - c, y - c) + 0.5);
      const i = (y * size + x) * 4;
      px[i] = 0x13 + (0xe8 - 0x13) * dotA;
      px[i + 1] = 0x13 + (0x72 - 0x13) * dotA;
      px[i + 2] = 0x12 + (0x0c - 0x12) * dotA;
      px[i + 3] = tileA * 255;
    }
  }
  return { w: size, h: size, px };
}

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

export function png({ w, h, px }) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) px.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** An .ico of PNG entries, which Windows Vista and later read at every size. */
export function ico(sizes = [16, 20, 24, 32, 40, 48, 64, 256]) {
  const images = sizes.map((s) => png(mark(s)));
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(sizes.length, 4);
  let offset = head.length;
  sizes.forEach((s, i) => {
    const e = 6 + 16 * i;
    head[e] = s >= 256 ? 0 : s;
    head[e + 1] = s >= 256 ? 0 : s;
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(images[i].length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += images[i].length;
  });
  return Buffer.concat([head, ...images]);
}
