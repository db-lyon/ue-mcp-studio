import { useEffect, useState } from "react";
import {
  EFFORTS,
  EFFORT_NAMES,
  IMAGE_EDGES,
  MAX_SUBAGENTS_PER_TURN,
  type Effort,
  type ImageSize,
  type StudioSettings,
  type SubagentMode,
  type UsageSettings,
} from "@ue-mcp-studio/shared";
import { api } from "../../api";
import { EffortPicker, ModelPicker, useCatalog } from "../ModelPicker";
import { Head, type SettingsSection } from "../SettingsHub";
import { InstructionsPanel } from "./InstructionsPanel";
import { Card, Row, Seg, Switch, useMessage } from "./controls";

export const DELEGATION_MODES: ReadonlyArray<{ id: SubagentMode; name: string; about: string }> = [
  { id: "off", name: "Never", about: "The main agent does all the work itself." },
  { id: "asked", name: "Only when I ask", about: "Helpers start only when you ask for one in the chat." },
  { id: "automatic", name: "Automatic", about: "The main agent splits work with independent parts across helpers running at the same time." },
];

export const IMAGE_SIZES: ReadonlyArray<{ id: ImageSize; name: string }> = [
  { id: "small", name: `Small ${IMAGE_EDGES.small} px` },
  { id: "standard", name: `Standard ${IMAGE_EDGES.standard} px` },
  { id: "full", name: `Full ${IMAGE_EDGES.full} px` },
];

type Tab = "main" | "delegation" | "instructions";

/**
 * Agents: who works on this project, on which model, and what each reads.
 * The main agent is what every new chat talks to; helpers take work it hands over.
 */
export function AgentsSection({ onSection }: { onSection: (s: SettingsSection) => void }) {
  const [settings, setSettings] = useState<StudioSettings | null>(null);
  const [tab, setTab] = useState<Tab>("main");
  const [files, setFiles] = useState<{ on: number; all: number } | null>(null);
  const msg = useMessage();
  useEffect(() => {
    api.settings().then(setSettings, msg.fail);
    api.instructions().then((v) => setFiles({ on: v.files.filter((f) => f.on && !f.sameAs).length, all: v.files.filter((f) => !f.sameAs).length }), () => setFiles(null));
  }, []);
  const saveUsage = (u: Partial<UsageSettings>) => api.saveSettings({ usage: u }).then(setSettings, msg.fail);
  if (!settings) return <>{msg.node ?? <p className="muted">Loading</p>}</>;
  const tabs: Array<{ id: Tab; name: string; count?: number | null }> = [
    { id: "main", name: "Main agent" },
    { id: "delegation", name: "Delegation" },
    { id: "instructions", name: "Instructions", count: files?.all },
  ];
  return (
    <>
      <Head title="Agents" lead="Who works on this project: the main agent every chat talks to, the helpers it hands work to, and the instructions they all read." />
      {msg.node}
      <nav className="subtabs" aria-label="Agents">
        {tabs.map((t) => (
          <button key={t.id} className={`subtab ${tab === t.id ? "active" : ""}`} aria-current={tab === t.id ? "page" : undefined} onClick={() => setTab(t.id)}>
            {t.name}{t.count ? <span className="count">{t.count}</span> : null}
          </button>
        ))}
      </nav>
      {tab === "main" && <MainAgent settings={settings} onSettings={setSettings} saveUsage={saveUsage} onSection={onSection} onInstructions={() => setTab("instructions")} files={files} />}
      {tab === "delegation" && <Delegation settings={settings} saveUsage={saveUsage} />}
      {tab === "instructions" && <InstructionsPanel agents={[{ id: "main", name: "Main agent" }, { id: "playtest-runner", name: "Playtest runner" }]} />}
    </>
  );
}

