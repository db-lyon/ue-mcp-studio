/**
 * The composer's rules with no UI: the bar's tiers by its own width, the
 * message box's height, and how a file waiting to be sent is described.
 * Shared by the web client's composer and the mobile app's.
 */

/**
 * How much of the composer bar fits, widest first. Send and Stop never change;
 * the rest gives way in this order as the bar narrows:
 *
 * - full: every control with its words, the model's route badge and the key hint.
 * - compact: the route badge, the "Effort" word and the key hint go.
 * - icons: Checkpoints and Attach become icon buttons.
 * - merged: the model and the effort become one chip with one menu.
 * - narrowest: that menu opens across the whole bar.
 */
export type BarTier = "full" | "compact" | "icons" | "merged" | "narrowest";

/** Each tier's least bar width, in ems of the bar's font, so a larger UI font steps down sooner. */
export const BAR_TIERS: readonly [BarTier, number][] = [["full", 54], ["compact", 44], ["icons", 34], ["merged", 26]];

/** The tier for a bar this wide. An unmeasured bar (no layout yet) is full. */
export function barTier(width: number, em: number): BarTier {
  if (!(width > 0)) return "full";
  const ems = width / (em > 0 ? em : 13.5);
  return BAR_TIERS.find(([, min]) => ems >= min)?.[0] ?? "narrowest";
}

/** At or below a tier: `atMost("icons", t)` is true for icons, merged and narrowest. */
export function atMost(tier: BarTier, t: BarTier): boolean {
  const order: BarTier[] = ["full", "compact", "icons", "merged", "narrowest"];
  return order.indexOf(t) >= order.indexOf(tier);
}

/** The text box grows with what is written up to this many lines, then scrolls. */
export const MAX_LINES = 15;
/** The text box is never shorter than this, in pixels. */
export const MIN_HEIGHT = 60;
/** The transcript keeps at least this much height, however far the divider is dragged. */
export const MIN_TRANSCRIPT = 120;
/** One arrow key press on the divider moves it this far. */
export const NUDGE = 16;
/** Arrow key presses are saved once they stop for this long, so a held key sends one save. */
export const NUDGE_SAVE_MS = 400;

/** A dragged height, kept between MIN_HEIGHT and the room the transcript can give up. */
export function clampHeight(h: number, room: number): number {
  return Math.round(Math.max(MIN_HEIGHT, Math.min(h, Math.max(MIN_HEIGHT, room))));
}

/**
 * The text box's height for what is written: the content's height, at least the
 * dragged height (`floor`), and at most the larger of 15 lines and that floor,
 * never more than `room`. Past the top it scrolls.
 */
export function fitHeight({ content, line, chrome, floor, room }: { content: number; line: number; chrome: number; floor: number | null; room: number }): { height: number; scroll: boolean } {
  const top = Math.max(MIN_HEIGHT, Math.min(Math.max(line * MAX_LINES + chrome, floor ?? 0), room));
  const want = Math.max(content, floor ?? 0, MIN_HEIGHT);
  return { height: Math.round(Math.min(want, top)), scroll: content > top + 1 };
}

/** Where a sent file is served from. */
export const attachmentUrl = (sessionId: string, id: string): string =>
  `/v1/ext/studio/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(id)}`;

export const isImage = (type: string): boolean => /^image\/(png|jpeg|gif|webp)$/.test(type);

/** 3 KB, 1.2 MB. */
export function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** The largest file the agent accepts; matches MAX_ATTACHMENT_BYTES there. */
export const MAX_BYTES = 100 * 1024 * 1024;

/** A file's extension as its chip shows it when there is no preview: up to four letters, FILE without one. */
export const extOf = (name: string): string => (name.includes(".") ? name.split(".").pop()!.slice(0, 4).toUpperCase() : "FILE");
