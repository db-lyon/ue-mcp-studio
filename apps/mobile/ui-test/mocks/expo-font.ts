/**
 * expo-font for component tests and the web visual QA page: each font becomes
 * an @font-face rule over the bundled TTF, so the page draws with the same
 * files the app does. In jsdom there is nothing to load.
 */
import { useEffect, useState } from "react";

const added = new Set<string>();

export function useFonts(map: Record<string, unknown>): [boolean, Error | null] {
  const [loaded, setLoaded] = useState(typeof document === "undefined" || !("fonts" in document));
  useEffect(() => {
    if (typeof document === "undefined" || !("fonts" in document)) return;
    const css: string[] = [];
    for (const [name, src] of Object.entries(map)) {
      if (added.has(name)) continue;
      added.add(name);
      const url = typeof src === "string" ? src : (src as { uri?: string; default?: string })?.uri ?? (src as { default?: string })?.default;
      if (url) css.push(`@font-face { font-family: "${name}"; src: url("${url}") format("truetype"); font-display: block; }`);
    }
    if (css.length) {
      const style = document.createElement("style");
      style.textContent = css.join("\n");
      document.head.appendChild(style);
    }
    void Promise.all(Object.keys(map).map((n) => document.fonts.load(`16px "${n}"`).catch(() => undefined))).then(() => setLoaded(true));
  }, [map]);
  return [loaded, null];
}

export const isLoaded = () => true;
/** Nothing is built in on a web page: every font loads through useFonts. */
export const getLoadedFonts = (): string[] => [];
export const loadAsync = async () => undefined;
