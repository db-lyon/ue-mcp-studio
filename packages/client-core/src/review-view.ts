/**
 * The review card's and the asset diff's words and decisions, for the web
 * client and the app alike: item labels, what the native view button says,
 * how a diff record reads, the tier a comparison takes at a width, a colour
 * value's CSS colour, and blueprint(diff)'s answer as nested lines.
 */
import { exportNumber, factRows, nodeValues, type AssetDiff, type AssetDiffRecord, type AssetDiffSection, type AssetThumbnail, type AssetVersion, type ReviewItem } from "@ue-mcp-studio/shared";

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

/** A side whose picture file could not be read, or that drew one flat colour: either way, no picture of it. */
export type PictureFailure = "unreadable" | "blank";

/** Why a version shows no picture, in words. */
export function pictureWhy(v: AssetVersion | null | undefined, missing: string, failed?: PictureFailure): string {
  return !v ? missing
    : v.thumbnail && "error" in v.thumbnail ? `No picture: ${v.thumbnail.error}`
    : failed === "blank" ? "No picture: Unreal's thumbnail renderer drew nothing for this version."
    : failed ? "No picture: the file could not be read."
    : "No picture: the editor kept none for this version.";
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
  return text.split(/(?<=\.)(?!\d)|(?<=[/\\_:,\s])|(?<==)(?!\u00a0)/).flatMap((p) => (p.trim().length > 32 ? p.split(/(?<=[a-z0-9])(?=[A-Z])/) : [p]));
}

/** The engine's message without the verb the badge beside it already says: "Added Node Branch" under ADDED reads "Node Branch". */
export const withoutVerb = (text: string, kind: string): string => {
  const verb = kind === "Added" ? /^Added\s+/ : kind === "Removed" ? /^Removed\s+/ : null;
  return verb && verb.test(text) ? text.replace(verb, "").replace(/^\w/, (c) => c.toUpperCase()) : text;
};

/** A struct of numbers as ExportText writes it, (X=1200.000000,Y=-280.000000,Z=0.000000), as "X 1200, Y -280, Z 0"; null for any other text. */
export function numberStruct(v: string): string | null {
  const m = /^\(([^()]*)\)$/.exec(v.trim());
  if (!m) return null;
  const parts = m[1].split(",").map((p) => /^\s*(\w+)=(-?\d+(?:\.\d+)?(?:e[-+]?\d+)?)\s*$/i.exec(p));
  if (!parts.length || parts.some((p) => !p)) return null;
  return parts.map((p) => `${p![1]}\u00a0${Number(p![2])}`).join(", ");
}

/** Most a colour channel may vary across a picture that still counts as one flat colour. */
export const FLAT_TOLERANCE = 6;

/**
 * Whether RGBA pixels are one flat colour, or fully transparent: what a
 * thumbnail renderer that drew nothing leaves (black, or only its background).
 * A picture of nothing is not a picture of the version.
 */
export function isFlatPicture(px: ArrayLike<number>): boolean {
  if (px.length < 4) return true;
  const min = [255, 255, 255];
  const max = [0, 0, 0];
  for (let i = 0; i + 3 < px.length; i += 4) {
    if (px[i + 3] < 8) continue;
    for (let c = 0; c < 3; c++) {
      if (px[i + c] < min[c]) min[c] = px[i + c];
      if (px[i + c] > max[c]) max[c] = px[i + c];
    }
    if (max[0] - min[0] > FLAT_TOLERANCE || max[1] - min[1] > FLAT_TOLERANCE || max[2] - min[2] > FLAT_TOLERANCE) return false;
  }
  return true;
}

/**
 * Whether the tile takes an absent picture's place. A new or deleted asset's
 * tile says what it is. A changed one's says only what changed in its facts,
 * so it is shown when a fact changed and no record lists the change: the item's
 * line above already names the asset.
 */
export const wantsTile = (diff: AssetDiff, status: "added" | "modified" | "deleted"): boolean =>
  status !== "modified"
  || (!(diff.sections ?? []).some((x) => x.entries.some((e) => !e.hidden)) && !diff.textDiff?.diff && factRows(diff.before, diff.after).some((r) => r.changed));

/**
 * Facts the engine records already show: a variable's fact when My Blueprint
 * lists that variable, and the count of variables, components or graphs when
 * that section has records.
 */
export function coveredFacts(sections: AssetDiffSection[]): Set<string> {
  const out = new Set<string>();
  for (const s of sections) {
    if (!s.entries.some((e) => !e.hidden)) continue;
    if (s.category === "My Blueprint") {
      out.add("Variables");
      for (const e of s.entries) if (e.group) out.add(`Variable ${e.group}`);
    }
    if (s.category === "Components") out.add("Components");
    for (const e of s.entries) {
      const kind = /^(Scalar|Vector|Texture) Parameter Values$/.exec(e.path ?? "");
      if (kind) out.add(`${kind[1]} parameter`);
    }
    if (s.category.startsWith("Graph: ")) out.add("Graphs");
    if (s.category === "Material Graph") out.add("Expressions");
  }
  return out;
}

/** Whether a fact is one a record already shows (coveredFacts), so the facts table leaves it out. */
export const isCoveredFact = (covered: Set<string>, name: string): boolean =>
  covered.has(name) || [...covered].some((c) => / parameter$/.test(c) && name.startsWith(`${c} `));
