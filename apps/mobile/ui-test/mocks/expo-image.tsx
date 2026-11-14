/**
 * expo-image for component tests and the visual QA page: an <img> the browser
 * draws (and animates, for a GIF), marked so a test can tell the picture went
 * through expo-image and whether it plays. Its load event carries the natural
 * size, as expo-image's does.
 */
import type { CSSProperties } from "react";
// @ts-ignore react-native-web ships no types; the app types it as react-native.
import { StyleSheet } from "../../../../node_modules/react-native-web/dist/index.js";

export type ImageLoadEventData = { cacheType: "none" | "disk" | "memory"; source: { url: string; width: number; height: number; mediaType: string | null; isAnimated?: boolean } };

type Props = {
  source?: { uri?: string } | string | null;
  contentFit?: "cover" | "contain" | "fill" | "none" | "scale-down";
  autoplay?: boolean;
  recyclingKey?: string | null;
  onLoad?: (e: ImageLoadEventData) => void;
  onError?: (e: { error: string }) => void;
  style?: unknown;
  testID?: string;
  accessibilityLabel?: string;
  accessibilityIgnoresInvertColors?: boolean;
};

export function Image({ source, contentFit = "cover", autoplay = true, recyclingKey, onLoad, onError, style, testID, accessibilityLabel }: Props) {
  const uri = typeof source === "string" ? source : source?.uri;
  const flat = (StyleSheet.flatten(style) ?? {}) as CSSProperties & { flex?: number };
  return (
    <img
      data-expo-image=""
      data-autoplay={String(autoplay)}
      data-content-fit={contentFit}
      data-recycling-key={recyclingKey ?? undefined}
      data-testid={testID}
      src={uri}
      alt={accessibilityLabel ?? ""}
      style={{ ...flat, display: "block", boxSizing: "border-box", borderStyle: flat.borderWidth ? "solid" : undefined, objectFit: contentFit === "scale-down" ? "scale-down" : contentFit, minHeight: 0, minWidth: 0 }}
      onLoad={(e) => {
        const img = e.currentTarget;
        onLoad?.({ cacheType: "none", source: { url: img.src, width: img.naturalWidth, height: img.naturalHeight, mediaType: null } });
      }}
      onError={() => onError?.({ error: "could not load" })}
    />
  );
}

export default Image;
