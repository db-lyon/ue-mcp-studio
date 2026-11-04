// STUB: owned by the playtest team
import { createContext } from "react";
import type { PendingForm, QaRun } from "@ue-mcp-studio/shared";
import { newerRun, type StreamEvent } from "@ue-mcp-studio/client-core";

export { newerRun };

export interface QaLive {
  events: StreamEvent[];
  streaming: boolean;
  forms: PendingForm[];
  sessionId: string | null;
  onThread: (id: string | null) => void;
}

export const QaContext = createContext<QaLive | null>(null);

export function useOutsideRuns(_events: StreamEvent[], _streaming: boolean): { runs: QaRun[]; dismiss: (runId: string) => void } {
  return { runs: [], dismiss: () => undefined };
}

export function OutsideRuns(_props: { runs: QaRun[]; onDismiss: (runId: string) => void }) {
  return null;
}
