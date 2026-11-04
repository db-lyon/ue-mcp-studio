/**
 * Approvals & review as a paired browser shows it (client-web
 * views/settings/ApprovalsSection.tsx): the ask-first rules and the dialog
 * policy read only, since they decide what runs on the computer without
 * asking; playtest starts, feedback reports, who answers editor dialogs and
 * turn review still change.
 */
import { useEffect, useState } from "react";
import { View } from "react-native";
import { APPROVAL_ROWS, PROJECT_SCOPED_KINDS, type AgentSettings, type ApprovalKind, type ApprovalRule, type DialogMode, type DialogPolicy, type FeedbackMode, type PlaytestRunsMode, type StudioSettings } from "@ue-mcp-studio/shared";
import { Card, font, T, useTheme } from "../../ui";
import { CardLabel, Head, Opt, Radio, Seg, SettingRow, Switch, Txt, useMessage } from "./controls";
import { Message } from "./GeneralSection";
import { ReadOnly } from "./ModelsSection";
import { useSettingsApi } from "./hooks";

const RULES: ReadonlyArray<{ id: ApprovalRule; name: string }> = [{ id: "ask", name: "Ask" }, { id: "allow", name: "Allow" }];
const SCOPED_RULES: ReadonlyArray<{ id: ApprovalRule; name: string }> = [
  { id: "ask", name: "Ask" },
  { id: "project", name: "In project" },
  { id: "allow", name: "Anywhere" },
];

const DIALOG_MODES: { id: DialogMode; name: string; about: string }[] = [
  { id: "interactive", name: "Show in Studio", about: "A card in the chat with the dialog's buttons." },
  { id: "auto", name: "Agent answers", about: "An answer that discards work waits 10 seconds for you to override." },
  { id: "defer", name: "Leave in editor", about: "The turn waits until you answer in the editor." },
];

const FEEDBACK_MODES: { id: FeedbackMode; name: string; about: string }[] = [
  { id: "interactive", name: "Ask", about: "Edit, approve or discard each report in the chat." },
  { id: "auto-approve", name: "File automatically", about: "Reports go straight to GitHub." },
  { id: "defer", name: "Hold", about: "Review later with npx ue-mcp feedback review." },
];

const PLAYTEST_STARTS: ReadonlyArray<{ id: PlaytestRunsMode; name: string; help: string }> = [
  { id: "manual", name: "Manual", help: "Playtests run only when you start or assign them." },
  { id: "automatic", name: "Automatic", help: "Agents start playtests when needed." },
];

const POLICIES: ReadonlyArray<{ id: DialogPolicy["kind"]; name: string }> = [
  { id: "wait", name: "Keep waiting" },
  { id: "agent", name: "Hand to agent" },
  { id: "safe", name: "Press Cancel or Keep" },
];

type AgentUpdate = Partial<{ feedbackTool: boolean; feedbackMode: FeedbackMode; dialogMode: DialogMode; playtestRuns: PlaytestRunsMode }>;

