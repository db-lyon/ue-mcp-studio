import { useCallback, useEffect, useRef, useState } from "react";
import { host, type HostState, type Live, type ReportAnswer } from "./native";
import { parseReport, readAt, type MachineReport } from "./model";
import { Mark } from "./Mark";
import { ProjectsView } from "./Projects";
import { UpdatesView } from "./Updates";
import { DaemonsView } from "./Daemons";
import { SetupView } from "./Setup";
import { NodeCard } from "./NodeCard";

export type Screen = "projects" | "updates" | "daemons";

const SCREENS: Array<{ id: Screen; label: string; icon: JSX.Element }> = [
  { id: "projects", label: "Projects", icon: <path d="M3 5.5h5l1.5 2H17v8.5H3z" /> },
  { id: "updates", label: "Updates", icon: <path d="M10 3v9m0 0-3.5-3.5M10 12l3.5-3.5M4 15.5h12" /> },
  { id: "daemons", label: "Daemons", icon: <path d="M4 5h12v4H4zM4 11h12v4H4zM7 7h.01M7 13h.01" /> },
];

/** What the app knows about this computer: the host, ue-mcp's report, and which daemons run now. */
export interface Machine {
  state: HostState | null;
  answer: ReportAnswer | null;
  report: MachineReport | null;
  /** The report shown is an earlier one, because this read failed. */
  stale: boolean;
  live: Record<string, Live> | null;
  loading: boolean;
  refresh: () => Promise<void>;
  refreshNode: () => Promise<void>;
}

function useMachine(): Machine {
  const [state, setState] = useState<HostState | null>(null);
  const [answer, setAnswer] = useState<ReportAnswer | null>(null);
  const [live, setLive] = useState<Record<string, Live> | null>(null);
  const [cached, setCached] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
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

  useEffect(() => {
    const h = host();
    if (!h) return;
    void h.getstate().then((s) => {
      setState(s);
      if (s.mode !== "app") return;
      void h.cachedreport().then(setCached);
      void refresh();
    });
  }, [refresh]);

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
  const keys = report ? [...new Set([...report.projects.map((p) => p.key), ...report.daemons.map((d) => d.key)])] : [];
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

  return { state, answer, report, stale, live, loading, refresh, refreshNode };
}

/** The UE-MCP app: its setup when not installed, else Projects, Updates and Daemons. */
export function App({ initial = "projects" }: { initial?: Screen } = {}) {
  const m = useMachine();
  const [screen, setScreen] = useState<Screen>(initial);
  if (!m.state) return <div className="app-shell app-loading" aria-busy="true" />;
  if (m.state.mode === "setup") return <SetupView state={m.state} refreshNode={m.refreshNode} />;
  const needsNode = !m.state.node.ok;
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
              <button className={`app-nav-item${screen === s.id ? " active" : ""}`} aria-current={screen === s.id ? "page" : undefined} onClick={() => setScreen(s.id)}>
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
        {needsNode ? (
          <NodeCard state={m.state} refreshNode={m.refreshNode} onInstalled={() => void m.refresh()} />
        ) : (
          <>
            <ReportProblem m={m} />
            {/* With no report to show, the problem above is the whole screen; Updates still has UE-MCP's own. */}
            {screen === "projects" && (m.report || m.loading) && <ProjectsView m={m} />}
            {screen === "updates" && <UpdatesView m={m} />}
            {screen === "daemons" && (m.report || m.loading) && <DaemonsView m={m} />}
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
            : `ue-mcp ${version} reports projects in a form this UE-MCP does not read. Update UE-MCP.`}
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
