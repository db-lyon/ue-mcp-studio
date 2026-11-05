/** keyboard.tsx on the web harness and in tests: a browser resizes the page itself. */
import { useSyncExternalStore, type ReactNode } from "react";
import { View, type ViewProps } from "react-native";

export function KeyboardProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function KeyboardAvoidingView({ behavior: _b, keyboardVerticalOffset: _k, ...rest }: ViewProps & { behavior?: string; keyboardVerticalOffset?: number }) {
  return <View {...rest} />;
}

export function KeyboardStickyView({ offset: _o, ...rest }: ViewProps & { offset?: { closed?: number; opened?: number } }) {
  return <View {...rest} />;
}

// No soft keyboard here: tests set one to see what a screen does while it is up.
let height = 0;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));

/** Tests only: a soft keyboard this tall is up (0 puts it away). */
export function setKeyboardHeight(h: number) {
  height = h;
  for (const l of listeners) l();
}

export const useKeyboardHeight = (): number => useSyncExternalStore(subscribe, () => height);
