import type { Machine } from "./App";
import { Busy } from "./BusyLabel";

/**
 * What stands in for a fact the app has not confirmed this session: a spinner
 * while the read that confirms it runs, "unknown" once that read failed. Never
 * the last run's value, which may be wrong.
 */
export function Unverified({ m, what, className = "app-chip dim" }: { m: Machine; what: string; className?: string }) {
  return (
    <span className={className} role="status">
      {m.loading ? <Busy>Checking {what}</Busy> : `${what[0]!.toUpperCase()}${what.slice(1)} unknown`}
    </span>
  );
}
