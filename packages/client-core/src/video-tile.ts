/**
 * A video a message carried, as both clients draw it. On the computer it
 * always plays. Through the relay (the phone, a paired browser) it plays when
 * it fits the plan's relay limit, else the offer, which always leaves a way
 * on: Compress and play (a smaller copy made on the computer), Open on the
 * computer, and Check again while the computer has no encoder. The limits are
 * read once and kept for a few minutes, for every tile in the chat.
 */
import { videoOfferText, videoVerdict, type Attachment, type VideoLimits } from "@ue-mcp-studio/shared";
import { formatBytes } from "./composer.js";

/** Until the computer has said: no relay figure, and no encoder claimed. */
export const VIDEO_LIMITS_UNKNOWN: VideoLimits = { relay: 0, compress: false };

const LIMITS_TTL_MS = 3 * 60_000;
let cached: { at: number; value: Promise<VideoLimits> } | null = null;

/** The account's video limits, asked once per few minutes; an error reads as no relay figure. */
export function videoLimitsOnce(load: () => Promise<VideoLimits>, now = Date.now()): Promise<VideoLimits> {
  if (!cached || now - cached.at > LIMITS_TTL_MS) {
    const value = load().catch(() => VIDEO_LIMITS_UNKNOWN);
    cached = { at: now, value };
  }
  return cached.value;
}

/** Forget the kept limits, after a failed compress or a Check again, and for tests. */
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
  /** No encoder yet: offer Check again, for after ffmpeg is installed. */
  recheck: boolean;
  /** Offer Open on the computer. */
  openOnComputer: boolean;
}

/** `remote`: the chat is drawn through the relay. */
export function videoTile(a: Attachment, limits: VideoLimits, copy: Attachment | null, remote: boolean): VideoTileModel {
  const none = { offer: "", compress: false, recheck: false, openOnComputer: false };
  if (copy) return { play: copy, ...none };
  if (videoVerdict(a.size, limits, remote).kind === "play") return { play: a, ...none };
  return { play: null, offer: videoOfferText(a.size, limits, formatBytes), compress: limits.compress, recheck: !limits.compress, openOnComputer: true };
}

export const VIDEO_COMPRESS_LABEL = "Compress and play";
export const VIDEO_COMPRESSING_LABEL = "Compressing";
export const VIDEO_RECHECK_LABEL = "Check again";
export const VIDEO_OPEN_ON_COMPUTER_LABEL = "Open on the computer";
export const VIDEO_OPENED_ON_COMPUTER = "Playing on the computer.";
