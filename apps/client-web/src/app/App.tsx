import { useCallback, useEffect, useRef, useState } from "react";
import { host, onHostEvent, type HostState, type Live, type Newest, type ReportAnswer } from "./native";
import { parseReport, readAt, updateUeMcpCopy, withoutRemoved, type MachineProject, type MachineReport } from "./model";
import { Mark } from "./Mark";
import { ProjectsView } from "./Projects";
import { ProjectDetail } from "./ProjectDetail";
import { SettingsView } from "./Settings";
import { SetupView } from "./Setup";
import { NodeCard } from "./NodeCard";
import { Busy } from "./BusyLabel";

export type Screen = "projects" | "settings";

const SCREENS: Array<{ id: Screen; label: string; icon: JSX.Element }> = [
  { id: "projects", label: "Projects", icon: <path d="M3 5.5h5l1.5 2H17v8.5H3z" /> },
  { id: "settings", label: "Settings", icon: <><circle cx="10" cy="10" r="2.6" /><path d="M10 2.8v2.1M10 15.1v2.1M2.8 10h2.1M15.1 10h2.1M4.9 4.9l1.5 1.5M13.6 13.6l1.5 1.5M4.9 15.1l1.5-1.5M13.6 6.4l1.5-1.5" /></> },
];

/** What the app knows about this computer: the host, ue-mcp's report, which daemons run now, and the newest releases. */
export interface Machine {
  state: HostState | null;
  answer: ReportAnswer | null;
  report: MachineReport | null;
  /** The report shown is an earlier one, because this read failed. */
  stale: boolean;
  /**
   * The report shown came from a read this session. Until then (the list from
   * the last run, or a failed read) its editor state and updates are unverified
   * and are drawn as checking or unknown, never as fact.
   */
  verified: boolean;
  live: Record<string, Live> | null;
  loading: boolean;
  /** When the report shown was read (ms), or null before the first read of this session answers. */
  readAt: number | null;
  /** The newest release of each part on the channel; null while it is read. */
  newest: Newest | null;
  /**
   * Read the report again. A call while a read runs asks for one more read
   * after it, so a change that lands mid-read is never missed. Resolves with
   * the newest report read, or null when the read failed.
   */
  refresh: () => Promise<MachineReport | null>;
  refreshNode: () => Promise<void>;
  /** Read the newest releases again, as after the channel changed. */
  refreshNewest: () => void;
  /** Ask for the channel's newest ue-mcp again and read the report with it. */
  updateUeMcp: () => Promise<void>;
  /** The last Update ue-mcp press found no newer one. */
  updated: boolean;
  /** Take a project off the list; a failure is said in `notice`, never dropped. */
  removeProject: (p: MachineProject) => Promise<boolean>;
  notice: string | null;
  dismissNotice: () => void;
}

