/**
 * The system around the app: the splash screen held until the fonts are in
 * (so no unstyled frame shows), and the window and bars drawn in the theme's
 * colours. The app draws edge to edge; screens pad themselves by the insets.
 */
import { Platform } from "react-native";
import * as SplashScreen from "expo-splash-screen";
import * as SystemUI from "expo-system-ui";
import * as NavigationBar from "expo-navigation-bar";
import type { Theme } from "../ui";

if (Platform.OS !== "web") void SplashScreen.preventAutoHideAsync().catch(() => undefined);

/** Lets the splash go, fading into the first drawn frame. */
export function hideSplash(): void {
  if (Platform.OS === "web") return;
  SplashScreen.setOptions({ duration: 200, fade: true });
  void SplashScreen.hideAsync().catch(() => undefined);
}

/** The window behind everything and the navigation bar's buttons, for the theme in use. All three themes are dark. */
export function applySystemTheme(t: Theme): void {
  if (Platform.OS === "web") return;
  void SystemUI.setBackgroundColorAsync(t.c.bg).catch(() => undefined);
  // Light buttons on the dark themes; the bar itself is transparent edge to edge.
  if (Platform.OS === "android") NavigationBar.setStyle("light");
}
