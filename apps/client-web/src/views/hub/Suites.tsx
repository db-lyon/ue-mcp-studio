/**
 * Suites: named lists of tests (an arrangement or one of its regions) and of
 * other suites. The tree on the left nests them; the suite on show has its
 * health, pass rate and pass-rate history, Run suite, and each test it holds
 * with its health and the marks a person sets on it: flaky, and quarantined
 * (it still runs but does not count).
 */
import { useState } from "react";
import type { SuiteItem, SuiteState, TestState } from "ue-mcp/daemon";
import {
  HUB_COPY,
  SUITE_HEALTH_LOOK,
  TEST_HEALTH_LOOK,
  historyBars,
  nextTitle,
  passRateText,
  rootSuites,
  shortAgo,
  suiteFileOf,
  withItem,
  withoutItem,
} from "@ue-mcp-studio/client-core";
import { api } from "../../api";
import { useHub } from "./state";
import { Empty, HubIcon, RouteLink, ScreenHead, StatusMark, StatusPill } from "./parts";

export function SuitesScreen({ selected }: { selected: string | null }) {
  const { o, go, notify, data } = useHub();
  const [busy, setBusy] = useState(false);
  const shown = o.suites.find((s) => s.id === selected) ?? rootSuites(o.suites)[0] ?? null;
  const create = async () => {
    setBusy(true);
    try {
      const s = await api.hub.createSuite({ title: nextTitle("Suite", o.suites.map((x) => x.title)), items: [], quarantined: [], flaky: [] });
      data.reload();
      go({ screen: "suites", id: s.id });
    } catch (e) {
      notify((e as Error).message, "bad");
    } finally {
      setBusy(false);
    }
  };
  const newButton = <button className="primary small-button" disabled={busy} onClick={() => void create()}><HubIcon name="plus" />{HUB_COPY.newSuite}</button>;
  return (
    <div className="hub-screen hub-suites">
      <ScreenHead title={HUB_COPY.suites} actions={newButton} />
      {o.suites.length === 0 ? (
        <Empty title={HUB_COPY.noSuites} actions={newButton}>{HUB_COPY.noSuitesHelp}</Empty>
      ) : (
        <div className="hub-suites-layout">
          <nav className="hub-suite-tree" aria-label={HUB_COPY.suites}>
            <ul className="hub-list">
              {rootSuites(o.suites).map((s) => <TreeNode key={s.id} suite={s} depth={0} at={shown?.id ?? null} path={[]} />)}
            </ul>
          </nav>
          {shown && <SuiteDetail key={shown.id} suite={shown} />}
        </div>
      )}
    </div>
  );
}

function TreeNode({ suite, depth, at, path }: { suite: SuiteState; depth: number; at: string | null; path: string[] }) {
  const { o } = useHub();
  const look = SUITE_HEALTH_LOOK[suite.health];
  const children = suite.items.flatMap((i) => ("suite" in i ? o.suites.filter((s) => s.id === i.suite && !path.includes(s.id)) : []));
  return (
    <li>
      <RouteLink className={`hub-row hub-mini-row ${at === suite.id ? "on" : ""}`} to={{ screen: "suites", id: suite.id }} style={{ paddingLeft: 6 + depth * 14 }} aria-current={at === suite.id ? "page" : undefined}>
        <StatusMark look={look} label={look.label} />
        <span className="hub-row-title">{suite.title}</span>
        <span className="hub-row-num">{passRateText(suite.passRate)}</span>
      </RouteLink>
      {children.length > 0 && (
        <ul className="hub-list">
          {children.map((c) => <TreeNode key={c.id} suite={c} depth={depth + 1} at={at} path={[...path, suite.id]} />)}
        </ul>
      )}
    </li>
  );
}

