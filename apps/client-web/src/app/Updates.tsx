import { useEffect, useState } from "react";
import { checkFailure, readUpdatesWith, readyLine, updateRows, updateStatus, updateSteps, type Updates } from "@ue-mcp-studio/client-core";
import type { Machine } from "./App";
import { follow, host, type AppUpdate, type JobState } from "./native";
import { running, studioOf, type MachineProject } from "./model";
import { JobOutput } from "./NodeCard";

/** Where a project's Studio opens to run its update: Settings, General, the Updates card. */
export const UPDATES_LOCATION = "#/settings/general";

/** A project's update check, read through its daemon with client-core's shared check. */
async function readProject(p: MachineProject): Promise<Updates> {
  const h = host();
  return readUpdatesWith(async (path) => {
    const r = await h?.daemon({ key: p.key, method: "GET", path });
    if (!r || r.status !== 200 || !r.body) return null;
    try {
      return JSON.parse(r.body) as unknown;
    } catch {
      return null;
    }
  });
}

/** The status a project without Studio has: its bridge and ue-mcp only. */
function bridgeOnly(u: Updates): { steps: number; unchecked: string | null } {
  return { steps: u.ueMcp?.target ? 1 : 0, unchecked: u.ueMcp ? u.ueMcp.error ?? null : "no answer" };
}

export function UpdatesView({ m }: { m: Machine }) {
  const projects = (m.report?.projects ?? []).filter((p) => p.ueMcp.setUp);
  return (
    <section className="app-screen" aria-labelledby="updates-head">
      <header className="app-head">
        <div>
          <h1 id="updates-head">Updates</h1>
          <p className="dim small">UE-MCP, and ue-mcp, the bridge plugin and Studio in each project.</p>
        </div>
      </header>
      <AppUpdateCard version={m.state?.version ?? ""} />
      {m.report && projects.length === 0 && <p className="muted app-none">No project is set up for ue-mcp yet. Add Studio to one on Projects.</p>}
      <ul className="app-list">
        {projects.map((p) => (
          <ProjectUpdates key={p.key} p={p} m={m} />
        ))}
      </ul>
    </section>
  );
}

/** UE-MCP's own update, from the latest Studio release. */
function AppUpdateCard({ version }: { version: string }) {
  const [u, setU] = useState<AppUpdate | null>(null);
  const [installing, setInstalling] = useState(false);
  const check = () => void host()?.appupdate().then(setU);
  useEffect(check, []);
  const install = async () => {
    setInstalling(true);
    const r = await host()?.appupdate({ install: "yes" });
    if (!r?.started) {
      setInstalling(false);
      setU(r ?? { ok: false, error: "The update did not start." });
    }
  };
  const pill = !u ? "Checking" : !u.ok ? "Not checked" : u.newer ? "Update available" : "Up to date";
  return (
    <div className="app-row app-update app-self">
      <div className="app-row-main">
        <div className="app-row-title">
          <span className="app-row-name">UE-MCP</span>
          <span className={`pill ${u?.ok && !u.newer ? "ok" : "warn"}`}>{pill}</span>
        </div>
        <div className="muted small">
          {installing ? "Installing. UE-MCP restarts when it is done." : u?.ok && u.newer ? `UE-MCP ${u.version} is ready to install. You have ${version}.` : u?.ok ? `UE-MCP ${version}.` : u ? `Could not check: ${u.error}` : `UE-MCP ${version}.`}
        </div>
      </div>
      <div className="app-row-actions">
        {u?.ok && u.newer ? (
          <button className="primary" disabled={installing} onClick={() => void install()}>{installing ? "Installing" : "Update UE-MCP"}</button>
        ) : (
          <button onClick={check} disabled={!u}>Check again</button>
        )}
      </div>
    </div>
  );
}

