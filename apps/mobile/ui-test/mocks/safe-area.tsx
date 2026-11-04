import type { ReactNode } from "react";
import { View } from "react-native";
const insets = { top: 24, bottom: 16, left: 0, right: 0 };
export const useSafeAreaInsets = () => insets;
export const SafeAreaProvider = ({ children, style }: { children: ReactNode; style?: unknown }) => <View style={style as never}>{children}</View>;
