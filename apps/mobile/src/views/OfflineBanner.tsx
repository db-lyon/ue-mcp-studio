/**
 * Under the bar while this phone has no network: nothing can reach the relay,
 * whatever the computer does. A strip the width of the screen in the warn
 * wash over the page's background, so nothing under it shows through, and
 * the bar above it stays usable.
 */
import { View } from "react-native";
import { useDeviceOnline } from "../native/online";
import { Dot, font, T, useInsets, useTheme } from "../ui";

/** The strip's height on a phone (one line of its text): what a page under it leaves free. */
export const OFFLINE_STRIP = 40;

export function OfflineBanner() {
  const online = useDeviceOnline();
  const insets = useInsets();
  const t = useTheme();
  if (online) return null;
  return (
    <View
      pointerEvents="none"
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={{ position: "absolute", left: 0, right: 0, top: 50 + insets.top, zIndex: 100, backgroundColor: t.c.bg, borderBottomWidth: 1, borderBottomColor: t.editor ? t.c.line : t.c.warnLine }}
    >
      <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: t.editor ? t.c.panel2 : t.c.warnWash }} />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingVertical: 6, minHeight: OFFLINE_STRIP - 1 }}>
        <Dot kind="warn" />
        <T style={{ ...font(t, "sans", 600, 13.5, 1.3), color: t.editor ? t.c.text : t.c.warnText, flexShrink: 1 }}>This phone is offline. The app reconnects on its own.</T>
      </View>
    </View>
  );
}
