/**
 * A panel that slides up from the bottom over a scrim, for what the phone's
 * conversation keeps off screen (its subagents, its checkpoints). The scrim,
 * Close or Android's back closes it. The drawing is src/ui's Sheet.
 */
import type { ReactNode } from "react";
import { Sheet as UiSheet } from "../ui";

export function Sheet({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  return (
    <UiSheet open={open} title={title} onClose={onClose}>
      {children}
    </UiSheet>
  );
}
