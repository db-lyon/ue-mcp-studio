// The pictures visual QA fixtures name, served by a Vite plugin for both the web client and the mobile app.
import { createRequire } from "node:module";

const { GifWriter } = createRequire(import.meta.url)("omggif");

/**
 * A project image a reply shows (GET /files/image): an animated GIF of a ball
 * crossing a floor, 320 by 180.
 */
function replyGif() {
  const w = 320;
  const h = 180;
  // Background, floor, ball, ball shade.
  const palette = [0x1d1f24, 0x3a3d45, 0xe8720c, 0x8a3f06];
  const buf = new Uint8Array(w * h * 8 + 1024);
  const gif = new GifWriter(buf, w, h, { loop: 0, palette });
  for (let f = 0; f < 8; f++) {
    const px = new Uint8Array(w * h);
    const cx = 60 + f * 28;
    const cy = 110 - Math.round(Math.sin((f / 7) * Math.PI) * 50);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const d = (x - cx) ** 2 + (y - cy) ** 2;
        px[y * w + x] = d < 18 ** 2 ? (x + y < cx + cy - 6 ? 2 : 3) : y > 140 ? 1 : 0;
      }
    }
    // The first frame holds for six seconds, so a shot taken soon after the page loads shows it on every side.
    gif.addFrame(0, 0, w, h, px, { delay: f === 0 ? 600 : 12 });
  }
  return Buffer.from(buf.subarray(0, gif.end()));
}

/**
 * Pictures the fixtures name: a review thumbnail, a captured review image or a
 * playtest capture, drawn as a shaded sphere whose hue comes from the id. An id
 * with "unreadable" in it answers 404, as a file the agent lost would; one
 * with "blank" in it is flat black, and one with "checker" in it Unreal's grey
 * checkerboard placeholder.
 */
export const pictures = {
  name: "visual-qa-pictures",
  configureServer(s) {
    s.middlewares.use((req, res, next) => {
      if (/^\/v1\/ext\/studio\/files\/image\?/.test(req.url ?? "")) {
        res.setHeader("content-type", "image/gif");
        return res.end(replyGif());
      }
      const m =/^\/v1\/ext\/studio\/(?:review\/(?:thumbnails|images)\/[^/?]+|qa\/runs\/[^?]+\/captures\/\d+)/.exec(req.url ?? "");
      if (!m) return next();
      // A run id with "unreadable-<n>" in it loses only its capture n.
      const lost = /unreadable(?:-(\d+))?/.exec(req.url);
      if (lost && (lost[1] === undefined || req.url.endsWith(`/captures/${lost[1]}`))) {
        res.statusCode = 404;
        return res.end();
      }
      // An id with "blank" in it is the black square a thumbnail renderer that drew nothing leaves.
      if (/blank/.test(req.url)) {
        res.setHeader("content-type", "image/svg+xml");
        return res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#000"/></svg>`);
      }
      // An id with "checker" in it is Unreal's empty placeholder, a grey checkerboard.
      if (/checker/.test(req.url)) {
        res.setHeader("content-type", "image/svg+xml");
        return res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><defs><pattern id="c" width="64" height="64" patternUnits="userSpaceOnUse"><rect width="64" height="64" fill="#a0a0a0"/><rect width="32" height="32" fill="#606060"/><rect x="32" y="32" width="32" height="32" fill="#606060"/></pattern></defs><rect width="256" height="256" fill="url(#c)"/></svg>`);
      }
      const hue =[...req.url].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
      res.setHeader("content-type", "image/svg+xml");
      res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><defs><radialGradient id="g" cx="0.38" cy="0.34" r="0.7"><stop offset="0" stop-color="hsl(${hue},55%,78%)"/><stop offset="0.55" stop-color="hsl(${hue},45%,42%)"/><stop offset="1" stop-color="hsl(${hue},40%,14%)"/></radialGradient></defs><rect width="256" height="256" fill="#1d1f24"/><ellipse cx="128" cy="214" rx="78" ry="12" fill="#000" opacity="0.45"/><circle cx="128" cy="124" r="86" fill="url(#g)"/></svg>`);
    });
  },
};
