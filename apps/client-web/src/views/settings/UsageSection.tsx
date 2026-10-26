import { useEffect, useState } from "react";
import { BUDGET_LIMITS, MAIN_AGENT_ID, MAX_SUBAGENTS_PER_TURN, PLAYTEST_RUNNER_ID, type Budget, type Budgets } from "@ue-mcp-studio/shared";
import { api, type BudgetsBody } from "../../api";
import { Head } from "../SettingsHub";
import { Card, NumberField, Row, Seg, useMessage } from "./controls";
import { UsageDashboard } from "./UsageDashboard";

/** What each row does at its per-run limit, as the runs enforce it today. */
const AT_LIMIT: Record<string, string> = {
  [MAIN_AGENT_ID]: "The turn stops and says so",
  [PLAYTEST_RUNNER_ID]: "The loop stops and waits for you",
};

const DAY_ACTIONS: ReadonlyArray<{ id: "ask" | "stop"; name: string; title: string }> = [
  { id: "ask", name: "Ask", title: "The next call waits for you to allow it" },
  { id: "stop", name: "Stop", title: "The turn ends and says why" },
];

/**
 * Usage: what the ledger recorded, each sign-in's plan, and every budget,
 * which are edited only here.
 */
export function UsageSection() {
  const [body, setBody] = useState<BudgetsBody | null>(null);
  const msg = useMessage();
  useEffect(() => {
    api.budgets().then(setBody, msg.fail);
  }, []);
  const done = (r: BudgetsBody) => {
    setBody(r);
    msg.clear();
  };
  const save = (id: string, b: Partial<Budget>) => api.saveBudgets({ agents: { [id]: b } }).then(done, msg.fail);
  const saveTeam = (t: Partial<Budgets["team"]>) => api.saveBudgets({ team: t }).then(done, msg.fail);
  if (!body) return <>{msg.node ?? <p className="muted">Loading</p>}</>;
  const team = body.budgets.team;
  return (
    <>
      <Head title="Usage" lead="What every agent spent and may spend, in the same four token kinds on every vendor and route, from Studio's own record of each model call. Kept on this machine and never written to the project." />
      {msg.node}
      <UsageDashboard teamPerDay={team.perDayTokens} />
      <Card label="Budgets">
        <p className="muted small">{body.definition}</p>
        <div className="scroll-x">
          <table className="cfg-table blocks">
            <thead>
              <tr><th>Who</th><th>Tokens per run</th><th>Minutes per run</th><th>Tokens per day</th><th>At the limit</th></tr>
            </thead>
            <tbody>
              {body.agents.map((a) => {
                const b = body.budgets.agents[a.id] ?? { perRunTokens: null, perRunMinutes: null, perDayTokens: null, onLimit: "stop-and-report" };
                const runner = a.id === PLAYTEST_RUNNER_ID;
                const perRun = a.id === MAIN_AGENT_ID || runner;
                return (
                  <tr key={a.id}>
                    <td>
                      <strong>{a.name}</strong>
                      <div className="cfg-note">{runner ? "One assigned playtest, every attempt included" : a.id === MAIN_AGENT_ID ? "One turn, its helpers' calls included" : a.id === "worker" ? "Every helper run it makes in a day" : "A project subagent, every run it makes in a day"}</div>
                    </td>
                    <td data-label="Tokens per run">
                      {perRun
                        ? <NumberField label={`${a.name} tokens per run`} value={b.perRunTokens} nullable={!runner} min={BUDGET_LIMITS.minTokens} max={BUDGET_LIMITS.maxTokens} onSave={(n) => void save(a.id, { perRunTokens: n })} />
                        : <span className="dim small">Counts toward the turn that started it</span>}
                    </td>
                    <td data-label="Minutes per run">
                      {runner
                        ? <NumberField label={`${a.name} minutes per run`} value={b.perRunMinutes} min={1} max={BUDGET_LIMITS.maxMinutes} onSave={(n) => void save(a.id, { perRunMinutes: n })} />
                        : <span className="dim small">No time limit</span>}
                    </td>
                    <td data-label="Tokens per day">
                      <NumberField label={`${a.name} tokens per day`} value={b.perDayTokens} nullable min={BUDGET_LIMITS.minTokens} max={BUDGET_LIMITS.maxTokens} onSave={(n) => void save(a.id, { perDayTokens: n })} />
                    </td>
                    <td className="small" data-label="At the limit">
                      <div>{AT_LIMIT[a.id] ?? (b.perDayTokens === null ? "No limit" : b.onLimit === "ask" ? "The next tool call asks you" : "The turn stops and says so")}</div>
                      {b.perDayTokens !== null && (
                        <Seg compact label={`${a.name}: at the daily limit`} value={b.onLimit === "ask" ? "ask" : "stop"} options={DAY_ACTIONS} onChange={(v) => void save(a.id, { onLimit: v === "ask" ? "ask" : "stop-and-report" })} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <Row title="All agents, per day" help="Every call on this machine together, from midnight.">
          <NumberField label="All agents tokens per day" value={team.perDayTokens} nullable min={BUDGET_LIMITS.minTokens} max={BUDGET_LIMITS.maxTokens} onSave={(n) => void saveTeam({ perDayTokens: n })} />
        </Row>
        <Row title="All agents, per month" help="The calendar month. It counts only what Studio recorded, so the month the record started counts from that day.">
          <NumberField label="All agents tokens per month" value={team.perMonthTokens} nullable min={BUDGET_LIMITS.minTokens} max={BUDGET_LIMITS.maxTokens} onSave={(n) => void saveTeam({ perMonthTokens: n })} />
        </Row>
        <Row title="At an all-agents limit" help="Ask: the next call waits for you. Stop: the turn ends and says why.">
          <Seg label="At an all-agents limit" value={team.onLimit} options={DAY_ACTIONS} onChange={(v) => void saveTeam({ onLimit: v })} />
        </Row>
        <Row title="Warn at" help="The share of any budget at which Usage shows a warning, from 50% to 95%.">
          <NumberField label="Warn at, percent" value={Math.round(body.budgets.warnAt * 100)} min={BUDGET_LIMITS.minWarn * 100} max={BUDGET_LIMITS.maxWarn * 100} onSave={(n) => n !== null && void api.saveBudgets({ warnAt: n / 100 }).then(done, msg.fail)} />
        </Row>
        <Row title="Helpers per turn" help="The most helpers one turn may start, Studio's worker and the project's own subagents together. Past it, the main agent is told to do the work itself.">
          <NumberField label="Helpers per turn" value={body.helpersPerTurn} min={1} max={MAX_SUBAGENTS_PER_TURN} onSave={(n) => n !== null && void api.saveBudgets({ helpersPerTurn: n }).then(done, msg.fail)} />
        </Row>
        <p className="cfg-note">A helper's tokens count toward the turn that started it. Empty means no limit, except the playtest runner's per-run limits, which it always has so its loop ends. Days and months are this machine's calendar. Tokens from {BUDGET_LIMITS.minTokens.toLocaleString("en-US")} to {BUDGET_LIMITS.maxTokens.toLocaleString("en-US")}; minutes up to {BUDGET_LIMITS.maxMinutes}.</p>
      </Card>
    </>
  );
}
