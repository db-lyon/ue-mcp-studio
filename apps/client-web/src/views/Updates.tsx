import { useEffect, useState } from "react";

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

async function post(url: string, body?: unknown): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).catch((e: Error) => ({ ok: false, json: async () => ({ error: e.message }) }) as Response);
  const j = (await res.json().catch(() => ({}))) as { error?: string; ok?: boolean };
  return { ok: res.ok && j.ok !== false, error: j.error };
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

const STEP_LABEL = { ueMcp: "Updating ue-mcp", plugin: "Updating the editor plugin: the editor closes and reopens", studio: "Updating Studio: the panel reloads" } as const;

/**
 * The Updates card: one status and one button. Update runs every part that
 * has something newer, in the order that keeps each step alive.
 */
export function UpdatesCard() {
  const [u, setU] = useState<{ studio: StudioUpdates | null; ueMcp: UeMcpUpdate | null } | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const load = () => void readUpdates().then(setU, () => setU({ studio: null, ueMcp: null }));
  useEffect(load, []);

  const steps = u ? updateSteps(u) : [];
  const ready = u ? readyLine(u) : "";
  const engineOnly = u?.studio?.plugin.location === "engine" && !!u?.studio?.plugin.latest;

  const update = async () => {
    setError(null);
    for (const step of steps) {
      setWorking(STEP_LABEL[step]);
      const r = step === "ueMcp"
        ? await post("/v1/update/apply", { version: u!.ueMcp!.target, binaries: u!.ueMcp!.binaries?.available ? u!.ueMcp!.binaries.file : null })
        : await post(`/v1/ext/studio/updates/${step}`);
      if (!r.ok) {
        setError(r.error ?? `${STEP_LABEL[step]} failed`);
        setWorking(null);
        load();
        return;
      }
    }
    setWorking(null);
    setDone(true);
    load();
  };

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
          <span className="muted">{working ?? (done && !steps.length ? "Updated." : steps.length ? ready : "Everything is up to date.")}</span>
          <span className="spacer" />
          {steps.length > 0 && <button className="primary" disabled={!!working} onClick={() => void update()}>Update</button>}
        </div>
      )}
      {error && <div className="banner bad">{error}</div>}
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
