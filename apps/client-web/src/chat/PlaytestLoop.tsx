/**
 * The Assign to subagent loop on a playtest's card: which attempt is running,
 * Passed with the attempt count, or Needs you with the reason and the
 * evidence; each attempt's changes, grouped, with its own Revert, and Revert
 * every attempt once the loop is not running.
 */
import { REVIEW_GROUPS, reviewGroupOf, type CheckpointChange, type QaLoop, type QaLoopChange } from "@ue-mcp-studio/shared";

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

/** A changed path's group, from its extension. */
function groupOf(c: QaLoopChange) {
  const kind: CheckpointChange["kind"] = /\.(uasset|umap)$/i.test(c.path) ? "package" : /\.ini$/i.test(c.path) ? "config" : /\.(cpp|h|hpp|cs|inl)$/i.test(c.path) ? "source" : "other";
  return reviewGroupOf({ path: c.path, kind });
}

/** The line under the card's head saying where the loop is. */
export function loopHeadline(loop: QaLoop): string {
  const n = loop.attempts.length;
  if (loop.state === "running") return n <= 1 ? "Attempt 1 is running: the subagent runs the playtest to see what fails." : `Attempt ${n} is running: the subagent fixes what failed and runs the playtest again.`;
  if (loop.state === "passed") return `Passed after ${plural(n, "attempt")}.`;
  if (loop.state === "stopped") return `The loop was stopped after ${plural(n, "attempt")}. Each attempt's changes can still be reverted.`;
  if (loop.state === "failed") return `The loop stopped on an error: ${loop.error ?? "unknown"}`;
  return `The loop is paused after ${plural(n, "attempt")}, waiting for you. Assign again to let it go on, or End loop.`;
}

/** The pill a loop puts beside the run's own status. */
export function loopPill(loop: QaLoop): { text: string; tone: string } {
  if (loop.state === "running") return { text: `Attempt ${Math.max(1, loop.attempts.length)}`, tone: "" };
  if (loop.state === "passed") return { text: "Passed", tone: "ok" };
  if (loop.state === "needs_you") return { text: "Needs you", tone: "warn" };
  if (loop.state === "failed") return { text: "Loop failed", tone: "bad" };
  return { text: "Loop stopped", tone: "" };
}

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
          {showReason && <div>{loop.blocker.reason}</div>}
          {loop.blocker.evidence.length > 0 && <ul>{loop.blocker.evidence.map((e, i) => <li key={i}><span className="dim">What it saw: </span>{e}</li>)}</ul>}
        </div>
      )}
      <div className="muted small">Budget: {loop.tokens.toLocaleString("en-US")} of {loop.budget.tokens.toLocaleString("en-US")} tokens used, and it stops after {loop.budget.minutes} minutes.</div>
      {loop.attempts.length > 0 && (
        <ol className="qa-attempts">
          {loop.attempts.map((a) => (
            <li key={a.n} className={`qa-attempt ${a.reverted ? "reverted" : ""}`}>
              <div className="row">
                <strong className="small">Attempt {a.n}</strong>
                <span className="dim small">{a.endedAt ? (a.changes.length ? plural(a.changes.length, "change") : "no changes") : "running"}</span>
                {a.reverted && <span className="pill small">Reverted</span>}
                <span className="spacer" />
                {!running && !a.reverted && a.changes.length > 0 && (
                  <button className="small-button" disabled={busy} onClick={() => onRevert(a.n)} aria-label={`Revert attempt ${a.n}`}>Revert</button>
                )}
                {onThread && <button className="small-button" onClick={() => onThread(a.callId)} aria-label={`Open attempt ${a.n}'s thread`} title="What the subagent did in this attempt">Open thread</button>}
              </div>
              {(a.changes.length > 0 || a.failing.length > 0) && (
                <details className="small">
                  <summary>{a.failing.length ? `${plural(a.failing.length, "step")} failed` : "What it changed"}</summary>
                  {a.failing.length > 0 && <ul className="qa-attempt-failing">{a.failing.map((f, i) => <li key={i}>{f}</li>)}</ul>}
                  {REVIEW_GROUPS.map(({ group, label }) => {
                    const items = a.changes.filter((c) => groupOf(c) === group);
                    return items.length ? (
                      <div key={group} className="qa-attempt-group">
                        <span className="dim">{label}:</span>
                        <ul className="mono">{items.map((c) => <li key={c.path}>{c.path} <span className="dim">{c.status}</span></li>)}</ul>
                      </div>
                    ) : null;
                  })}
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
