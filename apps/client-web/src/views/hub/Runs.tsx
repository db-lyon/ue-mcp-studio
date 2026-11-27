/**
 * Runs: what plays now and what waits in the queue, with why the next item
 * waits and Pause, then the recent runs. A run opens on its arrangement,
 * where its checks show their results.
 */
import { HUB_COPY, RUN_STATE_LOOK, runTally, shortAgo } from "@ue-mcp-studio/client-core";
import { parseTestId } from "ue-mcp/hub";
import { api } from "../../api";
import { useHub } from "./state";
import { Empty, HubIcon, RouteLink, ScreenHead, StatusMark } from "./parts";

export function RunsScreen() {
  const { o, notify, data } = useHub();
  const q = o.queue;
  const act = (f: () => Promise<unknown>) => f().then(() => data.reload(), (e: Error) => notify(e.message, "bad"));
  const items = [...q.running, ...q.queued];
  return (
    <div className="hub-screen">
      <ScreenHead
        title={HUB_COPY.runs}
        actions={<button className="small-button" onClick={() => void act(() => api.hub.pause(!q.paused))}><HubIcon name={q.paused ? "play" : "pause"} />{q.paused ? HUB_COPY.resume : HUB_COPY.pause}</button>}
      />
      <section className="hub-section">
        <div className="hub-section-head"><h2>{HUB_COPY.queue}</h2></div>
        {q.paused && <div className="banner warn small">{HUB_COPY.queuePaused}</div>}
        {!q.paused && q.waiting.length > 0 && <div className="banner small">{HUB_COPY.editorBusy}: {q.waiting.map((w) => w.text).join(" ")}</div>}
        {items.length === 0 ? <p className="dim small">Nothing is queued.</p> : (
          <ul className="hub-list">
            {items.map((i) => {
              const ref = parseTestId(i.test);
              const look = RUN_STATE_LOOK[i.state === "running" ? "running" : "starting"];
              return (
                <li key={i.id} className="hub-goal-line">
                  <RouteLink className="hub-row hub-mini-row" to={{ screen: "arrangement", id: ref?.arrangement ?? i.test, ...(i.runId ? { run: i.runId } : {}) }}>
                    <StatusMark look={i.state === "running" ? look : { glyph: "queued", tone: "idle", label: "Queued" }} label={i.state === "running" ? look.label : "Queued"} />
                    <span className="hub-row-title">{i.title}</span>
                    <span className="hub-row-meta">{i.suite ? `Suite ${i.suite}` : ""} {i.runner === "headless" ? "Headless" : ""}</span>
                  </RouteLink>
                  <span className="hub-row-actions">
                    {i.state === "running" && i.runId
                      ? <button className="small-button" onClick={() => void act(() => api.hub.stopRun(i.runId!))}>{HUB_COPY.stop}</button>
                      : <button className="icon-button" aria-label={`${HUB_COPY.remove} ${i.title}`} title={HUB_COPY.remove} onClick={() => void act(() => api.hub.dequeue(i.id))}><HubIcon name="close" /></button>}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <section className="hub-section">
        <div className="hub-section-head"><h2>{HUB_COPY.recent}</h2></div>
        {o.recent.length === 0 ? <Empty title={HUB_COPY.noRuns} /> : (
          <ul className="hub-list">
            {o.recent.map((r) => {
              const look = RUN_STATE_LOOK[r.state];
              const t = runTally(r);
              const ref = parseTestId(r.test);
              return (
                <li key={r.runId}>
                  <RouteLink className="hub-row hub-mini-row" to={{ screen: "arrangement", id: ref?.arrangement ?? r.test, run: r.runId }}>
                    <StatusMark look={look} label={look.label} />
                    <span className="hub-row-title">{r.title}</span>
                    <span className="hub-row-meta">{t.passed} of {t.total} checks{r.revision ? ` · ${r.revision.slice(0, 8)}` : ""}</span>
                    <span className="hub-row-when">{shortAgo(r.startedAt)}</span>
                  </RouteLink>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
