/** The runs holding for a verdict, as the app's bar and the playtest cards read them (held.tsx provides it). */
import { createContext, useContext } from "react";
import type { QaHeld } from "@ue-mcp-studio/shared";

export interface HeldValue {
  held: QaHeld[];
  /** Resume and watch: Play In Editor runs again while the step waits. */
  resume: (runId: string) => Promise<void>;
}

export const HeldContext = createContext<HeldValue | null>(null);

/** The held run with this id, while it waits. */
export function useHeldRun(runId: string): { held: QaHeld; resume: () => Promise<void> } | null {
  const v = useContext(HeldContext);
  const held = v?.held.find((h) => h.runId === runId);
  return v && held ? { held, resume: () => v.resume(runId) } : null;
}
