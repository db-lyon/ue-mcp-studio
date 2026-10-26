import { useEffect, useState } from "react";
import {
  APPROVAL_ROWS,
  MAX_DIALOG_MINUTES,
  type AgentSettings,
  type ApprovalKind,
  type ApprovalRule,
  type DialogMode,
  type DialogPolicy,
  type FeedbackMode,
  type PlaytestRunsMode,
  type StudioSettings,
} from "@ue-mcp-studio/shared";
import { api } from "../../api";
import { Head } from "../SettingsHub";
import { Card, NumberField, Opt, Row, Seg, Switch, useMessage } from "./controls";


const RULES: ReadonlyArray<{ id: ApprovalRule; name: string }> = [{ id: "ask", name: "Ask" }, { id: "allow", name: "Allow" }];

export const DIALOG_MODES: { id: DialogMode; name: string; about: string }[] = [
  { id: "interactive", name: "Show in Studio", about: "A card in the chat with the dialog's buttons." },
  { id: "auto", name: "Agent answers", about: "An answer that discards work waits 10 seconds for you to override." },
  { id: "defer", name: "Leave in editor", about: "The turn waits until you answer in the editor." },
];

export const FEEDBACK_MODES: { id: FeedbackMode; name: string; about: string }[] = [
  { id: "interactive", name: "Ask", about: "Edit, approve or discard each report in the chat." },
  { id: "auto-approve", name: "File automatically", about: "Reports go straight to GitHub." },
  { id: "defer", name: "Hold", about: "Review later with npx ue-mcp feedback review." },
];

const PLAYTEST_STARTS: ReadonlyArray<{ id: PlaytestRunsMode; name: string; help: string }> = [
  { id: "manual", name: "Manual", help: "Playtests run only when you start or assign them." },
  { id: "automatic", name: "Automatic", help: "Agents start playtests when needed." },
];

type AgentUpdate = Partial<{ feedbackTool: boolean; feedbackMode: FeedbackMode; dialogMode: DialogMode; playtestRuns: PlaytestRunsMode }>;

/**
 * Approvals & review: what waits for the user before an agent acts, and what
 * the user checks after. Global to every agent; each agent's own tools are set
 * in Agents.
 */
