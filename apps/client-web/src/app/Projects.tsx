import { useEffect, useRef, useState } from "react";
import type { Machine } from "./App";
import { follow, host, type JobState } from "./native";
import { actionsOf, chipsOf, filterProjects, type MachineProject } from "./model";
import { JobOutput } from "./NodeCard";

/** An install or a launch in progress or just ended, by project key. */
interface RowWork {
  kind: "install" | "launch" | "studio";
  job?: JobState;
  error?: string;
  done?: boolean;
}

/** A filter appears once the list is long enough to need one. */
const FILTER_FROM = 7;

export function ProjectsView({ m }: { m: Machine }) {
  const [query, setQuery] = useState("");
  const [work, setWork] = useState<Record<string, RowWork>>({});
  const [adding, setAdding] = useState<string | null>(null);
  const projects = m.report?.projects ?? [];
  const shown = filterProjects(projects, query);
  const set = (key: string, w: RowWork | null) => setWork((all) => {
    const next = { ...all };
    if (w) next[key] = w;
    else delete next[key];
    return next;
  });

  const add = async () => {
    setAdding(null);
    const r = await host()?.addproject();
    if (r && !r.ok && !r.cancelled) setAdding(r.error ?? "That project could not be added.");
    if (r?.ok) void m.refresh();
  };

  return (
    <section className="app-screen" aria-labelledby="projects-head">
      <header className="app-head">
        <div>
          <h1 id="projects-head">Projects</h1>
          {projects.length > 0 && <p className="dim small">{projects.length === 1 ? "1 project" : `${projects.length} projects`} on this computer</p>}
        </div>
        <span className="spacer" />
        {projects.length >= FILTER_FROM && (
          <input className="app-filter" type="search" placeholder="Filter" aria-label="Filter projects" value={query} onChange={(e) => setQuery(e.target.value)} />
        )}
        <button onClick={() => void m.refresh()} disabled={m.loading}>{m.loading ? "Reading" : "Refresh"}</button>
        <button className="primary" onClick={() => void add()}>Add project</button>
      </header>
      {adding && <div className="banner bad small">{adding}</div>}
      {!m.report && m.loading && <Skeleton />}
      {m.report && projects.length === 0 && (
        <div className="app-empty">
          <h2>No projects yet</h2>
          <p className="muted">UE-MCP lists the projects Unreal Editor has opened on this computer. Open one in Unreal, or add its .uproject file here.</p>
          <button className="primary" onClick={() => void add()}>Add project</button>
        </div>
      )}
      {projects.length > 0 && shown.length === 0 && <p className="muted app-none">No project matches "{query}".</p>}
      <ul className="app-list">
        {shown.map((p) => (
          <ProjectRow key={p.key} p={p} m={m} work={work[p.key] ?? null} busy={Object.values(work).some((w) => w.kind === "install" && w.job?.running)} set={(w) => set(p.key, w)} />
        ))}
      </ul>
    </section>
  );
}

