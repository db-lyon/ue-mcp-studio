/**
 * The review card's and the asset diff's words and decisions, for the web
 * client and the app alike: item labels, what the native view button says,
 * how a diff record reads, the tier a comparison takes at a width, a colour
 * value's CSS colour, and blueprint(diff)'s answer as nested lines.
 */
import { exportNumber, nodeValues, type AssetDiff, type AssetDiffRecord, type AssetThumbnail, type AssetVersion, type ReviewItem } from "@ue-mcp-studio/shared";

export const REVIEW_STATUS: Record<ReviewItem["status"], string> = { added: "Added", modified: "Modified", deleted: "Deleted" };

export const fileName = (p: string): string => p.split("/").pop() || p;

/** The native diff button's tooltip. */
export function nativeTitle(it: ReviewItem): string {
  if (!it.native?.available) return it.native?.reason ?? "Unreal cannot open a diff of this item.";
  return it.status === "added" ? "Open the new asset in its editor in Unreal" : it.status === "deleted" ? "Open the deleted version in its editor in Unreal" : "Open Unreal's own diff of before and after";
}

/** What opening Unreal's view of an item did. */
export function openedText(r: { opened: string; windowTitle?: string }): string {
  return r.opened === "editor" ? "Opened in Unreal, in its asset editor." : r.opened === "external" ? "Opened in your text diff tool." : `Unreal's diff window is open${r.windowTitle ? ` (${r.windowTitle})` : ""}.`;
}

/** A checkpoint's time, as the timeline shows it. */
export const markTime = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

/** A timeline mark's kind in words. */
export const markKind = (m: { kind: "turn" | "restore" | "attempt"; undone?: boolean }): string =>
  m.kind === "attempt" ? "Playtest attempt" : m.kind === "restore" ? (m.undone ? "Restore, undone" : "Restore") : "Turn";

/** blueprint(diff)'s answer as nested lines: each key, and its value or its children. */
export function blueprintLines(diff: Record<string, unknown>): Array<{ depth: number; text: string }> {
  const lines: Array<{ depth: number; text: string }> = [];
  const walk = (v: unknown, depth: number, key?: string) => {
    if (lines.length > 400) return;
    const head = key === undefined ? "" : `${key}: `;
    if (v === null || typeof v !== "object") {
      lines.push({ depth, text: `${head}${String(v)}` });
      return;
    }
    const entries = Array.isArray(v) ? v.map((x, i) => [String(i + 1), x] as const) : Object.entries(v as Record<string, unknown>);
    if (key !== undefined) lines.push({ depth, text: key });
    if (entries.length === 0) lines.push({ depth: depth + 1, text: "none" });
    for (const [k, x] of entries) walk(x, key === undefined ? depth : depth + 1, k);
  };
  walk(diff, 0);
  return lines;
}

/** EDiffType::Category and the diff types, in words. */
export const CHANGE_KIND: Record<string, string> = {
  ADDITION: "Added",
  SUBTRACTION: "Removed",
  MODIFICATION: "Changed",
  MINOR: "Minor",
  OBJECT_ADDED: "Added",
  OBJECT_REMOVED: "Removed",
  NODE_ADDED: "Added",
  NODE_REMOVED: "Removed",
  NODE_TYPE_CHANGED: "Changed",
  NODE_PROPERTY_CHANGED: "Changed",
  NODE_MOVED: "Moved",
  PropertyAddedToA: "Removed",
  PropertyAddedToB: "Added",
  PropertyValueChanged: "Changed",
};

export const kindOf = (r: AssetDiffRecord): string => CHANGE_KIND[r.category ?? ""] ?? CHANGE_KIND[r.diffType] ?? "Changed";
export const kindClass = (k: string): "add" | "del" | "minor" | "mod" => (k === "Added" ? "add" : k === "Removed" ? "del" : k === "Minor" || k === "Moved" ? "minor" : "mod");

export const pictureOf = (v: AssetVersion | null | undefined): Extract<AssetThumbnail, { id: string }> | null => (v?.thumbnail && "id" in v.thumbnail ? v.thumbnail : null);

/** The node a graph record is about, by the title the graph shows. */
export const nodeOf = (r: AssetDiffRecord): string | undefined => r.node2?.title ?? r.node1?.title;

