import { useEffect, useState } from "react";
import { PLAYTEST_RUNS, type AgentSettings, type DialogMode, type FeedbackMode, type PlaytestBudget, type PlaytestRunsMode, type StudioSettings } from "@ue-mcp-studio/shared";
import { api, ApiError } from "../api";
import { DialogPolicyField } from "./Settings";
import { UsageCard } from "./UsageCard";

const DIALOG_MODES: { id: DialogMode; name: string; about: string }[] = [
  { id: "interactive", name: "Show them to me in Studio", about: "Each dialog is a card in the chat with its buttons." },
  { id: "auto", name: "Let the agent answer", about: "An answer that discards work waits 10 seconds so you can override it." },
  { id: "defer", name: "Leave them in the editor", about: "Nothing is pressed; the turn waits until you answer in the editor." },
];

const FEEDBACK_MODES: { id: FeedbackMode; name: string; about: string }[] = [
  { id: "interactive", name: "Ask me before filing", about: "Each report is a card in the chat to edit, approve or discard." },
  { id: "auto-approve", name: "File without asking", about: "Reports go straight to GitHub." },
  { id: "defer", name: "Keep them for review", about: "Reports wait on this machine for npx ue-mcp feedback review." },
];

/**
 * Everything about how the agent works, in one place: what it may do without
 * asking, who answers editor dialogs, who starts playtests, and how it files feedback.
 */
export function AgentView() {
  const [settings, setSettings] = useState<StudioSettings | null>(null);
  const [agent, setAgent] = useState<AgentSettings | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const fail = (e: ApiError | Error) => setMessage({ ok: false, text: e.message });

  useEffect(() => {
    api.settings().then(setSettings, fail);
    api.agentSettings().then(setAgent, fail);
  }, []);

  const saveAgent = (u: Partial<{ feedbackTool: boolean; feedbackMode: FeedbackMode; dialogMode: DialogMode; playtestRuns: PlaytestRunsMode; playtestBudget: PlaytestBudget }>) =>
    api.saveAgentSettings(u).then((a) => {
      setAgent(a);
      setMessage(a.restarting ? { ok: true, text: "Saved. ue-mcp restarts to load it, after the turn in progress." } : null);
    }, fail);

  if (!settings || !agent) return message ? <div className="banner bad">{message.text}</div> : <p className="muted">Loading...</p>;
  const dialogMode = agent.dialogMode?.mode ?? null;
  return (
    <div className="stack">
      {message && <div className={message.ok ? "banner ok" : "banner bad"}>{message.text}</div>}
      <section className="card">
        <h2>Commands and files</h2>
        <label className="row toggle">
          <input type="checkbox" checked={settings.askBeforeChanges} onChange={(e) => api.saveSettings({ askBeforeChanges: e.target.checked }).then(setSettings, fail)} />
          <span>Ask before running commands and editing files</span>
        </label>
        <p className="muted small">On: each shell command and each file write or edit waits in the chat for Allow or Deny. Reading files and the web never asks.</p>
      </section>

      <UsageCard settings={settings} onSettings={setSettings} onError={fail} />

      <section className="card">
        <h2>Review</h2>
        <label className="row toggle">
          <input type="checkbox" checked={settings.reviewTurns !== false} onChange={(e) => api.saveSettings({ reviewTurns: e.target.checked }).then(setSettings, fail)} />
          <span>Review each turn</span>
        </label>
        <p className="muted small">On: Studio takes a ue-mcp checkpoint before and after each turn, and a card lists what the turn changed so you can keep or revert each file. A session's Checkpoints panel turns it on or off for that session. Assign to subagent on a playtest needs it on.</p>
      </section>

      <section className="card">
        <h2>Editor dialogs</h2>
        {agent.dialogMode ? (
          <fieldset>
            <legend>Who answers a dialog the agent's call opens</legend>
            {DIALOG_MODES.map((m) => (
              <label key={m.id} className="row toggle">
                <input type="radio" name="dialog-mode" checked={dialogMode === m.id} onChange={() => void saveAgent({ dialogMode: m.id })} />
                <span>{m.name} <span className="dim small">{m.about}</span></span>
              </label>
            ))}
            {dialogMode === null && <p className="muted small">Not set: each client decides. Studio shows them to you.</p>}
          </fieldset>
        ) : (
          <p className="muted small">Update ue-mcp to choose this from Studio.</p>
        )}
        {(dialogMode === "interactive" || dialogMode === null) && (
          <DialogPolicyField policy={settings.dialogPolicy} onSave={(dialogPolicy) => api.saveSettings({ dialogPolicy }).then(setSettings, fail)} />
        )}
      </section>

      <section className="card">
        <h2>Playtests</h2>
        {agent.playtestRuns ? (
          <fieldset>
            <legend>Playtest runs</legend>
            {PLAYTEST_RUNS.map((m) => (
              <label key={m.mode} className="row toggle">
                <input type="radio" name="playtest-runs" checked={agent.playtestRuns === m.mode} onChange={() => void saveAgent({ playtestRuns: m.mode })} />
                <span>{m.label} <span className="dim small">{m.help}</span></span>
              </label>
            ))}
          </fieldset>
        ) : (
          <p className="muted small">Update Studio to choose this.</p>
        )}
        {agent.playtestBudget && <BudgetField budget={agent.playtestBudget} onSave={(playtestBudget) => void saveAgent({ playtestBudget })} />}
      </section>

      <section className="card">
        <h2>Feedback</h2>
        <label className="row toggle">
          <input type="checkbox" checked={agent.feedbackTool} onChange={(e) => void saveAgent({ feedbackTool: e.target.checked })} />
          <span>Feedback tool <span className="dim small">The agent can report gaps in ue-mcp's tools as GitHub issues.</span></span>
        </label>
        {agent.feedbackTool && (agent.feedbackMode ? (
          <fieldset>
            <legend>Before a report is filed</legend>
            {FEEDBACK_MODES.map((m) => (
              <label key={m.id} className="row toggle">
                <input type="radio" name="feedback-mode" checked={agent.feedbackMode!.mode === m.id} onChange={() => void saveAgent({ feedbackMode: m.id })} />
                <span>{m.name} <span className="dim small">{m.about}</span></span>
              </label>
            ))}
          </fieldset>
        ) : (
          <p className="muted small">Update ue-mcp to choose this from Studio.</p>
        ))}
      </section>
      <p className="muted small">Saved for this project.</p>
    </div>
  );
}

