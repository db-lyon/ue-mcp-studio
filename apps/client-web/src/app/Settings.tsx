import { useEffect, useState } from "react";
import type { Machine } from "./App";
import { host, type AppUpdate, type Channel } from "./native";
import { appUpdateLine, channelLabel } from "./model";
import { NodeCard, nodeLine } from "./NodeCard";

/** What belongs to the computer rather than a project: UE-MCP itself and its channel, Node.js, and adding a project. */
export function SettingsView({ m }: { m: Machine }) {
  const [adding, setAdding] = useState<string | null>(null);
  const add = async () => {
    setAdding(null);
    const r = await host()?.addproject();
    if (r && !r.ok && !r.cancelled) setAdding(r.error ?? "That project could not be added.");
    if (r?.ok) {
      setAdding("Added. It is on Projects.");
      void m.refresh();
    }
  };
  const state = m.state!;
  return (
    <section className="app-screen app-settings" aria-labelledby="settings-head">
      <header className="app-head">
        <div>
          <h1 id="settings-head">Settings</h1>
          <p className="dim small">For this computer. Everything about a project is on its row in Projects.</p>
        </div>
      </header>
      <AppUpdateCard version={state.version} onChannel={m.refreshNewest} />
      {state.node.ok ? (
        <div className="app-row">
          <div className="app-row-main">
            <div className="app-row-title"><span className="app-row-name">Node.js</span><span className="pill ok">{state.node.version}</span></div>
            <div className="muted small">{nodeLine(state)} ue-mcp runs on it.</div>
          </div>
          <div className="app-row-actions"><button onClick={() => void m.refreshNode()}>Check again</button></div>
        </div>
      ) : (
        <NodeCard state={state} refreshNode={m.refreshNode} onInstalled={() => void m.refresh()} />
      )}
      <div className="app-row">
        <div className="app-row-main">
          <div className="app-row-title"><span className="app-row-name">Projects</span></div>
          <div className="muted small">Projects Unreal Editor has opened are listed on their own. Add one it has not opened, by its .uproject file.</div>
          {adding && <div className="small muted">{adding}</div>}
        </div>
        <div className="app-row-actions"><button onClick={() => void add()}>Add project</button></div>
      </div>
    </section>
  );
}

/** UE-MCP's own update, from the newest Studio release on the chosen channel (Studio's own, one choice for the machine). */
export function AppUpdateCard({ version, onChannel }: { version: string; onChannel?: () => void }) {
  const [u, setU] = useState<AppUpdate | null>(null);
  const [channel, setChannelState] = useState<Channel>("stable");
  const [switching, setSwitching] = useState(false);
  const [installing, setInstalling] = useState(false);
  const check = () => {
    setU(null);
    void host()?.appupdate().then((r) => {
      setU(r);
      if (r.channel) setChannelState(r.channel);
    });
  };
  useEffect(() => {
    void host()?.getchannel().then((r) => r?.channel && setChannelState(r.channel));
    check();
  }, []);
  const choose = async (c: Channel) => {
    setSwitching(true);
    setChannelState(c);
    const r = await host()?.setchannel({ channel: c });
    setSwitching(false);
    if (!r?.ok) {
      void host()?.getchannel().then((x) => x?.channel && setChannelState(x.channel));
      return setU({ ok: false, error: r?.error ?? "The channel could not be saved." });
    }
    check();
    // Each project's updates are against the channel's newest, so they are read again.
    onChannel?.();
  };
  const install = async () => {
    setInstalling(true);
    const r = await host()?.appupdate({ install: "yes" });
    if (!r?.started) {
      setInstalling(false);
      setU(r ?? { ok: false, error: "The update did not start." });
    }
  };
  const pill = !u ? "Checking" : !u.ok ? "Not checked" : u.newer ? "Update available" : "Up to date";
  return (
    <div className="app-row app-update app-self">
      <div className="app-row-main">
        <div className="app-row-title">
          <span className="app-row-name">UE-MCP</span>
          <span className={`pill ${u?.ok && !u.newer ? "ok" : "warn"}`}>{pill}</span>
        </div>
        <div className="muted small">{appUpdateLine(version, u, channel, installing)}</div>
        <div className="row update-channel" role="radiogroup" aria-label="Release channel">
          <span className="dim small">Channel</span>
          {(["stable", "beta"] as const).map((c) => (
            <label key={c} className="small">
              <input type="radio" name="app-update-channel" checked={channel === c} disabled={installing || switching} onChange={() => void choose(c)} />{" "}
              {channelLabel(c)}
            </label>
          ))}
        </div>
        <div className="dim small">The channel is one choice for this computer: UE-MCP, Studio in every project and ue-mcp follow it.</div>
      </div>
      <div className="app-row-actions">
        {u?.ok && u.newer ? (
          <button className="primary" disabled={installing} onClick={() => void install()}>{installing ? "Installing" : "Update UE-MCP"}</button>
        ) : (
          <button onClick={check} disabled={!u}>Check again</button>
        )}
      </div>
    </div>
  );
}
