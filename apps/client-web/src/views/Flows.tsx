import { useEffect, useMemo, useState } from "react";
import { api, type FlowSummary } from "../api";
import type { DaemonState } from "../state";
import { FlowGraph, type DeclaredStep, type PlannedStep, type StepState } from "./FlowGraph";

/** flow(plan)'s answer. `definition` arrives from ue-mcp versions that return the flow as declared. */
interface PlanResult {
  steps?: PlannedStep[];
  definition?: { description?: string; steps: Record<string, DeclaredStep> };
}

type Mode = "graph" | "json";

export function FlowsView({ daemon }: { daemon: DaemonState }) {
  const [flows, setFlows] = useState<FlowSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [output, setOutput] = useState<string>("");
  const [running, setRunning] = useState(false);
  const [mode, setMode] = useState<Mode>("graph");
  const [step, setStep] = useState<string | null>(null);

  useEffect(() => {
    api.flows().then((r) => setFlows(r.flows), (e: Error) => setError(e.message));
  }, []);

  const open = (name: string) => {
    setSelected(name);
    setStep(null);
    setPlan(null);
    api.planFlow(name).then((r) => {
      setPlan(r as PlanResult);
      setOutput(JSON.stringify(r, null, 2));
    }, (e: Error) => setOutput(e.message));
  };
  const run = (name: string) => {
    if (selected !== name) open(name);
    setRunning(true);
    api.runFlow(name).then((r) => setOutput(JSON.stringify(r, null, 2)), (e: Error) => setOutput(e.message))
      .finally(() => setRunning(false));
  };

  const flowEvents = daemon.events.filter((e) => e.type.startsWith("flow."));

  // The latest run of the open flow, step by step. The run is taken from the newest event rather
  // than its run_started, so a long run keeps its highlights after that event leaves the buffer.
  const states = useMemo(() => {
    const out: Record<number, StepState> = {};
    const mine = flowEvents.filter((e) => e.data.flowName === selected);
    const current = mine.length ? String(mine[mine.length - 1].data.runId) : null;
    for (const e of mine) {
      if (String(e.data.runId) !== current) continue;
      const n = (e.data.step as { stepNumber?: number } | undefined)?.stepNumber;
      if (n === undefined) continue;
      if (e.type === "flow.step_started") out[n] = "running";
      else if (e.type === "flow.step_failed") out[n] = "failed";
      else if (e.type === "flow.step_completed") {
        const r = e.data.result as { success?: boolean; skipped?: boolean } | undefined;
        out[n] = r?.skipped ? "skipped" : r?.success === false ? "failed" : "done";
      }
    }
    return out;
  }, [flowEvents, selected]);

  if (error) return <div className="banner bad">{error}</div>;
  if (!flows) return <p className="muted">Loading flows</p>;
  const definition = plan?.definition?.steps ?? null;
  const picked = step && definition ? definition[step] : null;

  return (
    <div className="split">
      <section className="card list">
        <h2>Flows</h2>
        {flows.map((f) => (
          <div key={f.name} className={`item ${selected === f.name ? "selected" : ""}`} onClick={() => open(f.name)}>
            <div className="row">
              <strong className="mono">{f.name}</strong>
              <span className="spacer" />
              <button disabled={running} onClick={(e) => { e.stopPropagation(); run(f.name); }}>Run</button>
            </div>
            {f.description && <p className="muted small">{f.description}</p>}
          </div>
        ))}
      </section>
      <section className="card flow-view">
        <div className="row">
          <h2>{selected ?? "Flow"}</h2>
          <span className="spacer" />
          <div className="segmented" role="tablist">
            <button className={mode === "graph" ? "active" : ""} onClick={() => setMode("graph")}>Graph</button>
            <button className={mode === "json" ? "active" : ""} onClick={() => setMode("json")}>JSON</button>
          </div>
        </div>
        {!selected && <p className="placeholder">Pick a flow to see its steps, or run it in the editor.</p>}
        {selected && running && <p className="muted small">Running</p>}
        {selected && mode === "graph" && plan && (
          <>
            {!definition && (
              <p className="dim small">This ue-mcp version reports step names only, so connections between steps are not shown.</p>
            )}
            <FlowGraph definition={definition} plan={plan.steps ?? []} states={states} selected={step} onSelect={setStep} />
            {picked && (
              <div className="step-detail">
                <div className="row">
                  <strong className="mono">Step {step}: {picked.task ?? picked.flow}</strong>
                  <span className="spacer" />
                  <button className="ghost" onClick={() => setStep(null)}>Close</button>
                </div>
                <pre className="output">{JSON.stringify(picked, null, 2)}</pre>
              </div>
            )}
          </>
        )}
        {selected && mode === "json" && <pre className="output">{output}</pre>}
      </section>
    </div>
  );
}
