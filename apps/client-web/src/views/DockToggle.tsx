/**
 * "Dock in editor" and "Open as window", in Studio's own window. Docked,
 * Studio sits over the editor's UE-MCP Studio tab; the choice is kept per
 * project. Shown only where it works: in studio-window.exe, with an editor
 * plugin that has the dock tab.
 */
import { useEffect, useState } from "react";
import { native } from "../native";

export type WindowMode = "docked" | "window";

/** getwindowmode's answer, or null when it is not one. */
export function parseWindowMode(raw: unknown): { mode: WindowMode; canDock: boolean } | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const v = JSON.parse(raw) as { mode?: unknown; canDock?: unknown };
    if (v.mode !== "docked" && v.mode !== "window") return null;
    return { mode: v.mode, canDock: v.canDock === true };
  } catch {
    return null;
  }
}

/** How often the toggle checks whether the editor can hold Studio: the editor starts and stops on its own. */
const POLL_MS = 3000;

export function DockToggle() {
  const [state, setState] = useState<{ mode: WindowMode; canDock: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const get = native().getwindowmode;
    if (!get) return;
    let live = true;
    const read = () => void get().then((raw) => live && setState(parseWindowMode(raw)), () => {});
    read();
    const t = setInterval(read, POLL_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  if (!state || (state.mode === "window" && !state.canDock)) return null;
  const next: WindowMode = state.mode === "docked" ? "window" : "docked";
  const toggle = () => {
    setBusy(true);
    void native().setwindowmode?.(next)
      .then((ok) => ok && setState({ ...state, mode: next }), () => {})
      .finally(() => setBusy(false));
  };
  const label = next === "docked" ? "Dock in editor" : "Open as window";
  return (
    <button className="ghost docs-link icon-button" disabled={busy} onClick={toggle} aria-label={label} title={label}>
      {next === "docked" ? <DockGlyph /> : <NewWindowGlyph />}
    </button>
  );
}

/** A window with an arrow leaving it: open in a window of its own. */
function NewWindowGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M7 2.75H3.75a1 1 0 0 0-1 1v8.5a1 1 0 0 0 1 1h8.5a1 1 0 0 0 1-1V9" />
      <path d="M9.5 2.75h3.75V6.5M13 3 8 8" />
    </svg>
  );
}

/** A window with a panel at its side: dock in the editor. */
function DockGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <rect x="2.75" y="2.75" width="10.5" height="10.5" rx="1" />
      <path d="M9.5 2.75v10.5" />
    </svg>
  );
}