function ProjectRow({ p, m, work, busy, set }: { p: MachineProject; m: Machine; work: RowWork | null; busy: boolean; set: (w: RowWork | null) => void }) {
  const chips = chipsOf(p, m.live);
  const installing = work?.kind === "install" && !!work.job?.running;
  const a = actionsOf(p, installing, busy && !installing);

  const addStudio = async () => {
    set({ kind: "install", job: { running: true, ok: false, lines: [] } });
    const started = await host()?.install({ uproject: p.uproject });
    if (!started?.ok || !started.job) return set({ kind: "install", error: started?.error ?? "The install did not start." });
    const end = await follow(started.job, (job) => set({ kind: "install", job }));
    set({ kind: "install", job: end, done: true });
    void m.refresh();
  };
  const openStudio = async () => {
    set({ kind: "studio" });
    const r = await host()?.openstudio({ key: p.key, uproject: p.uproject });
    set(r?.ok ? null : { kind: "studio", error: r?.error ?? "Studio did not open." });
    void m.refresh();
  };
  const launch = async () => {
    set({ kind: "launch" });
    const r = await host()?.launcheditor({ key: p.key, uproject: p.uproject, setUp: p.ueMcp.setUp });
    set(r?.ok ? null : { kind: "launch", error: r?.error ?? "The editor did not start." });
    void m.refresh();
  };

  return (
    <li className="app-row">
      <div className="app-row-main">
        <div className="app-row-title">
          <span className="app-row-name">{p.name}</span>
          {p.engine.version && <span className="app-engine">UE {p.engine.version}</span>}
        </div>
        <div className="app-row-path dim small" title={p.dir}>{p.dir}</div>
        <div className="app-chips">
          {chips.map((c) => (
            <span key={c.label} className={`app-chip ${c.tone}`} title={c.title}>{c.label}</span>
          ))}
        </div>
      </div>
      <div className="app-row-actions">
        {a.openStudio && (
          <button className="primary" disabled={work?.kind === "studio" && !work.error} onClick={() => void openStudio()}>
            {work?.kind === "studio" && !work.error ? "Opening" : "Open Studio"}
          </button>
        )}
        {a.addStudio && (
          <button className="primary" disabled={!!a.addBlocked} title={a.addBlocked ?? undefined} onClick={() => void addStudio()}>
            {installing ? "Adding Studio" : "Add Studio"}
          </button>
        )}
        <button disabled={!!a.launchBlocked || (work?.kind === "launch" && !work.error)} title={a.launchBlocked ?? undefined} onClick={() => void launch()}>
          {work?.kind === "launch" && !work.error ? "Starting" : "Launch editor"}
        </button>
        <RowMenu p={p} m={m} />
      </div>
      {a.addStudio && p.editor.running && !installing && <p className="app-row-note dim small">{a.addBlocked}</p>}
      {work?.kind === "install" && work.job && (
        <div className="app-row-work">
          <JobOutput job={work.job} title={work.job.running ? `Adding Studio to ${p.name}` : work.job.ok ? "Studio was added" : "Studio was not added"} />
          {work.done && work.job.ok && <p className="muted small">Studio opens from the Studio button on the editor toolbar, or from Open Studio here.</p>}
          {work.done && (
            <div className="row">
              <span className="spacer" />
              {!work.job.ok && <button onClick={() => void addStudio()}>Try again</button>}
              <button className="ghost" onClick={() => set(null)}>Dismiss</button>
            </div>
          )}
        </div>
      )}
      {work?.error && (
        <div className="app-row-work">
          <div className="banner bad small" role="alert">{work.error}</div>
          <div className="row">
            <span className="spacer" />
            {work.kind === "install" && <button onClick={() => void addStudio()}>Try again</button>}
            <button className="ghost" onClick={() => set(null)}>Dismiss</button>
          </div>
        </div>
      )}
    </li>
  );
}

/** The row's quieter actions. */
function RowMenu({ p, m }: { p: MachineProject; m: Machine }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div className="app-menu" ref={ref}>
      <button className="ghost app-menu-button" aria-label={`More for ${p.name}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="4.5" cy="10" r="1.4" /><circle cx="10" cy="10" r="1.4" /><circle cx="15.5" cy="10" r="1.4" /></svg>
      </button>
      {open && (
        <div className="app-menu-list" role="menu">
          <button role="menuitem" onClick={() => { setOpen(false); void host()?.openfolder({ path: p.dir }); }}>Open folder</button>
          <button role="menuitem" onClick={() => { setOpen(false); void host()?.removeproject({ uproject: p.uproject }).then(() => m.refresh()); }}>Remove from list</button>
        </div>
      )}
    </div>
  );
}

function Skeleton() {
  return (
    <ul className="app-list" aria-busy="true" aria-label="Reading your projects">
      {[0, 1, 2].map((i) => (
        <li key={i} className="app-row app-row-skeleton">
          <div className="app-row-main">
            <span className="app-bar" style={{ width: "34%" }} />
            <span className="app-bar" style={{ width: "58%" }} />
            <span className="app-bar" style={{ width: "26%" }} />
          </div>
        </li>
      ))}
    </ul>
  );
}
