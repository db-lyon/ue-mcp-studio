import type { ReactNode } from "react";

/** A pending button label: a spinner before the word, so a slow action visibly runs. The spinner is hidden from the accessible name. */
export function Busy({ children }: { children: ReactNode }) {
  return (
    <span className="app-busy">
      <span className="spinner small" aria-hidden="true" />
      {children}
    </span>
  );
}
