import { useEffect, useState } from "react";
import type { StatusReport } from "ue-mcp/daemon";
import { CONTEXT_STRATEGIES, CONTEXT_STRATEGY_INFO, type ClientContextStrategy, type ContextStrategy } from "@ue-mcp-studio/shared";
import { api } from "../../api";
import { inEditor, native } from "../../native";
import { ProjectSetup } from "../ProjectSetup";
import { ConfigView } from "../Config";
import { Head, type SettingsSection } from "../SettingsHub";
import { Card, Opt, tokens, useMessage } from "./controls";
import { Path } from "./NativePanel";

/**
 * Project: what ue-mcp gives every MCP client connected to this project. The
 * context strategy works from any browser; the client and tool setup that
 * runs `ue-mcp init` needs the editor.
 */
export function ProjectSection({ onSection }: { onSection: (s: SettingsSection) => void }) {
  const [report, setReport] = useState<StatusReport | null>(null);
  const [context, setContext] = useState<ClientContextStrategy | null>(null);
  const msg = useMessage();
  const load = () => {
    api.install().then(setReport, msg.fail);
    api.contextStrategy().then(setContext, msg.fail);
  };
  useEffect(load, []);
  const pick = (strategy: ContextStrategy) =>
    api.saveContextStrategy(strategy).then((c) => {
      setContext(c);
      msg.ok(c.restarting ? "Saved to ue-mcp.yml. ue-mcp restarts after the current turn." : "Saved to ue-mcp.yml.");
    }, msg.fail);
  const clients = report?.clients.filter((c) => c.configured) ?? [];
  const p = report?.plugin;
  return (
    <>
      <Head title="Project" lead="ue-mcp for this project's MCP clients, and the editor plugin." />
      {msg.node}
      <section className="card">
        <div className="cfg-inline">
          <span className={`dot ${report ? (report.ok ? "ok" : "warn") : ""}`} />
          <strong>{report ? (report.ok ? "Ready" : "Needs attention") : "Checking"}</strong>
          {p && <span className="muted small">Bridge {p.installedVersion ?? "?"} {p.deployed ? "installed" : "not installed"}{p.enabledInUproject ? ", enabled" : ""}, for UE {report?.project.engine ?? "?"}.</span>}
          <span className="spacer" />
          <button onClick={load}>Check again</button>
          <button onClick={() => void native().openprojectfolder()}>Open project folder</button>
        </div>
        {report?.problems.map((pr) => (
          <div key={pr.code} className="problem">
            <strong>{pr.what}</strong>
            <p className="muted">{pr.fix}</p>
          </div>
        ))}
      </section>

      <Card label="Context strategy">
        <p className="muted small">What every client loads at session start, Studio's agent included.</p>
        {context && (
          <>
            {context.envOverride && (
              <div className="banner warn small"><span className="mono">UE_MCP_CONTEXT_STRATEGY={context.envOverride}</span> overrides this. A choice here applies once it is unset.</div>
            )}
            <div className="opts row3" style={{ marginTop: 8 }}>
              {CONTEXT_STRATEGIES.map((s) => (
                <Opt
                  key={s}
                  name="client-context"
                  on={context.strategy === s}
                  onPick={() => void pick(s)}
                  title={<>{CONTEXT_STRATEGY_INFO[s].name} <span className="tag">~{tokens(context.seeds[s])} tokens</span>{context.envOverride === s && <> <span className="tag warn">in effect, from environment</span></>}{context.envOverride && context.envOverride !== s && context.strategy === s && <> <span className="tag">saved, not in effect</span></>}</>}
                  desc={<><br />{CONTEXT_STRATEGY_INFO[s].sees} {CONTEXT_STRATEGY_INFO[s].discovery}</>}
                />
              ))}
            </div>
            <p className="cfg-note" style={{ marginTop: 8 }}>
              {clients.length ? `Used by ${clients.map((c) => c.name).join(" and ")}. ` : "No other MCP client configured. "}
              Applies from each client's next session.{context.fromFile ? "" : " Default: Micro."} Token counts measured by ue-mcp.
            </p>
          </>
        )}
      </Card>

      <Card label="MCP clients">
        {clients.length === 0 && <p className="cfg-note">None configured.</p>}
        {!inEditor() && <p className="cfg-note">Change these from Studio in the editor. It runs ue-mcp init.</p>}
        {clients.map((c) => (
          <div key={c.id} className="toggle-row inline">
            <span className="dot ok" style={{ marginTop: 6 }} />
            <div className="grow"><div className="t"><strong>{c.name}</strong> <span className="muted small">{c.pinned ? `ue-mcp@${c.pinned}` : "ue-mcp@latest"}</span></div></div>
          </div>
        ))}
      </Card>

      <ProjectSetup onApplied={load} />

      {p && (
        <Card label="Bridge plugin">
          <dl className="grid">
            <dt>Installed</dt><dd>{p.deployed ? `${p.installedVersion ?? "?"} (${p.installKind ?? "unknown"})` : "no"}</dd>
            <dt>Package</dt><dd>{p.packagedVersion ?? "?"}</dd>
            <dt>Enabled</dt><dd>{p.enabledInUproject ? "yes" : "no"}</dd>
            <dt>Location</dt><dd>{p.pluginDir ? <Path p={p.pluginDir} /> : "-"}</dd>
            <dt>Engine</dt><dd>{report!.project.engine ?? "?"}</dd>
            <dt>C++ toolchain</dt><dd>{report!.toolchain.present ? report!.toolchain.name : "none"}</dd>
            <dt>Node.js</dt><dd>{report!.node.version}</dd>
          </dl>
        </Card>
      )}

      <details className="card advanced">
        <summary className="muted small">Advanced: ue-mcp.yml</summary>
        <ConfigView />
      </details>
    </>
  );
}
