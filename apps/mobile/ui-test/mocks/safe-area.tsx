import { createContext, useSyncExternalStore, type ReactNode } from "react";
import { View } from "react-native";

type Insets = { top: number; bottom: number; left: number; right: number };

/** What a phone with a status bar and a gesture bar gives; tests and the visual QA page set their own. */
export const DEFAULT_INSETS: Insets = { top: 24, bottom: 16, left: 0, right: 0 };
let current: Insets = DEFAULT_INSETS;
const listeners = new Set<() => void>();
const metrics = (insets: Insets) => ({ frame: { x: 0, y: 0, width: 390, height: 860 }, insets });

/** The window's metrics as the library reads them at startup: what a screen outside the provider (a modal on Android) falls back to. */
export let initialWindowMetrics: ReturnType<typeof metrics> | null = metrics(current);

/** Sets the safe area every screen reads, as a phone with that status and navigation bar would give it. */
export function setSafeAreaInsets(next: Partial<Insets>) {
  current = { ...DEFAULT_INSETS, ...next };
  initialWindowMetrics = metrics(current);
  for (const l of listeners) l();
}
export const resetSafeAreaInsets = () => setSafeAreaInsets(DEFAULT_INSETS);

const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));
export const useSafeAreaInsets = () => useSyncExternalStore(subscribe, () => current);

export const SafeAreaInsetsContext = createContext<Insets | null>(null);

export function SafeAreaProvider({ children, style }: { children: ReactNode; style?: unknown; initialMetrics?: unknown }) {
  const insets = useSafeAreaInsets();
  return (
    <SafeAreaInsetsContext.Provider value={insets}>
      <View style={style as never}>{children}</View>
    </SafeAreaInsetsContext.Provider>
  );
}
