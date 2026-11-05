/**
 * Gradient stops for react-native-svg. On Android a Stop drops the alpha of
 * an rgba() or #rrggbbaa stopColor and draws it at stopOpacity (1 unless
 * given), so a faint tint paints near-opaque white. Every Stop takes its
 * colour and opacity from here, split, with the opacity explicit.
 */
export interface StopColor {
  color: string;
  opacity: number;
}

export function stopOf(color: string): StopColor {
  const c = color.trim();
  if (c === "transparent") return { color: "rgb(0, 0, 0)", opacity: 0 };
  const rgba = /^rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/.exec(c);
  if (rgba) return { color: `rgb(${rgba[1]}, ${rgba[2]}, ${rgba[3]})`, opacity: Number(rgba[4]) };
  const hex8 = /^#([0-9a-f]{6})([0-9a-f]{2})$/i.exec(c);
  if (hex8) return { color: `#${hex8[1]}`, opacity: Math.round((parseInt(hex8[2], 16) / 255) * 1000) / 1000 };
  const hex4 = /^#([0-9a-f]{3})([0-9a-f])$/i.exec(c);
  if (hex4) return { color: `#${hex4[1]}`, opacity: Math.round((parseInt(hex4[2] + hex4[2], 16) / 255) * 1000) / 1000 };
  return { color: c, opacity: 1 };
}
