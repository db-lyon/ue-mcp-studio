/**
 * Editor dialogs as a client shows them: the one line the card, the banner and
 * the transcript say about who decides right now, and when the card may be
 * answered.
 */
import type { DialogBlock, EditorDialog } from "@ue-mcp-studio/shared";

type Item = NonNullable<EditorDialog["items"]>[number];
type Table = Extract<DialogBlock, { type: "table" }>;

/** A row a person can tick: one carrying a path, which the header's select-all box does not. */
function tickable(i: Item): boolean {
  return i.cells.some((c) => c.startsWith("/"));
}

/** The rows a person can tick: each unsaved asset of a save prompt. A press sends their ticks. */
export function tickableItems(d: EditorDialog): Item[] {
  return (d.items ?? []).filter(tickable);
}

/**
 * What a card draws as the dialog's body: ue-mcp's blocks when it read them,
 * the flat message otherwise, without the lines that only repeat a button
 * label (the buttons are drawn as buttons).
 */
export type DialogBody = { kind: "blocks"; blocks: DialogBlock[] } | { kind: "text"; text: string };

function wellFormed(b: DialogBlock): boolean {
  if (b.type === "paragraph") return typeof b.text === "string" && b.text.trim() !== "";
  return b.type === "table" && Array.isArray(b.columns) && Array.isArray(b.rows) && b.rows.every(Array.isArray);
}

export function dialogBody(d: EditorDialog): DialogBody {
  const blocks = (d.blocks ?? []).filter(wellFormed);
  if (blocks.length > 0) return { kind: "blocks", blocks };
  const buttons = new Set(d.buttons.map((b) => b.trim()));
  return { kind: "text", text: d.message.split("\n").filter((l) => !buttons.has(l.trim())).join("\n").trim() };
}

/** A table's column headings, or none when every heading is empty. */
export function tableColumns(t: Table): string[] {
  return t.columns.some((c) => c.trim() !== "") ? t.columns : [];
}

/** How many cells a table's rows are drawn with: its widest row or its headings. */
export function tableWidth(t: Table): number {
  return Math.max(t.columns.length, ...t.rows.map((r) => r.length), 0);
}

/** Whether a table has a checkbox column. */
export function tableHasChecks(t: Table): boolean {
  return (t.checked ?? []).some((c) => typeof c === "boolean");
}

/**
 * One table row's checkbox: its state, and the item a tick on it changes when
 * the row is one a person can tick. Null for a row without a checkbox.
 */
export function rowCheck(d: EditorDialog, t: Table, row: number): { checked: boolean; item: number | null } | null {
  const checked = t.checked?.[row];
  if (typeof checked !== "boolean") return null;
  const index = t.items?.[row];
  const item = typeof index === "number" ? d.items?.find((i) => i.index === index) : undefined;
  return { checked, item: item && tickable(item) ? item.index : null };
}

/**
 * Whether the separate list of tickable rows is drawn. Not when the body's
 * table already shows each row's checkbox: the same rows twice is noise.
 */
export function itemListShown(d: EditorDialog): boolean {
  const body = dialogBody(d);
  return body.kind === "text" || !body.blocks.some((b) => b.type === "table" && tableHasChecks(b));
}

/** A cell that holds an object path, drawn in the mono face. */
export function isPathCell(cell: string): boolean {
  return cell.startsWith("/");
}

/** m:ss, for a countdown. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Milliseconds until the card's buttons may be pressed; 0 when they may. */
export function readyIn(d: EditorDialog, now: number): number {
  return d.asking ? Math.max(0, d.asking.since + d.asking.minHumanMs - now) : 0;
}

/** Who is deciding: the user, the agent, or the editor. */
export type Decider = "you" | "agent" | "editor" | "done";

export function decider(d: EditorDialog): Decider {
  if (d.held || d.outcome?.kind === "delegated") return "agent";
  if (d.outcome) return "done";
  if (d.asking) return "you";
  return d.mode === "auto" ? "agent" : "editor";
}

/**
 * The truth about who decides, right now, and what happens next. "Waiting for
 * you" only while nothing else will answer, and then with the deadline when one
 * applies.
 */
export function statusLine(d: EditorDialog, now: number): string {
  if (d.held) return `The agent chose ${d.held.button}, pressing in ${clock(d.held.until - now)} (Override).`;
  const o = d.outcome;
  if (o?.kind === "delegated") {
    return o.by === "policy" ? "Nobody answered in time, so the agent is deciding." : "Handed to the agent. The agent is deciding.";
  }
  if (o) return outcomeLine(d);
  const a = d.asking;
  if (a) {
    if (a.deadline === null) {
      return a.policy.kind === "safe" ? "Waiting for you. It has no Cancel or Keep, so nothing is pressed for you." : "Waiting for you.";
    }
    const left = clock(a.deadline - now);
    return a.policy.kind === "agent" ? `Waiting for you. The agent decides in ${left}.` : `Waiting for you. ${a.safeButton} is pressed in ${left}.`;
  }
  if (d.mode === "auto") return "The agent is deciding.";
  if (d.mode === "defer") return "Waiting for an answer in the editor.";
  return "Not put to Studio yet. Answer it in the editor, or here once Studio asks.";
}

/** Which call met it: "editor(stop_editor)", with the subagent when one did. */
export function whoLine(d: EditorDialog): string | null {
  if (!d.call) return null;
  const [category, action] = d.call.split(".");
  return `${category}(${action})${d.subagent ? ` in subagent ${d.subagent}` : ""}`;
}

/** How it ended; empty while it has not. */
export function outcomeLine(d: EditorDialog): string {
  const o = d.outcome;
  if (!o || o.kind === "delegated") return "";
  if (o.kind === "closed") return "Closed in the editor.";
  if (o.by === "policy") return `Nobody answered in time, so ${o.button} was pressed.`;
  if (o.by === "you") return `You pressed ${o.button}.`;
  return `The agent pressed ${o.button}.`;
}
