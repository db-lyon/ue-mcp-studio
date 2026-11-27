/**
 * The Playtest Hub on the Playtests tab. Composing: arrangements place clips
 * on tracks in one level and grade the run on their Checks track. Testing:
 * suites group tests (an arrangement or a region of one) and track their
 * health. A rail on wide screens and a segmented bar on narrow ones move
 * between Arrangements, Suites and Runs; each screen has its own address
 * under #/playtests, so Back works and every screen can be linked.
 */
import { useEffect, useState, type ReactNode } from "react";
import type { QueueRequest } from "ue-mcp/daemon";
import { HUB_COPY, hubHash, hubPath, hubSection, parseHubPath, queuedText, type HubRoute, type HubSection } from "@ue-mcp-studio/client-core";
import { api } from "../../api";
import { pushLocation, readLocation } from "../../location";
import { HubContext, type HubContextValue, type HubData } from "./state";
import { HubIcon, HubLink, Placeholder, type HubIconName } from "./parts";
import { ArrangementsScreen } from "./Arrangements";
import { ArrangementScreen } from "./Arrangement";
import { ClipScreen } from "./ClipRoll";
import { SuitesScreen } from "./Suites";
import { RunsScreen } from "./Runs";
import "./hub.css";
import "./arrangement.css";

/** The hub screen the hash names, read again on every hashchange (Back, Forward, a pasted link). */
function useHubRoute(): [HubRoute, (r: HubRoute) => void] {
  const [route, setRoute] = useState<HubRoute>(() => parseHubPath(readLocation().sub));
  useEffect(() => {
    const follow = () => {
      const at = readLocation();
      if (at.tab === "Playtests") setRoute(parseHubPath(at.sub));
    };
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, []);
  const go = (r: HubRoute) => {
    setRoute(r);
    pushLocation({ tab: "Playtests", sub: hubPath(r) || null });
  };
  return [route, go];
}

const SECTIONS: ReadonlyArray<{ id: HubSection; label: string; icon: HubIconName; route: HubRoute }> = [
  { id: "arrangements", label: HUB_COPY.arrangements, icon: "arrange", route: { screen: "arrangements" } },
  { id: "suites", label: HUB_COPY.suites, icon: "suite", route: { screen: "suites" } },
  { id: "runs", label: HUB_COPY.runs, icon: "queue", route: { screen: "runs" } },
];

export function HubView({ data, narrow }: { data: HubData; narrow: boolean }) {
  const [route, go] = useHubRoute();
  const [toast, setToast] = useState<{ text: string; tone: "ok" | "bad"; n: number } | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.tone === "bad" ? 8000 : 4000);
    return () => clearTimeout(t);
  }, [toast?.n]);
  const notify = (text: string, tone: "ok" | "bad" = "ok") => setToast((t) => ({ text, tone, n: (t?.n ?? 0) + 1 }));

  const o = data.overview;
  if (!o) {
    return (
      <div className="hub-root hub-loading">
        {data.error ? <div className="banner bad" role="alert">The Playtest Hub did not load: {data.error} <button className="small-button" onClick={data.reload}>Try again</button></div> : <Placeholder rows={6} />}
      </div>
    );
  }

  const run = async (req: QueueRequest, what: string) => {
    try {
      const a = await api.hub.enqueue(req);
      const f = queuedText(a, what);
      notify(f.text, f.tone);
      data.reload();
    } catch (e) {
      notify((e as Error).message, "bad");
    }
  };

  const ctx: HubContextValue = { o, data, route, go, narrow, notify, run };
  const fill = route.screen === "arrangement" || route.screen === "clip";
  const screen = (() => {
    switch (route.screen) {
      case "arrangements": return <ArrangementsScreen />;
      case "arrangement": return <ArrangementScreen key={route.id} id={route.id} runId={route.run ?? null} />;
      case "clip": return <ClipScreen key={route.id} id={route.id} from={route.from ?? null} />;
      case "suites": return <SuitesScreen selected={route.id ?? null} />;
      case "runs": return <RunsScreen />;
    }
  })();

  return (
    <HubContext.Provider value={ctx}>
      <div className={`hub-root ${narrow ? "narrow" : "wide"}`}>
        {narrow ? <HubBar route={route} go={go} count={count(o)} /> : <HubRail route={route} go={go} count={count(o)} />}
        <div className={`hub-main ${fill ? "fill" : ""}`}>
          {data.error && <div className="banner warn small" role="alert">Could not refresh: {data.error}</div>}
          {o.problems.length > 0 && route.screen === "arrangements" && (
            <div className="banner warn small" role="alert" title={o.problems.map((p) => `${p.file}: ${p.findings[0]?.message ?? ""}`).join("\n")}>{HUB_COPY.problems(o.problems.length)}: {o.problems.map((p) => p.file).join(", ")}</div>
          )}
          {screen}
        </div>
        {toast && (
          <div className={`hub-toast ${toast.tone}`} role="status">
            {toast.text}
            <button className="ghost small-button" aria-label="Dismiss" onClick={() => setToast(null)}><HubIcon name="close" size={12} /></button>
          </div>
        )}
      </div>
    </HubContext.Provider>
  );
}

/** What each rail entry counts. */
function count(o: HubContextValue["o"]): Record<HubSection, ReactNode> {
  const live = o.queue.running.length > 0;
  return {
    arrangements: <span className="hub-rail-count">{o.arrangements.length}</span>,
    suites: <span className="hub-rail-count">{o.suites.length}</span>,
    runs: live ? <span className="hub-live-dot" aria-label="Running now" title="Running now" /> : o.queue.queued.length ? <span className="hub-rail-count">{o.queue.queued.length}</span> : null,
  };
}

/** The wide hub's rail. */
function HubRail({ route, go, count }: { route: HubRoute; go: (r: HubRoute) => void; count: Record<HubSection, ReactNode> }) {
  const at = hubSection(route);
  return (
    <nav className="hub-rail" aria-label={HUB_COPY.title}>
      <div className="hub-rail-group">
        {SECTIONS.map((s) => (
          <HubLink key={s.id} href={hubHash(s.route)} onGo={() => go(s.route)} className={`hub-rail-item ${at === s.id ? "active" : ""}`} aria-current={at === s.id ? "page" : undefined}>
            <HubIcon name={s.icon} />
            <span className="hub-rail-label">{s.label}</span>
            {count[s.id]}
          </HubLink>
        ))}
      </div>
    </nav>
  );
}

/** The narrow hub's bar: the three screens side by side. */
function HubBar({ route, go, count }: { route: HubRoute; go: (r: HubRoute) => void; count: Record<HubSection, ReactNode> }) {
  const at = hubSection(route);
  return (
    <div className="hub-bar">
      <nav className="hub-seg" aria-label={HUB_COPY.title}>
        {SECTIONS.map((s) => (
          <HubLink key={s.id} href={hubHash(s.route)} onGo={() => go(s.route)} className={`hub-seg-item ${at === s.id ? "active" : ""}`} aria-current={at === s.id ? "page" : undefined}>
            <span>{s.label}</span>
            {s.id === "runs" && count.runs}
          </HubLink>
        ))}
      </nav>
    </div>
  );
}
