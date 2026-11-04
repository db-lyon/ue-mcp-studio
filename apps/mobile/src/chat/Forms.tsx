// STUB: owned by transcript
import type { PendingForm } from "@ue-mcp-studio/shared";
import type { DaemonState } from "./hooks";

export function useForms(_daemon: Pick<DaemonState, "events" | "streaming">, _sessionId: string | null): PendingForm[] {
  return [];
}

export function FormCards(_props: { forms: PendingForm[]; runs?: ReadonlySet<string> }) {
  return null;
}
