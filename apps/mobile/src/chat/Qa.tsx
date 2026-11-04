// STUB: owned by agent-a (playtests). The transcript and FormCards call these with the web client's props.
import type { PendingForm, QaRun } from "@ue-mcp-studio/shared";

export function QaCard(_props: { run: QaRun; form?: PendingForm; onDismiss?: () => void; offline?: boolean }) {
  return null;
}

export function qaRunFromForm(_form: PendingForm): QaRun | null {
  return null;
}
