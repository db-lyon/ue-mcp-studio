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
import { Card, NumberField, Opt, Row, Seg, Shared, Switch, useMessage } from "./controls";


const RULES: ReadonlyArray<{ id: ApprovalRule; name: string }> = [{ id: "ask", name: "Ask" }, { id: "allow", name: "Allow" }];

export const DIALOG_MODES: { id: DialogMode; name: string; about: string }[] = [
  { id: "interactive", name: "Show them to me in Studio", about: "Each dialog is a card in the chat with its buttons." },
  { id: "auto", name: "Let the agent answer", about: "An answer that discards work waits 10 seconds so you can override it." },
  { id: "defer", name: "Leave them in the editor", about: "Nothing is pressed; the turn waits until you answer in the editor." },
];

export const FEEDBACK_MODES: { id: FeedbackMode; name: string; about: string }[] = [
  { id: "interactive", name: "Ask me", about: "Each report is a card in the chat to edit, approve or discard." },
  { id: "auto-approve", name: "File without asking", about: "Reports go straight to GitHub." },
  { id: "defer", name: "Keep for review", about: "Reports wait on this machine for npx ue-mcp feedback review." },
];

const PLAYTEST_STARTS: ReadonlyArray<{ id: PlaytestRunsMode; name: string; help: string }> = [
  { id: "manual", name: "Manual", help: "A playtest runs only when you start it, or assign it to a helper, from its card." },
  { id: "automatic", name: "Automatic", help: "Agents start playtests themselves when the work calls for one." },
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
      if (a.restarting) msg.ok("Saved. ue-mcp restarts to load it, after the turn in progress.");
      else msg.clear();
    }, msg.fail);
  if (!settings || !agent) return <>{msg.node ?? <p className="muted">Loading</p>}</>;
  const rule = (k: ApprovalKind) => settings.approvals?.[k] ?? (k === "shell" || k === "files" ? (settings.askBeforeChanges ? "ask" : "allow") : "allow");
  const dialogMode = agent.dialogMode?.mode ?? null;
  return (
    <>
      <Head title="Approvals & review" lead="What waits for you before an agent acts, and what you check after. It applies to every agent; each agent's own tools are set in Agents." />
      {msg.node}
      <Card label="Before it acts">
        {APPROVAL_ROWS.map((r) => {
          const unknown = r.kind === "destructive" && settings.destructiveKnown === false;
          return (
            <Row key={r.kind} title={r.label} help={unknown ? "This ue-mcp does not say which actions delete or overwrite, so none ask. Update ue-mcp to use this row." : r.help}>
              <Seg label={r.label} value={rule(r.kind)} options={RULES} disabled={unknown} onChange={(v) => void save({ approvals: { [r.kind]: v } })} />
            </Row>
          );
        })}
        <Row title="Starting playtests" help={PLAYTEST_STARTS.find((p) => p.id === (agent.playtestRuns ?? "manual"))!.help}>
          {agent.playtestRuns
            ? <Seg label="Starting playtests" value={agent.playtestRuns} options={PLAYTEST_STARTS} onChange={(v) => void saveAgent({ playtestRuns: v })} />
            : <span className="dim small">Update Studio to choose this.</span>}
        </Row>
        <p className="cfg-note">Reading files, searching the web and every other ue-mcp action never ask.</p>
      </Card>

      <Card label="Feedback reports">
        <Row inline title="Agents can report gaps in ue-mcp's tools" badge={<Shared />} help="Filed as GitHub issues on ue-mcp. Changing this restarts ue-mcp after the turn in progress.">
          <Switch label="Agents can report gaps in ue-mcp's tools" on={agent.feedbackTool} onChange={(v) => void saveAgent({ feedbackTool: v })} />
        </Row>
        {agent.feedbackTool && (
          <Row title="Before a report is filed" badge={<Shared />} help={agent.feedbackMode ? FEEDBACK_MODES.find((f) => f.id === agent.feedbackMode!.mode)?.about : "Update ue-mcp to choose this from Studio."}>
            {agent.feedbackMode && <Seg label="Before a report is filed" value={agent.feedbackMode.mode} options={FEEDBACK_MODES} onChange={(v) => void saveAgent({ feedbackMode: v })} />}
          </Row>
        )}
      </Card>

      <Card label="Editor dialogs">
        <Row title="Who answers a dialog an agent's call opens" badge={<Shared />} help="A dialog in the editor stops every call until it is answered." />
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
            {dialogMode === null && <p className="cfg-note">Not set: each client decides. Studio shows them to you.</p>}
          </div>
        ) : (
          <p className="cfg-note">Update ue-mcp to choose this from Studio.</p>
        )}
      </Card>

      <Card label="After it acts">
        <Row inline title="Review each turn" help="Studio takes a checkpoint before and after each turn and lists what it changed, so you can keep or revert each file. A session's Checkpoints panel can turn it off for that session. Assigning a playtest to a helper needs it on.">
          <Switch label="Review each turn" on={settings.reviewTurns !== false} onChange={(v) => void save({ reviewTurns: v })} />
        </Row>
      </Card>
    </>
  );
}

const POLICIES: ReadonlyArray<{ id: DialogPolicy["kind"]; name: string }> = [
  { id: "wait", name: "Keep waiting for me" },
  { id: "agent", name: "Let the agent decide" },
  { id: "safe", name: "Press the safe default, Cancel or Keep" },
];

/**
 * "If you do not answer in Studio", under Show them to me in Studio, the only
 * mode it applies to: the project's policy for a dialog nobody answers.
 * Studio's own, not shared.
 */
export function DialogPolicyField({ policy, onSave }: { policy: DialogPolicy; onSave: (p: DialogPolicy) => void }) {
  const minutes = policy.kind === "wait" ? 2 : policy.minutes;
  return (
    <div className="field dialog-policy" role="radiogroup" aria-label="If you do not answer in Studio">
      <span className="flabel">If you do not answer in Studio</span>
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
      <span className="help">The dialog shows in the chat with its buttons, and the window flashes when you are elsewhere. Saved for this project.</span>
    </div>
  );
}
