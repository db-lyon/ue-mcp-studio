import { useEffect, useState } from "react";
import { startUpdate, useRun } from "./UpdateOverlay";

/** GET /v1/ext/studio/updates. */
export interface StudioUpdates {
  studio: { installed: string; latest: string | null; available: boolean };
  plugin: { installed: string | null; latest: string | null; available: boolean; location: "project" | "engine" | "none"; engine: string | null };
  error?: string;
}

/** GET /v1/update on the daemon: ue-mcp and its bridge. */
export interface UeMcpUpdate {
  server: string;
  latest: string | null;
  target: string | null;
  binaries: { available: boolean; file: string } | null;
  error?: string;
}

async function get<T>(url: string): Promise<T | null> {
  const res = await fetch(url, { credentials: "same-origin" }).catch(() => null);
  return res?.ok ? ((await res.json()) as T) : null;
}

export async function readUpdates(): Promise<{ studio: StudioUpdates | null; ueMcp: UeMcpUpdate | null }> {
  const [studio, ueMcp] = await Promise.all([get<StudioUpdates>("/v1/ext/studio/updates"), get<UeMcpUpdate>("/v1/update")]);
  return { studio, ueMcp };
}

/** How many parts have an update waiting. */
export function waiting(u: { studio: StudioUpdates | null; ueMcp: UeMcpUpdate | null }): number {
  return (u.studio?.studio.available ? 1 : 0) + (u.studio?.plugin.available ? 1 : 0) + (u.ueMcp?.target ? 1 : 0);
}

/** Updates waiting, read when the panel opens and every six hours, for the dot on Settings. */
export function useUpdateCount(): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const read = () => void readUpdates().then((u) => setCount(waiting(u)), () => {});
    read();
    const t = setInterval(read, 6 * 3600_000);
    return () => clearInterval(t);
  }, []);
  return count;
}

/** The steps one Update runs, in order: ue-mcp, then the editor plugin (the editor closes and reopens), then Studio, which restarts ue-mcp. */
export function updateSteps(u: { studio: StudioUpdates | null; ueMcp: UeMcpUpdate | null }): Array<"ueMcp" | "plugin" | "studio"> {
  const steps: Array<"ueMcp" | "plugin" | "studio"> = [];
  if (u.ueMcp?.target) steps.push("ueMcp");
  if (u.studio?.plugin.available) steps.push("plugin");
  if (u.studio?.studio.available) steps.push("studio");
  return steps;
}

/** "Ready to install: ue-mcp 1.4.0-beta.3 and the editor plugin 0.1.0-beta.9." Names each part that has something newer. */
export function readyLine(u: { studio: StudioUpdates | null; ueMcp: UeMcpUpdate | null }): string {
  const parts: string[] = [];
  if (u.ueMcp?.target) parts.push(`ue-mcp ${u.ueMcp.target}`);
  if (u.studio?.plugin.available) parts.push(`the editor plugin ${u.studio.plugin.latest}`);
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
  const load = () => void readUpdates().then(setU, () => setU({ studio: null, ueMcp: null }));
  useEffect(load, []);
  // Read again once an update finishes or stops.
  useEffect(() => {
    if (run && !working) load();
  }, [working]);

  const steps = u ? updateSteps(u) : [];
  const ready = u ? readyLine(u) : "";
  const engineOnly = u?.studio?.plugin.location === "engine" && !!u?.studio?.plugin.latest;

  const rows: Array<[string, string | null, string | null, boolean]> = u
    ? [
        ["Studio", u.studio?.studio.installed ?? null, u.studio?.studio.latest ?? null, !!u.studio?.studio.available],
        ["Editor plugin", u.studio?.plugin.installed ?? null, u.studio?.plugin.latest ?? null, !!u.studio?.plugin.available],
        ["ue-mcp", u.ueMcp?.server ?? null, u.ueMcp?.latest ?? null, !!u.ueMcp?.target],
      ]
    : [];

  return (
    <section className="card">
      <div className="row">
        <h2>Updates</h2>
        <span className="spacer" />
        {!working && steps.length === 0 && <button className="ghost" onClick={load}>Check again</button>}
      </div>
      {!u && <p className="muted">Checking</p>}
      {u && (
        <div className="row update-status">
          <span className={`pill ${steps.length ? "warn" : "ok"}`}>{steps.length ? "Update available" : "Up to date"}</span>
          <span className="muted">{working ? "Updating" : steps.length ? ready : "Everything is up to date."}</span>
          <span className="spacer" />
          {steps.length > 0 && <button className="primary" disabled={working} onClick={() => u && startUpdate(u)}>Update</button>}
        </div>
      )}
      {engineOnly && <p className="dim small">The editor plugin was installed with the engine; the Epic launcher updates it.</p>}
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
