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
import { useKeyboardHeight } from "../native/keyboard";

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
 * The insets inside a KeyboardAvoidingView (the chat, the composer): while the
 * keyboard is up the view already ends on top of it, so the bottom is 0 and
 * nothing floats a navigation bar's height above the keys.
 */
export function useAvoidedInsets(): EdgeInsets {
  const insets = useInsets();
  const keyboard = useKeyboardHeight();
  return keyboard > 0 ? { ...insets, bottom: 0 } : insets;
}
