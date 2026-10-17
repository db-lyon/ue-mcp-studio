import { useEffect, useState } from "react";

/**
 * The one width the layout changes at, matching the max-width: 760px media
 * queries in styles.css. Below it the panel takes its narrow form: navigation
 * in a drawer, the chat one pane at a time, the editor's state as a chip.
 */
export const NARROW = "(max-width: 760px)";

export function matches(query: string): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
}

/** Whether a media query matches, kept current as the panel is resized. */
export function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => matches(query));
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const m = window.matchMedia(query);
    const change = () => setOn(m.matches);
    change();
    m.addEventListener("change", change);
    return () => m.removeEventListener("change", change);
  }, [query]);
  return on;
}
