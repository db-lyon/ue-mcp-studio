import { useEffect, useRef, useState } from "react";
import type { Machine } from "./App";
import { host } from "./native";
import { actionsOf, channelLabel, nameHint, running, updateHow, updatesOf, uptime, type MachineProject } from "./model";
import { connectedTo, installing, projectActions, useWorks } from "./actions";
import { DaemonChip, WorkPanel } from "./Projects";

/** One project: its versions and updates, its daemon with the log, and its editor. */
export function ProjectDetail({ p, m, onBack }: { p: MachineProject; m: Machine; onBack: () => void }) {
  const works = useWorks();
  const work = works[p.key] ?? null;
  const busy = installing(works);
  const mine = (work?.kind === "install" || work?.kind === "update") && !!work.job?.running;
  const a = actionsOf(p, mine && work?.kind === "install", busy && !mine);
  const act = projectActions(p, m, work);
  const u = updatesOf(p, m.newest);
  const hint = nameHint(p, m.report?.projects ?? []);
  const pending = (k: string) => work?.kind === k && !work.error && !work.done;
  const channel = channelLabel(m.newest?.channel ?? "stable");

  return (
    <section className="app-screen app-detail" aria-labelledby="detail-head">
      <button className="ghost small app-back" onClick={onBack}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12 4.5 6.5 10l5.5 5.5" /></svg>
        All projects
      </button>
      <header className="app-head">
        <div>
          <div className="app-row-title">
            <h1 id="detail-head">{p.name}</h1>
            {hint && <span className="app-row-hint dim">{hint}</span>}
            {p.engine.version && <span className="app-engine">UE {p.engine.version}</span>}
            {u?.pill && <span className={`pill ${u.tone}`}>{u.pill}</span>}
          </div>
          <p className="app-detail-path dim small">{p.dir}</p>
        </div>
        <div className="app-row-actions">
          {a.openStudio && (
            <button className="primary" disabled={pending("studio")} onClick={() => void act.openStudio()}>{pending("studio") ? "Opening" : "Open Studio"}</button>
          )}
          {a.addStudio && (
            <button className="primary" disabled={!!a.addBlocked} title={a.addBlocked ?? undefined} onClick={() => void act.addStudio()}>{pending("install") ? "Adding Studio" : "Add Studio"}</button>
          )}
          <button disabled={!!a.launchBlocked || pending("launch")} title={a.launchBlocked ?? undefined} onClick={() => void act.launch()}>{pending("launch") ? "Starting" : "Launch editor"}</button>
          <button className="ghost" onClick={() => void host()?.openfolder({ path: p.dir })}>Open folder</button>
        </div>
      </header>
      {work && work.kind !== "update" && <div className="app-detail-work"><WorkPanel p={p} work={work} act={act} /></div>}

      <div className="app-card">
        <div className="app-card-head">
          <h2>Versions and updates</h2>
          <span className="dim small">Newest on {channel}</span>
          <span className="spacer" />
          <button className="ghost small" disabled={!m.newest} onClick={m.refreshNewest}>{m.newest ? "Check again" : "Checking"}</button>
        </div>
        <table className="app-table">
          <thead>
            <tr><th>Part</th><th>Installed</th><th>Newest</th><th /></tr>
          </thead>
          <tbody>
            <UeMcpRow p={p} m={m} />
            {(u?.parts ?? []).map((x) => (
              <tr key={x.part}>
                <td>{x.name}</td>
                <td className="mono">{x.installed ?? "unknown"}</td>
                <td className="mono">{x.latest ?? (m.newest ? "not known" : "checking")}</td>
                <td>{x.available ? <span className="pill warn">Update</span> : x.latest ? <span className="pill ok">Current</span> : x.error ? <span className="dim small" title={x.error}>Not checked</span> : null}</td>
              </tr>
            ))}
            {!a.openStudio && p.ueMcp.setUp && (
              <tr><td>Studio</td><td className="dim">not added</td><td className="mono">{m.newest?.studio ?? ""}</td><td /></tr>
            )}
          </tbody>
        </table>
        {u && <p className="muted small app-card-line">{u.line}</p>}
        {u && u.waiting.length > 0 && (
          <div className="app-installs">
            <div className="small app-installs-head">What Update installs</div>
            <ul>
              {u.waiting.map((x) => <li key={x.part} className="small">{x.installs}</li>)}
            </ul>
            <p className="dim small">{updateHow(u, p)}</p>
            <div className="row">
              <span className="spacer" />
              <button className="primary" disabled={(u.via === "ue-mcp" && (p.editor.running || busy)) || pending("update")} onClick={() => void act.update()}>
                {pending("update") ? (u.via === "studio" ? "Opening Studio" : "Updating") : u.via === "studio" ? "Update in Studio" : "Update"}
              </button>
            </div>
          </div>
        )}
        {work?.kind === "update" && <WorkPanel p={p} work={work} act={act} />}
      </div>

      {p.ueMcp.setUp && <DaemonCard p={p} m={m} act={act} work={work} />}

      <div className="app-card">
        <div className="app-card-head"><h2>Editor</h2></div>
        <div className="app-facts small">
          <span><span className="dim">State</span> {p.editor.running ? `open${p.editor.pids.length ? `, pid ${p.editor.pids.join(", ")}` : ""}` : "not running"}</span>
          <span><span className="dim">Engine</span> {p.engine.version ? `UE ${p.engine.version}` : p.engine.association ?? "unknown"}</span>
          <span className="app-facts-wide"><span className="dim">Project file</span> {p.uproject}</span>
        </div>
      </div>

      <div className="row app-detail-foot">
        <span className="spacer" />
        <button className="ghost small" onClick={() => void host()?.removeproject({ uproject: p.uproject }).then(() => { onBack(); return m.refresh(); })}>Remove from list</button>
      </div>
    </section>
  );
}