export function ApprovalsSection() {
  const [settings, setSettings] = useState<StudioSettings | null>(null);
  const [agent, setAgent] = useState<AgentSettings | null>(null);
  const msg = useMessage();
  useEffect(() => {
    api.settings().then(setSettings, msg.fail);
    api.agentSettings().then(setAgent, msg.fail);
  }, []);
  const save = (u: Parameters<typeof api.saveSettings>[0]) => api.saveSettings(u).then(setSettings, msg.fail);
  const saveAgent = (u: AgentUpdate) =>
    api.saveAgentSettings(u).then((a) => {
      setAgent(a);
      if (a.restarting) msg.ok("Saved. ue-mcp restarts after the current turn.");
      else msg.clear();
    }, msg.fail);
  if (!settings || !agent) return <>{msg.node ?? <p className="muted">Loading</p>}</>;
  const rule = (k: ApprovalKind) => settings.approvals?.[k] ?? (k === "shell" || k === "files" ? (settings.askBeforeChanges ? "ask" : "allow") : "allow");
  const dialogMode = agent.dialogMode?.mode ?? null;
  return (
    <>
      <Head title="Approvals & review" lead="What needs your approval. Applies to every agent." />
      {msg.node}
      <Card label="Ask first">
        {APPROVAL_ROWS.map((r) => {
          const unknown = r.kind === "destructive" && settings.destructiveKnown === false;
          return (
            <Row key={r.kind} title={r.label} help={unknown ? <span className="warn-text">Unavailable. Update ue-mcp to use this rule.</span> : r.help}>
              <Seg label={r.label} value={unknown ? null : rule(r.kind)} options={RULES} disabled={unknown} onChange={(v) => void save({ approvals: { [r.kind]: v } })} />
            </Row>
          );
        })}
        <Row title="Starting playtests" help={PLAYTEST_STARTS.find((p) => p.id === (agent.playtestRuns ?? "manual"))!.help}>
          {agent.playtestRuns
            ? <Seg label="Starting playtests" value={agent.playtestRuns} options={PLAYTEST_STARTS} onChange={(v) => void saveAgent({ playtestRuns: v })} />
            : <span className="dim small">Update Studio to set this.</span>}
        </Row>
        <p className="cfg-note">All other actions run without asking.</p>
      </Card>

      <Card label="Feedback reports">
        <Row inline title="Report ue-mcp gaps" help="Agents file GitHub issues on ue-mcp. Changing this restarts ue-mcp.">
          <Switch label="Report ue-mcp gaps" on={agent.feedbackTool} onChange={(v) => void saveAgent({ feedbackTool: v })} />
        </Row>
        {agent.feedbackTool && (
          <Row title="Filing" help={agent.feedbackMode ? FEEDBACK_MODES.find((f) => f.id === agent.feedbackMode!.mode)?.about : "Update ue-mcp to set this."}>
            {agent.feedbackMode && <Seg label="Filing" value={agent.feedbackMode.mode} options={FEEDBACK_MODES} onChange={(v) => void saveAgent({ feedbackMode: v })} />}
          </Row>
        )}
      </Card>

      <Card label="Editor dialogs">
        <Row title="Who answers" help="Editor calls wait until an open dialog is answered." />
        {agent.dialogMode ? (
          <div className="opts">
            {DIALOG_MODES.map((d) => (
              <div key={d.id}>
                <Opt name="dialog-mode" on={dialogMode === d.id} onPick={() => void saveAgent({ dialogMode: d.id })} title={d.name} desc={d.about} />
                {d.id === "interactive" && (dialogMode === "interactive" || dialogMode === null) && (
                  <DialogPolicyField policy={settings.dialogPolicy} onSave={(dialogPolicy) => void save({ dialogPolicy })} />
                )}
              </div>
            ))}
            {dialogMode === null && <p className="cfg-note">Not set. Studio shows them.</p>}
          </div>
        ) : (
          <p className="cfg-note">Update ue-mcp to set this.</p>
        )}
      </Card>

      <Card label="Turn review">
        <Row inline title="Review each turn" help="Keep or revert each change after a turn. Override per session in Checkpoints. Required to assign playtests.">
          <Switch label="Review each turn" on={settings.reviewTurns !== false} onChange={(v) => void save({ reviewTurns: v })} />
        </Row>
      </Card>
    </>
  );
}

const POLICIES: ReadonlyArray<{ id: DialogPolicy["kind"]; name: string }> = [
  { id: "wait", name: "Keep waiting" },
  { id: "agent", name: "Hand to agent" },
  { id: "safe", name: "Press Cancel or Keep" },
];

/**
 * "If you do not answer in Studio", under Show them to me in Studio, the only
 * mode it applies to: the project's policy for a dialog nobody answers.
 * Studio's own, not shared.
 */
export function DialogPolicyField({ policy, onSave }: { policy: DialogPolicy; onSave: (p: DialogPolicy) => void }) {
  const minutes = policy.kind === "wait" ? 2 : policy.minutes;
  return (
    <div className="field dialog-policy" role="radiogroup" aria-label="If unanswered">
      <span className="flabel">If unanswered</span>
      {POLICIES.map((p) => (
        <label key={p.id} className="cfg-inline small">
          <input type="radio" name="dialog-policy" checked={policy.kind === p.id} aria-label={p.name} onChange={() => onSave(p.id === "wait" ? { kind: "wait" } : { kind: p.id, minutes })} />
          <span>{p.name}</span>
          {p.id !== "wait" && policy.kind === p.id && (
            <span className="nowrap cfg-inline">
              <span className="muted">after</span>
              <NumberField label="Minutes" value={policy.minutes} min={1} max={MAX_DIALOG_MINUTES} onSave={(n) => n !== null && onSave({ kind: p.id as "agent" | "safe", minutes: n })} className="cfg-num minutes" />
              <span className="muted">minutes</span>
            </span>
          )}
        </label>
      ))}
      <span className="help">The window flashes when Studio is not focused. Saved per project.</span>
    </div>
  );
}
