import { useEffect, useMemo, useState } from "react";
import {
  closestNames,
  flowFormFields,
  flowInputsOf,
  flowOptionsScope,
  stepScopedParams,
  flowValue,
  parseFlowArgs,
  singleType,
  type FlowInput,
  type FlowListing,
  type FlowRunRequest,
  type TranscriptEntry,
} from "@ue-mcp-studio/shared";
import { api } from "../api";
import { FieldsForm } from "./Forms";

type Loaded =
  | { kind: "loading" }
  | { kind: "unnamed"; flows: FlowListing[] }
  | { kind: "unknown"; closest: string[] }
  | { kind: "error"; message: string }
  | { kind: "ready"; flow: FlowListing | null; inputs: FlowInput[]; scope: "flat" | "step" };

/** A pair typed after the name, as the value of the field it prefills. */
function prefillValue(raw: string, input: FlowInput | undefined): unknown {
  const type = input ? singleType(input) : null;
  if (type === "boolean") return raw === "true" ? true : raw === "false" ? false : raw;
  return raw;
}

/** The form's values as the run's params: text read as the input's type. Pairs typed for no input go too. */
function paramsFrom(inputs: FlowInput[], content: Record<string, unknown>, typed: Record<string, string>): Record<string, unknown> {
  const byName = new Map(inputs.map((i) => [i.name, i]));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(typed)) if (!byName.has(k)) out[k] = flowValue(v, null);
  for (const [k, v] of Object.entries(content)) {
    const input = byName.get(k);
    out[k] = typeof v === "string" && input ? flowValue(v, singleType(input)) : v;
  }
  return out;
}

/**
 * What a /flow message opens above the composer: the flow's inputs as a form,
 * defaults filled in and the pairs typed after the name over them. A flow
 * with no inputs runs at once. A name that is no flow shows the closest ones.
 */
