import { useEffect, useMemo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ApiError, api, type CatalogPlugin, type InstalledPlugin, type PluginCommandResult } from "../api";
import { inEditor, native } from "../native";
import type { DaemonState } from "../state";

/** A catalog entry and an installed plugin are the same plugin when either name matches. */
export function isInstalled(c: CatalogPlugin, installed: InstalledPlugin[]): InstalledPlugin | undefined {
  return installed.find((p) => p.name === c.slug || p.name === c.packageName);
}

/** Catalog entries matching a search over name, slug, tagline, category and tags. */
export function searchCatalog(catalog: CatalogPlugin[], query: string): CatalogPlugin[] {
  const q = query.trim().toLowerCase();
  if (!q) return catalog;
  return catalog.filter((c) => [c.name, c.slug, c.tagline, c.category, ...(c.tags ?? [])].some((s) => s?.toLowerCase().includes(q)));
}

/**
 * The project's ue-mcp plugins: the installed ones, with update and remove,
 * and the registry's catalog to browse and install from. Changes load when
 * the daemon restarts, which Apply does from here.
 */
export function PluginsView({ daemon }: { daemon: DaemonState }) {
  const [installed, setInstalled] = useState<InstalledPlugin[] | null>(null);
  const [catalog, setCatalog] = useState<CatalogPlugin[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [last, setLast] = useState<{ what: string; result: PluginCommandResult } | null>(null);
  const [pending, setPending] = useState(false);

  const load = () => {
    api.plugins().then((r) => setInstalled(r.plugins), (e: Error) => {
      if (e instanceof ApiError && e.status === 404) setUnsupported(true);
      else setError(e.message);
    });
    api.pluginCatalog().then((r) => setCatalog(r.plugins), (e: Error) => setError(e.message));
  };
  useEffect(load, []);
  // Another client changed the plugins: read them again.
  const changes = daemon.events.filter((e) => e.type === "plugins.changed").length;
  useEffect(() => {
    if (changes) api.plugins().then((r) => setInstalled(r.plugins), () => {});
  }, [changes]);

  const shown = useMemo(() => searchCatalog(catalog ?? [], query), [catalog, query]);

  const act = (what: string, run: () => Promise<PluginCommandResult>) => {
    setWorking(what);
    setLast(null);
    run().then((result) => {
      setLast({ what, result });
      if (result.restartRequired) setPending(true);
      load();
    }, (e: Error) => setLast({ what, result: { ok: false, exitCode: null, output: e.message, restartRequired: false } }))
      .finally(() => setWorking(null));
  };

  const apply = async () => {
    setWorking("Restarting ue-mcp");
    await api.shutdownDaemon().catch(() => {});
    // The editor starts it again and the panel reconnects to it.
    if (inEditor()) await native().startdaemon?.().catch(() => false);
    setPending(false);
    setWorking(null);
  };

  if (unsupported) {
    return (
      <section className="card">
        <h2>Plugins</h2>
        <p className="muted">Managing plugins here needs ue-mcp 1.4.0-beta.2 or later. Until then: <code>npx ue-mcp plugin install &lt;name&gt;</code> in the project folder.</p>
      </section>
    );
  }

  return (
    <div className="stack plugins">
      {error && <div className="banner bad" onClick={() => setError(null)}>{error}</div>}
      {pending && (
        <div className="banner warn plugins-apply">
          <span>Plugin changes load when ue-mcp restarts.{!inEditor() && " Restart it with npx ue-mcp daemon stop, then reopen Studio."}</span>
          {inEditor() && <button className="primary" disabled={!!working} onClick={() => void apply()}>Apply changes</button>}
        </div>
      )}
      {working && <div className="banner">{working}</div>}
      {last && (
        <details className={`banner ${last.result.ok ? "ok" : "bad"}`} open={!last.result.ok}>
          <summary>{last.what}: {last.result.ok ? "done" : "failed"}</summary>
          <pre className="output">{last.result.output || "No output."}</pre>
        </details>
      )}

      <section className="card">
        <h2>Installed</h2>
        {installed === null && <p className="muted">Loading</p>}
        {installed?.length === 0 && <p className="muted">No plugins in this project yet. Browse the catalog below.</p>}
        {installed?.map((p) => (
          <div key={p.name} className="plugin-row">
            <strong>{p.name}</strong>
            <span className="dim small">{p.version ?? "not installed"}{p.pinned ? `, pinned ${p.pinned}` : ""}</span>
            <span className={`pill ${p.status === "ok" ? "ok" : "bad"}`}>{p.status}</span>
            {p.categories.length > 0 && <span className="dim small">adds {p.categories.join(", ")}</span>}
            <span className="spacer" />
            <button disabled={!!working} onClick={() => act(`Update ${p.name}`, () => api.updatePlugin(p.name))}>Update</button>
            <RemoveButton disabled={!!working} onRemove={() => act(`Remove ${p.name}`, () => api.uninstallPlugin(p.name))} />
            {p.problems.length > 0 && <div className="plugin-problems dim small">{p.problems.join("; ")}</div>}
          </div>
        ))}
      </section>

      <section className="card">
        <div className="row">
          <h2>Browse</h2>
          <span className="spacer" />
          <input className="plugin-search" placeholder="Search plugins" aria-label="Search plugins" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <p className="muted small">From the ue-mcp plugin registry at plugins.ue-mcp.com.</p>
        {catalog === null && <p className="muted">Loading</p>}
        {catalog !== null && shown.length === 0 && <p className="muted">No plugin matches.</p>}
        <div className="plugin-grid">
          {shown.map((c) => {
            const have = installed ? isInstalled(c, installed) : undefined;
            const isOpen = open === c.slug;
            return (
              <article key={c.slug} className={`plugin-card ${isOpen ? "open" : ""}`}>
                <div className="row">
                  <strong>{c.name}</strong>
                  {c.category && <span className="pill">{c.category}</span>}
                  <span className="spacer" />
                  {have ? (
                    <span className="pill ok">installed</span>
                  ) : (
                    <button className="primary" disabled={!!working} onClick={() => act(`Install ${c.name}`, () => api.installPlugin(c.slug))}>Install</button>
                  )}
                </div>
                {c.tagline && <p className="small">{c.tagline}</p>}
                <div className="row small">
                  <button className="ghost small-button" onClick={() => setOpen(isOpen ? null : c.slug)}>{isOpen ? "Hide details" : "Details"}</button>
                  {c.repoUrl && <a href={c.repoUrl} target="_blank" rel="noreferrer">Source</a>}
                  {c.homepageUrl && <a href={c.homepageUrl} target="_blank" rel="noreferrer">Homepage</a>}
                </div>
                {isOpen && (
                  <div className="plugin-readme md">
                    <Markdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a> }}>
                      {c.readme ?? c.description ?? "No description."}
                    </Markdown>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}

/** Remove asks once more before it runs. */
function RemoveButton({ disabled, onRemove }: { disabled: boolean; onRemove: () => void }) {
  const [confirm, setConfirm] = useState(false);
  return confirm ? (
    <button className="danger-button" disabled={disabled} onClick={() => { setConfirm(false); onRemove(); }} onBlur={() => setConfirm(false)}>Remove for good</button>
  ) : (
    <button disabled={disabled} onClick={() => setConfirm(true)}>Remove</button>
  );
}
