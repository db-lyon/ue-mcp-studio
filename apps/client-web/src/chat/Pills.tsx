import { useEffect } from "react";
import type { Pill, PillActions } from "./pill-providers";

/**
 * The pill row right above the composer. A click runs the pill; Escape clears
 * the row. Nothing renders while there are no pills.
 */
export function PillRow({ pills, actions, onClear }: { pills: Pill[]; actions: PillActions; onClear: () => void }) {
  const shown = pills.length > 0;
  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) onClear();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shown, onClear]);
  if (!shown) return null;
  return (
    <div className="pill-row" role="toolbar" aria-label="Suggestions">
      {pills.map((p) => (
        <button
          key={p.id}
          className="pill-suggestion small"
          title={p.title}
          onClick={() => {
            onClear();
            p.run(actions);
          }}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}
