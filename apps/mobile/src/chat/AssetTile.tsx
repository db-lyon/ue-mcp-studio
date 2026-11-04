/**
 * chat/AssetTile.tsx: what a review shows for an asset version with no
 * picture: the type's icon, its class and object path, what the turn changed
 * in it, and its facts. What it says is worked out in client-core.
 */
import { useState, type ReactNode } from "react";
import { Image, Text, View, type TextStyle } from "react-native";
import Svg, { Path } from "react-native-svg";
import { ASSET_ICON_PATHS, TILE_STATUS_LINE, assetFamily, type AssetFamily } from "@ue-mcp-studio/client-core";
import { baseFont, font, useTheme, type Theme } from "../ui";
import { EngineText } from "./breakable";

export { TILE_FACTS, assetFamily, changeCounts, tileFacts, tileOf, type AssetFamily } from "@ue-mcp-studio/client-core";

export function AssetIcon({ family, color }: { family: AssetFamily; color?: string }) {
  const t = useTheme();
  return (
    <Svg width={28} height={28} viewBox="0 0 16 16" fill="none" stroke={color ?? t.c.accent} strokeWidth={1.1} strokeLinecap="round" strokeLinejoin="round" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Path d={ASSET_ICON_PATHS[family]} />
    </Svg>
  );
}

const small = (t: Theme, color: string): TextStyle => ({ ...baseFont(t), fontSize: 12, lineHeight: 12 * (t.base.lineHeight / t.base.size), color });
/** `.mono.small`: the mono face at 0.92em of 12px. */
/** `.mono.small` on one element: .mono's 0.92em is of the body's size (the tile's path). */
const monoBody = (t: Theme, color: string): TextStyle => ({ ...font(t, "mono", 400, Math.round(t.base.size * 0.92 * 100) / 100), lineHeight: Math.round(t.base.lineHeight * 0.92 * 100) / 100, color });
const monoSmall = (t: Theme, color: string): TextStyle => ({ ...font(t, "mono", 400, 12 * 0.92), lineHeight: 12 * (t.base.lineHeight / t.base.size), color });

/**
 * The tile: icon, class, path, what changed, facts. Used where a picture would
 * go; `note` says why there is no picture when that is worth knowing.
 */
export function AssetTile({ cls, fileName, path, status, changes, facts, note }: {
  cls?: string;
  fileName: string;
  path?: string;
  status: "added" | "modified" | "deleted";
  changes?: Array<{ text: string; tone: string }>;
  facts?: Array<{ name: string; value: string; was?: string }>;
  note?: ReactNode;
}) {
  const t = useTheme();
  const family = assetFamily(cls, fileName);
  const [bodyWidth, setBodyWidth] = useState(0);
  const [nameWidth, setNameWidth] = useState(0);
  const toneColor = (tone: string) => (tone === "add" ? t.c.ok : tone === "del" ? t.c.bad : tone === "mod" ? t.c.warn : t.c.muted);
  const statusColor = status === "added" ? t.c.ok : status === "deleted" ? t.c.bad : t.c.muted;
  // fit-content(45%): the names' column is as wide as its widest name, at most 45% of the body.
  const nameCol = bodyWidth ? Math.min(nameWidth, (bodyWidth + 0.5) * 0.45) : undefined;
  return (
    <View accessibilityRole="none" accessibilityLabel={`${cls ?? "Asset"} ${fileName}`} style={{ flexDirection: "row", gap: 10, alignItems: "flex-start", minWidth: 0, paddingVertical: 8, paddingHorizontal: 10, borderWidth: 1, borderColor: t.c.line, borderLeftWidth: 3, borderLeftColor: t.c.accentLine, borderRadius: 4 }}>
      <View style={{ marginTop: 1 }}>
        <AssetIcon family={family} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 4 }} onLayout={(e) => setBodyWidth(e.nativeEvent.layout.width)}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", rowGap: 4, columnGap: 10 }}>
          <Text style={{ ...baseFont(t), ...font(t, "sans", 600, t.base.size), lineHeight: t.base.lineHeight, flexShrink: 1 }}>{cls ? <EngineText text={cls} /> : "Asset"}</Text>
          <Text style={small(t, statusColor)}>{TILE_STATUS_LINE[status]}</Text>
        </View>
        {path ? <Text style={monoBody(t, t.c.muted)}><EngineText text={path} /></Text> : null}
        {changes && changes.length > 0 ? (
          <View accessibilityLabel="What changed" style={{ flexDirection: "row", flexWrap: "wrap", rowGap: 4, columnGap: 6 }}>
            {changes.map((c) => (
              <View key={c.text} style={{ paddingHorizontal: 6, borderRadius: 3, borderWidth: 1, borderColor: c.tone === "add" || c.tone === "del" || c.tone === "mod" ? toneColor(c.tone) : t.c.lineStrong }}>
                <Text style={small(t, toneColor(c.tone))} numberOfLines={1}>{c.text}</Text>
              </View>
            ))}
          </View>
        ) : null}
        {facts && facts.length > 0 ? (
          <View style={{ gap: 2 }}>
            {facts.map((f) => (
              <View key={f.name} style={{ flexDirection: "row", columnGap: 12 }}>
                <Text style={[small(t, t.c.muted), nameCol !== undefined ? { width: nameCol } : { maxWidth: "45%" }]} onLayout={nameCol === undefined ? (e) => setNameWidth((w) => Math.max(w, Math.ceil(e.nativeEvent.layout.width))) : undefined}>
                  <EngineText text={f.name} />
                </Text>
                <Text style={[monoSmall(t, t.c.text), { flex: 1, minWidth: 0, lineHeight: Math.round(12 * 0.92 * (t.base.lineHeight / t.base.size) * 100) / 100 }]}>
                  {f.was !== undefined ? (
                    <>
                      <Text style={{ color: t.c.dim }}><EngineText text={f.was} /></Text>
                      {" to "}
                    </>
                  ) : null}
                  <EngineText text={f.value} />
                </Text>
              </View>
            ))}
          </View>
        ) : null}
        {note ? <Text style={small(t, t.c.dim)}>{note}</Text> : null}
      </View>
    </View>
  );
}

/** A picture that becomes `fallback` when it fails to load, so a missing file never leaves a broken frame. */
export function PictureOr({ src, alt, fallback, caption, width, height }: { src: string; alt: string; title?: string; lazy?: boolean; fallback: ReactNode; caption?: ReactNode; width: number; height: number }) {
  const t = useTheme();
  const [failed, setFailed] = useState(false);
  if (failed) return <>{fallback}</>;
  const img = <Image accessibilityLabel={alt} source={{ uri: src }} style={{ width, height }} onError={() => setFailed(true)} />;
  // A caption names the picture that drew, so it is never read as the note of the one beside it that failed.
  return caption ? (
    <>
      {img}
      <Text style={monoSmall(t, t.c.dim)}>{caption}</Text>
    </>
  ) : img;
}
