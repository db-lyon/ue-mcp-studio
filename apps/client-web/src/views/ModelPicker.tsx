import { useEffect, useRef, useState } from "react";
import {
  EFFORTS,
  EFFORT_NAMES,
  PROVIDERS,
  type Effort,
  type KeyProviderId,
  type ModelCatalog,
  type ModelOption,
  type SignInId,
  type StudioSettings,
  type StudioSignIn,
} from "@ue-mcp-studio/shared";
import { api } from "../api";

type Catalog = ModelCatalog;
type Vendor = Catalog["providers"][number];

/** How a model would run now: the first finished sign-in that runs it, else the vendor key, else nothing. */
export function runsVia(catalog: Catalog, vendor: Vendor, m: ModelOption): SignInId | "key" | null {
  return m.signIns.find((s) => catalog.signedIn[s]) ?? (vendor.connected ? "key" : null);
}

const VIA_LABEL: Record<SignInId | "key", string> = { chatgpt: "ChatGPT plan", claude: "Claude plan", studio: "Studio plan", key: "your key" };

function find(catalog: Catalog | null, vendor: KeyProviderId, model: string): { vendor: Vendor; model: ModelOption } | null {
  const v = catalog?.providers.find((p) => p.id === vendor);
  const m = v?.models.find((x) => x.id === model);
  return v && m ? { vendor: v, model: m } : null;
}

export function useCatalog(settings: StudioSettings | null): Catalog | null {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  useEffect(() => {
    if (settings) api.models().then(setCatalog, () => setCatalog(null));
  }, [settings?.connected, settings?.provider, settings?.model]);
  return catalog;
}

/**
 * The model picker: every model once, under its vendor. Picking one that
 * nothing connected can run asks to sign in right there (a key is the
 * fallback), then selects it.
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
  const catalog = useCatalog(settings);
  const [connecting, setConnecting] = useState<{ vendor: KeyProviderId; model: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

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

  const select = (vendor: KeyProviderId, model: string) =>
    api.saveSettings({ provider: vendor, model }).then((s) => {
      onSettings(s);
      setOpen(false);
      setConnecting(null);
    }, (e: Error) => setError(e.message));

  const current = find(catalog, settings.provider, settings.model);
  const via = settings.route;

  return (
    <div className="picker" ref={box}>
      <button className="picker-button" onClick={() => setOpen(!open)} title="Model">
        <span>{current?.model.name ?? settings.model}</span>
        {via && <span className="picker-via">{via === "key" ? `${PROVIDERS[settings.provider].name} key` : VIA_LABEL[via]}</span>}
        <span className="picker-caret" aria-hidden>{"▾"}</span>
      </button>
      {open && (
        <div className={`picker-menu ${up ? "up" : ""}`} role="listbox">
          {error && <div className="banner bad small" onClick={() => setError(null)}>{error}</div>}
          {connecting && catalog ? (
            <div className="picker-connect">
              <button className="ghost" onClick={() => setConnecting(null)}>{"‹"} Models</button>
              <ConnectModel
                catalog={catalog}
                vendor={connecting.vendor}
                model={connecting.model}
                onConnected={() => void select(connecting.vendor, connecting.model)}
              />
            </div>
          ) : (
            (catalog?.providers ?? []).map((p) => (
              <div key={p.id} className="picker-group">
                <div className="picker-group-head">
                  <span className="eyebrow">{p.name}</span>
                </div>
                {p.models.map((m) => {
                  const selected = settings.provider === p.id && settings.model === m.id;
                  const runs = runsVia(catalog!, p, m);
                  return (
                    <button
                      key={m.id}
                      role="option"
                      aria-selected={selected}
                      className={`picker-item ${selected ? "current" : ""} ${runs ? "" : "locked"}`}
                      onClick={() => (runs ? void select(p.id, m.id) : setConnecting({ vendor: p.id, model: m.id }))}
                    >
                      <span>{m.name}</span>
                      <span className={`picker-via ${runs ? "" : "off"}`}>{runs ? VIA_LABEL[runs] : m.signIns.length ? "sign in" : "connect"}</span>
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

/**
 * Connect something that runs this model: each sign-in that can, first one
 * foremost, and the vendor's API key as the fallback.
 */
export function ConnectModel({ catalog, vendor, model, onConnected }: {
  catalog: Catalog;
  vendor: KeyProviderId;
  model: string;
  onConnected: () => void;
}) {
  const found = find(catalog, vendor, model);
  const signIns = found?.model.signIns ?? [];
  const name = found?.model.name ?? model;
  return (
    <div className="connect">
      <p className="small"><strong>{name}</strong></p>
      {signIns.map((s, i) => <SignInForm key={s} id={s} primary={i === 0} onDone={onConnected} />)}
      {signIns.length > 0 ? (
        <details className="key-fallback">
          <summary className="dim small">Use your own {PROVIDERS[vendor].name} API key instead</summary>
          <KeyForm provider={vendor} onSaved={onConnected} />
        </details>
      ) : (
        <>
          <p className="dim small">Connect {PROVIDERS[vendor].name} with an API key.</p>
          <KeyForm provider={vendor} onSaved={onConnected} />
        </>
      )}
    </div>
  );
}

export function KeyForm({ provider, onSaved }: { provider: KeyProviderId; onSaved: () => void }) {
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
          placeholder={info.keyPlaceholder}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && key.trim() && void save()}
        />
        <button disabled={!key.trim()} onClick={() => void save()}>Save key</button>
      </div>
      <p className="dim small">
        The key stays on this machine. Get one at <a href={info.keyUrl} target="_blank" rel="noreferrer">{new URL(info.keyUrl!).host}</a>.
      </p>
    </div>
  );
}

