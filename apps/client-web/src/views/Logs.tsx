import { useMemo, useState } from "react";
import type { DaemonState } from "../state";

/** The payload as one line for the closed row, and indented for the opened one. */
export function eventPayload(data: unknown): { line: string; full: string } {
  if (data === undefined || data === null) return { line: "", full: "" };
  return { line: JSON.stringify(data), full: JSON.stringify(data, null, 2) };
}

/**
 * The daemon's events, newest first. Each one is its time and type on one line
 * and its payload under them, cut to one line until opened; an opened payload
 * scrolls sideways inside its own block, so the page never does.
 */
export function LogsView({ daemon }: { daemon: DaemonState }) {
  const [filter, setFilter] = useState("");
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const all = daemon.events.slice().reverse();
    return f ? all.filter((e) => e.type.toLowerCase().includes(f) || JSON.stringify(e.data).toLowerCase().includes(f)) : all;
  }, [daemon.events, filter]);

  return (
    <section className="card">
      <div className="row log-top">
        <h2>Events</h2>
        <span className="spacer" />
        <input placeholder="Filter" aria-label="Filter events" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <ol className="log" aria-label="Events, newest first">
        {shown.map((e) => {
          const p = eventPayload(e.data);
          return (
            <li key={`${e.id}-${e.type}`} className="log-event">
              <div className="log-head">
                <time className="log-time mono" dateTime={new Date(e.at).toISOString()}>{new Date(e.at).toLocaleTimeString()}</time>
                <span className="log-type mono">{e.type}</span>
              </div>
              {p.line && (
                <details className="log-data">
                  <summary className="mono small">{p.line}</summary>
                  <pre className="mono small">{p.full}</pre>
                </details>
              )}
            </li>
          );
        })}
      </ol>
      {shown.length === 0 && <p className="muted">No events yet.</p>}
    </section>
  );
}
