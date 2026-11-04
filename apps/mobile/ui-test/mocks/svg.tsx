/** react-native-svg for component tests: the shapes as plain views, enough to find and press what holds them. */
import type { ReactNode } from "react";
import { View } from "react-native";

const Shape = ({ children }: { children?: ReactNode }) => <View>{children}</View>;
export default Shape;
export const Svg = Shape;
export const Path = Shape;
export const Rect = Shape;
export const Circle = Shape;
export const G = Shape;
export const Polyline = Shape;
