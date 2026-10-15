import { PNG } from "pngjs";
import fs from "node:fs";
const [src, out, x, y, w, h] = process.argv.slice(2);
const p = PNG.sync.read(fs.readFileSync(src));
const o = new PNG({ width: +w, height: +h });
PNG.bitblt(p, o, +x, +y, +w, +h, 0, 0);
fs.writeFileSync(out, PNG.sync.write(o));
