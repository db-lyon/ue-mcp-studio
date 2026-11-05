/**
 * The safe area every screen, sheet and popover pads by. The app draws edge to
 * edge, so whatever reaches the bottom of the screen pads by the navigation
 * bar's inset (a large one with 3-button navigation, a small one with
 * gestures) and the sides by a landscape bar's.
 *
 * Read through these, never useSafeAreaInsets: a Modal on Android is its own
 * window, and a screen drawn there or outside the provider falls back to the
 * window's own metrics instead of throwing or reading zero.
 */
import { useContext } from "react";
import { initialWindowMetrics, SafeAreaInsetsContext, type EdgeInsets } from "react-native-safe-area-context";
import { View } from "react-native";
import { useKeyboardHeight } from "../native/keyboard";
import { useTheme } from "./ThemeProvider";

const NONE: EdgeInsets = { top: 0, bottom: 0, left: 0, right: 0 };

export function useInsets(): EdgeInsets {
  return useContext(SafeAreaInsetsContext) ?? initialWindowMetrics?.insets ?? NONE;
}

/** A full-screen overlay's padding: `pad` inside each bar. */
export function edgePadding(insets: EdgeInsets, pad: number) {
  return { paddingTop: pad + insets.top, paddingBottom: pad + insets.bottom, paddingLeft: pad + insets.left, paddingRight: pad + insets.right };
}

/**
 * The insets a surface floating at the bottom of the screen (a sheet, a menu,
 * a bottom bar) pads by: while the soft keyboard is up its bottom is the
 * keyboard's height, which already covers the navigation bar.
 */
export function useSheetInsets(): EdgeInsets {
  const insets = useInsets();
  const keyboard = useKeyboardHeight();
  return keyboard > 0 ? { ...insets, bottom: keyboard } : insets;
}

/**
 * An opaque strip behind the navigation bar, for a page that scrolls to the
 * bottom of the screen: its content passes under the bar mid-scroll, and the
 * system draws the bar see-through edge to edge. The page still pads its end
 * by the inset, so the last row stops above the strip.
 */
export function NavBarBacking({ color }: { color?: string }) {
  const insets = useInsets();
  const t = useTheme();
  if (insets.bottom <= 0) return null;
  return <View testID="navbar-backing" pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: insets.bottom, backgroundColor: color ?? t.c.bg }} />;
}

/**
 * The insets inside a KeyboardAvoidingView (the chat, the composer): while the
 * keyboard is up the view already ends on top of it, so the bottom is 0 and
 * nothing floats a navigation bar's height above the keys.
 */
export function useAvoidedInsets(): EdgeInsets {
  const insets = useInsets();
  const keyboard = useKeyboardHeight();
  return keyboard > 0 ? { ...insets, bottom: 0 } : insets;
}
