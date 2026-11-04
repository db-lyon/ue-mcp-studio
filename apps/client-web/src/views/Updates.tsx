import { useEffect, useState } from "react";
import { daemonMoves, fabUpdate, updateFailureLine as failureLine, pluginStep, readUpdatesWith, readyLine, studioUpdatesOf, ueMcpUpdateOf, updateRows, updateSteps, waiting, withFloor, type StudioUpdates, type UeMcpUpdate } from "@ue-mcp-studio/client-core";
import { startUpdate, useRun } from "./UpdateOverlay";
import { waitingSteps } from "./update-run";
import { REMOTE_UPDATES, onRemotePage } from "../connection";

/** The update check's model lives in client-core, shared with the mobile app. */
export { daemonMoves, fabUpdate, failureLine, pluginStep, readyLine, studioUpdatesOf, ueMcpUpdateOf, updateSteps, waiting, withFloor, type StudioUpdates, type UeMcpUpdate };

/** Opens in the system browser from the editor panel; a plain browser opens a tab. */
const openLink = (url: string) => void window.open(url, "_blank", "noopener");

/** Keep the channel for every project; Update follows it for Studio and the editor plugin. */
export async function setChannel(channel: "stable" | "beta"): Promise<void> {
  const res = await fetch("/v1/ext/studio/updates/channel", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel }),
    credentials: "same-origin",
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
}

async function get<T>(url: string): Promise<T | null> {
  const res = await fetch(url, { credentials: "same-origin" }).catch(() => null);
  return res?.ok ? ((await res.json().catch(() => null)) as T | null) : null;
}

/** Every read's count goes to the dot on Settings, so it never disagrees with the card. */
const countListeners = new Set<(n: number) => void>();

/** The bridge check follows Studio's channel: beta takes ue-mcp prereleases, stable takes latest. */
export async function readUpdates(): Promise<{ studio: StudioUpdates | null; ueMcp: UeMcpUpdate | null }> {
  const u = await readUpdatesWith((path) => get<unknown>(path));
  for (const l of countListeners) l(waiting(u));
  return u;
}

/** Updates waiting for the dot on Settings: read when the panel opens, every six hours, and whenever anything else reads them. */
export function useUpdateCount(): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    countListeners.add(setCount);
    const read = () => void readUpdates().catch(() => {});
    read();
    const t = setInterval(read, 6 * 3600_000);
    return () => {
      clearInterval(t);
      countListeners.delete(setCount);
    };
  }, []);
  return count;
}

/**
 * The Updates card: one status and one button. Update runs every part that
 * has something newer, in the order that keeps each step alive.
 */
/** `remote`: a paired browser, which sees what is installed and newer but cannot start an update or change the channel. */
export function UpdatesCard({ remote = onRemotePage() }: { remote?: boolean } = {}) {
  const [u, setU] = useState<{ studio: StudioUpdates | null; ueMcp: UeMcpUpdate | null } | null>(null);
  const run = useRun();
  const working = !!run && run.summary === undefined && !run.error;
  const waiting = !!run && waitingSteps(run).length > 0;
  // Why the last Update stopped, as the step said it (npm's error for an install), kept after its screen closes.
  const [stopped, setStopped] = useState<string | null>(null);
  useEffect(() => {
    if (run?.error) setStopped(run.error);
    else if (working) setStopped(null);
  }, [run?.error, working]);
  const load = () => void readUpdates().then(setU, () => setU({ studio: null, ueMcp: null }));
  useEffect(load, []);
  // Read again once an update finishes or stops.
  useEffect(() => {
    if (run && !working) load();
  }, [working]);

  const steps = u ? updateSteps(u) : [];
  const ready = u ? readyLine(u) : "";
  const fab = fabUpdate(u?.studio);
  const engineOnly = u?.studio?.plugin.location === "engine" && u.studio?.plugin.source !== "fab" && !!u.studio?.plugin.latest;

  const rows = u ? updateRows(u) : [];

  return (
    <section className="card">
      <div className="row">
        <h2>Updates</h2>
        <span className="spacer" />
        {!working && steps.length === 0 && <button onClick={load}>Check again</button>}
      </div>
      {!u && <p className="muted">Checking</p>}
      {u && (
        <div className="row update-status">
          <span className={`pill ${steps.length ? "warn" : "ok"}`}>{steps.length ? "Update available" : "Up to date"}</span>
          <span className="muted">{waiting ? "Update ready. Restarts after the current turn." : working ? "Updating" : steps.length ? ready : "Up to date."}</span>
          <span className="spacer" />
          {steps.length > 0 && !remote && <button className="primary" disabled={working} onClick={() => u && startUpdate(u)}>Update</button>}
        </div>
      )}
      {remote && <p className="dim small update-remote">{REMOTE_UPDATES}</p>}
      {stopped && !working && <div className="banner bad small update-error" role="alert">The last update stopped: {stopped}</div>}
      {!stopped && !working && failureLine(u?.studio) && <div className="banner bad small update-error" role="alert">{failureLine(u?.studio)}</div>}
      {u?.studio && (
        <div className="row update-channel" role="radiogroup" aria-label="Release channel">
          <span className="dim small">Channel</span>
          {(["stable", "beta"] as const).map((c) => (
            <label key={c} className="small">
              <input
                type="radio"
                name="update-channel"
                checked={(u.studio?.channel ?? "stable") === c}
                disabled={working || remote}
                onChange={() => void setChannel(c).then(load, () => load())}
              />{" "}
              {c === "stable" ? "Stable" : "Beta"}
            </label>
          ))}
        </div>
      )}
      {u?.studio?.plugin.required && (
        <div className="banner warn small">
          {u.studio.plugin.source === "fab"
            ? "Editor plugin too old. Update it from your Fab Library."
            : u.studio.plugin.location === "project"
              ? "Editor plugin too old. Update installs it and restarts the editor."
              : "Editor plugin too old. Update it where it was installed."}
        </div>
      )}
      {fab && (
        <div className="row update-fab">
          <span className="muted small">
            {fab.version ? `Editor plugin ${fab.version} is available. ` : ""}Update the editor plugin from your Fab Library.
          </span>
          <span className="spacer" />
          <button onClick={() => openLink(fab.url)}>Open Fab Library</button>
        </div>
      )}
      {engineOnly && <p className="dim small">Installed with the engine. The Epic launcher updates it.</p>}
      {u && (
        <details className="update-details">
          <summary className="dim small">Details</summary>
          {rows.map(([name, installed, latest, available]) => (
            <div key={name} className="dim small">{name}: {installed ?? "not installed"}{available && latest ? ` → ${latest}` : ""}</div>
          ))}
        </details>
      )}
    </section>
  );
}