/** ue-mcp itself: the daemon's version while it runs, else the one the app runs for the project, against the channel's newest. */
function UeMcpRow({ p, m }: { p: MachineProject; m: Machine }) {
  if (!p.ueMcp.setUp) return null;
  const d = running(p, m.live);
  const runs = d?.version ?? m.report?.ueMcp ?? null;
  return (
    <tr>
      <td>ue-mcp</td>
      <td className="mono">{runs ?? "unknown"}{!d && <span className="dim"> (when started)</span>}</td>
      <td className="mono">{m.newest?.ueMcp ?? (m.newest ? "not known" : "checking")}</td>
      <td><span className="dim small">{d ? "running" : "not running"}</span></td>
    </tr>
  );
}

function DaemonCard({ p, m, act, work }: { p: MachineProject; m: Machine; act: ReturnType<typeof projectActions>; work: ReturnType<typeof useWorks>[string] | null }) {
  const d = running(p, m.live);
  const [use, setUse] = useState<string | null>(null);
  useEffect(() => {
    setUse(null);
    if (d) void connectedTo(p.key).then(setUse);
  }, [p.key, d?.pid]);
  const snap = p.daemon.running && d && p.daemon.running.pid === d.pid ? p.daemon.running : null;
  return (
    <div className="app-card">
      <div className="app-card-head">
        <h2>Daemon</h2>
        <span className="spacer" />
        <DaemonChip p={p} m={m} work={work} act={act} />
      </div>
      <p className="dim small app-card-line">The ue-mcp process this project runs while Unreal, Studio or an MCP client uses it. It stops on its own after 30 minutes with nothing connected.</p>
      {d && (
        <div className="app-facts small">
          <span><span className="dim">ue-mcp</span> {d.version}</span>
          <span><span className="dim">pid</span> {d.pid}</span>
          <span><span className="dim">port</span> {d.port}</span>
          {snap && uptime(snap.startedAt) && <span><span className="dim">up</span> {uptime(snap.startedAt)}</span>}
          <span><span className="dim">connected</span> {use === null ? "checking" : use || "nothing"}</span>
        </div>
      )}
      <DaemonLog id={p.key} />
    </div>
  );
}

/** The end of a daemon's log, read again every few seconds. */
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
  const lines = (text ?? "").split(/\r?\n/).slice(-200).join("\n").trim();
  return (
    <div className="app-log">
      <div className="row">
        <span className="small app-installs-head">Log</span>
        <span className="spacer" />
        {lines && <button className="ghost small" onClick={() => void host()?.openlog({ key: id })}>Open log file</button>}
      </div>
      <pre ref={box} className="app-log-text" tabIndex={0} aria-label="Daemon log">{text === null ? "Reading" : lines || "No log yet: ue-mcp has not run for this project."}</pre>
    </div>
  );
}
