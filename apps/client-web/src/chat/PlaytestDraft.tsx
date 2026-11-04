/**
 * A draft Playtest's own controls: Start playtest with its options, and Edit, which
 * changes the steps in place (instruction, player, auto or manual, the
 * expectation) and saves them through pie(script_update).
 */
import { useState, useId } from "react";
import type { QaRun, QaScriptStep } from "@ue-mcp-studio/shared";
import { qaScriptSteps } from "@ue-mcp-studio/shared";
import { DEFAULT_RUN, EDIT_OPS as OPS, EDIT_PLAYERS as PLAYERS, EMPTY_ROW, playersNeeded, rowOf, rowsValid, stepsOf, type EditRow as Row, type RunOptions } from "@ue-mcp-studio/client-core";

export { DEFAULT_RUN, playersNeeded, stepsOf, type RunOptions } from "@ue-mcp-studio/client-core";

export function RunPanel({ run, busy, onStart, onCancel }: { run: QaRun; busy: boolean; onStart: (o: RunOptions) => void; onCancel: () => void }) {
  const needed = playersNeeded(run);
  const [o, setO] = useState<RunOptions>({ ...DEFAULT_RUN, players: needed, listen: needed > 1 });
  return (
    <div className="qa-run-options small" role="group" aria-label="Start playtest options">
      <label className="row toggle">
        <input type="checkbox" checked={o.startPie} onChange={(e) => setO({ ...o, startPie: e.target.checked })} />
        <span>Start PIE <span className="dim">(off: use the PIE session that is running)</span></span>
      </label>
      <label className="row">
        <span>Players</span>
        <input type="number" min={1} max={8} value={o.players} aria-label="Players"
          onChange={(e) => {
            const players = Math.max(1, Math.min(8, Number(e.target.value) || 1));
            setO({ ...o, players, listen: players > 1 ? o.listen : false });
          }} />
      </label>
      <label className="row toggle">
        <input type="checkbox" checked={o.listen} disabled={o.players < 2} onChange={(e) => setO({ ...o, listen: e.target.checked })} />
        <span>Listen server</span>
      </label>
      <label className="row toggle">
        <input type="checkbox" checked={o.record} onChange={(e) => setO({ ...o, record: e.target.checked })} />
        <span>Record <span className="dim">(so the run can be replayed)</span></span>
      </label>
      <div className="row">
        <span className="spacer" />
        <button className="ghost small-button" onClick={onCancel}>Cancel</button>
        <button className="primary small-button" disabled={busy} onClick={() => onStart(o)}>Start</button>
      </div>
    </div>
  );
}

export function DraftEditor({ run, busy, error, onSave, onCancel }: { run: QaRun; busy: boolean; error?: string | null; onSave: (steps: QaScriptStep[], map: string) => void; onCancel: () => void }) {
  const [rows, setRows] = useState<Row[]>(() => qaScriptSteps(run).map(rowOf));
  const [map, setMap] = useState(run.map ?? "");
  const mapHelp = useId();
  const set = (i: number, patch: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const valid = rowsValid(rows);
  return (
    <div className="qa-edit" role="group" aria-label="Edit the playtest">
      <label className="qa-edit-map small">
        <span className="dim">Level</span>
        <input className="mono" value={map} placeholder="/Game/Maps/L_Example" aria-describedby={mapHelp} onChange={(e) => setMap(e.target.value)} />
        <span id={mapHelp} className="dim small qa-edit-map-help">Empty: the level that is open.</span>
      </label>
      <ol className="qa-edit-steps">
        {rows.map((r, i) => (
          <li key={i} className="qa-edit-step">
            <div className="row">
              <span className="qa-num mono dim">{i + 1}</span>
              {/* A box that grows with the instruction, so a long one is read whole on a phone; it stays one line of text. */}
              <textarea className="qa-edit-instruction" rows={1} aria-label={`Step ${i + 1} instruction`} value={r.instruction} onChange={(e) => set(i, { instruction: e.target.value.replace(/\r?\n/g, " ") })} />
              <button className="small-button qa-edit-remove" aria-label={`Remove step ${i + 1}`} onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</button>
            </div>
            <div className="row small">
              <select aria-label={`Step ${i + 1} player`} value={r.player} onChange={(e) => set(i, { player: e.target.value })}>
                {PLAYERS.map((p) => <option key={p} value={p}>{p || "any player"}</option>)}
              </select>
              <select aria-label={`Step ${i + 1} judge`} value={r.judge} onChange={(e) => set(i, { judge: e.target.value as Row["judge"] })}>
                <option value="auto">auto</option>
                <option value="manual">manual</option>
              </select>
              {r.judge === "auto" ? (
                <>
                  <input className="mono" aria-label={`Step ${i + 1} value`} placeholder="Value, e.g. Door.OpenAngle" value={r.value} onChange={(e) => set(i, { value: e.target.value })} />
                  <select aria-label={`Step ${i + 1} op`} value={r.op} onChange={(e) => set(i, { op: e.target.value })}>
                    {OPS.map((op) => <option key={op} value={op}>{op}</option>)}
                  </select>
                  {r.op !== "decreasing" && r.op !== "increasing" && (
                    <input className="mono qa-edit-short" aria-label={`Step ${i + 1} target`} placeholder="target" value={r.target} onChange={(e) => set(i, { target: e.target.value })} />
                  )}
                  <input className="mono qa-edit-short" aria-label={`Step ${i + 1} within ms`} placeholder="within ms" value={r.withinMs} onChange={(e) => set(i, { withinMs: e.target.value })} />
                </>
              ) : (
                <label className="row toggle">
                  <input type="checkbox" checked={r.personOnly} onChange={(e) => set(i, { personOnly: e.target.checked })} />
                  <span>Only a person judges it</span>
                </label>
              )}
            </div>
          </li>
        ))}
      </ol>
      <div className="row">
        <button className="ghost small-button" onClick={() => setRows([...rows, { ...EMPTY_ROW }])}>Add a step</button>
        <span className="spacer" />
        <button className="ghost small-button" onClick={onCancel}>Cancel</button>
        <button className="primary small-button" disabled={busy || !valid} onClick={() => onSave(stepsOf(rows), map.trim())}>Save</button>
      </div>
      {error && <div className="banner bad small" role="alert">Not saved. {error}</div>}
    </div>
  );
}
