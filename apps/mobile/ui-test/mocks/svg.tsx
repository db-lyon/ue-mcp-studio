/** react-native-svg for component tests: the box, its shapes left out. The parity page draws the real one. */
import type { ReactNode } from "react";
import { View } from "react-native";

export default function Svg({ width, height, children }: { width?: number; height?: number; children?: ReactNode }) {
  return <View style={{ width, height }}>{children}</View>;
}
export const Path = (_props: { d: string }) => null;
