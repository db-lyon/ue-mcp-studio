import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { qaVerdictForm, type FormField, type PendingForm } from "@ue-mcp-studio/shared";
import { formContent, formInitial } from "@ue-mcp-studio/client-core";
import { Banner, bannerText, baseFont, Card, Check, ContentButton, font, fontName, Input, lineBox, SelectArrow, Sheet, useTheme } from "../../../ui";
import { useProjectNav } from "../../../nav";
import { haptic } from "../../../native/haptics";
import { CardsRegion } from "./Approvals";
import { QaCard, qaRunFromForm } from "../../../chat/Qa";
import type { DaemonState } from "../../../chat/hooks";

export { formContent };

/** The forms waiting in this session, kept current from studio.form.changed. */
export function useForms(daemon: Pick<DaemonState, "events" | "streaming">, sessionId: string | null): PendingForm[] {
  const { api } = useProjectNav();
  const [forms, setForms] = useState<PendingForm[]>([]);
  const last = [...daemon.events].reverse().find((e) => e.type === "studio.form.changed");
  useEffect(() => {
    if (!daemon.streaming || !sessionId) return void setForms([]);
    // An older Studio agent has no route; nothing shows then.
    api.forms(sessionId).then((r) => setForms(r.forms), () => setForms([]));
  }, [daemon.streaming, sessionId, last?.id, api]);
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
    <CardsRegion label="Waiting for your answer" testID="forms">
      {shown.map((f) => {
        const run = qaRunFromForm(f);
        return run ? <QaCard key={f.id} run={run} form={f} /> : <FormCard key={f.id} form={f} />;
      })}
    </CardsRegion>
  );
}

/** A select on a phone: the chosen option and a caret; a press lists the options in a sheet. */
function Select({ value, options, names, label, onChange }: { value: string; options: string[]; names?: string[]; label: string; onChange: (v: string) => void }) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const name = (v: string) => names?.[options.indexOf(v)] ?? v;
  return (
    <>
      <Pressable accessibilityRole="combobox" accessibilityLabel={label} accessibilityState={{ expanded: open }} onPress={() => setOpen(true)} style={{ flexDirection: "row", alignItems: "center", minHeight: 44, paddingVertical: 6, paddingHorizontal: 10, backgroundColor: t.c.panel2, borderWidth: 1, borderColor: t.c.lineStrong, borderRadius: t.radius }}>
        {/* The browser's select sets its value 4px in from its own padding, and half a pixel lower than centring its line would. */}
        <Text style={{ ...font(t, "sans", 400, 16), color: t.c.text, flex: 1, marginLeft: 4, position: "relative", top: 0.5 }} numberOfLines={1}>{name(value)}</Text>
        <SelectArrow />
      </Pressable>
      <Sheet open={open} title={label} onClose={() => setOpen(false)}>
        {options.map((o) => (
          <Pressable key={o} accessibilityRole="menuitem" accessibilityState={{ selected: o === value }} onPress={() => (onChange(o), setOpen(false))} style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 10, borderRadius: t.radius, backgroundColor: o === value ? t.c.accentWash : "transparent" }}>
            <Text style={{ ...baseFont(t), color: t.c.text }}>{name(o)}</Text>
          </Pressable>
        ))}
      </Sheet>
    </>
  );
}

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
  const t = useTheme();
  const [values, setValues] = useState<Record<string, unknown>>(() => ({ ...formInitial(fields), ...prefill }));
  const set = (k: string, v: unknown) => setValues((cur) => ({ ...cur, [k]: v }));
  const missing = requireFilled && required.some((k) => values[k] === "" || values[k] === undefined);
  const submit = () => {
    if (!sent && !missing) onSubmit(formContent(fields, values));
  };
  // The body's line-height multiple (1.55, or 1.5 in the editor themes), not the quotient of its already-cut line box.
  const lh = Math.round((t.base.lineHeight / t.base.size) * 100) / 100;
  const entries = Object.entries(fields);
  const main = entries.filter(([k]) => required.includes(k));
  const more = entries.filter(([k]) => !required.includes(k));
  // With something required, the optional fields fold away unless one was typed already (the web's .form-more).
  const fold = main.length > 0 && more.length > 0;
  const [open, setOpen] = useState(() => !fold || more.some(([k]) => prefill?.[k] !== undefined));
  const field = ([k, f]: [string, FormField]) => (
    <FormFieldRow key={k} name={k} field={f} value={values[k]} required={required.includes(k)} lh={lh} onChange={(v) => set(k, v)} onEnter={submit} />
  );
  // .form-fields: a column 12px apart, flush left.
  return (
    <View style={{ gap: 12, marginTop: 4 }}>
      {(fold ? main : entries).map(field)}
      {fold ? (
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={`${more.length} optional`} onPress={() => setOpen(!open)} hitSlop={8} style={{ flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", minHeight: 32 }}>
          <Text style={{ ...font(t, "sans", 500, 10), color: t.c.muted, width: 10 }}>{open ? "▾" : "▸"}</Text>
          <Text style={{ ...font(t, "sans", 500, 12, 1.4), color: t.c.muted }}>{more.length} optional</Text>
        </Pressable>
      ) : null}
      {fold && open ? more.map(field) : null}
      {error ? (
        <Banner kind="bad" style={{ marginBottom: 0 }}>
          <Text style={{ ...font(t, "sans", 400, 12, lh), color: bannerText(t, "bad") }}>{error}</Text>
        </Banner>
      ) : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10, marginTop: 2 }}>
        <View style={{ flex: 1 }} />
        <ContentButton kind="ghost" title={declineLabel} disabled={sent} onPress={onDecline} />
        <ContentButton kind="primary" title={submitLabel} disabled={sent || !!missing} onPress={submit} />
      </View>
    </View>
  );
}

