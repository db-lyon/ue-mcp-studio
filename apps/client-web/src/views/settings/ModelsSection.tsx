import { useEffect, useState } from "react";
import { KEY_PROVIDER_IDS, OFFERED_SIGN_INS, PROVIDERS, STUDIO_PLAN_AVAILABLE, type ModelCatalog, type ProviderId, type SignInId, type StudioSettings } from "@ue-mcp-studio/shared";
import { api } from "../../api";
import { ClaudeLoginWhy, KeyForm, SignInForm } from "../ModelPicker";
import { AccountView } from "../Account";
import { Head } from "../SettingsHub";
import { Card, useMessage } from "./controls";

/** The vendor whose models each sign-in runs. */
const SIGN_IN_VENDOR: Record<SignInId, string> = { claude: "anthropic", chatgpt: "openai", studio: "anthropic" };

const ROUTE_NAME: Record<SignInId | "key", string> = { claude: "Claude sign-in", chatgpt: "ChatGPT sign-in", studio: "Studio plan", key: "key" };

/**
 * Models & accounts: what can run models on this machine. Agents choose
 * models; this page decides how each is reached.
 */
export function ModelsSection() {
  const [settings, setSettings] = useState<StudioSettings | null>(null);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [gatewayUrl, setGatewayUrl] = useState("");
  const msg = useMessage();
  const refresh = () => {
    api.settings().then((s) => {
      setSettings(s);
      setGatewayUrl(s.gatewayUrl);
    }, msg.fail);
    api.models().then(setCatalog, () => setCatalog(null));
  };
  useEffect(refresh, []);
  if (!settings) return <>{msg.node ?? <p className="muted">Loading</p>}</>;
  const keyOnly = KEY_PROVIDER_IDS.filter((v) => !OFFERED_SIGN_INS.some((s) => SIGN_IN_VENDOR[s] === v)).map((v) => PROVIDERS[v].name);
  return (
    <>
      <Head title="Models & accounts" lead="What can run models on this machine. Agents choose models; this page decides how each one is reached." />
      {msg.node}
      <div className="cfg-cols">
        <Card label="Sign-ins">
          <p className="cfg-note">A sign-in runs its vendor's models on your plan, and is used before a key.</p>
          {OFFERED_SIGN_INS.map((p) => <ProviderRow key={p} provider={p} settings={settings} onChange={refresh} onError={msg.fail} />)}
          {keyOnly.length > 0 && <p className="cfg-note">{keyOnly.join(" and ")} {keyOnly.length === 1 ? "has" : "have"} no sign-in: {keyOnly.length === 1 ? "its" : "their"} models run on a key.</p>}
        </Card>
        <Card label="API keys">
          <p className="cfg-note">Optional. A model runs on your key only when no sign-in runs it. Keys stay on this machine and serve every project.</p>
          {KEY_PROVIDER_IDS.map((p) => <ProviderRow key={p} provider={p} settings={settings} onChange={refresh} onError={msg.fail} />)}
        </Card>
      </div>
      <Card label="Models">
        <div className="scroll-x">
          <table className="cfg-table">
            <thead>
              <tr><th>Model</th><th>Routes, in the order they are tried</th><th className="r">On this machine</th></tr>
            </thead>
            <tbody>
              {(catalog?.providers ?? []).flatMap((v) => v.models.map((m) => {
                const routes: Array<{ id: SignInId | "key"; on: boolean }> = [...m.signIns.map((s) => ({ id: s, on: !!catalog!.signedIn[s] })), { id: "key" as const, on: v.connected }];
                const runs = routes.find((r) => r.on);
                return (
                  <tr key={`${v.id}:${m.id}`}>
                    <td><strong>{m.name}</strong><div className="cfg-note">{v.name}</div></td>
                    <td>
                      {routes.map((r) => (
                        <div key={r.id} className="cfg-inline small">
                          <span className={`dot ${r.on ? "ok" : ""}`} />
                          <span className={r.on ? "" : "dim"}>{r.id === "key" ? `${v.name} key` : ROUTE_NAME[r.id]}</span>
                        </div>
                      ))}
                    </td>
                    <td className="r small">{runs ? <span className="tag ok">{runs.id === "key" ? `${v.name} key` : ROUTE_NAME[runs.id]}</span> : <span className="dim">not connected</span>}</td>
                  </tr>
                );
              }))}
            </tbody>
          </table>
        </div>
        <p className="cfg-note">A vendor with a saved key lists its own models, so new ones appear without a Studio update.{catalog?.providers.some((p) => p.source === "default") ? " Vendors without a key show Studio's starting list." : ""}</p>
      </Card>
      {STUDIO_PLAN_AVAILABLE && (
        <>
          <AccountView />
          <details className="card advanced">
            <summary className="muted small">Advanced</summary>
            <div className="cfg-inline">
              <span className="muted">Studio gateway</span>
              <input value={gatewayUrl} onChange={(e) => setGatewayUrl(e.target.value)} aria-label="Studio gateway URL" />
              <button onClick={() => api.saveSettings({ gatewayUrl }).then(() => msg.ok("Saved."), msg.fail)}>Save</button>
            </div>
          </details>
        </>
      )}
    </>
  );
}

/** One sign-in or one vendor key: whether it is connected, and connecting or disconnecting it. */
export function ProviderRow({ provider, settings, onChange, onError }: {
  provider: ProviderId;
  settings: StudioSettings;
  onChange: () => void;
  onError: (e: Error) => void;
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
    api.saveSettings(signIn ? { signOut: provider } : { keys: { [provider]: "" } }).then(onChange, onError);
  return (
    <div className="toggle-row inline">
      <span className={`dot ${connected ? "ok" : ""}`} style={{ marginTop: 6 }} />
      <div className="grow">
        <div className="t"><strong>{signIn ? ROUTE_NAME[provider as SignInId] : `${PROVIDERS[provider].name} key`}</strong> <span className="muted small">{status}</span></div>
        {signIn && !connected && <SignInForm id={provider} onDone={onChange} />}
        {!signIn && open && !connected && <KeyForm provider={provider} onSaved={() => { setOpen(false); onChange(); }} />}
      </div>
      {connected && provider === "studio" && settings.account?.via === "ue-mcp-login" ? (
        <span className="dim small">from ue-mcp login</span>
      ) : connected && provider === "claude" ? (
        <span className="dim small">from Claude Code <ClaudeLoginWhy /></span>
      ) : connected ? (
        <button onClick={() => void disconnect()}>{signIn ? "Sign out" : "Remove key"}</button>
      ) : signIn ? null : (
        <button onClick={() => setOpen(!open)}>{open ? "Cancel" : "Add key"}</button>
      )}
    </div>
  );
}
