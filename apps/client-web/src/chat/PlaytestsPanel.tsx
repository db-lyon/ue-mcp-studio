/**
 * A session's playtests in one place, beside the chat: every Playtest card the
 * session has, newest first and collapsed, so one is not lost above a long
 * conversation. Show in chat closes the panel and opens the card where it is
 * in the transcript.
 */
import type { QaRun, TranscriptEntry } from "@ue-mcp-studio/shared";
import { QaCard } from "./Qa";

/** The session's playtests, newest first, each once (a draft's card is the same run once it goes live). */
export function sessionPlaytests(transcript: TranscriptEntry[]): QaRun[] {
  const byRun = new Map<string, QaRun>();
  for (const e of transcript) if (e.kind === "qa" && !e.parent) byRun.set(e.run.runId, e.run);
  return [...byRun.values()].reverse();
}

/** A playtest that waits for the user: a verdict, or a loop that stopped for them. */
export const needsYou = (run: QaRun): boolean =>
  run.state === "awaiting_verdict" || run.steps.some((s) => s.status === "awaiting_verdict") || run.assignment?.loop?.state === "needs_you";

export function PlaytestsPanel({ runs, onShow }: { runs: QaRun[]; onShow: (runId: string) => void }) {
  if (runs.length === 0) return <p className="muted small">This session has no playtests yet. Ask the agent for one, or type /playtest.</p>;
  return (
    <div className="playtests-panel">
      {runs.map((r) => (
        <div key={r.runId} className="playtests-item">
          <QaCard run={r} />
          <button className="ghost small-button playtests-show" onClick={() => onShow(r.runId)}>Show in chat</button>
        </div>
      ))}
    </div>
  );
}
