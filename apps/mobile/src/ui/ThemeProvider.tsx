/**
 * The theme in use and the fonts it draws with. The web client's fonts are
 * bundled: Plus Jakarta Sans and JetBrains Mono (ue-mcp theme), Instrument
 * Serif italic (display words), Roboto 400 and 700 (editor themes).
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { StyleSheet } from "react-native";
import { useFonts } from "expo-font";
import { PlusJakartaSans_400Regular, PlusJakartaSans_500Medium, PlusJakartaSans_600SemiBold, PlusJakartaSans_700Bold } from "@expo-google-fonts/plus-jakarta-sans";
import { JetBrainsMono_400Regular, JetBrainsMono_500Medium, JetBrainsMono_600SemiBold, JetBrainsMono_700Bold } from "@expo-google-fonts/jetbrains-mono";
import { InstrumentSerif_400Regular, InstrumentSerif_400Regular_Italic } from "@expo-google-fonts/instrument-serif";
import { Roboto_400Regular, Roboto_700Bold } from "@expo-google-fonts/roboto";
import { THEMES, type Theme, type ThemeName } from "./theme";

export const FONTS = {
  PlusJakartaSans_400Regular,
  PlusJakartaSans_500Medium,
  PlusJakartaSans_600SemiBold,
  PlusJakartaSans_700Bold,
  JetBrainsMono_400Regular,
  JetBrainsMono_500Medium,
  JetBrainsMono_600SemiBold,
  JetBrainsMono_700Bold,
  InstrumentSerif_400Regular,
  InstrumentSerif_400Regular_Italic,
  Roboto_400Regular,
  Roboto_700Bold,
};

/** True once every font is in; the app shows its splash colour until then. */
export function useStudioFonts(): boolean {
  const [loaded, error] = useFonts(FONTS);
  return loaded || !!error;
}

const ThemeContext = createContext<Theme>(THEMES["ue-mcp"]);
const SetThemeContext = createContext<(name: ThemeName) => void>(() => undefined);

/** The theme a screen draws with. Below a project, the project's Studio setting picks it (useSetTheme). */
export function ThemeProvider({ name, onChange, children }: { name: ThemeName; onChange?: (name: ThemeName) => void; children: ReactNode }) {
  return (
    <SetThemeContext.Provider value={onChange ?? (() => undefined)}>
      <ThemeContext.Provider value={THEMES[name] ?? THEMES["ue-mcp"]}>{children}</ThemeContext.Provider>
    </SetThemeContext.Provider>
  );
}

/** Switches the app to a theme, as the open project's Settings > Theme says. */
export function useSetTheme(): (name: ThemeName) => void {
  return useContext(SetThemeContext);
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}

/** Styles made from the theme, made again only when the theme changes. */
export function useStyles<T extends Record<string, object>>(make: (t: Theme) => T): T {
  const t = useTheme();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => StyleSheet.create(make(t) as never) as T, [t]);
}