export function ApprovalsSection() {
  const api = useSettingsApi();
  const t = useTheme();
  const [settings, setSettings] = useState<StudioSettings | null>(null);
  const [agent, setAgent] = useState<AgentSettings | null>(null);
  const msg = useMessage();
  useEffect(() => {
    api.settings().then(setSettings, msg.fail);
    api.agentSettings().then(setAgent, msg.fail);
  }, [api]);
  const save = (u: Parameters<typeof api.saveSettings>[0]) => api.saveSettings(u).then(setSettings, msg.fail);
  const saveAgent = (u: AgentUpdate) =>
    api.saveAgentSettings(u).then((a) => {
      setAgent(a);
      if (a.restarting) msg.ok("Saved. ue-mcp restarts after the current turn.");
      else msg.clear();
    }, msg.fail);
  if (!settings || !agent) return msg.message ? <Message msg={msg} /> : <Txt tone="muted" style={{ marginVertical: t.base.size }}>Loading</Txt>;
  const rule = (k: ApprovalKind) => settings.approvals?.[k] ?? (k === "shell" || k === "files" ? (settings.askBeforeChanges ? "ask" : "allow") : "allow");
  const dialogMode = agent.dialogMode.mode;
  return (
    <>
      <Head title="Approvals & review" lead="What needs your approval. Applies to every agent." />
      <Message msg={msg} />
      <Card>
        <CardLabel>Ask first</CardLabel>
        <ReadOnly>
          <View>
            {APPROVAL_ROWS.map((r) => (
              <SettingRow key={r.kind} title={r.label} help={r.help}>
                <Seg label={r.label} value={rule(r.kind)} options={PROJECT_SCOPED_KINDS.includes(r.kind) ? SCOPED_RULES : RULES} onChange={() => undefined} disabled />
              </SettingRow>
            ))}
          </View>
        </ReadOnly>
        <SettingRow title="Starting playtests" help={PLAYTEST_STARTS.find((p) => p.id === agent.playtestRuns)?.help}>
          <Seg label="Starting playtests" value={agent.playtestRuns} options={PLAYTEST_STARTS} onChange={(v) => void saveAgent({ playtestRuns: v })} />
        </SettingRow>
        <Txt size={12} tone="dim" style={{ marginVertical: 12 }}>
          All other actions run without asking.
        </Txt>
      </Card>

      <Card>
        <CardLabel>Feedback reports</CardLabel>
        <SettingRow inline first title="Report ue-mcp gaps" help="Agents file GitHub issues on ue-mcp. Changing this restarts ue-mcp.">
          <Switch label="Report ue-mcp gaps" on={agent.feedbackTool} onChange={(v) => void saveAgent({ feedbackTool: v })} />
        </SettingRow>
        {agent.feedbackTool ? (
          <SettingRow title="Filing" help={FEEDBACK_MODES.find((f) => f.id === agent.feedbackMode.mode)?.about}>
            <Seg label="Filing" value={agent.feedbackMode.mode} options={FEEDBACK_MODES} onChange={(v) => void saveAgent({ feedbackMode: v })} />
          </SettingRow>
        ) : null}
      </Card>

      <Card>
        <CardLabel>Editor dialogs</CardLabel>
        <SettingRow first title="Who answers" help="Editor calls wait until an open dialog is answered." />
        <View style={{ gap: 6 }}>
          {DIALOG_MODES.map((d) => (
            <View key={d.id}>
              <Opt label={d.name} on={dialogMode === d.id} onPick={() => void saveAgent({ dialogMode: d.id })} title={d.name} desc={d.about} />
              {d.id === "interactive" && (dialogMode === "interactive" || dialogMode === null) ? (
                <ReadOnly>
                  <DialogPolicyField policy={settings.dialogPolicy} />
                </ReadOnly>
              ) : null}
            </View>
          ))}
          {dialogMode === null ? <Txt size={12} tone="dim">Not set. Studio shows them.</Txt> : null}
        </View>
      </Card>

      <Card>
        <CardLabel>Turn review</CardLabel>
        <SettingRow inline first title="Review each turn" help="Keep or revert each change after a turn. Override per session in Checkpoints. Required to assign playtests.">
          <Switch label="Review each turn" on={settings.reviewTurns !== false} onChange={(v) => void save({ reviewTurns: v })} />
        </SettingRow>
      </Card>
    </>
  );
}

/**
 * "If unanswered", under Show in Studio: the project's policy for a dialog
 * nobody answers, read only here. A .field's labels are 600 12px/1.3, the
 * chosen timed policy's minutes on the line under its name.
 */
function DialogPolicyField({ policy }: { policy: DialogPolicy }) {
  const t = useTheme();
  const label = [font(t, "sans", 600, 12, 1.3), { color: t.c.text }];
  return (
    // Its 8px top margin and the note's 8px bottom margin collapse into one, as they do in the page's fieldset.
    <View accessibilityRole="radiogroup" accessibilityLabel="If unanswered" style={{ gap: 6, marginTop: 0, marginBottom: 4, marginLeft: 30, paddingLeft: 12, borderLeftWidth: 2, borderLeftColor: t.c.lineStrong }}>
      <T style={label}>If unanswered</T>
      {POLICIES.map((p) => (
        <View key={p.id} accessibilityRole="radio" accessibilityLabel={p.name} accessibilityState={{ checked: policy.kind === p.id, disabled: true }} style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", alignContent: "stretch", columnGap: 8, rowGap: 8, minHeight: 44, marginRight: 14 }}>
          <Radio on={policy.kind === p.id} disabled />
          <T style={label}>{p.name}</T>
          {p.id !== "wait" && policy.kind === p.id ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <T style={[label, { color: t.c.muted }]}>after</T>
              <View style={{ width: 72, minHeight: 44, justifyContent: "center", paddingVertical: 6, paddingHorizontal: 10, borderWidth: 1, borderColor: t.c.lineStrong, borderRadius: t.radius, backgroundColor: t.c.panel2 }}>
                <T style={[font(t, "sans", 600, 16, 1.3), { color: t.c.text }]}>{policy.minutes}</T>
              </View>
              <T style={[label, { color: t.c.muted }]}>minutes</T>
            </View>
          ) : null}
        </View>
      ))}
      <Txt size={12} tone="dim">
        The window flashes when Studio is not focused. Saved per project.
      </Txt>
    </View>
  );
}
