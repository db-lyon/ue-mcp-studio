/**
 * Every arrangement in the project: its level, tracks, checks and regions,
 * and how its test did last. A row opens the Arrangement; New arrangement
 * makes an empty one in the open level.
 */
import { useState } from "react";
import { HUB_COPY, TEST_HEALTH_LOOK, arrangeClock, nextTitle, passRateText, shortAgo } from "@ue-mcp-studio/client-core";
import { api } from "../../api";
import { useHub } from "./state";
import { Empty, HubIcon, RouteLink, ScreenHead, StatusMark } from "./parts";

export function ArrangementsScreen() {
  const { o, go, notify, data, run } = useHub();
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      const title = nextTitle("Arrangement", o.arrangements.map((a) => a.title));
      const v = await api.hub.createArrangement({ title, tracks: [], checks: [], regions: [] });
      data.reload();
      go({ screen: "arrangement", id: v.arrangement.id });
    } catch (e) {
      notify((e as Error).message, "bad");
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: string, title: string) => {
    if (!window.confirm(HUB_COPY.deleteConfirm(title))) return;
    try {
      await api.hub.deleteArrangement(id);
      data.reload();
    } catch (e) {
      notify((e as Error).message, "bad");
    }
  };
  const list = [...o.arrangements].sort((a, b) => a.title.localeCompare(b.title));
  return (
    <div className="hub-screen">
      <ScreenHead title={HUB_COPY.arrangements} actions={<button className="primary small-button" disabled={busy} onClick={() => void create()}><HubIcon name="plus" />{HUB_COPY.newArrangement}</button>} />
      {list.length === 0 ? (
        <Empty title={HUB_COPY.noArrangements} actions={<button className="primary small-button" disabled={busy} onClick={() => void create()}>{HUB_COPY.newArrangement}</button>}>{HUB_COPY.noArrangementsHelp}</Empty>
      ) : (
        <ul className="hub-list hub-arrangement-list">
          {list.map((a) => {
            const test = o.tests.find((t) => t.id === a.id);
            const look = TEST_HEALTH_LOOK[test?.health ?? "never_run"];
            const blocking = a.findings.filter((f) => f.blocks).length;
            return (
              <li key={a.id} className="hub-goal-line">
                <RouteLink className="hub-row" to={{ screen: "arrangement", id: a.id }}>
                  <StatusMark look={look} label={look.label} />
                  <span className="hub-row-main">
                    <span className="hub-row-title">{a.title}</span>
                    <span className="hub-row-meta">
                      <span>{a.level ? a.level.split("/").pop() : HUB_COPY.openLevel}</span>
                      <span>{a.tracks === 1 ? "1 track" : `${a.tracks} tracks`}</span>
                      <span>{a.checks === 1 ? "1 check" : `${a.checks} checks`}</span>
                      {a.regions.length > 0 && <span>{a.regions.map((r) => r.name).join(", ")}</span>}
                      <span className="mono">{arrangeClock(a.length, 60)}</span>
                      {blocking > 0 && <span className="hub-bad-text">{HUB_COPY.findings(blocking)}</span>}
                    </span>
                  </span>
                  <span className="hub-row-num" title={HUB_COPY.passRate}>{passRateText(test?.passRate)}</span>
                  <span className="hub-row-when">{shortAgo(test?.last?.startedAt)}</span>
                </RouteLink>
                <span className="hub-row-actions">
                  <button className="icon-button" title={a.checks ? `${HUB_COPY.play} ${a.title}` : "Add a check to run it"} aria-label={`${HUB_COPY.play} ${a.title}`} disabled={!a.checks} onClick={() => void run({ test: a.id }, a.title)}><HubIcon name="play" /></button>
                  <button className="icon-button" title={`Delete ${a.title}`} aria-label={`Delete ${a.title}`} onClick={() => void remove(a.id, a.title)}><HubIcon name="trash" /></button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
