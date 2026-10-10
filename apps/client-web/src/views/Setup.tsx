import { useEffect, useState } from "react";
import type { StatusReport } from "ue-mcp/daemon";
import { api } from "../api";
import { native } from "../native";
import { ProjectSetup } from "./ProjectSetup";

export function SetupView() {
  const [report, setReport] = useState<StatusReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => api.install().then(setReport, (e: Error) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);

  if (error) return <div className="banner bad">{error}</div>;
  if (!report) return <p className="muted">Reading the install...</p>;
  const p = report.plugin;
  return (
    <div className="stack">
      <section className="card">
        <h2>Install</h2>
        <div className="status-head">
          <span className={`dot ${report.ok ? "ok" : "warn"}`} />
          <span className="title">{report.ok ? "Ready" : "Needs attention"}</span>
        </div>
        {report.problems.length === 0 && <p>The bridge is installed, enabled and built for this project.</p>}
        {report.problems.map((pr) => (
          <div key={pr.code} className="problem">
            <strong>{pr.what}</strong>
            <p className="muted">{pr.fix}</p>
          </div>
        ))}
        <div className="actions">
          <button onClick={() => void load()}>Check again</button>
          <button onClick={() => void native().openprojectfolder()}>Open project folder</button>
        </div>
      </section>
      <section className="card">
        <h2>Bridge plugin</h2>
        <dl className="grid">
          <dt>Installed</dt><dd>{p.deployed ? `${p.installedVersion ?? "?"} (${p.installKind ?? "unknown"})` : "no"}</dd>
          <dt>Package</dt><dd>{p.packagedVersion ?? "?"}</dd>
          <dt>Enabled</dt><dd>{p.enabledInUproject ? "yes" : "no"}</dd>
          <dt>Location</dt><dd className="mono">{p.pluginDir ?? "-"}</dd>
          <dt>Engine</dt><dd>{report.project.engine ?? "?"}</dd>
          <dt>C++ toolchain</dt><dd>{report.toolchain.present ? report.toolchain.name : "none"}</dd>
          <dt>Runtime</dt><dd>{report.node.version}</dd>
        </dl>
      </section>
      <section className="card">
        <h2>MCP clients</h2>
        {report.clients.filter((c) => c.detected || c.configured).map((c) => (
          <div key={c.id} className="row">
            <span className={`dot ${c.configured ? "ok" : "muted"}`} />
            <strong>{c.name}</strong>
            <span className="muted">{c.configured ? (c.pinned ? `ue-mcp@${c.pinned}` : "ue-mcp@latest") : "not configured"}</span>
          </div>
        ))}
      </section>
      <ProjectSetup onApplied={() => void load()} />
    </div>
  );
}
