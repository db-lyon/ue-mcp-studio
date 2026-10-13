import { UpdatesCard } from "./Updates";
import { useEffect, useState } from "react";
import { KEY_PROVIDER_IDS, MAX_DIALOG_MINUTES, OFFERED_SIGN_INS, PROVIDERS, STUDIO_PLAN_AVAILABLE, type DialogPolicy, type ProviderId, type StudioSettings, type StudioTheme } from "@ue-mcp-studio/shared";
import { api, ApiError } from "../api";
import { EffortPicker, KeyForm, ModelPicker, SignInForm } from "./ModelPicker";

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
      <UpdatesCard />
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
        <p className="muted">The model new turns run on, and how long it reasons. The chat input has the same pickers.</p>
        <div className="row">
          <ModelPicker settings={settings} onSettings={apply} />
          <EffortPicker settings={settings} onSettings={apply} />
        </div>
      </section>
      <section className="card">
        <h2>Sign-ins</h2>
        <p className="muted">Sign in to run models without an API key.</p>
        {message && <div className={`banner ${message.ok ? "ok" : "bad"}`}>{message.text}</div>}
        <div className="providers">
          {OFFERED_SIGN_INS.map((p) => (
            <ProviderRow key={p} provider={p} settings={settings} onChange={refresh} onError={(text) => setMessage({ ok: false, text })} />
          ))}
        </div>
        {STUDIO_PLAN_AVAILABLE && (
          <details className="advanced">
            <summary className="muted small">Advanced</summary>
            <div className="row">
              <span className="muted">Studio gateway</span>
              <input value={gatewayUrl} onChange={(e) => setGatewayUrl(e.target.value)} />
              <button onClick={() => save()}>Save</button>
            </div>
          </details>
        )}
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
  const signIn = provider === "studio" || provider === "claude" || provider === "chatgpt";
  const status = provider === "claude" || provider === "chatgpt"
    ? connected ? "Signed in" : "Not signed in"
    : signIn
      ? settings.account ? `Signed in as @${settings.account.login}` : "Not signed in"
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

/** "When an editor dialog needs an answer": the project's policy for a dialog nobody answers. */
export function DialogPolicyField({ policy, onSave }: { policy: DialogPolicy; onSave: (p: DialogPolicy) => void }) {
  const [minutes, setMinutes] = useState(policy.kind === "wait" ? "2" : String(policy.minutes));
  useEffect(() => {
    if (policy.kind !== "wait") setMinutes(String(policy.minutes));
  }, [policy]);
  const n = Number(minutes);
  const valid = Number.isFinite(n) && n > 0 && n <= MAX_DIALOG_MINUTES;
  const pick = (kind: DialogPolicy["kind"]) => onSave(kind === "wait" ? { kind } : { kind, minutes: valid ? n : 2 });
  const saveMinutes = () => {
    if (policy.kind !== "wait" && valid && n !== policy.minutes) onSave({ kind: policy.kind, minutes: n });
  };
  return (
    <fieldset className="dialog-policy">
      <legend>When an editor dialog needs an answer</legend>
      <label className="row toggle">
        <input type="radio" name="dialog-policy" checked={policy.kind === "wait"} onChange={() => pick("wait")} />
        <span>Ask me and wait</span>
      </label>
      <label className="row toggle">
        <input type="radio" name="dialog-policy" checked={policy.kind === "agent"} onChange={() => pick("agent")} />
        <span>Ask me, then let the agent decide</span>
      </label>
      <label className="row toggle">
        <input type="radio" name="dialog-policy" checked={policy.kind === "safe"} onChange={() => pick("safe")} />
        <span>Ask me, then press the safe default (Cancel or Keep)</span>
      </label>
      {policy.kind !== "wait" && (
        <label className="row">
          <span>after</span>
          <input
            type="number"
            min={1}
            max={MAX_DIALOG_MINUTES}
            aria-label="Minutes"
            className="minutes"
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            onBlur={saveMinutes}
            onKeyDown={(e) => e.key === "Enter" && saveMinutes()}
          />
          <span>minutes</span>
        </label>
      )}
      <p className="muted small">A dialog in the editor stops every call until it is answered. It shows in the chat with its buttons, and the window flashes when you are elsewhere. When the agent answers dialogs itself (dialog mode auto), an answer that discards work, such as Don't Save, waits 10 seconds so you can override it. Saved for this project.</p>
    </fieldset>
  );
}
