import { useEffect, useRef, useState } from "react";
import type { Machine } from "./App";
import { host, type IdeInfo } from "./native";
import { actionsOf, filterProjects, ideButton, ideOpens, listReadAt, nameHint, running, updatesOf, versionsOf, type MachineProject } from "./model";
import { JobOutput } from "./NodeCard";
import { installing, projectActions, useIdes, useWorks, workTitle, type Work } from "./actions";

/** A filter appears once the list is long enough to need one. */
const FILTER_FROM = 7;

/** Every project on this computer, one row each, with everything about it; a row opens the project's detail. */
export function ProjectsView({ m, onOpen }: { m: Machine; onOpen: (key: string) => void }) {
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState<string | null>(null);
  const works = useWorks();
  const projects = m.report?.projects ?? [];
  const shown = filterProjects(projects, query);
  const waiting = projects.filter((p) => updatesOf(p, m.newest)?.waiting.length).length;

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
          {projects.length > 0 && (
            <p className="dim small">
              {projects.length === 1 ? "1 project" : `${projects.length} projects`} on this computer
              {m.newest ? (waiting ? `, ${waiting === 1 ? "1 with an update" : `${waiting} with updates`}` : "") : ", checking for updates"}
            </p>
          )}
        </div>
        <span className="spacer" />
        {projects.length >= FILTER_FROM && (
          <input className="app-filter" type="search" placeholder="Filter" aria-label="Filter projects" value={query} onChange={(e) => setQuery(e.target.value)} />
        )}
        {m.readAt !== null && <span className="dim small app-read-at" title="The list reads again by itself when a project, daemon or Studio changes">{listReadAt(m.readAt)}</span>}
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
          <ProjectRow key={p.key} p={p} all={projects} m={m} work={works[p.key] ?? null} busy={installing(works)} onOpen={() => onOpen(p.key)} />
        ))}
      </ul>
    </section>
  );
}

function ProjectRow({ p, all, m, work, busy, onOpen }: { p: MachineProject; all: MachineProject[]; m: Machine; work: Work | null; busy: boolean; onOpen: () => void }) {
  const mine = (work?.kind === "install" || work?.kind === "update") && !!work.job?.running;
  const a = actionsOf(p, mine && work?.kind === "install", busy && !mine);
  const act = projectActions(p, m, work);
  const u = updatesOf(p, m.newest);
  const hint = nameHint(p, all);
  const versions = versionsOf(p, m.live, m.report?.ueMcp ?? null);
  const pending = (k: Work["kind"]) => work?.kind === k && !work.error && !work.done;

  return (
    <li className="app-row app-project">
      <div className="app-row-main">
        <div className="app-row-title">
          <button className="app-row-open" onClick={onOpen} title={`Details for ${p.name}`}>
            <span className="app-row-name">{p.name}</span>
            {hint && <span className="app-row-hint dim">{hint}</span>}
          </button>
          {p.engine.version && <span className="app-engine">UE {p.engine.version}</span>}
          {u?.pill && <span className={`pill ${u.tone}`} title={u.line}>{u.pill}</span>}
        </div>
        <div className="app-row-path dim small" title={p.dir}>{p.dir}</div>
        {versions.length > 0 && (
          <details className="app-versions-fold small">
            <summary className="dim">Versions</summary>
            <div className="app-versions">
              {versions.map((v) => (
                <span key={v.label}><span className="dim">{v.label}</span> {v.version}</span>
              ))}
            </div>
          </details>
        )}
        <div className="app-chips">
          {!p.ueMcp.setUp && <span className="app-chip dim">ue-mcp not set up</span>}
          {p.ueMcp.setUp && <DaemonChip p={p} m={m} work={work} act={act} />}
          {p.editor.running && <span className="app-chip warn">Editor open</span>}
        </div>
      </div>
      <div className="app-row-actions">
        {u?.via && (
          <button className="primary" disabled={(u.via === "ue-mcp" && (p.editor.running || busy)) || pending("update")} title={u.line} onClick={() => void act.update()}>
            {work?.watching ? "Updating in Studio" : pending("update") ? (u.via === "studio" ? "Opening" : "Updating") : "Update"}
          </button>
        )}
        {a.openStudio && (
          <button className={u?.via ? "" : "primary"} disabled={pending("studio")} onClick={() => void act.openStudio()}>
            {pending("studio") ? "Opening" : "Open Studio"}
          </button>
        )}
        {a.addStudio && (
          <button className={u?.via ? "" : "primary"} disabled={!!a.addBlocked} title={a.addBlocked ?? undefined} onClick={() => void act.addStudio()}>
            {pending("install") ? "Adding Studio" : "Add Studio"}
          </button>
        )}
        <button disabled={!!a.launchBlocked || pending("launch")} title={a.launchBlocked ?? undefined} onClick={() => void act.launch()}>
          {pending("launch") ? "Starting" : "Launch editor"}
        </button>
        <RowMenu p={p} m={m} act={act} onOpen={onOpen} />
      </div>
      {a.addStudio && p.editor.running && !mine && <p className="app-row-note dim small">{a.addBlocked}</p>}
      <WorkPanel p={p} work={work} act={act} />
    </li>
  );
}

