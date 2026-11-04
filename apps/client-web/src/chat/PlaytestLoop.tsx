/**
 * The Assign to subagent loop on a playtest's card: which attempt is running,
 * Passed with the attempt count, or Needs you with the reason and the
 * evidence; each attempt's changes, grouped, with its own Revert, and Revert
 * every attempt once the loop is not running.
 */
import type { QaLoop } from "@ue-mcp-studio/shared";
import { loopChangeGroups, loopHeadline, qaPlural as plural } from "@ue-mcp-studio/client-core";

export { loopHeadline, loopPill } from "@ue-mcp-studio/client-core";
import { StepText } from "./AssetLink";

export function LoopPanel({ loop, busy, onRevert, onThread, showReason = false }: {
  loop: QaLoop;
  /** Say why it waits here too: when a step's verdict holds the box under the card's path instead. */
  showReason?: boolean;
  busy: boolean;
  /** Revert one attempt's changes, or every attempt's with no number. */
  onRevert: (attempt?: number) => void;
  onThread?: (callId: string) => void;
}) {
  const running = loop.state === "running";
  const open = loop.attempts.filter((a) => !a.reverted && a.changes.length > 0);
  return (
    <div className={`qa-loop state-${loop.state}`} role="status" aria-label="Playtest loop">
      <div className="small">{loopHeadline(loop)}</div>
      {/* The reason is in the box under the card's path unless a verdict holds it; here, what it is based on. */}
      {loop.state === "needs_you" && loop.blocker && (showReason || loop.blocker.evidence.length > 0) && (
        <div className="qa-needs-you small" role="note">
          {showReason && <div><StepText text={loop.blocker.reason} /></div>}
          {loop.blocker.evidence.length > 0 && <ul>{loop.blocker.evidence.map((e, i) => <li key={i}><span className="dim">What it saw: </span><StepText text={e} /></li>)}</ul>}
        </div>
      )}
      {loop.attempts.length > 0 && (
        <ol className="qa-attempts">
          {loop.attempts.map((a) => (
            <li key={a.n} className={`qa-attempt ${a.reverted ? "reverted" : ""}`}>
              <div className="row">
                <strong className="small">Attempt {a.n}</strong>
                <span className="dim small">{a.endedAt ? (a.changes.length ? plural(a.changes.length, "change") : "no changes") : "running"}</span>
                {a.reverted && <span className="pill small">Reverted</span>}
              </div>
              {/* Every attempt's actions on one row of their own, in the same order, so attempts line up. */}
              {(onThread || (!running && !a.reverted && a.changes.length > 0)) && (
                <div className="qa-attempt-actions">
                  {onThread && <button className="small-button" onClick={() => onThread(a.callId)} aria-label={`Open attempt ${a.n}'s thread`} title="The subagent's messages and tool calls in this attempt">See what it did</button>}
                  {!running && !a.reverted && a.changes.length > 0 && (
                    <button className="small-button" disabled={busy} onClick={() => onRevert(a.n)} aria-label={`Revert attempt ${a.n}`} title="Undo the changes this attempt made">Undo its changes</button>
                  )}
                </div>
              )}
              {(a.changes.length > 0 || a.failing.length > 0) && (
                <details className="small">
                  <summary>{a.failing.length ? `${plural(a.failing.length, "step")} failed` : "What it changed"}</summary>
                  {a.failing.length > 0 && <ul className="qa-attempt-failing">{a.failing.map((f, i) => <li key={i}><StepText text={f} /></li>)}</ul>}
                  {loopChangeGroups(a.changes).map(({ group, label, items }) => (
                    <div key={group} className="qa-attempt-group">
                      <span className="dim">{label}:</span>
                      <ul className="mono">{items.map((c) => <li key={c.path}>{c.path} <span className="dim">{c.status}</span></li>)}</ul>
                    </div>
                  ))}
                </details>
              )}
            </li>
          ))}
        </ol>
      )}
      {!running && open.length > 0 && !loop.reverted && (
        <div className="row">
          <span className="dim small">Undo the changes of every attempt at once.</span>
          <span className="spacer" />
          <button className="small-button" disabled={busy} onClick={() => onRevert()}>Revert every attempt</button>
        </div>
      )}
    </div>
  );
}
