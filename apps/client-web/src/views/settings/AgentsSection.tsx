import { useEffect, useState } from "react";
import { AGENT_CONTEXT_STRATEGIES, CONTEXT_STRATEGY_INFO, EFFORT_NAMES, IMAGE_EDGES, anythingConnected, type AgentContextView, type Effort, type ImageSize, type NativeOverview, type StudioSettings, type UsageSettings } from "@ue-mcp-studio/shared";
import { api } from "../../api";
import { EffortPicker, ModelPicker } from "../ModelPicker";
import { Head, type SettingsSection } from "../SettingsHub";
import { NativePanel } from "./NativePanel";
import { Card, Row, Seg, Switch, tokens, useMessage } from "./controls";

export const IMAGE_SIZES: ReadonlyArray<{ id: ImageSize; name: string }> = [
  { id: "small", name: `Small ${IMAGE_EDGES.small} px` },
  { id: "standard", name: `Standard ${IMAGE_EDGES.standard} px` },
  { id: "full", name: `Full ${IMAGE_EDGES.full} px` },
];

const SAME = "Same as main agent";

/** What the ue-mcp tools row says: what the choice does, and why the strategy in effect differs when it does. */
function contextHelp(v: AgentContextView): string {
  const base = "How ue-mcp actions reach the agent: one search tool (Micro), a tool per category (Lean) or every signature up front (Full). More up front costs tokens on every call and saves discovery calls. Other MCP clients are set in Project.";
  if (!v.projection) return `${base} Only Micro is available until ue-mcp is updated.`;
  return v.note ? `${base} ${v.note}` : base;
}
const STARTS: Record<string, string> = { never: "Never, set by an earlier version", asked: "When you ask", automatic: "When work splits into independent parts" };

/**
 * Agents: the model every chat runs on, and what each vendor's own project
 * files give its models (instructions, subagents and skills), read only.
 */
export function AgentsSection({ onSection }: { onSection: (s: SettingsSection) => void }) {
  const [settings, setSettings] = useState<StudioSettings | null>(null);
  const [native, setNative] = useState<NativeOverview | null>(null);
  const [agentContext, setAgentContext] = useState<AgentContextView | null>(null);
  const msg = useMessage();
  const loadNative = () => api.native().then(setNative, msg.fail);
  useEffect(() => {
    api.settings().then(setSettings, msg.fail);
    void loadNative();
    if (typeof api.agentContext === "function") api.agentContext().then(setAgentContext, () => setAgentContext(null));
  }, []);
  const saveUsage = (u: Partial<UsageSettings>) => api.saveSettings({ usage: u }).then((s) => {
    setSettings(s);
    void loadNative();
  }, msg.fail);
  if (!settings) return <>{msg.node ?? <p className="muted">Loading</p>}</>;
  const anything = anythingConnected(settings);
  return (
    <>
      <Head title="Agents" lead="The chat model, and the project's agent files (read only)." />
      {msg.node}
      <Card label="Main agent">
        <p className="muted small">Same setting as the chat's model picker.</p>
        <div className="cfg-inline">
          <ModelPicker settings={settings} onSettings={setSettings} />
          <EffortPicker settings={settings} onSettings={setSettings} />
        </div>
        {settings.route === null && !anything && (
          <p className="banner warn small" style={{ marginTop: 10 }}>
            No model connected. <button className="link" onClick={() => onSection("models")}>Connect a sign-in or API key</button>.
          </p>
        )}
        {settings.route === null && anything && (
          <p className="banner warn small" style={{ marginTop: 10 }}>
            This model is not connected. <button className="link" onClick={() => onSection("models")}>Connect it</button> or pick another.
          </p>
        )}
        {agentContext && (
          <Row title="ue-mcp tools" help={contextHelp(agentContext)}>
            <Seg
              label="ue-mcp tools"
              value={agentContext.strategy}
              options={AGENT_CONTEXT_STRATEGIES.filter((s) => s !== "auto" || agentContext.measurement).map((s) => ({
                id: s,
                name: s === "auto" ? "Auto" : `${CONTEXT_STRATEGY_INFO[s].name}${agentContext.seeds ? ` ~${tokens(agentContext.seeds[s])}` : ""}`,
                title: s === "auto" ? "Fewest tokens among the strategies with the best measured pass rate" : `${CONTEXT_STRATEGY_INFO[s].sees} ${CONTEXT_STRATEGY_INFO[s].discovery}`,
                disabled: !agentContext.projection && s !== "micro",
              }))}
              onChange={(v) => void api.saveAgentContext(v).then(setAgentContext, msg.fail)}
            />
          </Row>
        )}
        <Row title="Screenshot size" help="Longest side of images shown to agents. Larger costs more tokens.">
          <Seg label="Screenshot size" value={settings.usage.imageSize} options={IMAGE_SIZES} onChange={(v) => void saveUsage({ imageSize: v })} />
        </Row>
      </Card>

      {native && (
        <Card label="Worker">
          <p className="muted small">Studio's built-in subagent. Helpers per turn is set in <button className="link" onClick={() => onSection("usage")}>Usage</button>.</p>
          <dl className="grid">
            <dt>Model</dt><dd>{native.worker.model ? `${native.worker.model} when the main agent runs on ${native.worker.model.split(" ")[0]}, else the main agent's` : SAME}</dd>
            <dt>Effort</dt><dd>{native.worker.effort ? EFFORT_NAMES[native.worker.effort as Effort] ?? native.worker.effort : SAME}</dd>
            <dt>Starts</dt><dd>{STARTS[native.worker.starts]}</dd>
          </dl>
          {native.worker.fromSettings && <p className="cfg-note">Read only, set by an earlier version.</p>}
        </Card>
      )}

      <div className="cfg-block-head">
        <Row inline title="Project agent files" help="Instructions, subagents and skills from the project and your home folder.">
          <Switch label="Read the project's agent files" on={settings.usage.projectInstructions} onChange={(v) => void saveUsage({ projectInstructions: v })} />
        </Row>
      </div>
      {native && settings.usage.projectInstructions && <NativePanel overview={native} onConnect={() => onSection("models")} />}
    </>
  );
}
