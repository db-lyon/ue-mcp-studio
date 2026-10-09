import { useEffect, useState } from "react";
import { api, type FlowSummary } from "../api";
import type { DaemonState } from "../state";

export function FlowsView({ daemon }: { daemon: DaemonState }) {
  const [flows, setFlows] = useState<FlowSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [output, setOutput] = useState<string>("");
  const [running, setRunning] = useState(false);

  useEffect(() => {
    api.flows().then((r) => setFlows(r.flows), (e: Error) => setError(e.message));
  }, []);

  const flowEvents = daemon.events.filter((e) => e.type.startsWith("flow."));

  const plan = (name: string) => {
    setSelected(name);
    api.planFlow(name).then((r) => setOutput(JSON.stringify(r, null, 2)), (e: Error) => setOutput(e.message));
  };
  const run = (name: string) => {
    setSelected(name);
    setRunning(true);
    setOutput("");
    api.runFlow(name).then((r) => setOutput(JSON.stringify(r, null, 2)), (e: Error) => setOutput(e.message))
      .finally(() => setRunning(false));
  };

  if (error) return <div className="banner bad">{error}</div>;
  if (!flows) return <p className="muted">Loading flows...</p>;
  return (
    <div className="split">
      <section className="card list">
        <h2>Flows</h2>
        {flows.map((f) => (
          <div key={f.name} className={`item ${selected === f.name ? "selected" : ""}`}>
            <div className="row">
              <strong>{f.name}</strong>
              <span className="spacer" />
              <button onClick={() => plan(f.name)}>Plan</button>
              <button disabled={running} onClick={() => run(f.name)}>Run</button>
            </div>
            {f.description && <p className="muted small">{f.description}</p>}
          </div>
        ))}
      </section>
      <section className="card">
        <h2>{selected ?? "Output"}</h2>
        {running && <p className="muted">Running...</p>}
        <div className="events">
          {flowEvents.slice(-30).map((e) => (
            <div key={e.id} className="mono small">{e.type.slice(5)} {String(e.data.stepName ?? e.data.flowName ?? "")}</div>
          ))}
        </div>
        <pre className="output">{output}</pre>
      </section>
    </div>
  );
}
