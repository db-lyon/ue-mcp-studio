import { useEffect, useState } from "react";
import type { CustomEndpoint, CustomEndpointInput, EndpointModel } from "@ue-mcp-studio/shared";
import { api } from "../../api";
import { Card } from "./controls";

/** The price columns an endpoint model offers: what an OpenAI-compatible server bills. Cache writes are not billed there. */
const RATES = [
  { id: "input", name: "Input" },
  { id: "cacheRead", name: "Cached read" },
  { id: "output", name: "Output" },
] as const;
type RateId = (typeof RATES)[number]["id"];

interface DraftModel {
  id: string;
  typed: boolean;
  rates: Record<RateId, string>;
}

const rateText = (v: number | null | undefined): string => (v === null || v === undefined ? "" : String(v));
const draftOf = (m: EndpointModel): DraftModel => ({ id: m.id, typed: !!m.typed, rates: { input: rateText(m.perMTok?.input), cacheRead: rateText(m.perMTok?.cacheRead), output: rateText(m.perMTok?.output) } });
const rateOf = (v: string): number | null => (v.trim() === "" ? null : Number(v));

/** A model's draft as the agent takes it: a price only when some rate is set. */
function modelOf(d: DraftModel): EndpointModel {
  const perMTok = { input: rateOf(d.rates.input), cacheRead: rateOf(d.rates.cacheRead), cacheWrite: null, output: rateOf(d.rates.output) };
  return { id: d.id, ...(d.typed ? { typed: true } : {}), ...(Object.values(perMTok).some((v) => v !== null) ? { perMTok } : {}) };
}

/**
 * Custom endpoints: any server that speaks OpenAI's Chat Completions, local
 * or hosted. Each one's models join the picker under its name.
 */
export function EndpointsCard({ onChange }: { onChange: () => void }) {
  const [list, setList] = useState<CustomEndpoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = () => api.endpoints().then((r) => {
    setList(r.endpoints);
    setError(null);
  }, (e: Error) => setError(e.message));
  useEffect(() => void load(), []);
  const changed = () => {
    setEditing(null);
    void load();
    onChange();
  };
  const refresh = (id: string) => {
    setBusy(id);
    api.listEndpointModels(id).then(() => {
      setBusy(null);
      changed();
    }, (e: Error) => {
      setBusy(null);
      setError(e.message);
    });
  };
  const remove = (e: CustomEndpoint) => {
    if (!window.confirm(`Remove ${e.name}? Its key is deleted from this machine.`)) return;
    api.removeEndpoint(e.id).then(changed, (x: Error) => setError(x.message));
  };
  return (
    <Card label="Custom endpoints" actions={list && editing !== "new" ? <button className="small-button" onClick={() => setEditing("new")}>Add endpoint</button> : undefined}>
      <p className="cfg-note">Any server that speaks OpenAI's Chat Completions API, on this machine or hosted. Its models run on it directly and read AGENTS.md and .agents/skills. Endpoints and their keys serve every project.</p>
      {error && <div className="banner bad small" role="alert">{error}</div>}
      {!list && !error && <p className="muted small">Loading endpoints</p>}
      {list && list.length === 0 && editing !== "new" && <p className="muted small endpoint-empty">No endpoints yet.</p>}
      {list?.map((e) => editing === e.id ? (
        <EndpointForm key={e.id} endpoint={e} onSaved={changed} onCancel={() => setEditing(null)} />
      ) : (
        <div key={e.id} className="toggle-row inline endpoint-row">
          <span className={`dot ${e.listError ? "warn" : e.models.length ? "ok" : ""}`} style={{ marginTop: 6 }} />
          <div className="grow">
            <div className="t"><strong>{e.name}</strong> <span className="muted small">{e.models.length === 1 ? "1 model" : `${e.models.length} models`}, {e.hasKey ? "key saved" : "no key"}</span></div>
            <div className="path dim">{e.baseUrl}</div>
            {e.listError && <div className="small endpoint-warn">Could not read its models: {e.listError}. {e.models.length ? "The ones below stay." : "Type them in Edit instead."}</div>}
            {e.models.length > 0 && <div className="endpoint-models">{e.models.map((m) => <span key={m.id} className="tag" title={m.perMTok ? "Priced by you" : "No price: Usage shows no cost for it"}>{m.id}{m.perMTok ? " $" : ""}</span>)}</div>}
          </div>
          <div className="endpoint-actions">
            <button className="small-button" disabled={busy === e.id} onClick={() => refresh(e.id)}>{busy === e.id ? "Reading" : "Read models"}</button>
            <button className="small-button" onClick={() => setEditing(e.id)}>Edit</button>
            <button className="small-button" onClick={() => remove(e)}>Remove</button>
          </div>
        </div>
      ))}
      {editing === "new" && <EndpointForm onSaved={changed} onCancel={() => setEditing(null)} />}
    </Card>
  );
}