function useMachine(): Machine {
  const [state, setState] = useState<HostState | null>(null);
  const [answer, setAnswer] = useState<ReportAnswer | null>(null);
  const [live, setLive] = useState<Record<string, Live> | null>(null);
  const [cached, setCached] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [newest, setNewest] = useState<Newest | null>(null);
  const [okAt, setOkAt] = useState<number | null>(null);
  const reading = useRef<Promise<MachineReport | null> | null>(null);
  const again = useRef(false);

  // Until the first read answers, the last report shows, so the list is there at once.
  const [removed, setRemoved] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [updated, setUpdated] = useState(false);
  const fresh = !!answer && answer.ok;
  const parsed = parseReport(answer ? (answer.ok ? answer.report : answer.cached) : cached ?? undefined);
  const report = fresh ? parsed : withoutRemoved(parsed, removed);
  const stale = !!answer && !answer.ok && !!report;
  const cachedAt = answer && !answer.ok && answer.cachedAt ? Date.parse(answer.cachedAt) : NaN;
  const readAt = stale && Number.isFinite(cachedAt) ? cachedAt : okAt;

  const refresh = useCallback((): Promise<MachineReport | null> => {
    const h = host();
    if (!h) return Promise.resolve(null);
    if (reading.current) {
      again.current = true;
      return reading.current;
    }
    const run = (async () => {
      setLoading(true);
      let last: ReportAnswer | null = null;
      try {
        do {
          again.current = false;
          last = await h.report();
          setAnswer(last);
          if (last.ok) setOkAt(Date.now());
        } while (again.current);
      } finally {
        setLoading(false);
        reading.current = null;
      }
      return last?.ok ? parseReport(last.report) : null;
    })();
    reading.current = run;
    return run;
  }, []);

  const refreshNode = useCallback(async () => {
    const h = host();
    if (!h) return;
    setState(await h.refreshnode());
  }, []);

  const refreshNewest = useCallback(() => {
    const h = host();
    if (!h) return;
    setNewest(null);
    void h.newest().then(setNewest, () => setNewest({ errors: { ueMcp: "No answer.", studio: "No answer.", plugin: "No answer." } }));
  }, []);

  useEffect(() => {
    const h = host();
    if (!h) return;
    void h.getstate().then((s) => {
      setState(s);
      if (s.mode !== "app") return;
      void h.cachedreport().then(setCached);
      void refresh();
      refreshNewest();
    });
  }, [refresh, refreshNewest]);

  // The report follows the machine, not only this app's own actions: the host
  // says when a file it comes from changed (a daemon started or stopped, an
  // update finished in a project's Studio, plugins swapped), and coming back
  // to the window reads it again every time, from the host's activation and
  // the page's own focus alike (a second signal within a moment is the same one).
  useEffect(() => {
    if (state?.mode !== "app") return;
    let lastFocus = 0;
    const onFocus = () => {
      if (Date.now() - lastFocus < 2_000) return;
      lastFocus = Date.now();
      void refresh();
    };
    const onVisible = () => document.visibilityState === "visible" && onFocus();
    const off = onHostEvent((e) => (e === "focus" ? onFocus() : void refresh()));
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      off();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh, state?.mode]);

  // Which daemons run now, from their discovery files: cheap, so it is read every few seconds while shown.
  const keys = report ? report.projects.map((p) => p.key) : [];
  const keyList = keys.join(",");
  useEffect(() => {
    const h = host();
    if (!h || !keyList) return;
    let gone = false;
    const read = () => {
      if (document.visibilityState === "hidden") return;
      void h.live({ keys: keyList.split(",") }).then((l) => !gone && setLive(l));
    };
    read();
    const t = setInterval(read, 2500);
    return () => {
      gone = true;
      clearInterval(t);
    };
  }, [keyList]);

  const updateUeMcp = useCallback(async () => {
    const h = host();
    if (!h) return;
    if (!h.updateuemcp) {
      await refresh();
      return;
    }
    setLoading(true);
    try {
      const a = await h.updateuemcp();
      setAnswer(a);
      if (a.ok) setOkAt(Date.now());
      setUpdated(!a.ok && a.reason === "unsupported");
    } finally {
      setLoading(false);
    }
  }, [refresh]);

  const removeProject = useCallback(
    async (p: MachineProject) => {
      const h = host();
      if (!h) return false;
      const r = await h.removeproject({ uproject: p.uproject });
      if (!r.ok) {
        setNotice(`${p.name} could not be hidden${r.error ? `: ${r.error}` : "."}`);
        return false;
      }
      setNotice(null);
      setRemoved((k) => (k.includes(p.key) ? k : [...k, p.key]));
      await refresh();
      return true;
    },
    [refresh],
  );

  return {
    state, answer, report, stale, verified: fresh, live, loading, readAt, newest, refresh, refreshNode, refreshNewest,
    updateUeMcp, updated, removeProject, notice, dismissNotice: () => setNotice(null),
  };
}