function SuiteDetail({ suite }: { suite: SuiteState }) {
  const { o, run, notify, data, go } = useHub();
  const [adding, setAdding] = useState("");
  const look = SUITE_HEALTH_LOOK[suite.health];
  const save = async (f: (s: ReturnType<typeof suiteFileOf>) => ReturnType<typeof suiteFileOf>) => {
    try {
      await api.hub.putSuite(f(suiteFileOf(suite)));
      data.reload();
    } catch (e) {
      notify((e as Error).message, "bad");
    }
  };
  const mark = async (kind: "quarantine" | "flaky", test: string, on: boolean) => {
    try {
      await (kind === "quarantine" ? api.hub.quarantine(suite.id, test, on) : api.hub.markFlaky(suite.id, test, on));
      data.reload();
    } catch (e) {
      notify((e as Error).message, "bad");
    }
  };
  const remove = async () => {
    if (!window.confirm(HUB_COPY.deleteConfirm(suite.title))) return;
    try {
      await api.hub.deleteSuite(suite.id);
      data.reload();
      go({ screen: "suites" });
    } catch (e) {
      notify((e as Error).message, "bad");
    }
  };
  const direct = new Set(suite.items.flatMap((i) => ("test" in i ? [i.test] : [])));
  const nested = suite.items.flatMap((i) => ("suite" in i ? [i.suite] : []));
  const candidates: Array<{ value: string; label: string; item: SuiteItem }> = [
    ...o.tests.filter((t) => !direct.has(t.id)).map((t) => ({ value: `t:${t.id}`, label: t.title, item: { test: t.id } as SuiteItem })),
    ...o.suites.filter((s) => s.id !== suite.id && !nested.includes(s.id)).map((s) => ({ value: `s:${s.id}`, label: `Suite: ${s.title}`, item: { suite: s.id } as SuiteItem })),
  ];
  const bars = historyBars(suite.history);
  const counted = suite.tests.filter((t) => !t.quarantined).length;
  return (
    <section className="hub-suite-detail">
      <header className="hub-head">
        <div className="hub-head-text">
          <input className="hub-suite-title" aria-label="Suite title" defaultValue={suite.title} key={`${suite.id}:${suite.title}`} onBlur={(e) => e.target.value.trim() && e.target.value !== suite.title && void save((s) => ({ ...s, title: e.target.value.trim() }))} />
          <div className="hub-sub">
            <StatusPill look={look} />
            <span>{HUB_COPY.passRate} {passRateText(suite.passRate)}</span>
            <span className="muted">{counted === suite.tests.length ? `${counted} tests` : `${counted} of ${suite.tests.length} tests count`}</span>
          </div>
        </div>
        <div className="hub-head-actions">
          <button className="primary small-button" disabled={suite.tests.length === 0} onClick={() => void run({ suite: suite.id }, suite.title)}><HubIcon name="play" />{HUB_COPY.runSuite}</button>
          <button className="ghost icon-button" aria-label={`Delete ${suite.title}`} title={`Delete ${suite.title}`} onClick={() => void remove()}><HubIcon name="trash" /></button>
        </div>
      </header>

      <div className="hub-card">
        <div className="hub-card-head">{HUB_COPY.history}</div>
        {bars.length === 0 ? <p className="dim small">{HUB_COPY.noHistory}</p> : (
          <div className="hub-history" role="img" aria-label={`${HUB_COPY.history}: ${bars.map((b) => `${Math.round(b.rate * 100)}%`).join(", ")}`}>
            {bars.map((b) => <span key={b.batch} className={`hub-history-bar ${b.rate === 1 ? "ok" : b.rate === 0 ? "bad" : "warn"}`} style={{ height: `${Math.max(6, b.rate * 100)}%` }} title={b.label} />)}
          </div>
        )}
      </div>

      {suite.missing.length > 0 && <div className="banner warn small" role="alert">{HUB_COPY.missing}: {suite.missing.join(", ")}</div>}

      <ul className="hub-list">
        {suite.tests.map((t) => <TestRow key={t.id} test={t} suite={suite} direct={direct.has(t.id)} onMark={mark} onRemove={() => void save((s) => withoutItem(s, { test: t.id }))} />)}
        {nested.map((id) => {
          const s = o.suites.find((x) => x.id === id);
          return (
            <li key={`s:${id}`} className="hub-goal-line">
              <RouteLink className="hub-row hub-mini-row" to={{ screen: "suites", id }}>
                {s ? <StatusMark look={SUITE_HEALTH_LOOK[s.health]} label={SUITE_HEALTH_LOOK[s.health].label} /> : <StatusMark look={TEST_HEALTH_LOOK.missing} />}
                <span className="hub-row-title">Suite: {s?.title ?? id}</span>
              </RouteLink>
              <span className="hub-row-actions"><button className="icon-button" aria-label="Remove from suite" title={HUB_COPY.remove} onClick={() => void save((x) => withoutItem(x, { suite: id }))}><HubIcon name="close" /></button></span>
            </li>
          );
        })}
      </ul>

      <div className="hub-suite-add">
        <select aria-label="Add a test or suite" value={adding} onChange={(e) => setAdding(e.target.value)}>
          <option value="">Add a test or suite</option>
          {candidates.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
        <button className="small-button" disabled={!adding} onClick={() => {
          const c = candidates.find((x) => x.value === adding);
          if (!c) return;
          setAdding("");
          void save((s) => withItem(s, c.item));
        }}>{HUB_COPY.addToSuite}</button>
      </div>
    </section>
  );
}

function TestRow({ test, suite, direct, onMark, onRemove }: { test: TestState; suite: SuiteState; direct: boolean; onMark: (kind: "quarantine" | "flaky", test: string, on: boolean) => void; onRemove: () => void }) {
  const look = TEST_HEALTH_LOOK[test.health];
  const quarantined = suite.quarantined.includes(test.id);
  const marked = suite.flaky.includes(test.id);
  return (
    <li className={`hub-goal-line hub-test-row ${quarantined ? "quarantined" : ""}`}>
      <RouteLink className="hub-row" to={{ screen: "arrangement", id: test.arrangement, ...(test.last ? { run: test.last.runId } : {}) }}>
        <StatusMark look={look} label={look.label} />
        <span className="hub-row-main">
          <span className="hub-row-title">{test.title}</span>
          <span className="hub-row-meta">
            <span>{look.label}</span>
            {test.flaky.detected && <span className="hub-flaky">{HUB_COPY.flakyDetected(test.flaky.checks)}</span>}
            {marked && <span className="hub-flaky">{HUB_COPY.flakyMarked}</span>}
            {quarantined && <span className="pill">{HUB_COPY.quarantined}</span>}
            {!direct && <span className="dim">from a nested suite</span>}
          </span>
        </span>
        <span className="hub-row-num" title={HUB_COPY.passRate}>{passRateText(test.passRate)}</span>
        <span className="hub-row-when">{shortAgo(test.last?.startedAt)}</span>
      </RouteLink>
      <span className="hub-row-actions">
        <button className={`small-button ghost ${marked ? "on" : ""}`} aria-pressed={marked} onClick={() => onMark("flaky", test.id, !marked)}>{marked ? HUB_COPY.unmarkFlaky : HUB_COPY.markFlaky}</button>
        <button className={`small-button ghost ${quarantined ? "on" : ""}`} aria-pressed={quarantined} onClick={() => onMark("quarantine", test.id, !quarantined)}>{quarantined ? HUB_COPY.unquarantine : HUB_COPY.quarantine}</button>
        {direct && <button className="icon-button" aria-label="Remove from suite" title={HUB_COPY.remove} onClick={onRemove}><HubIcon name="close" /></button>}
      </span>
    </li>
  );
}
