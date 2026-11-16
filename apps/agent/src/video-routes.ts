/**
 * GET /video: how large a video plays through the relay for this account (the
 * plan's relayMediaBytes from the gateway; on the computer any size plays),
 * and whether a smaller copy can be made.
 * POST /sessions/:id/attachments/:aid/compress: that copy, made on the
 * computer so only it crosses the relay, kept as one of the session's files
 * beside the original and made once (asking again answers the same copy).
 * POST /sessions/:id/attachments/:aid/open: the original video played on the
 * computer by its default app, the way on from a phone for one too large to
 * send. Videos only, by type and by name, so nothing that runs is opened.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { DaemonExtensionApi } from "ue-mcp/daemon";
import { RELAY_MEDIA_DEFAULTS, VIDEO_COMPRESS_TARGET_BYTES, VIDEO_EXT, hasPaidPlan, isVideo, type AccountUsage, type Attachment, type VideoLimits } from "@ue-mcp-studio/shared";
import type { AttachmentStore } from "./attachments.js";
import { canCompress, compressVideo, findFfmpeg, forgetFfmpeg } from "./video.js";
import { openWithSystem } from "./native-routes.js";

export interface VideoRouteOptions {
  attachments: AttachmentStore;
  /** The signed-in account's usage from the gateway, or null signed out or unreachable. */
  usage: () => Promise<AccountUsage | null>;
  compress?: typeof compressVideo;
  ffmpeg?: () => string | null;
  /** Plays a file with the computer's default app; openWithSystem by default. */
  open?: (abs: string) => void;
}

/** The relay cap a plan gives: the gateway's figure, else the default for its id, 0 without a live paid plan. */
export function relayLimit(u: AccountUsage | null, now = new Date()): number {
  if (!u || !hasPaidPlan(u, now)) return 0;
  const given = u.plan.relayMediaBytes;
  return typeof given === "number" && given >= 0 ? given : RELAY_MEDIA_DEFAULTS[u.plan.id] ?? 0;
}

const USAGE_TTL_MS = 3 * 60_000;

export function registerVideoRoutes(api: Pick<DaemonExtensionApi, "route">, o: VideoRouteOptions): void {
  const open = o.open ?? openWithSystem;
  // Compress works wherever an ffmpeg is found or a pinned one can be fetched on first use.
  const ffmpeg = o.ffmpeg ?? (() => {
    const can = canCompress();
    if (!findFfmpeg()) forgetFfmpeg();
    return can ? "ffmpeg" : null;
  });
  const compress = o.compress ?? compressVideo;
  let cached: { at: number; value: AccountUsage | null } | null = null;
  const usage = async (): Promise<AccountUsage | null> => {
    if (cached && Date.now() - cached.at < USAGE_TTL_MS) return cached.value;
    const value = await o.usage().catch(() => null);
    cached = { at: Date.now(), value };
    return value;
  };
  const limits = async (): Promise<VideoLimits> => ({ relay: relayLimit(await usage()), compress: ffmpeg() !== null });
  // One encode per file at a time: a second ask waits for the first.
  const running = new Map<string, Promise<{ status: number; body: Attachment | { error: string } }>>();

  api.route("GET", "/video", async () => ({ body: await limits() }));

  api.route("POST", "/sessions/:id/attachments/:aid/open", (req) => {
    const a = o.attachments.get(req.params.id, req.params.aid);
    if (!a) return { status: 404, body: { error: "no such attachment" } };
    if (!isVideo(a) || !VIDEO_EXT.test(a.path)) return { status: 415, body: { error: `${a.name} is not a video Studio plays.` } };
    open(a.path);
    return { status: 204 };
  });

  api.route("POST", "/sessions/:id/attachments/:aid/compress", async (req) => {
    const { id, aid } = req.params;
    const a = o.attachments.get(id, aid);
    if (!a) return { status: 404, body: { error: "no such attachment" } };
    if (!isVideo(a)) return { status: 415, body: { error: `${a.name} is not a video.` } };
    const key = `${id}/${aid}`;
    let job = running.get(key);
    if (!job) {
      job = (async () => {
        const { relay } = await limits();
        const target = relay > 0 ? relay : VIDEO_COMPRESS_TARGET_BYTES;
        // The copy sits beside the original, found again by its record.
        const copyName = `${path.parse(a.name).name}.small.mp4`;
        const record = path.join(path.dirname(a.path), `${aid}.small.json`);
        try {
          const known = JSON.parse(fs.readFileSync(record, "utf-8")) as { id: string };
          const kept = o.attachments.get(id, known.id);
          if (kept && kept.size <= target) {
            const { path: _p, ...copy } = kept;
            return { status: 200, body: copy };
          }
        } catch {
          // Not made yet.
        }
        const out = path.join(path.dirname(a.path), `${aid}.small.tmp.mp4`);
        const r = await compress(a.path, out, target);
        if (!r.ok) return { status: 422, body: { error: r.error } };
        try {
          const { path: _p, ...copy } = o.attachments.keep(id, copyName, "video/mp4", fs.readFileSync(out));
          fs.writeFileSync(record, JSON.stringify({ id: copy.id }));
          return { status: 201, body: copy };
        } finally {
          fs.rmSync(out, { force: true });
        }
      })().finally(() => running.delete(key));
      running.set(key, job);
    }
    return job;
  });
}
