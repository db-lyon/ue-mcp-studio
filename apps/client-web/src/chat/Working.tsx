/**
 * The working line above the composer while a turn runs: a spinner, what the
 * agent is doing right now, and how long the turn has run, ticking each second.
 */
import { useEffect, useState } from "react";
import type { SessionDetail } from "@ue-mcp-studio/shared";
import { turnElapsed as formatElapsed, workingStatus } from "@ue-mcp-studio/client-core";

export function WorkingLine({ detail }: { detail: Pick<SessionDetail, "status" | "waitingCause" | "transcript"> | null | undefined }) {
  const status = workingStatus(detail);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!status) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [!!status]);
  if (!status) return null;
  return (
    <div className={`working-line${status.waiting ? " waiting" : ""}`} role="status" aria-live="polite">
      <span className="spinner small" aria-hidden="true" />
      <span className="working-label">{status.label}</span>
      {status.since !== null && <span className="working-time">{formatElapsed(now - status.since)}</span>}
    </div>
  );
}
