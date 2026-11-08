import { useState } from "react";
import { follow, host, type HostState, type JobState } from "./native";
import { Mark } from "./Mark";
import { NodeInstall, nodeLine } from "./NodeCard";

type Step = "welcome" | "installing" | "done" | "failed";

/**
 * UE-MCP's setup: installs the app for this Windows user and offers to open
 * it. Node.js is checked, and installed only when the user ticks the box.
 */
export function SetupView({ state, refreshNode }: { state: HostState; refreshNode: () => Promise<void> }) {
  const [step, setStep] = useState<Step>("welcome");
  const [consent, setConsent] = useState(false);
  const [nodeJob, setNodeJob] = useState<JobState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const h = host();
  const older = !!state.installed && (state.compare === "older" || state.compare === "same");
  const upgrade = !!state.installed && state.compare === "newer";

  const install = async () => {
    setStep("installing");
    setError(null);
    if (consent && !state.node.ok) {
      const started = await h?.installnode({ consent: "yes" });
      if (started?.ok && started.job) {
        const end = await follow(started.job, setNodeJob);
        await refreshNode();
        // UE-MCP installs either way; it says what Node.js is for if it is still missing.
        if (!end.ok) setError(`Node.js was not installed${end.error ? `: ${end.error}` : "."} UE-MCP asks again when it starts.`);
      }
    }
    const r = await h?.setup();
    if (!r?.ok) {
      setError(r?.error ?? "UE-MCP was not installed.");
      return setStep("failed");
    }
    setStep("done");
  };
  const finish = () => void (open ? h?.launch() : h?.close());

  return (
    <div className="setup">
      <header className="setup-head">
        <Mark size={40} />
        <div>
          <div className="setup-product">UE-MCP</div>
          <div className="dim small">Version {state.version}</div>
        </div>
      </header>

      {step === "welcome" && older && (
        <main className="setup-body">
          <h1>UE-MCP {state.installed?.version} is installed</h1>
          <p className="muted">{state.compare === "same" ? "This is the version you have." : `It is newer than this setup's ${state.version}, so nothing needs installing.`}</p>
          <footer className="setup-foot">
            <span className="spacer" />
            <button onClick={() => void h?.close()}>Close</button>
            <button className="primary" onClick={() => void h?.launch()}>Open UE-MCP</button>
          </footer>
        </main>
      )}

      {step === "welcome" && !older && (
        <main className="setup-body">
          <h1>{upgrade ? `Update UE-MCP to ${state.version}` : "Install UE-MCP"}</h1>
          <p className="muted">
            UE-MCP keeps your Unreal projects in one place. It adds Studio to a project, opens each project's Studio, keeps them up to date and shows what runs.
          </p>
          <div className="setup-check">
            <span className={`setup-dot ${state.node.ok ? "ok" : "warn"}`} aria-hidden />
            <div>
              <div>{nodeLine(state)}</div>
              {!state.node.ok && <NodeInstall state={state} consent={consent} onConsent={setConsent} job={nodeJob} />}
            </div>
          </div>
          <p className="dim small setup-where">Installs for your Windows user in {state.installDir}. No admin rights needed.</p>
          <footer className="setup-foot">
            <span className="spacer" />
            <button onClick={() => void h?.close()}>Cancel</button>
            <button className="primary" onClick={() => void install()}>{upgrade ? "Update" : "Install"}</button>
          </footer>
        </main>
      )}

      {step === "installing" && (
        <main className="setup-body">
          <h1>{nodeJob?.running ? "Installing Node.js" : "Installing UE-MCP"}</h1>
          <div className="setup-progress" role="progressbar" aria-label="Installing"><span /></div>
          {nodeJob && <p className="dim small">{nodeJob.lines?.slice(-1)[0] ?? ""}</p>}
        </main>
      )}

      {step === "done" && (
        <main className="setup-body">
          <h1>UE-MCP is installed</h1>
          <p className="muted">Find it in the Start menu. Add Studio to a project from its Projects list.</p>
          {error && <div className="banner warn small">{error}</div>}
          <label className="app-consent">
            <input type="checkbox" checked={open} onChange={(e) => setOpen(e.target.checked)} />
            <span>Open UE-MCP now</span>
          </label>
          <footer className="setup-foot">
            <span className="spacer" />
            <button className="primary" onClick={finish}>Finish</button>
          </footer>
        </main>
      )}

      {step === "failed" && (
        <main className="setup-body">
          <h1>UE-MCP was not installed</h1>
          <div className="banner bad small" role="alert">{error}</div>
          <footer className="setup-foot">
            <span className="spacer" />
            <button onClick={() => void h?.close()}>Close</button>
            <button className="primary" onClick={() => void install()}>Try again</button>
          </footer>
        </main>
      )}
    </div>
  );
}
