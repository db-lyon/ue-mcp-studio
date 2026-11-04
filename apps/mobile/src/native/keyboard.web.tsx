/** keyboard.tsx on the web harness and in tests: a browser resizes the page itself. */
import type { ReactNode } from "react";
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
