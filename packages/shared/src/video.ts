/**
 * Videos a message carried, played in the chat. A video up to
 * VIDEO_PLAY_BYTES plays for everyone and one up to VIDEO_PLAY_PAID_BYTES on a
 * paid plan. Past that it is never a dead end: the chat offers a compressed
 * copy that does play (POST .../attachments/:aid/compress), the file itself,
 * and, where a plan would play it, the upgrade.
 */
import type { Attachment } from "./index.js";

/** The largest video that plays in the chat on any account. */
export const VIDEO_PLAY_BYTES = 4 * 1024 * 1024;
/** The largest video that plays in the chat on a paid plan. */
export const VIDEO_PLAY_PAID_BYTES = 20 * 1024 * 1024;

/** Video types a browser and the phone's player both play. */
const PLAYABLE = /^video\/(mp4|webm|quicktime|x-m4v|ogg)$/;
const VIDEO_EXT = /\.(mp4|m4v|webm|mov|ogv)$/i;

/** Whether an attachment is a video the chat can play, by its type or, without one, its name. */
export function isVideo(a: Pick<Attachment, "type" | "name">): boolean {
  return PLAYABLE.test(a.type) || ((!a.type || a.type === "application/octet-stream") && VIDEO_EXT.test(a.name));
}

/** GET /v1/ext/studio/video: how large a video plays here, and whether Studio can compress one. */
export interface VideoLimits {
  /** The largest video that plays for this account now. */
  limit: number;
  /** The account holds a paid plan. */
  paid: boolean;
  /** Studio found a video encoder (ffmpeg) on this computer. */
  compress: boolean;
}

/** The limit for an account. */
export const videoLimit = (paid: boolean): number => (paid ? VIDEO_PLAY_PAID_BYTES : VIDEO_PLAY_BYTES);

/** What the chat does with a video of `size` bytes. */
export type VideoVerdict =
  /** It plays as it is. */
  | { kind: "play" }
  /** Too large to play here: offer the compressed copy, the file, and the upgrade when a plan would play it. */
  | { kind: "offer"; upgrade: boolean };

export function videoVerdict(size: number, limits: Pick<VideoLimits, "limit" | "paid">): VideoVerdict {
  if (size <= limits.limit) return { kind: "play" };
  return { kind: "offer", upgrade: !limits.paid && size <= VIDEO_PLAY_PAID_BYTES };
}

/** The sentence the chat shows over a video too large to play. */
export function videoOfferText(size: number, limits: Pick<VideoLimits, "limit" | "paid" | "compress">, mb: (n: number) => string): string {
  const v = videoVerdict(size, limits);
  if (v.kind === "play") return "";
  const head = `This video is ${mb(size)}; the chat plays videos up to ${mb(limits.limit)}${v.upgrade ? ` (${mb(VIDEO_PLAY_PAID_BYTES)} on a paid plan)` : ""}.`;
  return limits.compress
    ? `${head} Compress it to play a smaller copy here.`
    : `${head} To play a smaller copy here, install ffmpeg on the computer (winget install ffmpeg), then press Check again.`;
}

/** POST /v1/ext/studio/sessions/:id/attachments/:aid/compress: the smaller copy, kept beside the original. */
export type VideoCompressResponse = Attachment;