type Actions = ReturnType<typeof projectActions>;

/** The daemon's state, with Start or Stop beside it. */
export function DaemonChip({ p, m, work, act }: { p: MachineProject; m: Machine; work: Work | null; act: Actions }) {
  const d = running(p, m.live);
  const busy = (work?.kind === "start" || work?.kind === "stop") && !!work.job?.running;
  return (
    <span className="app-daemon-chip">
      {d ? (
        <span className="app-chip accent" title={`ue-mcp ${d.version}, pid ${d.pid}, port ${d.port}`}>Daemon running</span>
      ) : (
        <span className="app-chip dim">Daemon stopped</span>
      )}
      <button className="ghost small app-chip-action" disabled={busy || !!work?.confirm} onClick={() => void (d ? act.stop() : act.start())}>
        {busy ? (work?.kind === "start" ? "Starting" : "Stopping") : d ? "Stop" : "Start"}
      </button>
    </span>
  );
}

/** A project's work: a job's output, why an action failed, or Stop asking again. */
export function WorkPanel({ p, work, act }: { p: MachineProject; work: Work | null; act: Actions }) {
  if (!work) return null;
  if (work.confirm) {
    return (
      <div className="app-row-work">
        <div className="banner warn small">Stopping ue-mcp disconnects {work.confirm}. Unreal keeps running; ue-mcp starts again when it is next needed.</div>
        <div className="row">
          <span className="spacer" />
          <button className="ghost" onClick={act.cancel}>Cancel</button>
          <button className="primary" onClick={() => void act.stop()}>Stop anyway</button>
        </div>
      </div>
    );
  }
  if (work.error) {
    return (
      <div className="app-row-work">
        <div className="banner bad small" role="alert">{work.error}</div>
        <div className="row">
          <span className="spacer" />
          {work.kind === "install" && <button onClick={() => void act.addStudio()}>Try again</button>}
          <button className="ghost" onClick={act.cancel}>Dismiss</button>
        </div>
      </div>
    );
  }
  if (work.needsFiles) {
    const n = work.needsFiles;
    return (
      <div className="app-row-work">
        <div className="banner warn small" role="status">
          {p.name} has no Visual Studio solution yet.{" "}
          {n.source
            ? "Generating its project files writes one, as Unreal's Generate Visual Studio project files does."
            : `${p.name} has no C++ source, so its solution would hold only the engine. VS Code can open the folder instead.`}
          {!n.generate && " No Unreal Engine was found here to generate them with."}
        </div>
        <div className="row">
          <span className="spacer" />
          <button className="ghost" onClick={act.cancel}>Cancel</button>
          {n.code && <button onClick={() => void act.openIde("vscode", false)}>Open folder in VS Code</button>}
          {n.generate && <button className="primary" onClick={() => void act.generateFiles(n.ide)}>Generate project files</button>}
        </div>
      </div>
    );
  }
  if (work.watching) {
    return (
      <div className="app-row-work">
        <div className="banner ok small" role="status">{p.name}'s Studio is running the update. The versions here refresh when it finishes.</div>
        <div className="row">
          <span className="spacer" />
          <button className="ghost" onClick={act.cancel}>Dismiss</button>
        </div>
      </div>
    );
  }
  if (!work.job) return null;
  return (
    <div className="app-row-work">
      <JobOutput job={work.job} title={workTitle(work.kind, work.job, p.name)} />
      {work.done && work.job.ok && work.kind === "install" && <p className="muted small">Studio opens from the Studio button on the editor toolbar, or from Open Studio here.</p>}
      {work.done && (
        <div className="row">
          <span className="spacer" />
          {!work.job.ok && work.kind === "install" && <button onClick={() => void act.addStudio()}>Try again</button>}
          {!work.job.ok && work.kind === "update" && <button onClick={() => void act.update()}>Try again</button>}
          {!work.job.ok && work.kind === "projectfiles" && <button onClick={() => void act.generateFiles()}>Try again</button>}
          <button className="ghost" onClick={act.cancel}>Dismiss</button>
        </div>
      )}
    </div>
  );
}

