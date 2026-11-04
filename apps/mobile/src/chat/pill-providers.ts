// STUB: owned by composer
import type { PlaytestRequest, SessionDetail } from "@ue-mcp-studio/shared";

export interface PillActions {
  playtest(request: PlaytestRequest): void;
}

export interface Pill {
  id: string;
  label: string;
  title?: string;
  run(actions: PillActions): void;
}

/** The pills for a session; the web client has no provider on, so none. */
export function pillsFor(_s: SessionDetail, _dismissed: ReadonlySet<string> = new Set()): Pill[] {
  return [];
}
