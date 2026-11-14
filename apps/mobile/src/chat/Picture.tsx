/**
 * chat/Picture.tsx: a picture in the chat, drawn with expo-image so a GIF or an
 * animated WebP plays inline as it does on the computer, on Android and iOS
 * alike. It decodes at the size it is drawn, so a long capture costs the memory
 * of a thumbnail, and the transcript's list drops it once it scrolls far away.
 * A tap opens it full screen over the app; a tap, Close or system back closes it.
 */
import { useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { Image, type ImageLoadEventData } from "expo-image";
import { useBack } from "../back";
import { font, useInsets, useTheme } from "../ui";

/** Natural size, once loaded; until then a 16:9 frame holds its place. */
type Size = { w: number; h: number };

/** `framed`: its own 8px rounded hairline, as `.md-image` has; off inside a tile that frames it already. */
export function Picture({ uri, alt, maxWidth, maxHeight, framed = true }: { uri: string; alt: string; maxWidth: number; maxHeight: number; framed?: boolean }) {
  const t = useTheme();
  const [size, setSize] = useState<Size | null>(null);
  const [open, setOpen] = useState(false);
  // Shrunk to fit, never stretched past its own size: `.md-image`'s max-width and max-height.
  const k = size ? Math.min(1, maxWidth / size.w, maxHeight / size.h) : 1;
  const box = size ? { width: Math.max(1, size.w * k), height: Math.max(1, size.h * k) } : { width: maxWidth, height: Math.min(maxHeight, (maxWidth * 9) / 16) };
  const loaded = (e: ImageLoadEventData) => {
    const { width, height } = e.source ?? {};
    if (width && height && (width !== size?.w || height !== size?.h)) setSize({ w: width, h: height });
  };
  return (
    <>
      <Pressable accessibilityRole="imagebutton" accessibilityLabel={alt} accessibilityHint="Opens the picture full screen" onPress={() => setOpen(true)} style={{ alignSelf: "flex-start" }}>
        <Image
          testID="picture"
          source={{ uri }}
          recyclingKey={uri}
          // A picture from the computer is a file in the app's cache already: no second copy in the image cache's.
          cachePolicy={uri.startsWith("file:") ? "memory" : "disk"}
          contentFit="contain"
          autoplay
          onLoad={loaded}
          accessibilityIgnoresInvertColors
          style={framed ? { ...box, borderRadius: 8, borderWidth: 1, borderColor: t.c.line, backgroundColor: t.c.panel2 } : box}
        />
      </Pressable>
      {open ? <PictureViewer uri={uri} alt={alt} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/** The picture full screen on black, playing if it is animated. */
export function PictureViewer({ uri, alt, onClose }: { uri: string; alt: string; onClose: () => void }) {
  const t = useTheme();
  const insets = useInsets();
  useBack(onClose, { overlay: true });
  return (
    <Modal visible animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={onClose}>
      <View testID="picture-viewer" role="dialog" aria-label={alt} style={{ flex: 1, backgroundColor: "#000" }}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close the picture">
          <Image source={{ uri }} recyclingKey={`${uri}#full`} contentFit="contain" autoplay accessibilityLabel={alt} accessibilityIgnoresInvertColors style={{ flex: 1, marginTop: insets.top, marginBottom: insets.bottom }} />
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} style={{ position: "absolute", top: insets.top + 8, right: insets.right + 8, minWidth: 44, minHeight: 44, paddingHorizontal: 12, justifyContent: "center", borderRadius: 8, backgroundColor: "rgba(0,0,0,0.55)" }}>
          <Text style={{ ...font(t, "sans", 600, 14), color: "#fff" }}>Close</Text>
        </Pressable>
        {alt ? (
          <Text numberOfLines={2} style={{ ...font(t, "sans", 400, 13), position: "absolute", left: 16 + insets.left, right: 16 + insets.right, bottom: insets.bottom + 12, color: "#fff", textAlign: "center" }}>
            {alt}
          </Text>
        ) : null}
      </View>
    </Modal>
  );
}
