/** Real images made in memory, for the tests that need a file a decoder accepts. */
import { PNG } from "pngjs";
import * as jpeg from "jpeg-js";
import { GifWriter } from "omggif";

/** A PNG of noise (so it does not compress away), or of one flat colour. */
export function pngBytes(width: number, height: number, opts: { noise?: boolean; alpha?: number } = {}): Buffer {
  const png = new PNG({ width, height });
  let seed = 12345;
  for (let i = 0; i < width * height * 4; i += 4) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    png.data[i] = opts.noise ? seed & 0xff : 200;
    png.data[i + 1] = opts.noise ? (seed >> 8) & 0xff : 100;
    png.data[i + 2] = opts.noise ? (seed >> 16) & 0xff : 50;
    png.data[i + 3] = opts.alpha ?? 255;
  }
  return PNG.sync.write(png);
}

export function jpegBytes(width: number, height: number): Buffer {
  const data = Buffer.alloc(width * height * 4, 128);
  return jpeg.encode({ width, height, data }, 90).data;
}

export function gifBytes(width: number, height: number): Buffer {
  const buf = Buffer.alloc(width * height * 2 + 1024);
  const w = new GifWriter(buf, width, height, { palette: [0xff0000, 0x00ff00] });
  w.addFrame(0, 0, width, height, new Array(width * height).fill(0).map((_, i) => i % 2));
  return buf.subarray(0, w.end());
}
