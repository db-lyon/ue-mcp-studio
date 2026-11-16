/**
 * Videos a message carried, played in the chat. On the computer any size
 * plays: the bytes go from the daemon over localhost and never reach a server.
 * On the phone or a paired browser every byte crosses the relay, so the
 * account's plan caps one item there (the gateway's relayMediaBytes: Remote
 * 10 MB, Pro 50 MB). Past that it is never a dead end: Compress and play makes
 * a smaller copy on the computer (POST .../attachments/:aid/compress), so
 * only that copy crosses the relay, and Open on the computer plays the
 * original there (POST .../attachments/:aid/open).
 */
import type { Attachment } from "./index.js";

const MB = 1024 * 1024;

/**
 * The relay cap per plan when the gateway does not say (an older gateway).
 * The gateway's plan is the place to tune it: Plan.relayMediaBytes.
 */
export const RELAY_MEDIA_DEFAULTS: Readonly<Record<string, number>> = { remote: 10 * MB, pro: 50 * MB };

/** What a compressed copy aims at when the plan gives no relay figure. */
export const VIDEO_COMPRESS_TARGET_BYTES = 10 * MB;

/** Video types a browser and the phone's player both play. */
const PLAYABLE = /^video\/(mp4|webm|quicktime|x-m4v|ogg)$/;
export const VIDEO_EXT = /\.(mp4|m4v|webm|mov|ogv)$/i;

/** Whether an attachment is a video the chat can play, by its type or, without one, its name. */
export function isVideo(a: Pick<Attachment, "type" | "name">): boolean {
  return PLAYABLE.test(a.type) || ((!a.type || a.type === "application/octet-stream") && VIDEO_EXT.test(a.name));
}

/** GET /v1/ext/studio/video: what plays where for this account, and whether Studio can compress one. */
export interface VideoLimits {
  /** The largest item that plays through the relay; 0 without a plan that has the relay. On the computer there is no limit. */
  relay: number;
  /** Studio found a video encoder (ffmpeg) on the computer. */
  compress: boolean;
}

/** What the chat does with a video of `size` bytes, shown on the computer (`remote` false) or through the relay. */
export type VideoVerdict = { kind: "play" } | { kind: "offer" };

export function videoVerdict(size: number, limits: Pick<VideoLimits, "relay">, remote: boolean): VideoVerdict {
  return !remote || size <= limits.relay ? { kind: "play" } : { kind: "offer" };
}

/** The sentence the chat shows over a video too large to play through the relay. */
export function videoOfferText(size: number, limits: VideoLimits, mb: (n: number) => string): string {
  const head = `This video is ${mb(size)}; on this device the chat plays videos up to ${mb(limits.relay)}.`;
  return limits.compress
    ? `${head} Compress it to play a smaller copy here, or open it on the computer.`
    : `${head} Open it on the computer, or install ffmpeg there (winget install ffmpeg) and press Check again to play a smaller copy here.`;
}

/** POST /v1/ext/studio/sessions/:id/attachments/:aid/compress: the smaller copy, kept beside the original. */
export type VideoCompressResponse = Attachment;