/** Add an endpoint, or change one: its name, address, key, the models it runs and what each costs. */
export function EndpointForm({ endpoint, onSaved, onCancel }: { endpoint?: CustomEndpoint; onSaved: () => void; onCancel: () => void }) {
  const [name, setName] = useState(endpoint?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(endpoint?.baseUrl ?? "");
  const [key, setKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [models, setModels] = useState<DraftModel[]>(endpoint?.models.map(draftOf) ?? []);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const addModel = () => {
    const id = typed.trim();
    if (!id || models.some((m) => m.id === id)) return setTyped("");
    setModels([...models, { id, typed: true, rates: { input: "", cacheRead: "", output: "" } }]);
    setTyped("");
  };
  const save = () => {
    const input: CustomEndpointInput = { name: name.trim(), baseUrl: baseUrl.trim(), models: models.map(modelOf) };
    if (key.trim()) input.key = key.trim();
    else if (clearKey) input.key = "";
    setSaving(true);
    (endpoint ? api.saveEndpoint(endpoint.id, input) : api.addEndpoint(input)).then(() => {
      setSaving(false);
      onSaved();
    }, (e: Error) => {
      setSaving(false);
      setError(e.message);
    });
  };
  const setRate = (i: number, id: RateId, v: string) => setModels(models.map((m, j) => (j === i ? { ...m, rates: { ...m.rates, [id]: v } } : m)));
  return (
    <div className="endpoint-form" role="group" aria-label={endpoint ? `Edit ${endpoint.name}` : "Add an endpoint"}>
      {error && <div className="banner bad small" role="alert">{error}</div>}
      <div className="endpoint-fields">
        <div className="field">
          <label htmlFor="ep-name">Name</label>
          <input id="ep-name" value={name} placeholder="Local Ollama" onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="ep-url">Base URL</label>
          <input id="ep-url" className="mono" value={baseUrl} placeholder="http://localhost:11434/v1" onChange={(e) => setBaseUrl(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="ep-key">API key <span className="dim">(optional)</span></label>
          <input id="ep-key" type="password" value={key} placeholder={endpoint?.hasKey ? "Saved; type to replace" : "None"} disabled={clearKey} onChange={(e) => setKey(e.target.value)} />
          {endpoint?.hasKey && (
            <label className="small muted endpoint-check"><input type="checkbox" checked={clearKey} onChange={(e) => setClearKey(e.target.checked)} /> Remove the saved key</label>
          )}
        </div>
      </div>
      <div className="field">
        <span className="flabel">Models</span>
        <span className="help">{endpoint ? "Read from its /models; type any it does not list." : "Read from its /models when you add it; type any it does not list."} A price, in dollars per million tokens, lets Usage estimate cost; without one it shows none.</span>
        {models.length > 0 && (
          <div className="scroll-x">
            <table className="cfg-table blocks endpoint-prices">
              <thead><tr><th>Model</th>{RATES.map((r) => <th key={r.id}>{r.name}</th>)}<th /></tr></thead>
              <tbody>
                {models.map((m, i) => (
                  <tr key={m.id}>
                    <td><span className="mono small">{m.id}</span> {!m.typed && <span className="dim small">listed</span>}</td>
                    {RATES.map((r) => (
                      <td key={r.id} data-label={r.name}>
                        <input className="num" inputMode="decimal" aria-label={`${m.id} ${r.name.toLowerCase()} per million tokens`} placeholder="none" value={m.rates[r.id]} onChange={(e) => setRate(i, r.id, e.target.value)} />
                      </td>
                    ))}
                    <td className="r">{m.typed && <button className="small-button" onClick={() => setModels(models.filter((_, j) => j !== i))}>Remove</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="row endpoint-add-model">
          <input aria-label="Model id" placeholder="Model id, as the endpoint names it" value={typed} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addModel()} />
          <button disabled={!typed.trim()} onClick={addModel}>Add model</button>
        </div>
      </div>
      <div className="row endpoint-buttons">
        <button className="primary" disabled={saving || !name.trim() || !baseUrl.trim()} onClick={save}>{saving ? "Saving" : endpoint ? "Save" : "Add endpoint"}</button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