/** An added or removed node's subtitle: its full title, when it says more than its name and its values already do. */
export function nodeSubtitle(r: AssetDiffRecord): string | null {
  if (r.diffType !== "NODE_ADDED" && r.diffType !== "NODE_REMOVED") return null;
  const n = r.node1 ?? r.node2;
  const full = n?.fullTitle?.replace(/\s*\n\s*/g, ", ");
  return full && full !== n!.title && !r.displayString.includes(full) && !nodeValues(n).some((v) => exportNumber(v.value) === full) ? full : null;
}

/** Why a version shows no picture, in words. */
export function pictureWhy(v: AssetVersion | null | undefined, missing: string, failed: boolean): string {
  return !v ? missing : v.thumbnail && "error" in v.thumbnail ? `No picture: ${v.thumbnail.error}` : failed ? "No picture: the file could not be read." : "No picture: the editor kept none for this version.";
}

/** What Revert and Keep do to an asset Unreal could not load. */
export function diffErrorConsequence(status: "added" | "modified" | "deleted"): string {
  return status === "added"
    ? "Revert deletes the file the agent added; Keep leaves it."
    : status === "deleted"
      ? "Revert puts the file back as it was before this turn; Keep leaves it deleted."
      : "Revert puts the file back exactly as it was before this turn, byte for byte; Keep leaves it as the agent left it. Neither needs Unreal to load it.";
}

/** The thumbnail errors of both versions, once each. */
export const thumbnailErrors = (diff: AssetDiff): string[] =>
  [...new Set([diff.before, diff.after].flatMap((v) => (v?.thumbnail && "error" in v.thumbnail ? [v.thumbnail.error] : [])))];

export type CompareTier = "wide" | "medium" | "narrow" | "tiny";

/** Each tier's least card width in ems of the card's font, so a larger UI font steps down sooner. */
export const COMPARE_TIERS: readonly [CompareTier, number][] = [["wide", 47], ["medium", 31], ["narrow", 20]];

/** The tier for a card this wide. An unmeasured card (no layout yet) is wide. */
export function compareTier(width: number, em: number): CompareTier {
  if (!(width > 0)) return "wide";
  const ems = width / (em > 0 ? em : 13.5);
  return COMPARE_TIERS.find(([, min]) => ems >= min)?.[0] ?? "tiny";
}

const toSrgb = (c: number): number => {
  const v = Math.min(1, Math.max(0, c));
  return Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));
};

/**
 * The CSS colour of a colour value as ExportText writes it: an FLinearColor,
 * (R=0.5,G=0.1,B=0,A=1), converted from linear, or an FColor, (B=0,G=0,R=255,A=255).
 * Null for any other text.
 */
export function colorOf(text: string): string | null {
  const m = /^\(([^()]*)\)$/.exec(text.trim());
  if (!m) return null;
  const f = new Map<string, number>();
  for (const part of m[1].split(",")) {
    const kv = /^\s*([RGBA])=(-?\d+(?:\.\d+)?)\s*$/.exec(part);
    if (!kv) return null;
    f.set(kv[1], Number(kv[2]));
  }
  if (!["R", "G", "B"].every((k) => f.has(k)) || f.size !== m[1].split(",").length) return null;
  const linear = /\./.test(m[1]);
  const [r, g, b] = ["R", "G", "B"].map((k) => (linear ? toSrgb(f.get(k)!) : Math.min(255, Math.max(0, Math.round(f.get(k)!)))));
  const a = f.has("A") ? Math.min(1, Math.max(0, linear ? f.get("A")! : f.get("A")! / 255)) : 1;
  return `rgba(${r}, ${g}, ${b}, ${Number(a.toFixed(3))})`;
}

/**
 * Where an engine name, path or value may break: after a dot (never one inside
 * a number), slash, backslash, underscore, colon, comma or equals sign (not one
 * a no-break space follows, as in "Roughness = 0.5"); and, only inside a part
 * longer than 32 characters, where a lower-case letter or digit meets a capital.
 */
export function engineParts(text: string): string[] {
  return text.split(/(?<=\.)(?!\d)|(?<=[/\\_:,\s])|(?<==)(?! )/).flatMap((p) => (p.trim().length > 32 ? p.split(/(?<=[a-z0-9])(?=[A-Z])/) : [p]));
}