/** The UE-MCP app: its setup when not installed, else the projects on this computer and a small Settings screen. */
export function App({ initial = "projects" }: { initial?: Screen } = {}) {
  const m = useMachine();
  const [screen, setScreen] = useState<Screen>(initial);
  const [selected, setSelected] = useState<string | null>(null);
  if (!m.state) return <div className="app-shell app-loading" aria-busy="true" />;
  if (m.state.mode === "setup") return <SetupView state={m.state} refreshNode={m.refreshNode} />;
  const needsNode = !m.state.node.ok;
  const project = selected ? m.report?.projects.find((p) => p.key === selected) ?? null : null;
  const go = (s: Screen) => {
    setScreen(s);
    setSelected(null);
  };
  return (
    <div className="app-shell">
      <nav className="app-rail" aria-label="UE-MCP Launcher">
        <div className="app-brand">
          <Mark size={22} />
          <span className="app-brand-name">UE-MCP Launcher</span>
        </div>
        <ul className="app-nav">
          {SCREENS.map((s) => (
            <li key={s.id}>
              <button className={`app-nav-item${screen === s.id ? " active" : ""}`} aria-current={screen === s.id ? "page" : undefined} onClick={() => go(s.id)}>
                <svg viewBox="0 0 20 20" aria-hidden="true">{s.icon}</svg>
                <span>{s.label}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="app-rail-foot dim small">
          <span>UE-MCP Launcher {m.state.version}</span>
          {m.report && <span>ue-mcp {m.report.ueMcp}</span>}
        </div>
      </nav>
      <main className="app-main">
        {needsNode && screen === "projects" ? (
          <NodeCard state={m.state} refreshNode={m.refreshNode} onInstalled={() => void m.refresh()} />
        ) : (
          <>
            {screen === "projects" && <ReportProblem m={m} onSettings={() => go("settings")} />}
            {/* With no report to show, the problem above is the whole screen. */}
            {screen === "projects" && project && <ProjectDetail p={project} m={m} onBack={() => setSelected(null)} />}
            {screen === "projects" && !project && (m.report || m.loading) && <ProjectsView m={m} onOpen={setSelected} />}
            {screen === "settings" && <SettingsView m={m} />}
          </>
        )}
      </main>
    </div>
  );
}

/** Why the report could not be read, above whatever is shown from an earlier one. */
function ReportProblem({ m, onSettings }: { m: Machine; onSettings: () => void }) {
  const notice = m.notice ? (
    <div className="banner warn app-banner" role="alert">
      <span>{m.notice}</span>
      <button onClick={m.dismissNotice}>Dismiss</button>
    </div>
  ) : null;
  const a = m.answer;
  if (!a || a.ok || m.loading) return notice;
  const version = a.ueMcp?.replace(/^ue-mcp@/, "") ?? "";
  if (a.reason === "unsupported") {
    const copy = updateUeMcpCopy(version, a.need, m.updated);
    return (
      <section className="app-callout" role="status">
        {notice}
        <h2>{copy.heading}</h2>
        <p className="muted">{copy.body}</p>
        {m.stale && <p className="dim small">Until then, this is the list read {readAt(a.cachedAt)}.</p>}
        <div className="row">
          {/* The update the text names is one press away, not a screen to find. */}
          <button className="primary" onClick={() => (m.updated ? onSettings() : void m.updateUeMcp())}>{copy.action}</button>
          <button disabled={m.loading} onClick={() => void m.refresh()}>{m.loading ? <Busy>Checking</Busy> : "Check again"}</button>
        </div>
      </section>
    );
  }
  if (a.reason === "version") {
    return (
      <section className="app-callout" role="status">
        {notice}
        <h2>Update UE-MCP to see your projects</h2>
        <p className="muted">{`ue-mcp ${version} lists projects in a newer form than this UE-MCP reads.`}</p>
        {m.stale && <p className="dim small">Until then, this is the list read {readAt(a.cachedAt)}.</p>}
        <div className="row">
          <button className="primary" onClick={onSettings}>Update UE-MCP</button>
          <button disabled={m.loading} onClick={() => void m.refresh()}>{m.loading ? <Busy>Checking</Busy> : "Check again"}</button>
        </div>
      </section>
    );
  }
  return (
    <>
      {notice}
      <div className="banner warn app-banner" role="alert">
        <span>
          {m.stale ? `Showing the list read ${readAt(a.cachedAt)}. ` : ""}
          Your projects could not be read{a.error ? `: ${a.error}` : "."}
        </span>
        <button disabled={m.loading} onClick={() => void m.refresh()}>{m.loading ? <Busy>Checking</Busy> : "Try again"}</button>
      </div>
    </>
  );
}
