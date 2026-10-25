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
import { api } from "../api";
import { useCatalog } from "./ModelPicker";

const SUBAGENT_MODES: { id: SubagentMode; name: string; about: string }[] = [
  { id: "off", name: "Off", about: "The agent does all the work itself." },
  { id: "asked", name: "When I ask", about: "The agent starts subagents only when you ask for them." },
  { id: "automatic", name: "When the work splits", about: "The agent splits work that has independent parts across subagents running at the same time." },
];

const IMAGE_SIZES: { id: ImageSize; name: string }[] = [
  { id: "small", name: "Small" },
  { id: "standard", name: "Standard" },
  { id: "full", name: "Full" },
];

/** The fewest tokens the turn limit takes, matching the agent's check. */
const MIN_LIMIT = 10_000;

/**
 * Settings > Agent > Usage: what a turn may spend. Each subagent starts with
 * a context of its own, so subagents are the setting that changes usage most.
 */
export function UsageCard({ settings, onSettings, onError }: { settings: StudioSettings; onSettings: (s: StudioSettings) => void; onError: (e: Error) => void }) {
  const usage = settings.usage;
  const catalog = useCatalog(settings);
  const save = (u: Partial<UsageSettings>) => api.saveSettings({ usage: u }).then(onSettings, onError);

  const [limit, setLimit] = useState(usage.turnTokenLimit === null ? "" : String(usage.turnTokenLimit));
  useEffect(() => setLimit(usage.turnTokenLimit === null ? "" : String(usage.turnTokenLimit)), [usage.turnTokenLimit]);
  const typed = limit.replace(/[,\s_]/g, "");
  const n = Number(typed);
  const limitValid = typed === "" || (Number.isInteger(n) && n >= MIN_LIMIT && n <= 1_000_000_000);
  const saveLimit = () => {
    const next = typed === "" ? null : n;
    if (limitValid && next !== usage.turnTokenLimit) void save({ turnTokenLimit: next });
  };

  // Subagents run on the main model's sign-in or key, so they can take any model of its vendor.
  const vendor = catalog?.providers.find((p) => p.id === settings.provider);
  const sameVendor = usage.subagentModel?.provider === settings.provider ? usage.subagentModel.model : "";
  const off = usage.subagents === "off";

  return (
    <section className="card usage-card">
      <h2>Usage</h2>
      <p className="muted small">What a turn may spend. Each subagent starts with a context of its own and reads its tools again, so subagents change usage the most.</p>

      <fieldset>
        <legend>Subagents</legend>
        {SUBAGENT_MODES.map((m) => (
          <label key={m.id} className="row toggle">
            <input type="radio" name="subagents" checked={usage.subagents === m.id} onChange={() => void save({ subagents: m.id })} />
            <span>{m.name}</span>
            <span className="muted small">{m.about}</span>
          </label>
        ))}
      </fieldset>

      <div className="row wrap">
        <label className="row">
          <span>Subagent model</span>
          <select
            aria-label="Subagent model"
            disabled={off}
            value={sameVendor}
            onChange={(e) => void save({ subagentModel: e.target.value ? { provider: settings.provider, model: e.target.value } : null })}
          >
            <option value="">Same as the chat</option>
            {(vendor?.models ?? []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </label>
        <label className="row">
          <span>Subagent effort</span>
          <select
            aria-label="Subagent effort"
            disabled={off}
            value={usage.subagentEffort ?? ""}
            onChange={(e) => void save({ subagentEffort: (e.target.value || null) as Effort | null })}
          >
            <option value="">Same as the chat</option>
            {EFFORTS.map((x) => <option key={x} value={x}>{EFFORT_NAMES[x]}</option>)}
          </select>
        </label>
        <label className="row">
          <span>At most</span>
          <select
            aria-label="Subagents per turn"
            disabled={off}
            value={usage.subagentsPerTurn}
            onChange={(e) => void save({ subagentsPerTurn: Number(e.target.value) })}
          >
            {Array.from({ length: MAX_SUBAGENTS_PER_TURN }, (_, i) => i + 1).map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
          <span>per turn</span>
        </label>
      </div>
      <p className="muted small">A cheaper model or a lower effort for subagents saves the most when they are on. Past the per-turn limit the agent does the work itself.</p>

      <label className="row toggle">
        <input type="checkbox" checked={usage.projectInstructions} onChange={(e) => void save({ projectInstructions: e.target.checked })} />
        <span>Give the agent the project's CLAUDE.md</span>
      </label>
      <p className="muted small">On: CLAUDE.md, .claude/CLAUDE.md and CLAUDE.local.md in the project folder go into the agent's instructions, as in a terminal client, so it does not have to search for what they say.</p>

      <fieldset>
        <legend>Image size</legend>
        <div className="row">
          {IMAGE_SIZES.map((s) => (
            <label key={s.id} className="row toggle">
              <input type="radio" name="image-size" checked={usage.imageSize === s.id} onChange={() => void save({ imageSize: s.id })} />
              <span>{s.name} ({IMAGE_EDGES[s.id]} px)</span>
            </label>
          ))}
        </div>
        <p className="muted small">The longest side of a screenshot or picture the agent is shown. A larger image costs more tokens every time the conversation is read again.</p>
      </fieldset>

      <label className="row">
        <span>Stop a turn after</span>
        <input type="text" inputMode="numeric" aria-label="Turn token limit" className="tokens" placeholder="no limit" value={limit} onChange={(e) => setLimit(e.target.value)} onBlur={saveLimit} onKeyDown={(e) => e.key === "Enter" && saveLimit()} />
        <span>tokens</span>
      </label>
      {!limitValid && <p className="banner bad small">Leave it empty for no limit, or give a whole number from {MIN_LIMIT.toLocaleString()} to 1,000,000,000.</p>}
      <p className="muted small">Counts input and output tokens of the turn and its subagents; cache writes count, cache reads do not. Each turn ends with a line saying what it spent.</p>
    </section>
  );
}