function ProjectUpdates({ p, m }: { p: MachineProject; m: Machine }) {
  const live = running(p, m.live);
  const studio = studioOf(p);
  const [u, setU] = useState<Updates | null>(null);
  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState<string | null>(null);
  const [job, setJob] = useState<JobState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const read = () => {
    setChecking(true);
    void readProject(p).then(setU).finally(() => setChecking(false));
  };
  // Read when the daemon is up, and again when it comes back on another process.
  useEffect(() => {
    if (live) read();
    else setU(null);
  }, [live?.pid]);

  const start = async () => {
    setStarting("Starting ue-mcp");
    setError(null);
    const r = await host()?.startdaemon({ uproject: p.uproject });
    if (!r?.ok || !r.job) {
      setStarting(null);
      return setError(r?.error ?? "ue-mcp did not start.");
    }
    const end = await follow(r.job, () => {});
    setStarting(null);
    if (!end.ok) setError(end.error ?? "ue-mcp did not start.");
    void m.refresh();
  };
  const inStudio = async () => {
    setError(null);
    const r = await host()?.openstudio({ key: p.key, uproject: p.uproject, location: UPDATES_LOCATION });
    if (!r?.ok) setError(r?.error ?? "Studio did not open.");
  };
  const bridge = async () => {
    if (!u?.ueMcp?.target) return;
    setError(null);
    const r = await host()?.updatebridge({ uproject: p.uproject, version: u.ueMcp.target });
    if (!r?.ok || !r.job) return setError(r?.error ?? "The update did not start.");
    const end = await follow(r.job, setJob);
    if (end.ok) read();
  };

  const counts = u ? (studio.installed ? { steps: updateSteps(u).length, unchecked: checkFailure(u) } : bridgeOnly(u)) : null;
  const status = counts ? updateStatus({ ...counts, waiting: false, working: !!job?.running, ready: studio.installed ? readyLine(u!) : u?.ueMcp?.target ? `Ready to install: the bridge plugin ${u.ueMcp.target}.` : "" }) : null;
  const rows = u ? updateRows(u).filter(([name]) => studio.installed || name === "Bridge plugin" || name === "ue-mcp") : [];

  return (
    <li className="app-row app-update">
      <div className="app-row-main">
        <div className="app-row-title">
          <span className="app-row-name">{p.name}</span>
          {status && <span className={`pill ${status.tone}`}>{status.pill}</span>}
          {!live && <span className="pill">Not running</span>}
        </div>
        <div className="muted small">
          {!live ? "ue-mcp is not running for this project, so its updates are not checked." : checking && !u ? "Checking" : status?.line}
        </div>
        {u && rows.length > 0 && (
          <details className="app-details">
            <summary className="dim small">Details</summary>
            {rows.map(([name, installed, latest, available]) => (
              <div key={name} className="dim small">{name}: {installed ?? "not installed"}{available && latest ? ` to ${latest}` : ""}</div>
            ))}
          </details>
        )}
        {job && <JobOutput job={job} title={job.running ? "Updating the bridge plugin" : job.ok ? "The bridge plugin is updated" : "The bridge plugin was not updated"} />}
        {error && <div className="banner bad small" role="alert">{error}</div>}
      </div>
      <div className="app-row-actions">
        {!live && <button disabled={!!starting} onClick={() => void start()}>{starting ?? "Check"}</button>}
        {live && counts && counts.steps > 0 && studio.installed && (
          <button className="primary" onClick={() => void inStudio()} title="Opens this project's Studio on its Updates card, where the update runs.">Update in Studio</button>
        )}
        {live && counts && counts.steps > 0 && !studio.installed && (
          <button className="primary" disabled={p.editor.running || !!job?.running} title={p.editor.running ? `Close ${p.name} in Unreal first.` : undefined} onClick={() => void bridge()}>
            {job?.running ? "Updating" : "Update"}
          </button>
        )}
        {live && counts && counts.steps === 0 && <button disabled={checking} onClick={read}>Check again</button>}
      </div>
    </li>
  );
}
