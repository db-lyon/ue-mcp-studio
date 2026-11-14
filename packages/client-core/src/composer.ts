/**
 * The composer's rules with no UI: the bar's tiers by its own width, the
 * message box's height, and how a file waiting to be sent is described.
 * Shared by the web client's composer and the mobile app's.
 */

/**
 * How much of the composer bar fits, widest first. Send and Stop never change;
 * the rest gives way in this order as the bar narrows:
 *
 * - full: the model with its route badge, and the effort with its word.
 * - compact: the route badge and the "Effort" word go.
 * - merged: the model and the effort become one chip with one menu.
 * - narrowest: that menu opens across the whole bar.
 *
 * The utility buttons (Checkpoints, Subagents, Attach) are icons at every
 * tier, and fold into one overflow button by measured fit (`foldUtilities`).
 */
export type BarTier = "full" | "compact" | "merged" | "narrowest";

/** Each tier's least bar width, in ems of the bar's font, so a larger UI font steps down sooner. */
export const BAR_TIERS: readonly [BarTier, number][] = [["full", 54], ["compact", 34], ["merged", 26]];

/** The tier for a bar this wide. An unmeasured bar (no layout yet) is full. */
export function barTier(width: number, em: number): BarTier {
  if (!(width > 0)) return "full";
  const ems = width / (em > 0 ? em : 13.5);
  return BAR_TIERS.find(([, min]) => ems >= min)?.[0] ?? "narrowest";
}

/** At or below a tier: `atMost("merged", t)` is true for merged and narrowest. */
export function atMost(tier: BarTier, t: BarTier): boolean {
  const order: BarTier[] = ["full", "compact", "merged", "narrowest"];
  return order.indexOf(t) >= order.indexOf(tier);
}

/**
 * The composer bar's utility buttons, after the model and the context meter,
 * in this order on every client. Each is an icon with its name for a screen
 * reader; Subagents shows only while the session has subagents.
 */
export type BarUtilityId = "checkpoints" | "subagents" | "attach";
export const BAR_UTILITIES: readonly BarUtilityId[] = ["checkpoints", "subagents", "attach"];

/** A utility's name: its accessibility label and its overflow menu item. */
export function utilityLabel(id: BarUtilityId, count = 0): string {
  return id === "checkpoints" ? "Checkpoints" : id === "subagents" ? `Subagents (${count})` : "Attach";
}

/** A utility's longer description: its tooltip, or its accessibility hint. */
export const UTILITY_TITLE: Record<BarUtilityId, string> = {
  checkpoints: "Review this session's changes and its checkpoints",
  subagents: "This session's subagents",
  attach: "Attach files (or drop or paste them)",
};

/**
 * What a press on the bar's Subagents button does. Where the subagent list is
 * drawn inline under the composer (a wide web layout), the button is a toggle
 * for that list and never opens a second copy of it: a hidden list is shown, a
 * shown list in view is hidden, and a shown list scrolled out of view is
 * brought back into view. Where there is no inline list (a narrow web layout,
 * a paired phone's browser, the app), it opens the list, the only one on screen.
 */
export type SubagentsPress = "open-list" | "show" | "hide" | "reveal";
export function subagentsPress({ inline, shown, inView }: { inline: boolean; shown: boolean; inView: boolean }): SubagentsPress {
  if (!inline) return "open-list";
  if (!shown) return "show";
  return inView ? "hide" : "reveal";
}

/** Where a viewer's choice to show or hide the inline subagent list is kept, per device. */
export const SUBAGENTS_SHOWN_KEY = "studio.subagents.shown";
/** Whether the inline subagent list shows, from what was stored: shown unless this viewer hid it. */
export const subagentsShownFrom = (stored: string | null | undefined): boolean => stored !== "hidden";
/** The value stored for a choice to show or hide the inline subagent list. */
export const subagentsShownValue = (shown: boolean): string => (shown ? "shown" : "hidden");

/** Send's and Stop's tooltips, where the keyboard's keys are told: the bar shows no words. */
export const SEND_KEYS = "Send (Enter). Shift+Enter for a new line";
export const STOP_KEYS = "Stop the turn. Enter queues the message, Ctrl+Enter stops the turn and sends it now";

/** The overflow button the utilities fold into. */
export const UTILITY_MORE_LABEL = "More controls";

/** The overflow button's accessibility label: with the subagents' count while there are some, as its badge shows. */
export function moreLabel(subagents = 0): string {
  return subagents > 0 ? `${UTILITY_MORE_LABEL}, ${subagents} ${subagents === 1 ? "subagent" : "subagents"}` : UTILITY_MORE_LABEL;
}

/**
 * Whether the utility buttons fold into the one overflow button, from measured
 * widths: `row` is the buttons laid out side by side at their natural width,
 * `room` what the bar gives them now: the width of their slot (the row, or the
 * overflow button when folded) plus the bar's free space (its spacer). The
 * slot is the first thing in the bar to shrink, so a row that does not fit
 * shows as a slot narrower than the row. Both states measure the same room,
 * so the answer does not flip back and forth. Unmeasured (null) does not fold.
 */
export function foldUtilities(row: number | null, room: number | null): boolean {
  if (row === null || room === null || !(row > 0) || !(room >= 0)) return false;
  return row > room + 0.5;
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
