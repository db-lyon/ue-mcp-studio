import { useState } from "react";
import { follow, host, type HostState, type JobState } from "./native";

export const NODE_DOWNLOAD = "https://nodejs.org/en/download";

/** One line on Node.js as this computer has it. */
export function nodeLine(state: HostState): string {
  if (state.node.ok) return `Node.js ${state.node.version} is installed.`;
  if (state.node.found) return `This computer has Node.js ${state.node.version || "older than " + state.node.min}, and ue-mcp needs ${state.node.min} or newer.`;
  return `Node.js is not installed. ue-mcp needs ${state.node.min} or newer.`;
}

/**
 * Installing Node.js, only with the user's consent: an unticked box, then
 * winget's Node.js LTS. Without winget, the download page.
 */
export function NodeInstall({ state, consent, onConsent, job }: { state: HostState; consent: boolean; onConsent: (v: boolean) => void; job: JobState | null }) {
  if (!state.winget) {
    return (
      <p className="muted small">
        Install the LTS release from{" "}
        <a href={NODE_DOWNLOAD} onClick={(e) => { e.preventDefault(); void host()?.openurl({ url: NODE_DOWNLOAD }); }}>nodejs.org</a>, then check again.
      </p>
    );
  }
  return (
    <>
      <label className="app-consent">
        <input type="checkbox" checked={consent} disabled={!!job?.running} onChange={(e) => onConsent(e.target.checked)} />
        <span>
          Install Node.js LTS with winget, the Windows package manager.
          <span className="dim"> Windows asks for permission, because Node.js installs for every user on this computer.</span>
        </span>
      </label>
      {job && <JobOutput job={job} />}
    </>
  );
}

/** A job's last lines while it runs, and what it said when it failed. */
export function JobOutput({ job, title }: { job: JobState; title?: string }) {
  // ue-mcp marks each line with a status glyph; the box says the state itself.
  const lines = (job.lines ?? []).map((l) => l.replace(/^[^ -~]+\s+/, ""));
  return (
    <div className={`app-job${job.running ? " running" : job.ok ? " ok" : " bad"}`} role="status" aria-live="polite">
      {title && <div className="app-job-title">{job.running && <span className="spinner small" aria-hidden />}{title}</div>}
      {lines.length > 0 && <pre className="app-job-lines">{lines.slice(-8).join("\n")}</pre>}
      {!job.running && !job.ok && job.error && <div className="app-job-error">{job.error}</div>}
    </div>
  );
}

/** The app with no usable Node.js: what it is for, and installing it. */
export function NodeCard({ state, refreshNode, onInstalled }: { state: HostState; refreshNode: () => Promise<void>; onInstalled: () => void }) {
  const [consent, setConsent] = useState(false);
  const [job, setJob] = useState<JobState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const install = async () => {
    setError(null);
    const started = await host()?.installnode({ consent: "yes" });
    if (!started?.ok || !started.job) return setError(started?.error ?? "winget did not start.");
    const end = await follow(started.job, setJob);
    await refreshNode();
    if (end.ok) onInstalled();
  };
  return (
    <section className="app-callout app-node" aria-labelledby="node-head">
      <h2 id="node-head">Node.js is needed</h2>
      <p className="muted">
        ue-mcp, the part of UE-MCP that talks to Unreal, runs on Node.js. {nodeLine(state)}
      </p>
      <NodeInstall state={state} consent={consent} onConsent={setConsent} job={job} />
      {error && <div className="banner bad small">{error}</div>}
      <div className="row">
        <span className="spacer" />
        <button onClick={() => void refreshNode()} disabled={!!job?.running}>Check again</button>
        {state.winget && (
          <button className="primary" disabled={!consent || !!job?.running} onClick={() => void install()}>
            {job?.running ? "Installing Node.js" : "Install Node.js"}
          </button>
        )}
      </div>
    </section>
  );
}