/**
 * "Assign to subagent budget": the time and tokens one loop may spend before it
 * stops and asks for you. Saved when a field is left or Enter is pressed.
 */
export function BudgetField({ budget, onSave }: { budget: PlaytestBudget; onSave: (b: PlaytestBudget) => void }) {
  const [minutes, setMinutes] = useState(String(budget.minutes));
  const [tokens, setTokens] = useState(String(budget.tokens));
  useEffect(() => {
    setMinutes(String(budget.minutes));
    setTokens(String(budget.tokens));
  }, [budget.minutes, budget.tokens]);
  const m = Number(minutes);
  const t = Number(tokens.replace(/[,\s_]/g, ""));
  const valid = Number.isInteger(m) && m > 0 && m <= 1440 && Number.isInteger(t) && t > 0 && t <= 1_000_000_000;
  const save = () => {
    if (valid && (m !== budget.minutes || t !== budget.tokens)) onSave({ minutes: m, tokens: t });
  };
  const keys = (e: React.KeyboardEvent) => e.key === "Enter" && save();
  return (
    <fieldset className="playtest-budget">
      <legend>Assign to subagent budget</legend>
      <label className="row">
        <span>Up to</span>
        <input type="number" min={1} max={1440} aria-label="Minutes per loop" className="minutes" value={minutes} onChange={(e) => setMinutes(e.target.value)} onBlur={save} onKeyDown={keys} />
        <span>minutes and</span>
        <input type="text" inputMode="numeric" aria-label="Tokens per loop" className="tokens" value={tokens} onChange={(e) => setTokens(e.target.value)} onBlur={save} onKeyDown={keys} />
        <span>tokens per playtest</span>
      </label>
      {!valid && <p className="banner bad small">Minutes from 1 to 1440, tokens from 1 to 1000000000.</p>}
      <p className="muted small">Assign to subagent runs the playtest, fixes what fails and runs it again until every step passes. It stops and asks for you when it reaches either limit. Tokens count input and output; cached input is not counted.</p>
    </fieldset>
  );
}
