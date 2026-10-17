import { useEffect, useState } from "react";

/**
 * Width breakpoints the components need to know about. They match the media
 * queries in styles.css: below SINGLE_PANE_CHAT the chat shows the session
 * list or a conversation, not both; below MENU_BAR the tabs and tools move
 * into a drawer that slides over the page.
 */
export const SINGLE_PANE_CHAT = "(max-width: 760px)";
export const MENU_BAR = "(max-width: 600px)";

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

/**
 * Picking Chat while the chat is already on screen and shows one pane at a
 * time goes back to the session list. Wide, both are on screen, so a pick of
 * the current tab changes nothing.
 */
export function backToSessions(current: string, picked: string, singlePane: boolean): boolean {
  return singlePane && current === "Chat" && picked === "Chat";
}
