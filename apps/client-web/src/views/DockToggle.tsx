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
  return (
    <button className="ghost docs-link" disabled={busy} onClick={toggle}
      title={next === "docked" ? "Show Studio in a tab of the editor" : "Show Studio in a window of its own"}>
      {next === "docked" ? "Dock in editor" : "Open as window"}
    </button>
  );
}
