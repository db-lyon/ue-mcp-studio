/**
 * The pills above the composer: one row of small suggestions, each from a
 * provider, a function of the session as the agent reports it. A pill comes
 * only from tool-call facts (the session's turn facts and transcript), never
 * from reading the agent's prose.
 */
import type { SessionDetail } from "@ue-mcp-studio/shared";

/** What a pill can do when it is clicked: the chat view passes the actions its providers need. */
export type PillActions = Record<string, (...args: never[]) => void>;

export interface Pill {
  /** Stable for what it was made from, so a dismissed pill stays dismissed until that changes. */
  id: string;
  label: string;
  title?: string;
  run(actions: PillActions): void;
}

export type PillProvider = (session: SessionDetail) => Pill | null;

/** Every provider, in the order their pills show. None ships today, so the row renders nothing. */
export const PILL_PROVIDERS: readonly PillProvider[] = [];

/** The pills for a session, without the ones dismissed. */
export function pillsFor(s: SessionDetail, dismissed: ReadonlySet<string> = new Set(), providers: readonly PillProvider[] = PILL_PROVIDERS): Pill[] {
  return providers.map((p) => p(s)).filter((p): p is Pill => p !== null && !dismissed.has(p.id));
}
