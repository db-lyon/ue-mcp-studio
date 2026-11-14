/**
 * The project images a reply shows: what each one is (type, size, frames),
 * sent with the reply so a chat draws its tile at the final size at once, and
 * its poster, the first frame as a small JPEG served by GET /files/image with
 * poster=1, so the tile shows the picture within a second while the whole
 * file (an 11 MB capture GIF over the relay) still loads.
 *
 * Posters are kept in the extension's data folder, named by the source's path,
 * size and time, so a capture written again gets a new one and a project's
 * own folders never gain files.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { IMAGE_READ_MAX_BYTES, POSTER_EDGE, POSTER_MAX_BYTES, POSTER_MIN_BYTES, projectImageType, replyImagePaths, type ReplyImageInfo } from "@ue-mcp-studio/shared";
import { imageFacts, makePoster, sniffImage } from "./images.js";
import { resolveProjectFile, type FileScope } from "./project-files.js";

/** Posters kept before the oldest are cleared. */
const POSTERS_KEPT = 400;

const factsCache = new Map<string, ReplyImageInfo | null>();
const making = new Map<string, Promise<Buffer>>();

const keyOf = (real: string, stat: fs.Stats): string => `${real}|${stat.size}|${Math.floor(stat.mtimeMs)}`;

/** Whether an image of this type and size gets a poster. BMP is not decoded here. */
export const wantsPoster = (type: string, bytes: number): boolean => bytes >= POSTER_MIN_BYTES && type !== "image/bmp";

/** What a project image file is, or null when it is not one Studio shows or cannot be read. */
export function imageInfoOf(real: string): ReplyImageInfo | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(real);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > IMAGE_READ_MAX_BYTES) return null;
  const key = keyOf(real, stat);
  const hit = factsCache.get(key);
  if (hit !== undefined) return hit;
  let info: ReplyImageInfo | null = null;
  try {
    const facts = imageFacts(fs.readFileSync(real));
    if (facts) info = { ...facts, bytes: stat.size, ...(wantsPoster(facts.type, stat.size) ? { poster: true } : {}) };
  } catch {
    info = null;
  }
  if (factsCache.size > 2000) factsCache.clear();
  factsCache.set(key, info);
  return info;
}

/**
 * The images a reply's text shows that the daemon can read, by their path as
 * replyImagePaths gives it; undefined when it shows none. Each one that gets a
 * poster has it made now, in the background, so the first client to ask is
 * answered at once.
 */
export function replyImages(text: string, scope: FileScope, posters?: string): Record<string, ReplyImageInfo> | undefined {
  if (!text.includes("![")) return undefined;
  const out: Record<string, ReplyImageInfo> = {};
  for (const p of replyImagePaths(text)) {
    const r = resolveProjectFile(scope, p);
    if (!r.ok || !(projectImageType(r.real) ?? projectImageType(r.abs))) continue;
    const info = imageInfoOf(r.real);
    if (!info) continue;
    out[p] = info;
    if (info.poster && posters) void posterFor(r.real, posters).catch(() => undefined);
  }
  return Object.keys(out).length ? out : undefined;
}

/** Clears the oldest posters once more than POSTERS_KEPT are kept. */
function prune(dir: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".jpg"));
  } catch {
    return;
  }
  if (names.length <= POSTERS_KEPT) return;
  const aged = names.map((n) => {
    try {
      return { n, t: fs.statSync(path.join(dir, n)).mtimeMs };
    } catch {
      return { n, t: 0 };
    }
  }).sort((a, b) => a.t - b.t);
  for (const { n } of aged.slice(0, names.length - POSTERS_KEPT)) fs.rmSync(path.join(dir, n), { force: true });
}

/**
 * The poster of an image file: the kept one when the file has not changed
 * since it was made, made and kept otherwise. One make per file at a time,
 * however many clients ask.
 */
export function posterFor(real: string, dir: string): Promise<Buffer> {
  const stat = fs.statSync(real);
  const key = keyOf(real, stat);
  const file = path.join(dir, `${crypto.createHash("sha1").update(key).digest("hex").slice(0, 24)}.jpg`);
  try {
    return Promise.resolve(fs.readFileSync(file));
  } catch {
    // Not made yet.
  }
  let pending = making.get(file);
  if (!pending) {
    pending = (async () => {
      const buf = fs.readFileSync(real);
      const type = sniffImage(buf);
      if (!type) throw new Error("not an image Studio decodes");
      const poster = await makePoster(buf, type, POSTER_EDGE, POSTER_MAX_BYTES);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, poster);
      fs.renameSync(tmp, file);
      prune(dir);
      return poster;
    })();
    making.set(file, pending);
    void pending.finally(() => making.delete(file)).catch(() => undefined);
  }
  return pending;
}