const SIGN_IN_ABOUT: Record<SignInId, string> = {
  chatgpt: "With your ChatGPT account. OpenAI models run on your ChatGPT plan's limits.",
  claude: "Runs Claude models on your Claude plan's limits through the Claude Agent SDK, with the login you made in Claude Code.",
  studio: "With your GitHub account. Runs the models in your Studio plan.",
};

export function SignInForm(props: { id: SignInId; primary?: boolean; onDone: () => void }) {
  return props.id === "claude" ? <ClaudeCodeLogin onDone={props.onDone} /> : <AppSignIn {...props} />;
}

/**
 * Claude has no sign-in in Studio: the user signs in with Claude Code in a
 * terminal, and this follows until Studio sees the login.
 */
function ClaudeCodeLogin({ onDone }: { onDone: () => void }) {
  const [state, setState] = useState<StudioSignIn | null>(null);
  const done = useRef(false);

  useEffect(() => {
    const check = () => api.signIn("claude").then(setState, () => {});
    void check();
    const t = setInterval(check, 2000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (state?.state === "done" && !done.current) {
      done.current = true;
      onDone();
    }
  }, [state]);

  if (!state) return null;
  if (state.state === "done") return <p className="small">Signed in to Claude.</p>;
  return (
    <div className="connect signin">
      <p className="small">Sign in with Claude Code: run <code className="mono">claude /login</code> in a terminal. Studio picks up the login on its own.</p>
      {state.state === "idle" && state.terminal && <TerminalSignIn command={state.terminal} lead="No Claude Code? Run Claude's login from Studio's copy in" />}
      <p className="dim small">{SIGN_IN_ABOUT.claude}</p>
    </div>
  );
}

/** One sign-in: a button, then the page to approve on, until it finishes. */
function AppSignIn({ id, primary = true, onDone }: { id: SignInId; primary?: boolean; onDone: () => void }) {
  const [state, setState] = useState<StudioSignIn | null>(null);
  const done = useRef(false);

  useEffect(() => {
    // A finished sign-in from before means a sign-out since, when this form is showing.
    api.signIn(id).then((s) => setState(s.state === "done" ? { state: "idle" } : s), () => setState({ state: "idle" }));
  }, [id]);

  // Follow a pending sign-in until it is approved.
  useEffect(() => {
    if (state?.state !== "pending") return;
    const t = setInterval(() => api.signIn(id).then(setState, () => {}), 2000);
    return () => clearInterval(t);
  }, [state?.state, id]);

  useEffect(() => {
    if (state?.state === "done" && !done.current) {
      done.current = true;
      onDone();
    }
  }, [state]);

  const start = () => api.startSignIn(id).then((s) => {
    setState(s);
    if (s.state === "pending" && s.url) window.open(s.url, "_blank");
  }, (e: Error) => setState({ state: "error", error: e.message }));

  const name = PROVIDERS[id].name;
  if (!state) return null;
  if (state.state === "pending") {
    return (
      <div className="connect signin">
        {state.userCode ? (
          <>
            <p className="small muted">Enter this code on GitHub to sign in to {name}:</p>
            <div className="row">
              <span className="signin-code mono">{state.userCode}</span>
              <button onClick={() => void navigator.clipboard?.writeText(state.userCode!)}>Copy</button>
              <a href={state.url} target="_blank" rel="noreferrer"><button className="primary">Open GitHub</button></a>
            </div>
          </>
        ) : !state.url ? (
          <>
            <p className="small muted">{name}'s sign-in page opened in your browser. Approve it there.</p>
            {state.terminal && <TerminalSignIn command={state.terminal} />}
          </>
        ) : (
          <div className="row">
            <span className="small muted">Approve the sign-in in your browser.</span>
            <a href={state.url} target="_blank" rel="noreferrer"><button>Open again</button></a>
          </div>
        )}
        <p className="dim small">Waiting for approval. <button className="ghost small-button" onClick={() => void api.cancelSignIn(id).then(() => setState({ state: "idle" }))}>Cancel</button></p>
      </div>
    );
  }
  if (state.state === "done") return <p className="small">Signed in to {name}.</p>;
  return (
    <div className="connect signin">
      {state.state === "error" && <div className="banner bad small">{state.error}</div>}
      {state.state === "error" && state.terminal && <TerminalSignIn command={state.terminal} />}
      <button className={primary ? "primary" : ""} onClick={() => void start()}>Sign in to {name}</button>
      <p className="dim small">{SIGN_IN_ABOUT[id]}</p>
    </div>
  );
}

/** The sign-in command for a terminal. */
function TerminalSignIn({ command, lead = "No browser opened? Run this in" }: { command: string; lead?: string }) {
  return (
    <div className="signin-terminal">
      <p className="dim small">{lead} {command.startsWith("& ") || command.startsWith("$env:") ? "PowerShell" : "a terminal"} and follow its prompts:</p>
      <div className="row">
        <code className="mono small">{command}</code>
        <button onClick={() => void navigator.clipboard?.writeText(command)}>Copy</button>
      </div>
    </div>
  );
}

/** How long the model reasons. Every vendor gets the nearest level it has. */
export function EffortPicker({ settings, onSettings }: { settings: StudioSettings; onSettings: (s: StudioSettings) => void }) {
  const [error, setError] = useState<string | null>(null);
  const pick = (effort: Effort) => api.saveSettings({ effort }).then(onSettings, (e: Error) => setError(e.message));
  return (
    <label className="effort" title={error ?? "How long the model reasons before it answers"}>
      <span className="effort-label">Effort</span>
      <select value={settings.effort} onChange={(e) => void pick(e.target.value as Effort)} aria-label="Effort">
        {EFFORTS.map((x) => <option key={x} value={x}>{EFFORT_NAMES[x]}</option>)}
      </select>
    </label>
  );
}
