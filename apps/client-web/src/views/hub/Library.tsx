/**
 * The library: every playtest the project has, goals or not, filtered by
 * health, goal and text. Rows select with their box or x, and the selection
 * runs as one batch or joins a goal.
 */
import { useMemo, useRef, useState } from "react";
import { HEALTH_FILTERS, HUB_COPY, filterChecks, healthCounts, sortGoals, type HealthFilter } from "@ue-mcp-studio/client-core";
import { useCursor, useHub } from "./state";
import { Empty, EvidenceScope, HubIcon, Kbd, ScreenHead } from "./parts";
import { CheckRow } from "./rows";

export function LibraryScreen() {
  const hub = useHub();
  const { o, go } = hub;
  const [health, setHealth] = useState<HealthFilter>("all");
  const [goalId, setGoalId] = useState("");
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const filterBox = useRef<HTMLInputElement>(null);
  const counts = useMemo(() => healthCounts(o.checks), [o.checks]);
  const rows = useMemo(() => filterChecks(o.checks, { health, goalId, text }, o.goals), [o.checks, o.goals, health, goalId, text]);
  const goals = useMemo(() => sortGoals(o.goals.filter((g) => !g.goal.archived)), [o.goals]);
  const list = useRef<HTMLDivElement>(null);
  const [at, setAt, move] = useCursor(rows.length, list);
  const chosen = rows.filter((c) => picked.has(c.id));
  const allShown = rows.length > 0 && rows.every((c) => picked.has(c.id));

  const toggle = (id: string) => setPicked((p) => {
    const next = new Set(p);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const runChosen = () => {
    if (chosen.length === 0) return;
    void hub.runPlan({ title: `${chosen.length} selected`, scope: { kind: "checks", checks: chosen.map((c) => c.check) } }, `${chosen.length} selected`);
    setPicked(new Set());
  };

  hub.onKeys((a) => {
    const cur = rows[at];
    if (a.type === "next") move(1);
    else if (a.type === "prev") move(-1);
    else if (a.type === "open" && cur) go({ screen: "check", checkId: cur.id });
    else if (a.type === "select" && cur) toggle(cur.id);
    else if (a.type === "run" && chosen.length > 0) runChosen();
    else if (a.type === "run" && cur) void hub.runCheck(cur.id, cur.name);
    else if (a.type === "filter") filterBox.current?.focus();
    else return false;
    return true;
  });

  return (
    <div className="hub-screen hub-library">
      <ScreenHead title={HUB_COPY.library} sub={<><span>{o.checks.length} {o.checks.length === 1 ? "playtest" : "playtests"}</span><EvidenceScope /></>} />
      <div className="hub-filters">
        <div className="hub-search">
          <HubIcon name="search" />
          <input
            ref={filterBox}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") { setText(""); (e.target as HTMLInputElement).blur(); }
              if (e.key === "Enter" || e.key === "ArrowDown") { e.preventDefault(); (e.target as HTMLInputElement).blur(); setAt(0); }
            }}
            placeholder={HUB_COPY.filterPlaceholder}
            aria-label="Filter playtests"
          />
          {!hub.narrow && <Kbd>/</Kbd>}
        </div>
        <select value={goalId} onChange={(e) => setGoalId(e.target.value)} aria-label="Goal">
          <option value="">Any goal</option>
          <option value="none">{HUB_COPY.notInGoal}</option>
          {goals.map((g) => <option key={g.goal.id} value={g.goal.id}>{g.goal.title}</option>)}
        </select>
      </div>
      <div className="hub-chips" role="group" aria-label="Health">
        {HEALTH_FILTERS.filter((f) => f.id === "all" || counts[f.id] > 0).map((f) => (
          <button key={f.id} className={`filter-chip ${health === f.id ? "active" : ""} ${f.id === "failing" ? "attention" : ""}`} aria-pressed={health === f.id} onClick={() => setHealth(f.id)}>
            {f.label} <span className="filter-count">{counts[f.id]}</span>
          </button>
        ))}
      </div>
      {chosen.length > 0 && (
        <div className="hub-bulk" role="toolbar" aria-label="Selected playtests">
          <strong>{chosen.length} selected</strong>
          <button className="primary" onClick={runChosen}><HubIcon name="play" size={12} /> {HUB_COPY.runSelected}</button>
          <button onClick={() => hub.addToGoal(chosen.map((c) => c.id))}><HubIcon name="goal" size={12} /> {HUB_COPY.addToGoal}</button>
          <span className="spacer" />
          <button className="ghost" onClick={() => setPicked(new Set())}>Clear</button>
        </div>
      )}
      {rows.length === 0 ? <Empty title={o.checks.length ? HUB_COPY.libraryEmpty : HUB_COPY.noChecksTitle}>{o.checks.length ? null : HUB_COPY.noChecksLead}</Empty> : (
        <>
          <label className="hub-select-all small">
            <input type="checkbox" checked={allShown} onChange={() => setPicked(allShown ? new Set() : new Set(rows.map((c) => c.id)))} />
            Select all {rows.length}
          </label>
          <div className="hub-list" ref={list}>
            {rows.map((c, i) => (
              <CheckRow key={c.id} c={c} on={i === at} onPoint={() => setAt(i)}
                lead={<input type="checkbox" className="hub-pick" checked={picked.has(c.id)} onChange={() => toggle(c.id)} aria-label={`Select ${c.name}`} />}
                actions={<button className="ghost icon-button" aria-label={`Run ${c.name}`} title="Run (r)" onClick={() => void hub.runCheck(c.id, c.name)}><HubIcon name="play" size={12} /></button>} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
