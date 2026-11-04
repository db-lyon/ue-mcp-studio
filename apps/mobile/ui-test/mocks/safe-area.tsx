import type { ReactNode } from "react";
import { View } from "react-native";
// The visual QA page sets __qaInsets to zero: the web reference has no safe area to match.
const insets = { top: 24, bottom: 16, left: 0, right: 0 };
export const useSafeAreaInsets = () => (globalThis as { __qaInsets?: typeof insets }).__qaInsets ?? insets;
export const SafeAreaProvider = ({ children, style }: { children: ReactNode; style?: unknown }) => <View style={style as never}>{children}</View>;
