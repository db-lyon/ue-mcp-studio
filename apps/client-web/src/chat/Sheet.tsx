import { useEffect, type ReactNode } from "react";

/**
 * A panel that slides up from the bottom of the page over a scrim, for what
 * a narrow conversation keeps off screen (its subagents). The scrim or
 * Escape closes it. Mounted while closed, so it can slide out.
 */
export function Sheet({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [open]);
  return (
    <div className={`sheet-root ${open ? "open" : ""}`} aria-hidden={!open}>
      <div className="sheet-scrim" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="sheet-head">
          <span className="sheet-grip" aria-hidden="true" />
          <strong>{title}</strong>
          <span className="spacer" />
          <button className="ghost" onClick={onClose}>Close</button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}
