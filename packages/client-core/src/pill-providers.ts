/**
 * The pills above the composer: one row of small suggestions, each from a
 * provider, a function of the session as the agent reports it. A pill comes
 * only from tool-call facts (the session's turn facts and transcript), never
 * from reading the agent's prose.
 */
import type { PlaytestRequest, SessionDetail } from "@ue-mcp-studio/shared";

/** What a pill can do when it is clicked. */
export interface PillActions {
  playtest(request: PlaytestRequest): void;
}

export interface Pill {
  /** Stable for what it was made from, so a dismissed pill stays dismissed until that changes. */
  id: string;
  label: string;
  title?: string;
  run(actions: PillActions): void;
}

export type PillProvider = (session: SessionDetail) => Pill | null;

const finished = (s: SessionDetail): boolean => s.status !== "running" && s.status !== "waiting";

/**
 * Make playtest: the last finished turn made at least one call that changed
 * something, and did not itself save a playtest with pie(script_create) or
 * the playtest flow. It runs the playtest flow on what that turn changed.
 */
export const makePlaytestPill: PillProvider = (s) => {
  const turn = s.turn;
  if (!turn || !finished(s) || turn.mutations < 1 || turn.playtest) return null;
  return {
    id: `make-playtest:${turn.start}`,
    label: "Make playtest",
    title: "Draft a playtest of what the last turn changed, as a Playtest card",
    run: (a) => a.playtest({ text: "", turn: turn.start }),
  };
};

/** Every provider, in the order their pills show. */
// Make playtest is hidden until its relevance check (#115) is built; with no provider the row renders nothing.
export const PILL_PROVIDERS: readonly PillProvider[] = [];

/** The pills for a session, without the ones dismissed. */
export function pillsFor(s: SessionDetail, dismissed: ReadonlySet<string> = new Set(), providers: readonly PillProvider[] = PILL_PROVIDERS): Pill[] {
  return providers.map((p) => p(s)).filter((p): p is Pill => p !== null && !dismissed.has(p.id));
}