/** A menu's open state, closed by a press outside it. */
function useMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  return { open, setOpen, ref };
}

/** Open with...: every IDE found here, the one the project opens in ticked. Picking one opens the project in it and keeps it for the project. */
function IdeChoices({ p, info, onPick }: { p: MachineProject; info: IdeInfo | null; onPick: (id: string) => void }) {
  return (
    <>
      <div className="app-menu-head">Open with</div>
      {!info && <div className="app-menu-note dim small">Looking for IDEs</div>}
      {info && !info.ides?.length && <div className="app-menu-note dim small">No IDE found. UE-MCP looks for Visual Studio, VS Code and Rider.</div>}
      {info?.ides?.map((ide) => (
        <button key={ide.id} className="app-menu-ide" role="menuitemradio" aria-checked={ide.id === info.chosen} title={ideOpens(ide, info, p)} onClick={() => onPick(ide.id)}>
          <span className="app-menu-check" aria-hidden="true">{ide.id === info.chosen ? "✓" : ""}</span>
          <span>{ide.name}</span>
        </button>
      ))}
    </>
  );
}

/** Open in IDE with Open with... beside it, for a project's detail. */
export function IdeButton({ p, act, work }: { p: MachineProject; act: Actions; work: Work | null }) {
  const info = useIdes(p, true);
  const b = ideButton(info, p);
  const { open, setOpen, ref } = useMenu();
  const pending = work?.kind === "ide" && !work.error && !work.needsFiles;
  return (
    <div className="app-menu app-split" ref={ref}>
      <button disabled={!b.ide || pending} title={b.title} onClick={() => void act.openIde()}>{pending ? "Opening" : b.label}</button>
      <button className="app-split-more" aria-label={`Open ${p.name} with`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.5 8l4.5 4.5L14.5 8" /></svg>
      </button>
      {open && (
        <div className="app-menu-list" role="menu">
          <IdeChoices p={p} info={info} onPick={(id) => { setOpen(false); void act.openIde(id); }} />
        </div>
      )}
    </div>
  );
}

/** The row's quieter actions: Open in IDE and Open with..., Show in Explorer, the detail, and leaving the list. */
function RowMenu({ p, m, act, onOpen }: { p: MachineProject; m: Machine; act: Actions; onOpen: () => void }) {
  const { open, setOpen, ref } = useMenu();
  const info = useIdes(p, open);
  const b = ideButton(info, p);
  return (
    <div className="app-menu" ref={ref}>
      <button className="ghost app-menu-button" aria-label={`More for ${p.name}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="4.5" cy="10" r="1.4" /><circle cx="10" cy="10" r="1.4" /><circle cx="15.5" cy="10" r="1.4" /></svg>
      </button>
      {open && (
        <div className="app-menu-list" role="menu">
          <button role="menuitem" disabled={!b.ide} title={b.title} onClick={() => { setOpen(false); void act.openIde(); }}>{b.label}</button>
          <button role="menuitem" onClick={() => { setOpen(false); act.reveal(); }}>Show in Explorer</button>
          <div className="app-menu-sep" />
          <IdeChoices p={p} info={info} onPick={(id) => { setOpen(false); void act.openIde(id); }} />
          <div className="app-menu-sep" />
          <button role="menuitem" onClick={() => { setOpen(false); onOpen(); }}>Details</button>
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
