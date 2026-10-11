import { useEffect, useState } from "react";
import { KEY_PROVIDER_IDS, PROVIDERS, SIGN_IN_IDS, type ProviderId, type StudioSettings, type StudioTheme } from "@ue-mcp-studio/shared";
import { api, ApiError } from "../api";
import { KeyForm, ModelPicker, SignInForm } from "./ModelPicker";

const THEMES: { id: StudioTheme; name: string; about: string }[] = [
  { id: "ue-mcp", name: "ue-mcp", about: "Dark, with the ue-mcp.com orange." },
  { id: "light", name: "Light", about: "The same look on a light background." },
  { id: "editor", name: "Editor", about: "Unreal's own colors and type, so the panel blends in." },
];

export function SettingsView({ onTheme }: { onTheme: (t: StudioTheme) => void }) {
  const [settings, setSettings] = useState<StudioSettings | null>(null);
  const [gatewayUrl, setGatewayUrl] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const apply = (s: StudioSettings) => {
    setSettings(s);
    setGatewayUrl(s.gatewayUrl);
  };

  useEffect(() => {
    api.settings().then(apply, (e: Error) => setMessage({ ok: false, text: e.message }));
  }, []);

  const save = () => {
    api.saveSettings({ gatewayUrl }).then((s) => {
      apply(s);
      setMessage({ ok: true, text: "Saved." });
    }, (e: ApiError) => setMessage({ ok: false, text: e.message }));
  };

  // A theme applies as soon as it is picked; saving it is separate from the model form.
  const pickTheme = (theme: StudioTheme) => {
    onTheme(theme);
    api.saveSettings({ theme }).then(apply, (e: ApiError) => setMessage({ ok: false, text: e.message }));
  };

  const refresh = () => void api.settings().then(apply);

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
        <p className="muted">The model new turns run on. The chat input has the same picker.</p>
        <ModelPicker settings={settings} onSettings={apply} />
      </section>
      <section className="card">
        <h2>Sign-ins</h2>
        <p className="muted">Sign in to run models without an API key.</p>
        {message && <div className={`banner ${message.ok ? "ok" : "bad"}`}>{message.text}</div>}
        <div className="providers">
          {SIGN_IN_IDS.map((p) => (
            <ProviderRow key={p} provider={p} settings={settings} onChange={refresh} onError={(text) => setMessage({ ok: false, text })} />
          ))}
        </div>
        <details className="advanced">
          <summary className="muted small">Advanced</summary>
          <div className="row">
            <span className="muted">Studio gateway</span>
            <input value={gatewayUrl} onChange={(e) => setGatewayUrl(e.target.value)} />
            <button onClick={() => save()}>Save</button>
          </div>
        </details>
      </section>
      <section className="card">
        <h2>API keys</h2>
        <p className="muted">Optional. A model runs on your key only when no sign-in above runs it.</p>
        <div className="providers">
          {KEY_PROVIDER_IDS.map((p) => (
            <ProviderRow key={p} provider={p} settings={settings} onChange={refresh} onError={(text) => setMessage({ ok: false, text })} />
          ))}
        </div>
      </section>
    </div>
  );
}

function ProviderRow({ provider, settings, onChange, onError }: {
  provider: ProviderId;
  settings: StudioSettings;
  onChange: () => void;
  onError: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const connected = settings.connected[provider];
  const signIn = provider === "studio" || provider === "openrouter";
  const status = provider === "studio"
    ? settings.account ? `Signed in as @${settings.account.login}` : "Not signed in"
    : provider === "openrouter"
      ? connected ? "Signed in" : "Not signed in"
      : connected ? "Key saved on this machine" : "No key";
  const disconnect = () =>
    api.saveSettings(signIn ? { signOut: provider } : { keys: { [provider]: "" } }).then(onChange, (e: Error) => onError(e.message));
  return (
    <div className="provider-row">
      <div className="row">
        <strong>{PROVIDERS[provider].name}</strong>
        <span className={`dot ${connected ? "ok" : ""}`} />
        <span className="muted small">{status}</span>
        <span className="spacer" />
        {connected && provider === "studio" && settings.account?.via === "ue-mcp-login" ? (
          <span className="dim small">from ue-mcp login</span>
        ) : connected ? (
          <button onClick={() => void disconnect()}>{signIn ? "Sign out" : "Remove key"}</button>
        ) : signIn ? null : (
          <button onClick={() => setOpen(!open)}>{open ? "Cancel" : "Add key"}</button>
        )}
      </div>
      {signIn && !connected && <SignInForm id={provider} onDone={onChange} />}
      {!signIn && open && !connected && <KeyForm provider={provider} onSaved={() => { setOpen(false); onChange(); }} />}
    </div>
  );
}
