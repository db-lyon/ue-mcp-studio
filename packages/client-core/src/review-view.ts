/**
 * The review card's and the asset diff's words and decisions, for the web
 * client and the app alike: item labels, what the native view button says,
 * how a diff record reads, the tier a comparison takes at a width, a colour
 * value's CSS colour, which pictures an item shows, and blueprint(diff)'s
 * answer as nested lines.
 */
import type { AssetDiff, AssetThumbnail, AssetVersion, ReviewItem } from "@ue-mcp-studio/shared";
import { assetFamily, type AssetFamily } from "./asset-tile.js";

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

export type PictureSide = "before" | "after";

/** A picture the review shows, and the word under it. */
export interface ShownPicture {
  side: PictureSide;
  label: "Before" | "After" | "New" | "Deleted";
}

/**
 * The asset kinds whose change a picture shows: materials and their
 * instances, meshes, textures, levels and effects. A Blueprint's thumbnail, a
 * data asset's or a sound's says nothing about its components, graphs or
 * values, so those changes are the diff's rows alone.
 */
export const VISUAL_FAMILIES: ReadonlySet<AssetFamily> = new Set<AssetFamily>(["material", "mesh", "texture", "level", "effect"]);

/** Whether an asset of this class (or, with none, this file name) changes in a way a picture shows. */
export const isVisualAsset = (cls: string | undefined, fileName = ""): boolean => VISUAL_FAMILIES.has(assetFamily(cls, fileName));

/**
 * Which pictures a review item shows. Only a visual kind shows any; a changed
 * asset shows Before and After only when both are real pictures, since one
 * side alone compares nothing; a new asset shows its picture as New, a
 * deleted one its last picture as Deleted. Anything else shows none, and the
 * diff carries the change.
 */
export function pictureSides(o: { visual: boolean; status: "added" | "modified" | "deleted"; before: boolean; after: boolean }): ShownPicture[] {
  if (!o.visual) return [];
  if (o.status === "added") return o.after ? [{ side: "after", label: "New" }] : [];
  if (o.status === "deleted") return o.before ? [{ side: "before", label: "Deleted" }] : [];
  return o.before && o.after ? [{ side: "before", label: "Before" }, { side: "after", label: "After" }] : [];
}

/** The class a diff is of: the engine's, else either version's. */
export const diffClass = (diff: AssetDiff): string | undefined => diff.assetClass ?? diff.after?.class ?? diff.before?.class;

/**
 * The pictures an engine diff shows, each with the thumbnail to load: the
 * rule above, with a side real only when the daemon sent a picture of it and
 * the client did not find it unreadable or blank.
 */
export function diffPictures(
  diff: AssetDiff,
  status: "added" | "modified" | "deleted",
  fileName: string,
  failed: Partial<Record<PictureSide, PictureFailure>> = {},
): Array<ShownPicture & { thumbnail: Extract<AssetThumbnail, { id: string }> }> {
  const real = (side: PictureSide) => !!pictureOf(diff[side]) && !failed[side];
  return pictureSides({ visual: isVisualAsset(diffClass(diff), fileName), status, before: real("before"), after: real("after") })
    .map((p) => ({ ...p, thumbnail: pictureOf(diff[p.side])! }));
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

/** Whether a loaded thumbnail shows nothing of the asset, from the shared package, which the agent checks with too. */
export { FLAT_TOLERANCE, isBlankPicture, isFlatPicture, isPlaceholderPicture } from "@ue-mcp-studio/shared";

/**
 * Whether the tile takes an absent picture's place: a new or deleted asset
 * with no facts, which the grid would otherwise leave with nothing to say what
 * it is. A changed asset's line above names it, and its facts are rows of the grid.
 */
export const wantsTile = (diff: AssetDiff, status: "added" | "modified" | "deleted"): boolean => status !== "modified" && !diff.before?.facts.length && !diff.after?.facts.length;

/** Whether a fact is one a record already shows (coveredFacts), so the facts table leaves it out. */
export const isCoveredFact = (covered: Set<string>, name: string): boolean =>
  covered.has(name) || [...covered].some((c) => / parameter$/.test(c) && name.startsWith(`${c} `));
