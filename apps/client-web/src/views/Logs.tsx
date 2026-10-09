import { useMemo, useState } from "react";
import type { DaemonState } from "../state";

export function LogsView({ daemon }: { daemon: DaemonState }) {
  const [filter, setFilter] = useState("");
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const all = daemon.events.slice().reverse();
    return f ? all.filter((e) => e.type.toLowerCase().includes(f) || JSON.stringify(e.data).toLowerCase().includes(f)) : all;
  }, [daemon.events, filter]);

  return (
    <section className="card">
      <div className="row">
        <h2>Events</h2>
        <span className="spacer" />
        <input placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <table className="log">
        <tbody>
          {shown.map((e) => (
            <tr key={`${e.id}-${e.type}`}>
              <td className="muted mono">{new Date(e.at).toLocaleTimeString()}</td>
              <td className="mono">{e.type}</td>
              <td className="mono small">{JSON.stringify(e.data)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {shown.length === 0 && <p className="muted">No events yet.</p>}
    </section>
  );
}
