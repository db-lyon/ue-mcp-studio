/**
 * Agents (client-web views/settings/AgentsSection.tsx): the chat model and
 * effort, the screenshot size, Studio's worker, and the project's agent files.
 * A paired client may change all of these.
 */
import { useEffect, useState } from "react";
import { View } from "react-native";
import { notThere, type SettingsSection } from "@ue-mcp-studio/client-core";
import { IMAGE_EDGES, MAX_SUBAGENTS_PER_TURN, UNLIMITED_SUBAGENTS, anythingConnected, type ImageSize, type KeyProviderId, type NativeOverview, type StudioSettings, type SubagentMode, type UsageSettings } from "@ue-mcp-studio/shared";
import { Banner, Card, bannerText, useTheme } from "../../ui";
import { CardLabel, Head, NumberField, Seg, SettingRow, Switch, Txt, useMessage } from "./controls";
import { Message } from "./GeneralSection";
import { EffortPicker, ModelPicker } from "./Pickers";
import { NativePanel } from "./NativePanel";
import { useSettingsApi } from "./hooks";

export const IMAGE_SIZES: ReadonlyArray<{ id: ImageSize; name: string }> = [
  { id: "small", name: `Small ${IMAGE_EDGES.small} px` },
  { id: "standard", name: `Standard ${IMAGE_EDGES.standard} px` },
  { id: "full", name: `Full ${IMAGE_EDGES.full} px` },
];

const SAME = "Same as main agent";
const CONCURRENCY_HELP = "Maximum number of active workers allowed at one time. Additional workers are queued. Use -1 for no limit.";

const STARTS: ReadonlyArray<{ id: SubagentMode; name: string }> = [
  { id: "off", name: "Never" },
  { id: "asked", name: "When you ask" },
  { id: "automatic", name: "When work splits into independent parts" },
];

export function AgentsSection({ onSection }: { onSection: (s: SettingsSection) => void }) {
  const api = useSettingsApi();
  const t = useTheme();
  const [settings, setSettings] = useState<StudioSettings | null>(null);
  const [native, setNative] = useState<NativeOverview | null>(null);
  const msg = useMessage();
  const loadNative = () => api.native().then(setNative, (e: Error) => (notThere(e) ? setNative(null) : msg.fail(e)));
  useEffect(() => {
    api.settings().then(setSettings, msg.fail);
    void loadNative();
  }, [api]);
  const saveUsage = (u: Partial<UsageSettings>) =>
    api.saveSettings({ usage: u }).then((s) => {
      setSettings(s);
      void loadNative();
    }, msg.fail);
  if (!settings) return msg.message ? <Message msg={msg} /> : <Txt tone="muted" style={{ marginVertical: t.base.size }}>Loading</Txt>;
  const anything = anythingConnected(settings);
  const workerOff = settings.usage.subagents === "off";
  return (
    <>
      <Head title="Agents" lead="The chat model, and the project's agent files (read only)." />
      <Message msg={msg} />
      <Card>
        <CardLabel>Main agent</CardLabel>
        <Txt size={12} tone="muted" style={{ marginBottom: 12 }}>
          Same setting as the chat's model picker.
        </Txt>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <ModelPicker settings={settings} onSettings={setSettings} />
          <EffortPicker settings={settings} onSettings={setSettings} />
        </View>
        {settings.route === null ? (
          <Banner kind="warn" style={{ marginTop: 10 }}>
            <Txt size={12} style={{ color: bannerText(t, "warn") }}>
              {anything ? "This model is not connected. " : "No model connected. "}
              <Txt size={12} tone="accentHi" onPress={() => onSection("models")}>
                {anything ? "Connect it" : "Connect a sign-in or API key"}
              </Txt>
              {anything ? " or pick another." : "."}
            </Txt>
          </Banner>
        ) : null}
        <SettingRow title="Screenshot size" help="Longest side of images shown to agents. Larger costs more tokens.">
          <Seg label="Screenshot size" value={settings.usage.imageSize} options={IMAGE_SIZES} onChange={(v) => void saveUsage({ imageSize: v })} />
        </SettingRow>
      </Card>

      <Card>
        <CardLabel>Worker</CardLabel>
        <Txt size={12} tone="muted" style={{ marginBottom: 12 }}>
          Studio's built-in subagent. It runs on the main agent's sign-in or key.
        </Txt>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <ModelPicker
            settings={settings}
            onSettings={setSettings}
            disabled={workerOff}
            follow={{
              label: "Worker model",
              same: SAME,
              value: settings.usage.subagentModel?.provider === settings.provider ? settings.usage.subagentModel.model : null,
              onPick: (model) => saveUsage({ subagentModel: model ? { provider: settings.provider as KeyProviderId, model } : null }),
            }}
          />
          <EffortPicker settings={settings} onSettings={setSettings} disabled={workerOff} follow={{ label: "Worker effort", same: SAME, value: settings.usage.subagentEffort, onPick: (effort) => saveUsage({ subagentEffort: effort }) }} />
        </View>
        <SettingRow title="Starts" help="Never: the agent starts no workers, including subagents defined in the project's agent files.">
          <Seg label="Worker starts" value={settings.usage.subagents} options={STARTS} onChange={(v) => void saveUsage({ subagents: v })} />
        </SettingRow>
        <SettingRow inline field={settings.usage.subagentsPerTurn !== UNLIMITED_SUBAGENTS} title="Concurrency" help={CONCURRENCY_HELP}>
          {settings.usage.subagentsPerTurn === UNLIMITED_SUBAGENTS ? (
            <Txt size={12} tone="muted" style={{ alignSelf: "center" }}>
              No limit
            </Txt>
          ) : null}
          <NumberField label="Concurrency" value={settings.usage.subagentsPerTurn} min={1} max={MAX_SUBAGENTS_PER_TURN} extra={UNLIMITED_SUBAGENTS} disabled={workerOff} onSave={(n) => n !== null && void saveUsage({ subagentsPerTurn: n })} />
        </SettingRow>
      </Card>

      <View style={{ marginTop: 22, marginBottom: 6, paddingTop: 14, borderTopWidth: 1, borderTopColor: t.c.line }}>
        <SettingRow inline first title="Project agent files" help="Instructions, subagents and skills from the project and your home folder." style={{ paddingVertical: 0 }}>
          <Switch label="Read the project's agent files" on={settings.usage.projectInstructions} onChange={(v) => void saveUsage({ projectInstructions: v })} />
        </SettingRow>
      </View>
      {native && settings.usage.projectInstructions ? <NativePanel overview={native} onConnect={() => onSection("models")} /> : null}
    </>
  );
}
