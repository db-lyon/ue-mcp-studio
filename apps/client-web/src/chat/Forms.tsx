import { useEffect, useState, type KeyboardEvent } from "react";
import { qaVerdictForm, type FormField, type PendingForm } from "@ue-mcp-studio/shared";
import { api } from "../api";
import type { DaemonState } from "../state";
import { QaCard, qaRunFromForm } from "./Qa";
import { formContent, formInitial } from "@ue-mcp-studio/client-core";

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

export { formContent } from "@ue-mcp-studio/client-core";

/**
 * A control per field and the form's buttons: the body of an elicitation
 * form, and of /flow's form for a flow's inputs. `prefill` overrides the
 * fields' defaults. With `requireFilled`, Submit waits for every required field.
 */
export function FieldsForm({ fields, required, prefill, sent, error, submitLabel = "Submit", declineLabel = "Decline", requireFilled, onSubmit, onDecline }: {
  fields: Record<string, FormField>;
  required: string[];
  prefill?: Record<string, unknown>;
  sent: boolean;
  error: string | null;
  submitLabel?: string;
  declineLabel?: string;
  requireFilled?: boolean;
  onSubmit: (content: Record<string, unknown>) => void;
  onDecline: () => void;
}) {
  const [values, setValues] = useState<Record<string, unknown>>(() => ({ ...formInitial(fields), ...prefill }));
  const set = (k: string, v: unknown) => setValues((cur) => ({ ...cur, [k]: v }));
  const missing = requireFilled && required.some((k) => values[k] === "" || values[k] === undefined);
  const submit = () => {
    if (!sent && !missing) onSubmit(formContent(fields, values));
  };
  const entries = Object.entries(fields);
  const main = entries.filter(([k]) => required.includes(k));
  const more = entries.filter(([k]) => !required.includes(k));
  // With something required, the optional fields fold away unless one was typed already.
  const fold = main.length > 0 && more.length > 0;
  const [open, setOpen] = useState(() => !fold || more.some(([k]) => prefill?.[k] !== undefined));
  const field = ([k, f]: [string, FormField], i: number) => (
    <FormFieldRow key={k} name={k} field={f} value={values[k]} required={required.includes(k)} autoFocus={i === 0} onChange={(v) => set(k, v)} onEnter={submit} />
  );
  return (
    <div className="form-fields">
      {(fold ? main : entries).map(field)}
      {fold && (
        <>
          <button type="button" className="form-more" aria-expanded={open} onClick={() => setOpen(!open)}>
            <span className="form-more-mark" aria-hidden>{open ? "▾" : "▸"}</span>
            {more.length} optional
          </button>
          {open && more.map((e) => field(e, -1))}
        </>
      )}
      {error && <div className="banner bad small">{error}</div>}
      <div className="row form-actions">
        <span className="spacer" />
        <button className="ghost" disabled={sent} onClick={onDecline}>{declineLabel}</button>
        <button className="primary" disabled={sent || missing} onClick={submit}>{submitLabel}</button>
      </div>
    </div>
  );
}

/** A choice short enough to show every option as a button. */
const segmented = (f: FormField): f is Extract<FormField, { type: "string" }> & { enum: string[] } =>
  f.type === "string" && !!f.enum && f.enum.length <= 4 && f.enum.every((v, i) => (f.enumNames?.[i] ?? v).length <= 12);

/** One field: its name (and whether it may be left out), what it is for, and its control. */
function FormFieldRow({ name, field: f, value, required, autoFocus, onChange, onEnter }: {
  name: string;
  field: FormField;
  value: unknown;
  required: boolean;
  autoFocus: boolean;
  onChange: (v: unknown) => void;
  onEnter: () => void;
}) {
  const label = f.title ?? name;
  const id = `form-field-${name}`;
  const enter = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onEnter();
    }
  };
  if (f.type === "boolean") {
    return (
      <label className="form-field form-check">
        <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
        <span className="form-label">{label}</span>
        {f.description && <span className="form-help">{f.description}</span>}
      </label>
    );
  }
  let control;
  if (segmented(f)) {
    control = (
      <div className="form-seg" role="radiogroup" aria-labelledby={`${id}-label`}>
        {f.enum.map((v, i) => (
          <button key={v} type="button" role="radio" aria-checked={String(value ?? "") === v} className={String(value ?? "") === v ? "on" : undefined} onClick={() => onChange(v)}>
            {f.enumNames?.[i] ?? v}
          </button>
        ))}
      </div>
    );
  } else if (f.type === "string" && f.enum) {
    control = (
      <select id={id} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}>
        {f.enum.map((v, i) => <option key={v} value={v}>{f.enumNames?.[i] ?? v}</option>)}
      </select>
    );
  } else if (f.type === "string" && f.multiline) {
    control = <textarea id={id} rows={2} spellCheck={false} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} />;
  } else {
    control = (
      <input
        id={id}
        type={f.type === "string" ? "text" : "number"}
        spellCheck={false}
        autoFocus={autoFocus}
        value={String(value ?? "")}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={enter}
      />
    );
  }
  return (
    <div className="form-field">
      <label className="form-label" id={`${id}-label`} htmlFor={id}>
        {label}
        {!required && <span className="form-optional">optional</span>}
      </label>
      {f.description && <span className="form-help">{f.description}</span>}
      {control}
    </div>
  );
}

/** One form: its message, a control per field, and Submit or Decline. */
export function FormCard({ form }: { form: PendingForm }) {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = (answer: Parameters<typeof api.answerForm>[1]) => {
    setSent(true);
    setError(null);
    api.answerForm(form.id, answer).catch((e: Error) => {
      setSent(false);
      setError(e.message);
    });
  };
  return (
    <div className="approval-card card" role="group" aria-label={`A question from ${form.call}`}>
      <div className="approval-head">
        <strong>Your answer is needed</strong>
        <span className="dim small">{form.call}</span>
      </div>
      <pre className="form-message">{form.message}</pre>
      <FieldsForm
        fields={form.fields}
        required={form.required}
        sent={sent}
        error={error}
        onSubmit={(content) => send({ action: "accept", content })}
        onDecline={() => send({ action: "decline" })}
      />
    </div>
  );
}

/** The forms of one session, where the chat shows them. */
export function SessionForms({ daemon, sessionId, runs }: { daemon: DaemonState; sessionId: string; runs?: ReadonlySet<string> }) {
  return <FormCards forms={useForms(daemon, sessionId)} runs={runs} />;
}
