import { useEffect, useRef, useState } from "react";
import type { Machine } from "./App";
import { follow, host } from "./native";
import { daemonRows, uptime, type MachineDaemon } from "./model";

interface Health {
  editors: Array<{ name: string; connected: boolean }>;
  clients: number;
}

export function DaemonsView({ m }: { m: Machine }) {
  const rows = m.report ? daemonRows(m.report, m.live) : [];
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="app-screen" aria-labelledby="daemons-head">
      <header className="app-head">
        <div>
          <h1 id="daemons-head">Daemons</h1>
          <p className="dim small">The ue-mcp process each project runs while Unreal, Studio or an MCP client uses it. Each stops on its own after 30 minutes with nothing connected.</p>
        </div>
        <span className="spacer" />
        <button onClick={() => void m.refresh()} disabled={m.loading}>{m.loading ? "Reading" : "Refresh"}</button>
      </header>
      {m.report && rows.length === 0 && (
        <div className="app-empty">
          <h2>Nothing is running</h2>
          <p className="muted">A project's daemon starts when its editor, Studio or an MCP client needs ue-mcp.</p>
        </div>
      )}
      <ul className="app-list">
        {rows.map((d) => (
          <DaemonRow key={d.key} d={d} m={m} logOpen={open === d.key} onLog={() => setOpen(open === d.key ? null : d.key)} />
        ))}
      </ul>
    </section>
  );
}

function DaemonRow({ d, m, logOpen, onLog }: { d: MachineDaemon & { name: string; listed: boolean }; m: Machine; logOpen: boolean; onLog: () => void }) {
  const [health, setHealth] = useState<Health | null>(null);
  const [sure, setSure] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void host()?.daemon({ key: d.key, method: "GET", path: "/v1/health" }).then((r) => {
      try {
        if (r.status === 200 && r.body) setHealth(JSON.parse(r.body) as Health);
      } catch {
        // A health answer that does not parse leaves the row without it.
      }
    });
  }, [d.key, d.pid]);
  const editors = health?.editors.filter((e) => e.connected).length ?? 0;
  const inUse = editors > 0 || (health?.clients ?? 0) > 0;
  const stop = async () => {
    if (inUse && !sure) return setSure(true);
    setSure(false);
    setStopping(true);
    setError(null);
    const r = d.uproject ? await host()?.stopdaemon({ uproject: d.uproject }) : { ok: false, error: "This daemon's project file is not known." };
    const end = r?.ok && r.job ? await follow(r.job, () => {}) : null;
    setStopping(false);
    if (!end?.ok) setError(end?.error ?? r?.error ?? "The daemon did not stop.");
    void m.refresh();
  };
  const use = health ? [editors ? `${editors} editor${editors > 1 ? "s" : ""} connected` : "no editor", `${health.clients} client${health.clients === 1 ? "" : "s"}`].join(", ") : "";
  return (
    <li className="app-row app-daemon">
      <div className="app-row-main">
        <div className="app-row-title">
          <span className="app-row-name">{d.name}</span>
          <span className="app-engine">ue-mcp {d.version}</span>
          {!d.listed && <span className="pill" title="Not on the Projects list, for example a copy made by tests">Not listed</span>}
        </div>
        <div className="dim small app-daemon-facts">
          <span>pid {d.pid}</span>
          <span>port {d.port}</span>
          {uptime(d.startedAt) && <span>up {uptime(d.startedAt)}</span>}
          {use && <span>{use}</span>}
        </div>
        {sure && <div className="banner warn small">Stopping it disconnects {use}. Unreal keeps running; ue-mcp starts again when it is next needed.</div>}
        {error && <div className="banner bad small" role="alert">{error}</div>}
        {logOpen && <DaemonLog id={d.key} />}
      </div>
      <div className="app-row-actions">
        <button onClick={onLog} aria-expanded={logOpen}>{logOpen ? "Hide log" : "Log"}</button>
        {sure && <button className="ghost" onClick={() => setSure(false)}>Cancel</button>}
        <button className={sure ? "primary" : ""} disabled={stopping || !d.uproject} onClick={() => void stop()}>{stopping ? "Stopping" : sure ? "Stop anyway" : "Stop"}</button>
      </div>
    </li>
  );
}

/** The end of a daemon's log, read again every few seconds while it is open. */
function DaemonLog({ id }: { id: string }) {
  const [text, setText] = useState<string | null>(null);
  const box = useRef<HTMLPreElement>(null);
  useEffect(() => {
    let gone = false;
    const read = () => void host()?.readlog({ key: id }).then((t) => !gone && setText(t));
    read();
    const t = setInterval(read, 3000);
    return () => {
      gone = true;
      clearInterval(t);
    };
  }, [id]);
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [text]);
  const lines = (text ?? "").split(/\r?\n/).slice(-400).join("\n");
  return (
    <div className="app-log">
      <pre ref={box} className="app-log-text" tabIndex={0} aria-label="Daemon log">{text === null ? "Reading" : lines || "The log is empty."}</pre>
      <div className="row">
        <span className="spacer" />
        <button className="ghost small" onClick={() => void host()?.openlog({ key: id })}>Open log file</button>
      </div>
    </div>
  );
}
