/**
 * GET /video: how large a video plays in the chat for this account, and
 * whether a smaller copy can be made. POST /sessions/:id/attachments/:aid/compress:
 * that copy, kept as one of the session's files beside the original and made
 * once (asking again answers with the same copy).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { DaemonExtensionApi } from "ue-mcp/daemon";
import { VIDEO_PLAY_BYTES, isVideo, videoLimit, type Attachment, type VideoLimits } from "@ue-mcp-studio/shared";
import type { AttachmentStore } from "./attachments.js";
import { compressVideo, findFfmpeg, forgetFfmpeg } from "./video.js";

export interface VideoRouteOptions {
  attachments: AttachmentStore;
  /** Whether the signed-in account holds a paid plan; cached by the caller. */
  paid: () => Promise<boolean>;
  compress?: typeof compressVideo;
  ffmpeg?: () => string | null;
}

export function registerVideoRoutes(api: Pick<DaemonExtensionApi, "route">, o: VideoRouteOptions): void {
  const ffmpeg = o.ffmpeg ?? (() => {
    // A user told to install ffmpeg does it while Studio runs: look again until one is found.
    const f = findFfmpeg();
    if (!f) forgetFfmpeg();
    return f;
  });
  const compress = o.compress ?? compressVideo;
  const limits = async (): Promise<VideoLimits> => {
    const paid = await o.paid().catch(() => false);
    return { limit: videoLimit(paid), paid, compress: ffmpeg() !== null };
  };
  // One encode per file at a time: a second ask waits for the first.
  const running = new Map<string, Promise<{ status: number; body: Attachment | { error: string } }>>();

  api.route("GET", "/video", async () => ({ body: await limits() }));

  api.route("POST", "/sessions/:id/attachments/:aid/compress", async (req) => {
    const { id, aid } = req.params;
    const a = o.attachments.get(id, aid);
    if (!a) return { status: 404, body: { error: "no such attachment" } };
    if (!isVideo(a)) return { status: 415, body: { error: `${a.name} is not a video.` } };
    const key = `${id}/${aid}`;
    let job = running.get(key);
    if (!job) {
      job = (async () => {
        const { limit } = await limits();
        const target = Math.min(limit, VIDEO_PLAY_BYTES);
        // The copy sits beside the original, found again by its name.
        const copyName = `${path.parse(a.name).name}.small.mp4`;
        const record = path.join(path.dirname(a.path), `${aid}.small.json`);
        try {
          const known = JSON.parse(fs.readFileSync(record, "utf-8")) as { id: string };
          const kept = o.attachments.get(id, known.id);
          if (kept) {
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
