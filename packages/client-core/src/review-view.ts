/**
 * The review card's and the asset diff's words and decisions, for the web
 * client and the app alike: item labels, what the native view button says,
 * how a diff record reads, the tier a comparison takes at a width, a colour
 * value's CSS colour, and blueprint(diff)'s answer as nested lines.
 */
import type { AssetDiff, AssetThumbnail, AssetVersion, ReviewItem } from "@ue-mcp-studio/shared";

/** How a diff record reads, from the shared diff tree, so client-core keeps no copy of its own. */
export { CHANGE_KIND, colorOf, coveredFacts, kindOf, nodeOf, nodeSubtitle, numberStruct, withoutVerb } from "@ue-mcp-studio/shared";

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

export const kindClass = (k: string): "add" | "del" | "minor" | "mod" => (k === "Added" ? "add" : k === "Removed" ? "del" : k === "Minor" || k === "Moved" ? "minor" : "mod");

export const pictureOf = (v: AssetVersion | null | undefined): Extract<AssetThumbnail, { id: string }> | null => (v?.thumbnail && "id" in v.thumbnail ? v.thumbnail : null);

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

/**
 * Where an engine name, path or value may break: after a dot (never one inside
 * a number), slash, backslash, underscore, colon, comma or equals sign (not one
 * a no-break space follows, as in "Roughness = 0.5"); and, only inside a part
 * longer than 32 characters, where a lower-case letter or digit meets a capital.
 */
export function engineParts(text: string): string[] {
  return text.split(/(?<=\.)(?!\d)|(?<=[/\\_:,\s])|(?<==)(?!\u00a0)/).flatMap((p) => (p.trim().length > 32 ? p.split(/(?<=[a-z0-9])(?=[A-Z])/) : [p]));
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
 * Whether the tile takes an absent picture's place: a new or deleted asset
 * with no facts, which the grid would otherwise leave with nothing to say what
 * it is. A changed asset's line above names it, and its facts are rows of the grid.
 */
export const wantsTile = (diff: AssetDiff, status: "added" | "modified" | "deleted"): boolean => status !== "modified" && !diff.before?.facts.length && !diff.after?.facts.length;

/** Whether a fact is one a record already shows (coveredFacts), so the facts table leaves it out. */
export const isCoveredFact = (covered: Set<string>, name: string): boolean =>
  covered.has(name) || [...covered].some((c) => / parameter$/.test(c) && name.startsWith(`${c} `));
