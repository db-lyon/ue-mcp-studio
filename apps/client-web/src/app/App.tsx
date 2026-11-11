import { useCallback, useEffect, useRef, useState } from "react";
import { host, type HostState, type Live, type Newest, type ReportAnswer } from "./native";
import { parseReport, readAt, type MachineReport } from "./model";
import { Mark } from "./Mark";
import { ProjectsView } from "./Projects";
import { ProjectDetail } from "./ProjectDetail";
import { SettingsView } from "./Settings";
import { SetupView } from "./Setup";
import { NodeCard } from "./NodeCard";

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
  live: Record<string, Live> | null;
  loading: boolean;
  /** The newest release of each part on the channel; null while it is read. */
  newest: Newest | null;
  refresh: () => Promise<void>;
  refreshNode: () => Promise<void>;
  /** Read the newest releases again, as after the channel changed. */
  refreshNewest: () => void;
}

function useMachine(): Machine {
  const [state, setState] = useState<HostState | null>(null);
  const [answer, setAnswer] = useState<ReportAnswer | null>(null);
  const [live, setLive] = useState<Record<string, Live> | null>(null);
  const [cached, setCached] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [newest, setNewest] = useState<Newest | null>(null);
  const reading = useRef<Promise<void> | null>(null);

  // Until the first read answers, the last report shows, so the list is there at once.
  const report = parseReport(answer ? (answer.ok ? answer.report : answer.cached) : cached ?? undefined);
  const stale = !!answer && !answer.ok && !!report;

  const refresh = useCallback(() => {
    const h = host();
    if (!h) return Promise.resolve();
    reading.current ??= (async () => {
      setLoading(true);
      try {
        setAnswer(await h.report());
      } finally {
        setLoading(false);
        reading.current = null;
      }
    })();
    return reading.current;
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

  // Coming back to the window reads the report again; ue-mcp may have changed meanwhile.
  useEffect(() => {
    let last = Date.now();
    const onFocus = () => {
      if (state?.mode !== "app" || Date.now() - last < 15_000) return;
      last = Date.now();
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
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

  return { state, answer, report, stale, live, loading, newest, refresh, refreshNode, refreshNewest };
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
      <nav className="app-rail" aria-label="UE-MCP">
        <div className="app-brand">
          <Mark size={22} />
          <span className="app-brand-name">UE-MCP</span>
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
          <span>UE-MCP {m.state.version}</span>
          {m.report && <span>ue-mcp {m.report.ueMcp}</span>}
        </div>
      </nav>
      <main className="app-main">
        {needsNode && screen === "projects" ? (
          <NodeCard state={m.state} refreshNode={m.refreshNode} onInstalled={() => void m.refresh()} />
        ) : (
          <>
            {screen === "projects" && <ReportProblem m={m} />}
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
function ReportProblem({ m }: { m: Machine }) {
  const a = m.answer;
  if (!a || a.ok || m.loading) return null;
  const version = a.ueMcp?.replace(/^ue-mcp@/, "") ?? "";
  if (a.reason === "unsupported" || a.reason === "version") {
    return (
      <section className="app-callout" role="status">
        <h2>UE-MCP needs a newer ue-mcp</h2>
        <p className="muted">
          {a.reason === "unsupported"
            ? `UE-MCP lists your projects with ue-mcp's projects command, and ue-mcp ${version} does not have it yet. It comes with the next ue-mcp release.`
            : `ue-mcp ${version} reports projects in a form this UE-MCP does not read. Update UE-MCP in Settings.`}
        </p>
        {m.stale && <p className="dim small">Showing the list read {readAt(a.cachedAt)}.</p>}
        <div className="row">
          <button onClick={() => void m.refresh()}>Check again</button>
        </div>
      </section>
    );
  }
  return (
    <div className="banner warn app-banner" role="alert">
      <span>
        {m.stale ? `Showing the list read ${readAt(a.cachedAt)}. ` : ""}
        Your projects could not be read{a.error ? `: ${a.error}` : "."}
      </span>
      <button onClick={() => void m.refresh()}>Try again</button>
    </div>
  );
}
