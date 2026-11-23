/**
 * The demo's own controls, apart from the product: which project, how fast
 * runs go, whether the editor is connected, and Reset. Styled on its own so it
 * never passes for part of Studio.
 */
import { useState, type CSSProperties } from "react";
import type { DemoSeed } from "./seed";

export interface ToolbarProps {
  seed: DemoSeed;
  speed: number;
  editor: boolean;
  onSeed: (seed: DemoSeed) => void;
  onSpeed: (speed: number) => void;
  onEditor: (connected: boolean) => void;
  onReset: () => void;
}

const SEED_LABELS: Record<DemoSeed, string> = { full: "Full project", empty: "Scripts, no goals", fresh: "No scripts" };
const OPEN_KEY = "studio.hub-demo.toolbar-open";

const box: CSSProperties = {
  position: "fixed",
  right: 12,
  bottom: 12,
  zIndex: 2147483000,
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 10,
  maxWidth: "calc(100vw - 24px)",
  padding: "6px 10px",
  borderRadius: 10,
  border: "1px dashed #f5b942",
  background: "rgba(24, 20, 12, 0.94)",
  color: "#f4ead8",
  font: "500 12px/1.3 system-ui, sans-serif",
  boxShadow: "0 6px 20px rgba(0, 0, 0, 0.35)",
};
const badge: CSSProperties = { border: 0, borderRadius: 6, padding: "3px 8px", background: "#f5b942", color: "#1c1406", font: "700 11px/1.2 system-ui, sans-serif", letterSpacing: "0.06em", textTransform: "uppercase", cursor: "pointer" };
const control: CSSProperties = { background: "#2d2617", color: "#f4ead8", border: "1px solid #5c4d2e", borderRadius: 6, padding: "3px 6px", font: "inherit" };
const pressed = (on: boolean): CSSProperties => ({ ...control, cursor: "pointer", ...(on ? { background: "#f5b942", color: "#1c1406", borderColor: "#f5b942" } : {}) });

function readOpen(): boolean {
  try {
    return window.localStorage.getItem(OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}

export function Toolbar(p: ToolbarProps) {
  const [open, setOpen] = useState(readOpen);
  const [speed, setSpeed] = useState(p.speed);
  const [editor, setEditor] = useState(p.editor);
  const toggle = () => {
    setOpen(!open);
    try {
      window.localStorage.setItem(OPEN_KEY, open ? "0" : "1");
    } catch {
      // Storage blocked: the toolbar opens next time.
    }
  };
  return (
    <div style={box} role="region" aria-label="Demo controls">
      <button type="button" style={badge} onClick={toggle} aria-expanded={open} title={open ? "Hide the demo controls" : "Show the demo controls"}>
        Demo
      </button>
      {open && (
        <>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            Project
            <select style={control} value={p.seed} onChange={(e) => p.onSeed(e.target.value as DemoSeed)}>
              {(Object.keys(SEED_LABELS) as DemoSeed[]).map((s) => (
                <option key={s} value={s}>{SEED_LABELS[s]}</option>
              ))}
            </select>
          </label>
          <span role="group" aria-label="Speed" style={{ display: "flex", alignItems: "center", gap: 4 }}>
            Speed
            {[1, 4].map((n) => (
              <button key={n} type="button" style={pressed(speed === n)} aria-pressed={speed === n} onClick={() => { setSpeed(n); p.onSpeed(n); }}>
                {n}x
              </button>
            ))}
          </span>
          <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
            <input type="checkbox" checked={editor} onChange={(e) => { setEditor(e.target.checked); p.onEditor(e.target.checked); }} />
            Editor connected
          </label>
          <button type="button" style={{ ...control, cursor: "pointer" }} onClick={p.onReset} title="Restore this project to its starting state">
            Reset
          </button>
        </>
      )}
    </div>
  );
}
