// STUB: owned by the integrator (mobile/m1); the real module wraps react-native-keyboard-controller with web fallbacks.
import type { ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";

export function KeyboardProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function KeyboardAvoidingView({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle>; behavior?: "padding" | "height" | "position" }) {
  return <View style={style}>{children}</View>;
}

export function KeyboardStickyView({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle>; offset?: { closed?: number; opened?: number } }) {
  return <View style={style}>{children}</View>;
}
