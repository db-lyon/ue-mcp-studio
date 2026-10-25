import { useEffect, useState } from "react";
import { EFFORT_NAMES, IMAGE_EDGES, type Effort, type ImageSize, type NativeOverview, type StudioSettings, type UsageSettings } from "@ue-mcp-studio/shared";
import { api } from "../../api";
import { EffortPicker, ModelPicker } from "../ModelPicker";
import { Head, type SettingsSection } from "../SettingsHub";
import { NativePanel } from "./NativePanel";
import { Card, Row, Seg, Switch, useMessage } from "./controls";

export const IMAGE_SIZES: ReadonlyArray<{ id: ImageSize; name: string }> = [
  { id: "small", name: `Small ${IMAGE_EDGES.small} px` },
  { id: "standard", name: `Standard ${IMAGE_EDGES.standard} px` },
  { id: "full", name: `Full ${IMAGE_EDGES.full} px` },
];

const SAME = "Same as the main agent";
const STARTS: Record<string, string> = { never: "never: earlier settings turned it off", asked: "when you ask for a helper", automatic: "when the work splits into independent parts" };

/**
 * Agents: the model every chat runs on, and what each vendor's own project
 * files give its models (instructions, subagents and skills), read only.
 */
export function AgentsSection({ onSection }: { onSection: (s: SettingsSection) => void }) {
  const [settings, setSettings] = useState<StudioSettings | null>(null);
  const [native, setNative] = useState<NativeOverview | null>(null);
  const msg = useMessage();
  const loadNative = () => api.native().then(setNative, msg.fail);
  useEffect(() => {
    api.settings().then(setSettings, msg.fail);
    void loadNative();
  }, []);
  const saveUsage = (u: Partial<UsageSettings>) => api.saveSettings({ usage: u }).then((s) => {
    setSettings(s);
    void loadNative();
  }, msg.fail);
  if (!settings) return <>{msg.node ?? <p className="muted">Loading</p>}</>;
  const anything = Object.values(settings.connected ?? {}).some(Boolean);
  return (
    <>
      <Head title="Agents" lead="The model every chat runs on, and what the project's own agent files give it. Studio reads each vendor's files as that vendor's tools read them, and writes none of them." />
      {msg.node}
      <Card label="Main agent">
        <p className="muted small">New turns run on this model. The chat's picker changes the same setting.</p>
        <div className="cfg-inline">
          <ModelPicker settings={settings} onSettings={setSettings} />
          <EffortPicker settings={settings} onSettings={setSettings} />
        </div>
        {settings.route === null && !anything && (
          <p className="banner warn small" style={{ marginTop: 10 }}>
            No model can run on this machine yet. <button className="link" onClick={() => onSection("models")}>Connect a sign-in or an API key</button> for any vendor, then pick its model here.
          </p>
        )}
        {settings.route === null && anything && (
          <p className="banner warn small" style={{ marginTop: 10 }}>
            Nothing on this machine can run this model yet. <button className="link" onClick={() => onSection("models")}>Connect it in Models & accounts</button>, or pick a model that runs.
          </p>
        )}
        <Row title="Screenshot size" help="The longest side of a screenshot or picture an agent is shown. A larger image costs more every time the conversation is read again.">
          <Seg label="Screenshot size" value={settings.usage.imageSize} options={IMAGE_SIZES} onChange={(v) => void saveUsage({ imageSize: v })} />
        </Row>
      </Card>

      {native && (
        <Card label="Studio's worker">
          <p className="muted small">Studio's worker and the project's subagents are the agent's helpers. The worker is the one Studio adds for work that splits into independent parts. How many helpers a turn may start is in <button className="link" onClick={() => onSection("usage")}>Usage</button>.</p>
          <dl className="grid">
            <dt>Model</dt><dd>{native.worker.model ?? SAME}</dd>
            <dt>Effort</dt><dd>{native.worker.effort ? EFFORT_NAMES[native.worker.effort as Effort] ?? native.worker.effort : SAME}</dd>
            <dt>Starts</dt><dd>{STARTS[native.worker.starts]}</dd>
          </dl>
          {native.worker.fromSettings && <p className="cfg-note">Set in an earlier Studio and kept. Read only.</p>}
        </Card>
      )}

      <div className="cfg-block-head">
        <Row inline title="Read the project's own files" help="Instructions, subagents and skills from each vendor's own files in the project and your home folder, read as that vendor's tools read them. Off: no route reads any of them.">
          <Switch label="Read the project's agent files" on={settings.usage.projectInstructions} onChange={(v) => void saveUsage({ projectInstructions: v })} />
        </Row>
      </div>
      {native && settings.usage.projectInstructions && <NativePanel overview={native} onConnect={() => onSection("models")} />}
      {native && !settings.usage.projectInstructions && <p className="cfg-note">Off: agents are given none of the project's own files.</p>}
    </>
  );
}