function MainAgent({ settings, onSettings, saveUsage, onSection, onInstructions, files }: {
  files: { on: number; all: number } | null;
  settings: StudioSettings;
  onSettings: (s: StudioSettings) => void;
  saveUsage: (u: Partial<UsageSettings>) => void;
  onSection: (s: SettingsSection) => void;
  onInstructions: () => void;
}) {
  const usage = settings.usage;
  return (
    <>
      <Card label="Model">
        <p className="muted small">The model every new chat runs on, and how long it reasons. The chat's own picker changes it for that session.</p>
        <div className="cfg-inline">
          <ModelPicker settings={settings} onSettings={onSettings} />
          <EffortPicker settings={settings} onSettings={onSettings} />
        </div>
        {settings.route === null && !Object.values(settings.connected ?? {}).some(Boolean) && (
          <p className="banner warn small" style={{ marginTop: 10 }}>
            No model can run on this machine yet. <button className="link" onClick={() => onSection("models")}>Connect a sign-in or an API key</button> for any vendor, then pick its model here.
          </p>
        )}
        {settings.route === null && Object.values(settings.connected ?? {}).some(Boolean) && (
          <p className="banner warn small" style={{ marginTop: 10 }}>
            Nothing on this machine can run this model yet. <button className="link" onClick={() => onSection("models")}>Connect it in Models & accounts</button>.
          </p>
        )}
      </Card>
      <Card label="What it reads and sees">
        <Row inline title="Read the project's instruction files" help={<>{files ? `${files.on} of ${files.all} files are on. ` : ""}<button className="link" onClick={onInstructions}>Turn files on or off in Instructions</button></>}>
          <Switch label="Read the project's instruction files" on={usage.projectInstructions} onChange={(v) => saveUsage({ projectInstructions: v })} />
        </Row>
        <Row title="Screenshot size" help="The longest side of a screenshot or picture an agent is shown. A larger image costs more every time the conversation is read again.">
          <Seg label="Screenshot size" value={usage.imageSize} options={IMAGE_SIZES} onChange={(v) => saveUsage({ imageSize: v })} />
        </Row>
      </Card>
      <p className="cfg-note">The main agent's per-turn budget is in <button className="link" onClick={() => onSection("usage")}>Usage</button>; what it may do without asking is in <button className="link" onClick={() => onSection("approvals")}>Approvals & review</button>.</p>
    </>
  );
}

function Delegation({ settings, saveUsage }: { settings: StudioSettings; saveUsage: (u: Partial<UsageSettings>) => void }) {
  const usage = settings.usage;
  const catalog = useCatalog(settings);
  const vendor = catalog?.providers.find((p) => p.id === settings.provider);
  const off = usage.subagents === "off";
  const sameVendor = usage.subagentModel?.provider === settings.provider ? usage.subagentModel.model : "";
  return (
    <>
      <Card label="When the main agent hands work over">
        <Seg label="When the main agent hands work over" value={usage.subagents} options={DELEGATION_MODES} onChange={(v) => saveUsage({ subagents: v })} />
        <p className="muted small" style={{ marginTop: 8 }}>{DELEGATION_MODES.find((d) => d.id === usage.subagents)!.about} Each helper starts with a context of its own, so helpers change usage the most.</p>
      </Card>
      <Card label="Helper">
        <Row title="Model" help="Helpers run on the main agent's sign-in or key, so they take a model of its vendor.">
          <select aria-label="Helper model" disabled={off} value={sameVendor} onChange={(e) => saveUsage({ subagentModel: e.target.value ? { provider: settings.provider, model: e.target.value } : null })}>
            <option value="">Same as the main agent</option>
            {(vendor?.models ?? []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </Row>
        <Row title="Effort">
          <select aria-label="Helper effort" disabled={off} value={usage.subagentEffort ?? ""} onChange={(e) => saveUsage({ subagentEffort: (e.target.value || null) as Effort | null })}>
            <option value="">Same as the main agent</option>
            {EFFORTS.map((x) => <option key={x} value={x}>{EFFORT_NAMES[x]}</option>)}
          </select>
        </Row>
        <Row title="Helpers per turn" help="Past this, the main agent is told to do the work itself.">
          <select aria-label="Helpers per turn" disabled={off} value={usage.subagentsPerTurn} onChange={(e) => saveUsage({ subagentsPerTurn: Number(e.target.value) })}>
            {Array.from({ length: MAX_SUBAGENTS_PER_TURN }, (_, i) => i + 1).map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </Row>
      </Card>
    </>
  );
}
