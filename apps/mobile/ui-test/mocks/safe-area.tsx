import type { ReactNode } from "react";
import { View } from "react-native";
// No bottom inset: the web reference is a paired browser, whose page has none.
const insets = { top: 24, bottom: 0, left: 0, right: 0 };
export const useSafeAreaInsets = () => insets;
export const SafeAreaProvider = ({ children, style }: { children: ReactNode; style?: unknown }) => <View style={style as never}>{children}</View>;
