import { useEffect, useState } from "react";
import type { ProviderKind, StudioSettings, StudioTheme } from "@ue-mcp-studio/shared";
import { api, ApiError } from "../api";

const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-haiku-5-5"];

const THEMES: { id: StudioTheme; name: string; about: string }[] = [
  { id: "ue-mcp", name: "ue-mcp", about: "Dark, with the ue-mcp.com orange." },
  { id: "light", name: "Light", about: "The same look on a light background." },
  { id: "editor", name: "Editor", about: "Unreal's own colors and type, so the panel blends in." },
];

export function SettingsView({ onTheme }: { onTheme: (t: StudioTheme) => void }) {
  const [settings, setSettings] = useState<StudioSettings | null>(null);
  const [provider, setProvider] = useState<ProviderKind>("byok");
  const [model, setModel] = useState("");
  const [gatewayUrl, setGatewayUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [token, setToken] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const apply = (s: StudioSettings) => {
    setSettings(s);
    setProvider(s.provider);
    setModel(s.model);
    setGatewayUrl(s.gatewayUrl);
  };

  useEffect(() => {
    api.settings().then(apply, (e: Error) => setMessage({ ok: false, text: e.message }));
  }, []);

  const save = (extra: { apiKey?: string; accountToken?: string } = {}) => {
    api.saveSettings({ provider, model, gatewayUrl, ...extra }).then((s) => {
      apply(s);
      setApiKey("");
      setToken("");
      setMessage({ ok: true, text: "Saved." });
    }, (e: ApiError) => setMessage({ ok: false, text: e.message }));
  };

  // A theme applies as soon as it is picked; saving it is separate from the model form.
  const pickTheme = (theme: StudioTheme) => {
    onTheme(theme);
    api.saveSettings({ theme }).then(apply, (e: ApiError) => setMessage({ ok: false, text: e.message }));
  };

  if (!settings) return message ? <div className="banner bad">{message.text}</div> : <p className="muted">Loading...</p>;
  return (
    <div className="stack">
      <section className="card">
        <h2>Appearance</h2>
        <div className="themes">
          {THEMES.map((t) => (
            <button key={t.id} className={`theme-option ${settings.theme === t.id ? "selected" : ""}`} onClick={() => pickTheme(t.id)}>
              <span className={`swatch swatch-${t.id}`}><i /><i /><i /></span>
              <strong>{t.name}</strong>
              <span className="muted small">{t.about}</span>
            </button>
          ))}
        </div>
      </section>
      <section className="card">
        <h2>Model</h2>
        {message && <div className={`banner ${message.ok ? "ok" : "bad"}`}>{message.text}</div>}
        <div className="row">
          <label><input type="radio" checked={provider === "byok"} onChange={() => setProvider("byok")} /> My Anthropic API key</label>
          <label><input type="radio" checked={provider === "gateway"} onChange={() => setProvider("gateway")} /> UE-MCP hosted model</label>
        </div>
        <div className="row">
          <span className="muted">Model</span>
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            {[...new Set([model, ...MODELS])].map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
        <div className="actions"><button className="primary" onClick={() => save()}>Save</button></div>
      </section>
      {provider === "byok" ? (
        <section className="card">
          <h2>Anthropic API key</h2>
          <p className="muted">{settings.hasApiKey ? "A key is saved. It stays on this machine and is never shown again." : "No key saved."}</p>
          <div className="row">
            <input type="password" placeholder="sk-ant-..." value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
            <button className="primary" disabled={!apiKey.trim()} onClick={() => save({ apiKey })}>Save key</button>
            {settings.hasApiKey && <button onClick={() => save({ apiKey: "" })}>Remove key</button>}
          </div>
        </section>
      ) : (
        <section className="card">
          <h2>UE-MCP account</h2>
          <p className="muted">{settings.hasAccountToken ? "Signed in." : "Not signed in. Paste the token from your account page."}</p>
          <div className="row">
            <input type="password" placeholder="Account token" value={token} onChange={(e) => setToken(e.target.value)} />
            <button className="primary" disabled={!token.trim()} onClick={() => save({ accountToken: token })}>Save token</button>
            {settings.hasAccountToken && <button onClick={() => save({ accountToken: "" })}>Sign out</button>}
          </div>
          <div className="row">
            <span className="muted">Gateway</span>
            <input value={gatewayUrl} onChange={(e) => setGatewayUrl(e.target.value)} />
          </div>
        </section>
      )}
    </div>
  );
}
