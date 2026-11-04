// The pictures visual QA fixtures name, served by a Vite plugin for both the web client and the mobile app.
/**
 * Pictures the fixtures name: a review thumbnail, a captured review image or a
 * playtest capture, drawn as a shaded sphere whose hue comes from the id. An id
 * with "unreadable" in it answers 404, as a file the agent lost would.
 */
export const pictures = {
  name: "visual-qa-pictures",
  configureServer(s) {
    s.middlewares.use((req, res, next) => {
      const m = /^\/v1\/ext\/studio\/(?:review\/(?:thumbnails|images)\/[^/?]+|qa\/runs\/[^?]+\/captures\/\d+)/.exec(req.url ?? "");
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
      const hue = [...req.url].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
      res.setHeader("content-type", "image/svg+xml");
      res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><defs><radialGradient id="g" cx="0.38" cy="0.34" r="0.7"><stop offset="0" stop-color="hsl(${hue},55%,78%)"/><stop offset="0.55" stop-color="hsl(${hue},45%,42%)"/><stop offset="1" stop-color="hsl(${hue},40%,14%)"/></radialGradient></defs><rect width="256" height="256" fill="#1d1f24"/><ellipse cx="128" cy="214" rx="78" ry="12" fill="#000" opacity="0.45"/><circle cx="128" cy="124" r="86" fill="url(#g)"/></svg>`);
    });
  },
};
