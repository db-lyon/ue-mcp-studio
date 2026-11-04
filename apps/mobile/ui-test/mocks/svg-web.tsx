/**
 * react-native-svg for the parity page: the browser's own <svg> and <path>,
 * which is what react-native-svg's web build draws, without its native
 * modules that Vite's dependency scan cannot resolve.
 */
import { createElement, type ReactNode } from "react";

type Props = Record<string, unknown> & { children?: ReactNode };
const el = (tag: string) => ({ children, ...props }: Props) => createElement(tag, props, children);

export const Svg = ({ children, ...props }: Props) => createElement("svg", { xmlns: "http://www.w3.org/2000/svg", style: { display: "block", flexShrink: 0 }, ...props }, children);
export default Svg;
export const Path = el("path");
export const Rect = el("rect");
export const Circle = el("circle");
export const G = el("g");
export const Polyline = el("polyline");
