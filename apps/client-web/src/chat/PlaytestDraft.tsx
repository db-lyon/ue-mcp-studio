/**
 * A draft Playtest's own controls: Run with its options, and Edit, which
 * changes the steps in place (instruction, player, auto or manual, the
 * expectation) and saves them through pie(script_update).
 */
import { useState } from "react";
import type { QaExpect, QaRun, QaScriptStep } from "@ue-mcp-studio/shared";
import { qaScriptSteps } from "@ue-mcp-studio/shared";

export interface RunOptions {
  startPie: boolean;
  players: number;
  listen: boolean;
  record: boolean;
}

export const DEFAULT_RUN: RunOptions = { startPie: true, players: 1, listen: false, record: true };

/** How many players a run needs: one more than the highest client a step names. */
export function playersNeeded(run: QaRun): number {
  let n = 1;
  for (const s of run.steps) {
    const m = /^client\s*(\d+)?$/i.exec(s.player ?? "");
    if (m) n = Math.max(n, Number(m[1] ?? 1) + 1);
  }
  return n;
}

export function RunPanel({ run, busy, onStart, onCancel }: { run: QaRun; busy: boolean; onStart: (o: RunOptions) => void; onCancel: () => void }) {
  const needed = playersNeeded(run);
  const [o, setO] = useState<RunOptions>({ ...DEFAULT_RUN, players: needed, listen: needed > 1 });
  return (
    <div className="qa-run-options small" role="group" aria-label="Run options">
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

const OPS = ["decreasing", "increasing", "eq", "gt", "lt", "visible", "exists"] as const;
const PLAYERS = ["", "host", "client 1", "client 2", "client 3"];

function targetOf(op: string, raw: string): number | boolean | undefined {
  if (op === "decreasing" || op === "increasing") return undefined;
  if (op === "visible" || op === "exists") return raw === "false" ? false : undefined;
  const n = Number(raw);
  return raw.trim() && Number.isFinite(n) ? n : undefined;
}

/** The steps as the editor holds them. */
interface Row {
  instruction: string;
  judge: "auto" | "manual";
  player: string;
  value: string;
  op: string;
  target: string;
  withinMs: string;
  personOnly: boolean;
}

function rowOf(s: QaScriptStep): Row {
  return {
    instruction: s.instruction,
    judge: s.judge,
    player: s.player ?? "",
    value: s.expect?.value ?? "",
    op: s.expect?.op ?? "eq",
    target: s.expect?.target === undefined ? "" : String(s.expect.target),
    withinMs: s.expect?.within_ms ? String(s.expect.within_ms) : "",
    personOnly: s.agent_judgeable === false,
  };
}

/** The editor's rows as script steps. An auto step without a value has no expectation and passes when it starts. */
export function stepsOf(rows: Row[]): QaScriptStep[] {
  return rows.map((r) => {
    const expect: QaExpect | undefined = r.judge === "auto" && r.value.trim()
      ? { value: r.value.trim(), op: r.op, ...(targetOf(r.op, r.target) !== undefined ? { target: targetOf(r.op, r.target) } : {}), ...(Number(r.withinMs) > 0 ? { within_ms: Number(r.withinMs) } : {}) }
      : undefined;
    return {
      instruction: r.instruction.trim(),
      judge: r.judge,
      ...(expect ? { expect } : {}),
      ...(r.judge === "manual" && r.personOnly ? { agent_judgeable: false } : {}),
      ...(r.player ? { player: r.player } : {}),
    };
  });
}

export function DraftEditor({ run, busy, onSave, onCancel }: { run: QaRun; busy: boolean; onSave: (steps: QaScriptStep[]) => void; onCancel: () => void }) {
  const [rows, setRows] = useState<Row[]>(() => qaScriptSteps(run).map(rowOf));
  const set = (i: number, patch: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const valid = rows.length > 0 && rows.every((r) => r.instruction.trim());
  return (
    <div className="qa-edit" role="group" aria-label="Edit the playtest">
      <ol className="qa-edit-steps">
        {rows.map((r, i) => (
          <li key={i} className="qa-edit-step">
            <div className="row">
              <span className="qa-num mono dim">{i + 1}</span>
              <input className="qa-edit-instruction" aria-label={`Step ${i + 1} instruction`} value={r.instruction} onChange={(e) => set(i, { instruction: e.target.value })} />
              <button className="ghost small-button" aria-label={`Remove step ${i + 1}`} onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</button>
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
        <button className="ghost small-button" onClick={() => setRows([...rows, { instruction: "", judge: "manual", player: "", value: "", op: "eq", target: "", withinMs: "", personOnly: false }])}>Add a step</button>
        <span className="spacer" />
        <button className="ghost small-button" onClick={onCancel}>Cancel</button>
        <button className="primary small-button" disabled={busy || !valid} onClick={() => onSave(stepsOf(rows))}>Save</button>
      </div>
    </div>
  );
}
