/**
 * A video a message carried, as both clients draw it: playing when it fits
 * the account's limit, else an offer that always leaves a way on (Compress
 * and play, Open the file, Upgrade where a plan would play it). The limits
 * are read once and kept for a few minutes, for every tile in the chat.
 */
import { VIDEO_PLAY_BYTES, videoOfferText, videoVerdict, type Attachment, type VideoLimits } from "@ue-mcp-studio/shared";
import { formatBytes } from "./composer.js";

/** Until the computer has said: the free limit, and no encoder claimed. */
export const VIDEO_LIMITS_UNKNOWN: VideoLimits = { limit: VIDEO_PLAY_BYTES, paid: false, compress: false };

const LIMITS_TTL_MS = 3 * 60_000;
let cached: { at: number; value: Promise<VideoLimits> } | null = null;

/** The account's video limits, asked once per few minutes; an error reads as the free limit. */
export function videoLimitsOnce(load: () => Promise<VideoLimits>, now = Date.now()): Promise<VideoLimits> {
  if (!cached || now - cached.at > LIMITS_TTL_MS) {
    const value = load().catch(() => VIDEO_LIMITS_UNKNOWN);
    cached = { at: now, value };
  }
  return cached.value;
}

/** Forget the kept limits, after an upgrade or a failed compress, and for tests. */
export function forgetVideoLimits(): void {
  cached = null;
}

/** What a video tile shows. */
export interface VideoTileModel {
  /** Play this attachment: the original, or its compressed copy. */
  play: Attachment | null;
  /** The offer's sentence when it does not play. */
  offer: string;
  /** Offer Compress and play. */
  compress: boolean;
  /** Offer the upgrade. */
  upgrade: boolean;
  /** No encoder yet: offer Check again, for after ffmpeg is installed. */
  recheck: boolean;
}

export function videoTile(a: Attachment, limits: VideoLimits, copy: Attachment | null): VideoTileModel {
  const none = { offer: "", compress: false, upgrade: false, recheck: false };
  if (copy) return { play: copy, ...none };
  const v = videoVerdict(a.size, limits);
  if (v.kind === "play") return { play: a, ...none };
  return { play: null, offer: videoOfferText(a.size, limits, formatBytes), compress: limits.compress, upgrade: v.upgrade, recheck: !limits.compress };
}

export const VIDEO_COMPRESS_LABEL = "Compress and play";
export const VIDEO_RECHECK_LABEL = "Check again";
export const VIDEO_COMPRESSING_LABEL = "Compressing";
export const VIDEO_OPEN_LABEL = "Open file";