/** A choice short enough to show every option as a button (the web's .form-seg). */
const segmented = (f: FormField): f is Extract<FormField, { type: "string" }> & { enum: string[] } =>
  f.type === "string" && !!f.enum && f.enum.length <= 4 && f.enum.every((v, i) => (f.enumNames?.[i] ?? v).length <= 12);

/** One field, as the web's .form-field: its name in mono with OPTIONAL, what it is for, then its control, flush left. */
function FormFieldRow({ name, field: f, value, required, lh, onChange, onEnter }: {
  name: string;
  field: FormField;
  value: unknown;
  required: boolean;
  lh: number;
  onChange: (v: unknown) => void;
  onEnter: () => void;
}) {
  const t = useTheme();
  const label = f.title ?? name;
  const nameStyle = { ...font(t, "mono", 600, 12, 1.3), color: t.c.text };
  const help = f.description ? <Text style={{ ...font(t, "sans", 400, 12, 1.45), color: t.c.muted }}>{f.description}</Text> : null;
  if (f.type === "boolean") {
    return (
      <Check label={label} checked={!!value} onChange={(v) => onChange(v)}>
        <View style={{ flexShrink: 1, gap: 2, marginLeft: 8 }}>
          <Text style={nameStyle}>{label}</Text>
          {help}
        </View>
      </Check>
    );
  }
  let control;
  if (segmented(f)) {
    const current = String(value ?? "");
    control = (
      <View accessibilityRole="radiogroup" accessibilityLabel={label} style={{ flexDirection: "row", alignSelf: "flex-start", maxWidth: "100%", borderWidth: 1, borderColor: t.c.lineStrong, borderRadius: t.radius, overflow: "hidden" }}>
        {f.enum.map((v, i) => {
          const on = current === v;
          return (
            <Pressable
              key={v}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              onPress={() => onChange(v)}
              style={{ minHeight: 36, justifyContent: "center", paddingHorizontal: 14, backgroundColor: on ? t.c.accentWash : t.c.panel2, borderRightWidth: i < f.enum.length - 1 ? 1 : 0, borderRightColor: t.c.lineStrong, borderBottomWidth: 2, borderBottomColor: on ? t.c.accent : "transparent" }}
            >
              <Text style={{ ...font(t, "sans", 500, 13, 1.4), color: on ? t.c.text : t.c.muted }}>{f.enumNames?.[i] ?? v}</Text>
            </Pressable>
          );
        })}
      </View>
    );
  } else if (f.type === "string" && f.enum) {
    control = <Select label={label} value={String(value ?? "")} options={f.enum} names={f.enumNames} onChange={(v) => onChange(v)} />;
  } else if (f.type === "string" && f.multiline) {
    control = <Input accessibilityLabel={label} multiline numberOfLines={2} autoCapitalize="none" autoCorrect={false} value={String(value ?? "")} onChangeText={(v) => onChange(v)} style={{ ...font(t, "mono", 400, 14), height: 2 * lineBox(14, lh) + 14, lineHeight: lineBox(14, lh), textAlignVertical: "top" }} />;
  } else {
    control = (
      <Input
        accessibilityLabel={label}
        keyboardType={f.type === "string" ? "default" : "numeric"}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="go"
        onSubmitEditing={onEnter}
        value={String(value ?? "")}
        onChangeText={(v) => onChange(v)}
        style={{ ...font(t, "mono", 400, 14) }}
      />
    );
  }
  return (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
        <Text style={nameStyle}>{label}</Text>
        {!required ? <Text style={{ ...font(t, "sans", 500, 10), letterSpacing: 0.4, color: t.c.dim }}>OPTIONAL</Text> : null}
      </View>
      {help}
      {control}
    </View>
  );
}

/** One form: its message, a control per field, and Submit or Decline. */
export function FormCard({ form }: { form: PendingForm }) {
  const t = useTheme();
  const { api } = useProjectNav();
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = (answer: Parameters<typeof api.answerForm>[1]) => {
    haptic.success();
    setSent(true);
    setError(null);
    api.answerForm(form.id, answer).catch((e: Error) => {
      setSent(false);
      setError(e.message);
    });
  };
  return (
    <Card style={t.shadow ? { boxShadow: "0 20px 40px -24px rgba(0, 0, 0, 0.6)", ...(t.editor ? { borderColor: "transparent" } : null) } : t.editor ? { borderColor: "transparent" } : undefined}>
      <View accessibilityLabel={`A question from ${form.call}`} style={{ flexDirection: "row", alignItems: "baseline", gap: 10 }}>
        <Text style={{ ...baseFont(t), ...font(t, "sans", 700, t.base.size), lineHeight: t.base.lineHeight }}>Your answer is needed</Text>
        <Text style={{ ...baseFont(t), fontSize: 12, color: t.c.dim, flexShrink: 1 }}>{form.call}</Text>
      </View>
      <ScrollView nestedScrollEnabled style={{ maxHeight: 240, marginVertical: 6 }}>
        <Text style={{ fontFamily: fontName("system-mono"), fontSize: 12, color: t.c.text }} selectable>{form.message}</Text>
      </ScrollView>
      <FieldsForm
        fields={form.fields}
        required={form.required}
        sent={sent}
        error={error}
        onSubmit={(content) => send({ action: "accept", content })}
        onDecline={() => send({ action: "decline" })}
      />
    </Card>
  );
}

/** The forms of one session, where the chat shows them. */
export function SessionForms({ daemon, sessionId, runs }: { daemon: Pick<DaemonState, "events" | "streaming">; sessionId: string; runs?: ReadonlySet<string> }) {
  return <FormCards forms={useForms(daemon, sessionId)} runs={runs} />;
}
