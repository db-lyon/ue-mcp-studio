import { useEffect, useState } from "react";
import type { StatusReport } from "ue-mcp/daemon";
import { CONTEXT_STRATEGIES, CONTEXT_STRATEGY_INFO, type ClientContextStrategy, type ContextStrategy } from "@ue-mcp-studio/shared";
import { api, notThere } from "../../api";
import { inEditor, native } from "../../native";
import { ProjectSetup } from "../ProjectSetup";
import { ConfigView } from "../Config";
import { Head, type SettingsSection } from "../SettingsHub";
import { Card, Opt, tokens, useMessage } from "./controls";
import { Path } from "./NativePanel";
import { problemCopy, readRebuild } from "./install-problems";

type RebuildState = "idle" | "confirm" | "running";

/** What the panel says when a rebuild ends. */
function rebuildMessage(outcome: ReturnType<typeof readRebuild>, reopened: boolean | null): { ok: boolean; text: string } {
  if (outcome.ok) return { ok: true, text: "The bridge plugin is rebuilt and the editor is open again." };
  const f = outcome.failure!;
  if (f.step === "stop") return { ok: false, text: "The editor did not close, so nothing was built. Save your work and close any open dialogs in the editor, then try again." };
  if (f.step === "build") {
    const after = reopened === false
      ? "The editor did not open again. Open the project in Unreal to keep working on the previous build."
      : "The editor opened again on the previous build.";
    return { ok: false, text: `The build failed. ${after} ${f.reason}` };
  }
  if (f.step === "start") return { ok: false, text: "The bridge plugin is rebuilt, but the editor did not open again. Open the project in Unreal." };
  return { ok: false, text: `The rebuild did not finish. ${f.reason}` };
}

/**
 * Project: what ue-mcp gives every MCP client connected to this project. The
 * context strategy works from any browser; the client and tool setup that
 * runs `ue-mcp init` needs the editor.
 */
export function ProjectSection({ onSection }: { onSection: (s: SettingsSection) => void }) {
  const [report, setReport] = useState<StatusReport | null>(null);
  const [context, setContext] = useState<ClientContextStrategy | null>(null);
  const msg = useMessage();
  const [rebuild, setRebuild] = useState<RebuildState>("idle");
  const load = () => {
    api.install().then(setReport, msg.fail);
    api.contextStrategy().then(setContext, (e: Error) => (notThere(e) ? setContext(null) : msg.fail(e)));
  };
  useEffect(load, []);
  const pick = (strategy: ContextStrategy) =>
    api.saveContextStrategy(strategy).then((c) => {
      setContext(c);
      msg.ok(c.restarting ? "Saved to ue-mcp.yml. ue-mcp restarts after the current turn." : "Saved to ue-mcp.yml.");
    }, msg.fail);
  // Stop, build, start: the daemon's own rebuild. A failed build leaves the editor
  // down, so it is opened again on the previous build.
  const runRebuild = async () => {
    setRebuild("running");
    msg.clear();
    try {
      const outcome = readRebuild(await api.editor("rebuild"));
      let reopened: boolean | null = null;
      if (outcome.failure?.step === "build") {
        reopened = await api.editor("start").then((r) => readRebuild(r).ok, () => false);
      }
      const said = rebuildMessage(outcome, reopened);
      if (said.ok) msg.ok(said.text);
      else msg.fail(said.text);
    } catch (e) {
      msg.fail(`The rebuild did not run. ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRebuild("idle");
      load();
    }
  };
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
        {report?.problems.map((pr) => {
          const copy = problemCopy(pr, report);
          return (
            <div key={pr.code} className="problem">
              <strong>{copy.title}</strong>
              {copy.detail && <p className="muted">{copy.detail}</p>}
              {copy.action === "rebuild" && rebuild === "idle" && (
                <div className="actions"><button className="primary" onClick={() => setRebuild("confirm")}>Rebuild</button></div>
              )}
              {copy.action === "rebuild" && rebuild === "confirm" && (
                <div className="banner warn small" role="alert">
                  Rebuild closes the editor, builds the bridge plugin, and opens the editor again. It can take a few minutes. The editor does not close while it has unsaved changes.
                  <div className="actions">
                    <button className="primary" onClick={() => void runRebuild()}>Close the editor and rebuild</button>
                    <button className="ghost" onClick={() => setRebuild("idle")}>Cancel</button>
                  </div>
                </div>
              )}
              {copy.action === "rebuild" && rebuild === "running" && (
                <div className="banner ok small" role="status">Rebuilding. The editor closes, the bridge plugin builds, then the editor opens again.</div>
              )}
              {copy.action === "updates" && (
                <div className="actions"><button onClick={() => onSection("general")}>Open Updates</button></div>
              )}
            </div>
          );
        })}
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
                  title={<>{CONTEXT_STRATEGY_INFO[s].name}{context.seeds[s] !== undefined && <> <span className="tag">~{tokens(context.seeds[s])} tokens</span></>}{context.envOverride === s && <> <span className="tag warn">in effect, from environment</span></>}{context.envOverride && context.envOverride !== s && context.strategy === s && <> <span className="tag">saved, not in effect</span></>}</>}
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
