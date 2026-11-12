/**
 * Whether a thumbnail is a picture of nothing: what Unreal's thumbnail
 * renderer leaves when it drew nothing (one flat colour, or only transparency),
 * or its empty placeholder (a grey checkerboard). The agent drops such a
 * capture before it reaches a client, and the clients check what they load too,
 * since an older agent or a saved thumbnail can still send one.
 */

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
 * Whether RGBA pixels are Unreal's empty placeholder: a checkerboard of two
 * greys. Every opaque pixel is a neutral grey, two grey levels (each at least a
 * quarter of the picture) make up nearly all of it, and the rest is the blend
 * a scaled-down checker leaves at its edges. A rendered asset has colour or
 * shading across many levels, so it never passes.
 */
export function isPlaceholderPicture(px: ArrayLike<number>): boolean {
  const levels = new Map<number, number>();
  let opaque = 0;
  for (let i = 0; i + 3 < px.length; i += 4) {
    if (px[i + 3] < 8) continue;
    const r = px[i];
    const g = px[i + 1];
    const b = px[i + 2];
    if (Math.abs(r - g) > FLAT_TOLERANCE || Math.abs(g - b) > FLAT_TOLERANCE || Math.abs(r - b) > FLAT_TOLERANCE) return false;
    const level = Math.round((r + g + b) / 3 / 8);
    levels.set(level, (levels.get(level) ?? 0) + 1);
    opaque++;
  }
  if (opaque === 0) return false;
  const [first, second] = [...levels.entries()].sort((a, b) => b[1] - a[1]);
  if (!first || !second || Math.abs(first[0] - second[0]) < 2) return false;
  return first[1] + second[1] >= opaque * 0.9 && second[1] >= opaque * 0.25;
}

/** Whether a thumbnail's pixels show nothing of the asset: flat, or the empty placeholder. */
export const isBlankPicture = (px: ArrayLike<number>): boolean => isFlatPicture(px) || isPlaceholderPicture(px);
