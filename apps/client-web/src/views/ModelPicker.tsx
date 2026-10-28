import { useEffect, useId, useRef, useState } from "react";
import {
  EFFORTS,
  EFFORT_NAMES,
  KEY_PROVIDER_IDS,
  PROVIDERS,
  anythingConnected,
  endpointIdOf,
  routesInOrder,
  type Effort,
  type KeyProviderId,
  type VendorId,
  type ModelCatalog,
  type ModelOption,
  type SignInId,
  type StudioSettings,
  type StudioSignIn,
} from "@ue-mcp-studio/shared";
import { api } from "../api";
import { atMost, useBarTier } from "../chat/barTier";

type Catalog = ModelCatalog;
type Vendor = Catalog["providers"][number];

type Via = SignInId | "key" | "endpoint";

/**
 * How a model would run now: a custom endpoint's on that endpoint; a named
 * vendor's on the first connected sign-in or key by the route order; else nothing.
 */
export function runsVia(catalog: Catalog, vendor: Vendor, m: ModelOption): Via | null {
  if (vendor.endpoint) return "endpoint";
  return routesInOrder(m.signIns, catalog.routeOrder).find((r) => (r === "key" ? vendor.connected : catalog.signedIn[r])) ?? null;
}

/** One name per route, the same in the picker, the Models table and the sign-in rows. */
export const VIA_LABEL: Record<SignInId | "key", string> = { chatgpt: "ChatGPT sign-in", claude: "Claude sign-in", studio: "Studio plan", key: "key" };

/** A route's name beside a model: a key and an endpoint by their vendor's name. */
export function viaName(via: Via, vendorName: string): string {
  return via === "endpoint" ? vendorName : via === "key" ? `${vendorName} key` : VIA_LABEL[via];
}

