/**
 * react-native-svg for the web harness and tests: the same elements as the
 * DOM's own <svg> and <path>, which is what the library draws on the web.
 * Its full web build pulls in native module registries a plain page lacks.
 */
import { createElement, type ReactNode } from "react";

type Props = Record<string, unknown> & { children?: ReactNode };

const attrs = (p: Props) => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (k === "children" || v === undefined) continue;
    out[k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`).replace(/^view-box$/, "viewBox")] = v;
  }
  return out;
};

export default function Svg({ children, ...p }: Props) {
  return createElement("svg", { xmlns: "http://www.w3.org/2000/svg", ...attrs(p) }, children);
}
export const Path = (p: Props) => createElement("path", attrs(p));
