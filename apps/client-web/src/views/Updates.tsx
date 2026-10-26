import { useEffect, useState } from "react";
import { FAB_LIBRARY_URL, type StudioPluginUpdate } from "@ue-mcp-studio/shared";
import { startUpdate, useRun } from "./UpdateOverlay";
import { waitingSteps } from "./update-run";

/** GET /v1/ext/studio/updates. */
export interface StudioUpdates {
  /** stable follows each latest release; beta also takes prereleases. */
  channel?: "stable" | "beta";
  studio: { installed: string; latest: string | null; available: boolean };
  plugin: StudioPluginUpdate;
  /** The step the agent is running now (the plugin swap). */
  running?: string;
  error?: string;
}

/** Update installs the plugin itself: never for a Fab install, which the Fab Library updates. */
export const pluginStep = (s: StudioUpdates | null | undefined): boolean => !!s?.plugin.available && s.plugin.source !== "fab";

/** A Fab install with a newer plugin out: where to send the user. */
export function fabUpdate(s: StudioUpdates | null | undefined): { version: string | null; url: string } | null {
  if (s?.plugin.source !== "fab" || !(s.plugin.newer || s.plugin.required)) return null;
  return { version: s.plugin.newer ? s.plugin.latest : null, url: s.plugin.fabUrl || FAB_LIBRARY_URL };
}

/** Opens in the system browser from the editor panel; a plain browser opens a tab. */
const openLink = (url: string) => void window.open(url, "_blank", "noopener");

/**
 * GET /v1/update on the daemon. target is the release the project's bridge
 * plugin moves to, compared against installed.version, not against server.
 */
export interface UeMcpUpdate {
  installed: { version: string | null };
  /** The ue-mcp package the daemon runs. */
  server: string;
  latest: string | null;
  target: string | null;
  binaries: { available: boolean; file: string } | null;
  error?: string;
}

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
  return res?.ok ? ((await res.json()) as T) : null;
}

/** Every read's count goes to the dot on Settings, so it never disagrees with the card. */
const countListeners = new Set<(n: number) => void>();

/** The bridge check follows Studio's channel: beta takes ue-mcp prereleases, stable takes latest. */
export async function readUpdates(): Promise<{ studio: StudioUpdates | null; ueMcp: UeMcpUpdate | null }> {
  const studio = await get<StudioUpdates>("/v1/ext/studio/updates");
  const ueMcp = await get<UeMcpUpdate>(`/v1/update?channel=${studio?.channel === "beta" ? "beta" : "latest"}`);
  const u = { studio, ueMcp };
  for (const l of countListeners) l(waiting(u));
  return u;
}

/** How many parts have an update waiting. */
export function waiting(u: { studio: StudioUpdates | null; ueMcp: UeMcpUpdate | null }): number {
  return (u.studio?.studio.available ? 1 : 0) + (pluginStep(u.studio) ? 1 : 0) + (u.ueMcp?.target ? 1 : 0);
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

/** The bridge update restarts the daemon onto the target only when it runs another version. */
export const daemonMoves = (u: UeMcpUpdate | null | undefined): boolean => !!u?.target && u.server !== u.target;

/** The steps one Update runs, in order: the bridge plugin, then the editor plugin (the editor closes and reopens), then Studio, which restarts ue-mcp. */
export function updateSteps(u: { studio: StudioUpdates | null; ueMcp: UeMcpUpdate | null }): Array<"ueMcp" | "plugin" | "studio"> {
  const steps: Array<"ueMcp" | "plugin" | "studio"> = [];
  if (u.ueMcp?.target) steps.push("ueMcp");
  if (pluginStep(u.studio)) steps.push("plugin");
  if (u.studio?.studio.available) steps.push("studio");
  return steps;
}

/** "Ready to install: the bridge plugin 1.4.3 and the editor plugin 0.1.0-beta.9." Names each part that has something newer. */
export function readyLine(u: { studio: StudioUpdates | null; ueMcp: UeMcpUpdate | null }): string {
  const parts: string[] = [];
  if (u.ueMcp?.target) parts.push(`the bridge plugin ${u.ueMcp.target}`);
  if (pluginStep(u.studio)) parts.push(`the editor plugin ${u.studio?.plugin.latest}`);
  if (u.studio?.studio.available) parts.push(`Studio ${u.studio.studio.latest}`);
  if (!parts.length) return "";
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `Ready to install: ${list}.`;
}

/**
 * The Updates card: one status and one button. Update runs every part that
 * has something newer, in the order that keeps each step alive.
 */
export function UpdatesCard() {
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

  const rows: Array<[string, string | null, string | null, boolean]> = u
    ? [
        ["Studio", u.studio?.studio.installed ?? null, u.studio?.studio.latest ?? null, !!u.studio?.studio.available],
        ["Editor plugin", u.studio?.plugin.installed ?? null, u.studio?.plugin.latest ?? null, !!(u.studio?.plugin.available || u.studio?.plugin.newer)],
        ["Bridge plugin", u.ueMcp?.installed.version ?? null, u.ueMcp?.target ?? null, !!u.ueMcp?.target],
        ["ue-mcp", u.ueMcp?.server ?? null, u.ueMcp?.target ?? null, daemonMoves(u.ueMcp)],
      ]
    : [];

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
          {steps.length > 0 && <button className="primary" disabled={working} onClick={() => u && startUpdate(u)}>Update</button>}
        </div>
      )}
      {stopped && !working && <div className="banner bad small update-error" role="alert">The last update stopped: {stopped}</div>}
      {u?.studio && (
        <div className="row update-channel" role="radiogroup" aria-label="Release channel">
          <span className="dim small">Channel</span>
          {(["stable", "beta"] as const).map((c) => (
            <label key={c} className="small">
              <input
                type="radio"
                name="update-channel"
                checked={(u.studio?.channel ?? "stable") === c}
                disabled={working}
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