function find(catalog: Catalog | null, vendor: VendorId, model: string): { vendor: Vendor; model: ModelOption } | null {
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
 * A picker for a model that follows the main agent's unless one is chosen:
 * the main agent's vendor only, with the follow choice first.
 */
export interface Follow<T> {
  /** The chosen value; null follows the main agent. */
  value: T | null;
  /** What null is called, such as "Same as main agent". */
  same: string;
  onPick: (v: T | null) => Promise<unknown>;
  /** Names the control for a screen reader. */
  label: string;
}

/**
 * The model picker: every model once, under its vendor. Picking one that
 * nothing connected can run asks to sign in right there (a key is the
 * fallback), then selects it. With follow, it picks a model of the main
 * agent's vendor, or none, through follow.onPick instead of the main model.
 */
export function ModelPicker({
  settings,
  onSettings,
  up = false,
  follow,
  merged = false,
}: {
  settings: StudioSettings;
  onSettings: (s: StudioSettings) => void;
  /** Open above the button, for the composer at the bottom of the panel. */
  up?: boolean;
  follow?: Follow<string>;
  /** The effort too: the button names both and the menu has an Effort section under the models. */
  merged?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const catalog = useCatalog(settings);
  const [connecting, setConnecting] = useState<{ vendor: VendorId; model: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

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

  const done = () => {
    setOpen(false);
    setConnecting(null);
  };
  const select = (vendor: VendorId, model: string | null) =>
    (follow
      ? follow.onPick(model).then(done)
      : api.saveSettings({ provider: vendor, model: model! }).then((s) => {
          onSettings(s);
          done();
        })).catch((e: Error) => setError(e.message));

  // Following, only the main agent's vendor is offered: the worker runs on its sign-in or key.
  const providers = follow
    ? (catalog?.providers ?? []).filter((p) => p.id === settings.provider && KEY_PROVIDER_IDS.includes(p.id as KeyProviderId))
    : catalog?.providers ?? [];
  const current = follow
    ? follow.value === null ? null : find(catalog, settings.provider, follow.value)
    : find(catalog, settings.provider, settings.model);
  const via = follow ? null : settings.route;
  const shown = follow
    ? follow.value === null ? follow.same : current?.model.name ?? follow.value
    // Nothing connected yet: no vendor is chosen for the user.
    : anythingConnected(settings) ? current?.model.name ?? settings.model : "Choose a model";

  // A model with no route has no effort to set, as the separate Effort control is then disabled.
  const withEffort = merged && !follow && settings.route !== null;
  const label = withEffort ? `${shown} · ${EFFORT_NAMES[settings.effort]}` : shown;
  // Escape closes the menu; the arrow keys move between the models.
  const keyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" && open) {
      e.stopPropagation();
      done();
      button.current?.focus();
      return;
    }
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && open) {
      const items = [...(box.current?.querySelectorAll<HTMLButtonElement>(".picker-models button.picker-item") ?? [])];
      if (!items.length) return;
      e.preventDefault();
      const at = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = at < 0 ? (e.key === "ArrowDown" ? 0 : items.length - 1) : (at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next].focus();
    }
  };

  return (
    <div className={`picker ${merged ? "merged" : ""}`} ref={box} onKeyDown={keyDown}>
      <button
        ref={button}
        className="picker-button"
        onClick={() => setOpen(!open)}
        title={withEffort ? "Model and effort" : "Model"}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={follow ? `${follow.label}: ${shown}` : withEffort ? `Model and effort: ${shown}, ${EFFORT_NAMES[settings.effort]}` : undefined}
      >
        <span className="picker-label">{label}</span>
        {via && <span className="picker-via">{viaName(via, current?.vendor.name ?? (via === "key" ? PROVIDERS[settings.provider as KeyProviderId]?.name ?? settings.provider : settings.provider))}</span>}
        <span className="picker-caret" aria-hidden>{"▾"}</span>
      </button>
      {open && (
        <div className={`picker-menu ${up ? "up" : ""}`}>
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
            <div className="picker-models" role="listbox" aria-label="Model">
            {follow && (
              <button role="option" aria-selected={follow.value === null} className={`picker-item ${follow.value === null ? "current" : ""}`} onClick={() => void select(settings.provider, null)}>
                <span>{follow.same}</span>
              </button>
            )}
            {providers.map((p) => (
              <div key={p.id} className="picker-group">
                <div className="picker-group-head">
                  <span className="eyebrow">{p.name}</span>
                </div>
                {p.models.map((m) => {
                  const selected = follow ? follow.value === m.id : settings.provider === p.id && settings.model === m.id;
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
                      <span className={`picker-via ${runs ? "" : "off"}`}>{runs ? viaName(runs, p.name) : m.signIns.length ? "sign in" : "connect"}</span>
                    </button>
                  );
                })}
              </div>
            ))}
            </div>
          )}
          {withEffort && !connecting && <EffortSegments settings={settings} onSettings={onSettings} />}
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
  vendor: VendorId;
  model: string;
  onConnected: () => void;
}) {
  const found = find(catalog, vendor, model);
  // A custom endpoint has no sign-in or key to connect here: it is set up, or it is gone.
  if (endpointIdOf(vendor) !== null) {
    const endpoint = catalog.providers.find((p) => p.id === vendor);
    return (
      <div className="connect">
        <p className="small"><strong>{model}</strong></p>
        <p className="dim small">
          {found
            ? `${found.vendor.name} runs this model.`
            : endpoint
              ? `${endpoint.name} no longer lists this model. Add it in the endpoint's Edit, in Settings, Models & accounts, or choose another model.`
              : "The custom endpoint that ran this model is no longer set up. Add it again in Settings, Models & accounts, or choose another model."}
        </p>
      </div>
    );
  }
  const keyVendor = vendor as KeyProviderId;
  const signIns = found?.model.signIns ?? [];
  const name = found?.model.name ?? model;
  return (
    <div className="connect">
      <p className="small"><strong>{name}</strong></p>
      {signIns.map((s, i) => <SignInForm key={s} id={s} primary={i === 0} onDone={onConnected} />)}
      {signIns.length > 0 ? (
        <details className="key-fallback">
          <summary className="dim small">Use your own {PROVIDERS[keyVendor].name} API key instead</summary>
          <KeyForm provider={keyVendor} onSaved={onConnected} />
        </details>
      ) : (
        <>
          <p className="dim small">Connect {PROVIDERS[keyVendor].name} with an API key.</p>
          <KeyForm provider={keyVendor} onSaved={onConnected} />
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
  chatgpt: "Runs OpenAI models on your ChatGPT plan.",
  claude: "Runs Claude models on your Claude plan, using your Claude Code login.",
  studio: "Runs your Studio plan's models. Sign in with GitHub.",
};

export function SignInForm(props: { id: SignInId; primary?: boolean; onDone: () => void }) {
  return props.id === "claude" ? <ClaudeCodeLogin onDone={props.onDone} /> : <AppSignIn {...props} />;
}

/** Why the Claude row has no sign-in button. */
export const CLAUDE_LOGIN_WHY =
  "Anthropic does not allow apps it has not approved to offer Claude sign-in themselves. You sign in with Claude Code, and Studio runs Claude on that login. Studio never sees your Claude credentials.";

/** "Why?", with the reason on hover, focus and to a screen reader. */
export function ClaudeLoginWhy() {
  return <span className="info-tip" tabIndex={0} role="note" title={CLAUDE_LOGIN_WHY} aria-label={CLAUDE_LOGIN_WHY}>Why?</span>;
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
      <p className="small">
        Sign in with Claude Code: run <code className="mono">claude /login</code> in a terminal. Studio picks up the login on its own.{" "}
        <ClaudeLoginWhy />
      </p>
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

/**
 * The model and the effort in the composer bar: two controls while there is
 * room, one chip with one menu when the bar narrows (chat/barTier.ts).
 */
export function ModelAndEffort({ settings, onSettings }: { settings: StudioSettings; onSettings: (s: StudioSettings) => void }) {
  return atMost("merged", useBarTier())
    ? <ModelPicker settings={settings} onSettings={onSettings} up merged />
    : <><ModelPicker settings={settings} onSettings={onSettings} up /><EffortPicker settings={settings} onSettings={onSettings} /></>;
}

/** The effort as a row of choices, in the merged menu. Left and Right move and pick. */
function EffortSegments({ settings, onSettings }: { settings: StudioSettings; onSettings: (s: StudioSettings) => void }) {
  const [error, setError] = useState<string | null>(null);
  const pick = (effort: Effort) => api.saveSettings({ effort }).then(onSettings, (e: Error) => setError(e.message));
  const group = useRef<HTMLDivElement>(null);
  const head = useId();
  const keyDown = (e: React.KeyboardEvent) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    e.stopPropagation();
    const at = EFFORTS.indexOf(settings.effort);
    const next = EFFORTS[(at + step + EFFORTS.length) % EFFORTS.length];
    void pick(next);
    group.current?.querySelector<HTMLButtonElement>(`[data-effort="${next}"]`)?.focus();
  };
  return (
    <div className="picker-effort">
      <div className="picker-group-head"><span className="eyebrow" id={head}>Effort</span></div>
      {error && <div className="banner bad small" onClick={() => setError(null)}>{error}</div>}
      <div className="segments" role="radiogroup" aria-labelledby={head} ref={group} onKeyDown={keyDown}>
        {EFFORTS.map((x) => (
          <button
            key={x}
            role="radio"
            data-effort={x}
            aria-checked={settings.effort === x}
            tabIndex={settings.effort === x ? 0 : -1}
            className={settings.effort === x ? "current" : ""}
            onClick={() => void pick(x)}
          >
            {EFFORT_NAMES[x]}
          </button>
        ))}
      </div>
    </div>
  );
}

/** How long the model reasons. Every vendor gets the nearest level it has. */
export function EffortPicker({ settings, onSettings, follow }: { settings: StudioSettings; onSettings: (s: StudioSettings) => void; follow?: Follow<Effort> }) {
  const [error, setError] = useState<string | null>(null);
  const pick = (effort: Effort) => api.saveSettings({ effort }).then(onSettings, (e: Error) => setError(e.message));
  return (
    <label className="effort" title={error ?? "How long the model reasons before it answers"}>
      <span className="effort-label">Effort</span>
      <select
        value={follow ? follow.value ?? "" : settings.effort}
        onChange={(e) => void (follow ? follow.onPick((e.target.value || null) as Effort | null).catch((x: Error) => setError(x.message)) : pick(e.target.value as Effort))}
        aria-label={follow?.label ?? "Effort"}
        disabled={settings.route === null}
        title={settings.route === null ? "Pick a model that runs first" : undefined}
      >
        {follow && <option value="">{follow.same}</option>}
        {EFFORTS.map((x) => <option key={x} value={x}>{EFFORT_NAMES[x]}</option>)}
      </select>
    </label>
  );
}
