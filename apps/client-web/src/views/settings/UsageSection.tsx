import { useEffect, useState } from "react";
import { BUDGET_LIMITS, MAIN_AGENT_ID, MAX_SUBAGENTS_PER_TURN, PLAYTEST_RUNNER_ID, type Budget } from "@ue-mcp-studio/shared";
import { api, type BudgetsBody } from "../../api";
import { Head } from "../SettingsHub";
import { Card, NumberField, Row, useMessage } from "./controls";

/** What each row does at its limit, as the runs enforce it today. */
const AT_LIMIT: Record<string, string> = {
  [MAIN_AGENT_ID]: "The turn stops and says so",
  [PLAYTEST_RUNNER_ID]: "The loop stops and asks for you",
};

/**
 * Usage: every budget, and the only place they are edited. Each row is what
 * one run of that agent may spend.
 */
export function UsageSection() {
  const [body, setBody] = useState<BudgetsBody | null>(null);
  const msg = useMessage();
  useEffect(() => {
    api.budgets().then(setBody, msg.fail);
  }, []);
  const save = (id: string, b: Partial<Budget>) => api.saveBudgets({ agents: { [id]: b } }).then((r) => {
    setBody(r);
    msg.clear();
  }, msg.fail);
  if (!body) return <>{msg.node ?? <p className="muted">Loading</p>}</>;
  return (
    <>
      <Head title="Usage" lead="What every agent may spend, in the same units on every vendor and route. Budgets are kept on this machine and never written to the project." />
      {msg.node}
      <Card label="Budgets">
        <p className="muted small">{body.definition}</p>
        <div className="scroll-x">
          <table className="cfg-table blocks">
            <thead>
              <tr><th>Who</th><th>Tokens per run</th><th>Minutes per run</th><th>At the limit</th></tr>
            </thead>
            <tbody>
              {body.agents.map((a) => {
                const b = body.budgets.agents[a.id] ?? { perRunTokens: null, perRunMinutes: null, perDayTokens: null, onLimit: "stop-and-report" };
                const runner = a.id === PLAYTEST_RUNNER_ID;
                return (
                  <tr key={a.id}>
                    <td>
                      <strong>{a.name}</strong>
                      <div className="cfg-note">{runner ? "One assigned playtest, every attempt included" : "One turn of its own calls"}</div>
                    </td>
                    <td data-label="Tokens per run">
                      <NumberField label={`${a.name} tokens per run`} value={b.perRunTokens} nullable={!runner} min={BUDGET_LIMITS.minTokens} max={BUDGET_LIMITS.maxTokens} onSave={(n) => void save(a.id, { perRunTokens: n })} />
                    </td>
                    <td data-label="Minutes per run">
                      {runner
                        ? <NumberField label={`${a.name} minutes per run`} value={b.perRunMinutes} min={1} max={BUDGET_LIMITS.maxMinutes} onSave={(n) => void save(a.id, { perRunMinutes: n })} />
                        : <input type="text" className="minutes" disabled value="" placeholder="None" aria-label={`${a.name} minutes per run: a turn has no time limit`} title="A turn has no time limit" />}
                    </td>
                    <td className="small" data-label="At the limit">{AT_LIMIT[a.id] ?? "Stops and reports"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <Row title="Helpers per turn" help="The most helpers one turn may start, the built-in worker and the project's own subagents together. Past it, the main agent is told to do the work itself.">
          <NumberField label="Helpers per turn" value={body.helpersPerTurn} min={1} max={MAX_SUBAGENTS_PER_TURN} onSave={(n) => n !== null && void api.saveBudgets({ helpersPerTurn: n }).then(setBody, msg.fail)} />
        </Row>
        <p className="cfg-note">Empty means no limit. Tokens from {BUDGET_LIMITS.minTokens.toLocaleString("en-US")} to {BUDGET_LIMITS.maxTokens.toLocaleString("en-US")}; minutes up to {BUDGET_LIMITS.maxMinutes}. Each turn ends with a line in the chat saying what it spent.</p>
      </Card>
    </>
  );
}