export function FlowLauncher({ text, run, onClose }: { text: string; run: (request: FlowRunRequest) => Promise<unknown>; onClose: () => void }) {
  const parsed = useMemo(() => parseFlowArgs(text.replace(/^\s*\/flow\b/, "")), [text]);
  const [name, setName] = useState(parsed.name);
  const typed = name === parsed.name ? parsed.values : {};
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = (params: Record<string, unknown>, shown?: string) => {
    setSent(true);
    setError(null);
    run({ name, params, ...(shown ? { text: shown } : {}) }).then(onClose, (e: Error) => {
      setSent(false);
      setError(e.message);
    });
  };

  useEffect(() => {
    let live = true;
    setLoaded({ kind: "loading" });
    const listed = api.flows().then((r) => r.flows, () => null);
    if (!name) {
      void listed.then((flows) => live && setLoaded({ kind: "unnamed", flows: flows ?? [] }));
      return () => {
        live = false;
      };
    }
    void Promise.all([listed, api.planFlow(name).then((p) => ({ ok: true as const, p }), (e: Error) => ({ ok: false as const, e }))]).then(([flows, plan]) => {
      if (!live) return;
      const flow = flows?.find((f) => f.name === name) ?? null;
      if (flows && !flow) return setLoaded({ kind: "unknown", closest: closestNames(name, flows.map((f) => f.name)) });
      if (!plan.ok) return setLoaded({ kind: "error", message: plan.e.message });
      const inputs = flowInputsOf(plan.p);
      const scope = flowOptionsScope(plan.p);
      setLoaded({ kind: "ready", flow, inputs, scope });
      // Nothing to ask: it runs as it is.
      if (inputs.length === 0) start(scope === "step" ? {} : Object.fromEntries(Object.entries(typed).map(([k, v]) => [k, flowValue(v, null)])));
    });
    return () => {
      live = false;
    };
  }, [name]);

  const head = (
    <div className="approval-head">
      <strong>{name ? `Run flow ${name}` : "Run a flow"}</strong>
      <span className="dim small">/flow</span>
    </div>
  );
  const pickName = (n: string) => (
    <button key={n} className="small-button mono" onClick={() => setName(n)}>{n}</button>
  );
  const close = <button className="ghost" onClick={onClose}>Close</button>;

  let body;
  if (loaded.kind === "loading") body = <p className="dim small" role="status">Reading the flow</p>;
  else if (loaded.kind === "unnamed") {
    body = (
      <>
        <p className="small">Name a flow after /flow.</p>
        {loaded.flows.length > 0 && <div className="row flow-names">{loaded.flows.map((f) => pickName(f.name))}</div>}
        <div className="row"><span className="spacer" />{close}</div>
      </>
    );
  } else if (loaded.kind === "unknown") {
    body = (
      <>
        <p className="small">No flow named {name}.</p>
        {loaded.closest.length > 0 && <div className="row flow-names"><span className="dim small">Closest:</span>{loaded.closest.map(pickName)}</div>}
        <div className="row"><span className="spacer" />{close}</div>
      </>
    );
  } else if (loaded.kind === "error") {
    body = (
      <>
        <div className="banner bad small">{loaded.message}</div>
        <div className="row"><span className="spacer" />{close}</div>
      </>
    );
  } else if (loaded.inputs.length === 0) {
    body = error ? <><div className="banner bad small">{error}</div><div className="row"><span className="spacer" />{close}</div></> : <p className="dim small" role="status">Starting</p>;
  } else {
    const inputs = loaded.inputs;
    const { fields, required } = flowFormFields(inputs);
    const byName = new Map(inputs.map((i) => [i.name, i]));
    const prefill = Object.fromEntries(Object.entries(typed).filter(([k]) => k in fields).map(([k, v]) => [k, prefillValue(v, byName.get(k))]));
    // A step-scoped flow takes each param under the step it is for.
    const scoped = loaded.scope === "step";
    const submit = (params: Record<string, unknown>) => {
      if (!scoped) return start(params);
      const nested = stepScopedParams(inputs, params);
      if (nested) return start(nested);
      setError("This flow takes its params per step, and one of them is read by a nested flow's step, a hook step or no step, so this form cannot address it. Run the flow with flow(run) and params per step.");
    };
    body = (
      <>
        {loaded.flow?.description && <p className="small">{loaded.flow.description}</p>}
        <FieldsForm
          key={name}
          fields={fields}
          required={required}
          prefill={prefill}
          sent={sent}
          error={error}
          submitLabel="Run"
          declineLabel="Cancel"
          requireFilled
          onSubmit={(content) => submit(paramsFrom(inputs, content, typed))}
          onDecline={onClose}
        />
      </>
    );
  }
  return (
    <div className="approvals" role="region" aria-label="Run a flow">
      <div className="approval-card card" role="group" aria-label={name ? `Run flow ${name}` : "Run a flow"}>
        {head}
        {body}
      </div>
    </div>
  );
}

const STATE_LABEL: Record<Extract<TranscriptEntry, { kind: "flow" }>["state"], string> = {
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  stopped: "Stopped",
};

/** A /flow's card in the transcript: its steps as they run, then its summary or errors. */
export function FlowCard({ entry }: { entry: Extract<TranscriptEntry, { kind: "flow" }> }) {
  const tone = entry.state === "failed" ? "bad" : entry.state === "stopped" ? "warn" : "";
  return (
    <div className={`banner flow-card ${tone}`} role="status" aria-label={`Flow ${entry.name}`}>
      <div className="row">
        <strong className="mono">{entry.name}</strong>
        <span className="dim small">{STATE_LABEL[entry.state]}{entry.duration !== undefined ? ` in ${(entry.duration / 1000).toFixed(1)} s` : ""}</span>
      </div>
      {entry.steps.length > 0 && (
        <ol className="small flow-steps">
          {entry.steps.map((s) => (
            <li key={s.id} className={s.state} style={s.depth ? { marginLeft: s.depth * 14 } : undefined}>
              <span className="mono">{s.name}</span>
              {s.state === "skipped" && <span className="dim"> skipped</span>}
              {s.error && <span> {s.error}</span>}
            </li>
          ))}
        </ol>
      )}
      {entry.errors && entry.errors.length > 0 && (entry.errors.length === 1 ? <div className="small">{entry.errors[0]}</div> : <ul className="small">{entry.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>)}
      {entry.summary && <pre className="output small flow-summary">{entry.summary}</pre>}
    </div>
  );
}
