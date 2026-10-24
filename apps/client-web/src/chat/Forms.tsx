import { useEffect, useState } from "react";
import { qaVerdictForm, type FormField, type PendingForm } from "@ue-mcp-studio/shared";
import { api } from "../api";
import type { DaemonState } from "../state";
import { QaCard, qaRunFromForm } from "./Qa";

/** The forms waiting in this session, kept current from studio.form.changed. */
export function useForms(daemon: Pick<DaemonState, "events" | "streaming">, sessionId: string | null): PendingForm[] {
  const [forms, setForms] = useState<PendingForm[]>([]);
  const last = [...daemon.events].reverse().find((e) => e.type === "studio.form.changed");
  useEffect(() => {
    if (!daemon.streaming || !sessionId) return void setForms([]);
    // An older Studio agent has no route; nothing shows then.
    api.forms(sessionId).then((r) => setForms(r.forms), () => setForms([]));
  }, [daemon.streaming, sessionId, last?.id]);
  return forms;
}

/**
 * Forms ue-mcp raised during this session's calls, such as approving a feedback
 * report. A playtest's verdict form is answered on its run's Playtest card:
 * here only when that run has no card on screen (`runs`), as a card of its own.
 */
export function FormCards({ forms, runs }: { forms: PendingForm[]; runs?: ReadonlySet<string> }) {
  const shown = forms.filter((f) => {
    const q = qaVerdictForm(f);
    return !q || !q.runId || !runs?.has(q.runId);
  });
  if (shown.length === 0) return null;
  return (
    <div className="approvals" role="region" aria-label="Waiting for your answer">
      {shown.map((f) => {
        const run = qaRunFromForm(f);
        return run ? <QaCard key={f.id} run={run} form={f} /> : <FormCard key={f.id} form={f} />;
      })}
    </div>
  );
}

const initial = (fields: Record<string, FormField>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, f.default ?? (f.type === "boolean" ? false : f.type === "string" && f.enum ? f.enum[0] : "")]));

/** One form: its message, a control per field, and Submit or Decline. */
export function FormCard({ form }: { form: PendingForm }) {
  const [values, setValues] = useState<Record<string, unknown>>(() => initial(form.fields));
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: string, v: unknown) => setValues((cur) => ({ ...cur, [k]: v }));
  const send = (answer: Parameters<typeof api.answerForm>[1]) => {
    setSent(true);
    setError(null);
    api.answerForm(form.id, answer).catch((e: Error) => {
      setSent(false);
      setError(e.message);
    });
  };
  const content = () => Object.fromEntries(Object.entries(values).filter(([, v]) => v !== "").map(([k, v]) => {
    const f = form.fields[k];
    return [k, f && (f.type === "number" || f.type === "integer") ? Number(v) : v];
  }));
  return (
    <div className="approval-card card" role="group" aria-label={`A question from ${form.call}`}>
      <div className="approval-head">
        <strong>Your answer is needed</strong>
        <span className="dim small">{form.call}</span>
      </div>
      <pre className="form-message">{form.message}</pre>
      {Object.entries(form.fields).map(([k, f]) => {
        const label = f.title ?? k;
        const required = form.required.includes(k);
        return (
          <label key={k} className={f.type === "boolean" ? "row toggle" : "form-field"}>
            {f.type === "boolean" ? (
              <>
                <input type="checkbox" checked={!!values[k]} onChange={(e) => set(k, e.target.checked)} />
                <span>{label}</span>
              </>
            ) : (
              <>
                <span>{label}{required ? "" : <span className="dim small"> (optional)</span>}</span>
                {f.type === "string" && f.enum ? (
                  <select value={String(values[k] ?? "")} onChange={(e) => set(k, e.target.value)}>
                    {f.enum.map((v, i) => <option key={v} value={v}>{f.enumNames?.[i] ?? v}</option>)}
                  </select>
                ) : f.type === "string" ? (
                  <textarea rows={3} value={String(values[k] ?? "")} onChange={(e) => set(k, e.target.value)} />
                ) : (
                  <input type="number" value={String(values[k] ?? "")} onChange={(e) => set(k, e.target.value)} />
                )}
              </>
            )}
            {f.description && <span className="dim small">{f.description}</span>}
          </label>
        );
      })}
      {error && <div className="banner bad small">{error}</div>}
      <div className="row">
        <span className="spacer" />
        <button className="ghost" disabled={sent} onClick={() => send({ action: "decline" })}>Decline</button>
        <button className="primary" disabled={sent} onClick={() => send({ action: "accept", content: content() })}>Submit</button>
      </div>
    </div>
  );
}

/** The forms of one session, where the chat shows them. */
export function SessionForms({ daemon, sessionId, runs }: { daemon: DaemonState; sessionId: string; runs?: ReadonlySet<string> }) {
  return <FormCards forms={useForms(daemon, sessionId)} runs={runs} />;
}
