import { useEffect, useRef, useState } from "react";
import { PROVIDERS, type KeyProviderId, type ModelCatalog, type ProviderId, type StudioSettings, type StudioSignIn } from "@ue-mcp-studio/shared";
import { api } from "../api";

/** The selected model's display name, from the catalog when it is loaded. */
function nameOf(catalog: ModelCatalog | null, provider: ProviderId, model: string): string {
  return catalog?.providers.find((p) => p.id === provider)?.models.find((m) => m.id === model)?.name ?? model;
}

/**
 * The model picker: every provider's models in one list. Picking a model from
 * a provider that is not connected asks for the sign-in or key right there,
 * then selects the model.
 */
export function ModelPicker({
  settings,
  onSettings,
  up = false,
}: {
  settings: StudioSettings;
  onSettings: (s: StudioSettings) => void;
  /** Open above the button, for the composer at the bottom of the panel. */
  up?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [connecting, setConnecting] = useState<{ provider: ProviderId; model: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const load = () => api.models().then(setCatalog, (e: Error) => setError(e.message));
  useEffect(() => void load(), [settings.connected]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) {
        setOpen(false);
        setConnecting(null);
      }
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const select = (provider: ProviderId, model: string) =>
    api.saveSettings({ provider, model }).then((s) => {
      onSettings(s);
      setOpen(false);
      setConnecting(null);
    }, (e: Error) => setError(e.message));

  const pick = (provider: ProviderId, model: string) => {
    if (settings.connected[provider]) void select(provider, model);
    else setConnecting({ provider, model });
  };

  return (
    <div className="picker" ref={box}>
      <button className="picker-button" onClick={() => setOpen(!open)} title="Model">
        <span className="picker-provider">{PROVIDERS[settings.provider].name}</span>
        <span>{nameOf(catalog, settings.provider, settings.model)}</span>
        <span className="picker-caret" aria-hidden>{"▾"}</span>
      </button>
      {open && (
        <div className={`picker-menu ${up ? "up" : ""}`} role="listbox">
          {error && <div className="banner bad small" onClick={() => setError(null)}>{error}</div>}
          {connecting ? (
            <div className="picker-connect">
              <div className="row">
                <button className="ghost" onClick={() => setConnecting(null)}>{"‹"} Models</button>
              </div>
              <p className="small">
                <strong>{nameOf(catalog, connecting.provider, connecting.model)}</strong>{" "}
                <span className="muted">needs {connecting.provider === "studio" ? "a Studio sign-in" : `your ${PROVIDERS[connecting.provider].name} API key`}.</span>
              </p>
              <ConnectProvider
                provider={connecting.provider}
                onConnected={() => void select(connecting.provider, connecting.model)}
              />
            </div>
          ) : (
            (catalog?.providers ?? []).map((p) => (
              <div key={p.id} className="picker-group">
                <div className="picker-group-head">
                  <span className="eyebrow">{p.name}</span>
                  <span className={`picker-status ${p.connected ? "on" : ""}`}>
                    {p.connected ? (p.id === "studio" ? "signed in" : "key saved") : p.id === "studio" ? "sign in" : "add key"}
                  </span>
                </div>
                {p.models.map((m) => {
                  const current = settings.provider === p.id && settings.model === m.id;
                  return (
                    <button
                      key={m.id}
                      role="option"
                      aria-selected={current}
                      className={`picker-item ${current ? "current" : ""} ${p.connected ? "" : "locked"}`}
                      onClick={() => pick(p.id, m.id)}
                    >
                      <span>{m.name}</span>
                      {m.name !== m.id && <span className="dim mono small">{m.id}</span>}
                    </button>
                  );
                })}
              </div>
            ))
          )}
          {!catalog && !error && <p className="muted small">Loading models</p>}
        </div>
      )}
    </div>
  );
}

/** Connect one provider: the Studio sign-in, or a key field for the others. */
export function ConnectProvider({ provider, onConnected }: { provider: ProviderId; onConnected: () => void }) {
  return provider === "studio" ? <StudioSignInForm onDone={onConnected} /> : <KeyForm provider={provider} onSaved={onConnected} />;
}

function KeyForm({ provider, onSaved }: { provider: KeyProviderId; onSaved: () => void }) {
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const info = PROVIDERS[provider];
  const save = () => api.saveSettings({ keys: { [provider]: key.trim() } }).then(() => {
    setKey("");
    onSaved();
  }, (e: Error) => setError(e.message));
  return (
    <div className="connect">
      {error && <div className="banner bad small">{error}</div>}
      <div className="row">
        <input
          type="password"
          autoFocus
          placeholder={info.keyPlaceholder}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && key.trim() && void save()}
        />
        <button className="primary" disabled={!key.trim()} onClick={() => void save()}>Save key</button>
      </div>
      <p className="dim small">
        The key stays on this machine. Get one at <a href={info.keyUrl} target="_blank" rel="noreferrer">{new URL(info.keyUrl!).host}</a>.
      </p>
    </div>
  );
}

function StudioSignInForm({ onDone }: { onDone: () => void }) {
  const [state, setState] = useState<StudioSignIn | null>(null);
  const done = useRef(false);

  useEffect(() => {
    // A finished sign-in from before means a sign-out since, when this form is showing.
    api.signIn().then((s) => setState(s.state === "done" ? { state: "idle" } : s), () => setState({ state: "idle" }));
  }, []);

  // Follow a pending sign-in until GitHub approves it.
  useEffect(() => {
    if (state?.state !== "pending") return;
    const t = setInterval(() => api.signIn().then(setState, () => {}), 2000);
    return () => clearInterval(t);
  }, [state?.state]);

  useEffect(() => {
    if (state?.state === "done" && !done.current) {
      done.current = true;
      onDone();
    }
  }, [state]);

  const start = () => api.startSignIn().then((s) => {
    setState(s);
    if (s.state === "pending") window.open(s.verificationUri, "_blank");
  }, (e: Error) => setState({ state: "error", error: e.message }));

  if (!state) return <p className="muted small">Checking sign-in</p>;
  if (state.state === "pending") {
    return (
      <div className="connect">
        <p className="small muted">Enter this code on GitHub to sign in to Studio:</p>
        <div className="row">
          <span className="signin-code mono">{state.userCode}</span>
          <button onClick={() => void navigator.clipboard?.writeText(state.userCode)}>Copy</button>
          <a href={state.verificationUri} target="_blank" rel="noreferrer"><button className="primary">Open GitHub</button></a>
        </div>
        <p className="dim small">Waiting for approval. <button className="ghost small-button" onClick={() => void api.cancelSignIn().then(() => setState({ state: "idle" }))}>Cancel</button></p>
      </div>
    );
  }
  if (state.state === "done") return <p className="small">Signed in as @{state.login}.</p>;
  return (
    <div className="connect">
      {state.state === "error" && <div className="banner bad small">{state.error}</div>}
      <div className="row">
        <button className="primary" onClick={() => void start()}>Sign in to Studio</button>
      </div>
      <p className="dim small">Signs in with your GitHub account. Models run on your Studio plan, no API key needed.</p>
    </div>
  );
}
