import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { qaVerdictForm, type FormField, type PendingForm } from "@ue-mcp-studio/shared";
import { formContent, formInitial } from "@ue-mcp-studio/client-core";
import { Banner, baseFont, Card, Check, ContentButton, font, fontName, Input, Sheet, useTheme } from "../ui";
import { useProjectNav } from "../nav";
import { haptic } from "../native/haptics";
import { CardsRegion } from "./Approvals";
import { QaCard, qaRunFromForm } from "./Qa";

export { formContent };

/** The forms waiting in this session, kept current from studio.form.changed. */
export function useForms(sessionId: string | null): PendingForm[] {
  const { project, api } = useProjectNav();
  const [forms, setForms] = useState<PendingForm[]>([]);
  const [changed, setChanged] = useState(0);
  useEffect(() => project.onEvent((e) => e.type === "studio.form.changed" && setChanged((n) => n + 1)), [project]);
  useEffect(() => {
    if (project.live !== "live" || !sessionId) return void setForms([]);
    // An older Studio agent has no route; nothing shows then.
    api.forms(sessionId).then((r) => setForms(r.forms), () => setForms([]));
  }, [project.live, sessionId, changed, api]);
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
    <CardsRegion label="Waiting for your answer">
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
        <Text style={{ ...font(t, "sans", 400, 16), color: t.c.text, flex: 1 }} numberOfLines={1}>{name(value)}</Text>
        <Text style={{ color: t.c.muted, fontSize: 12 }}>{"▾"}</Text>
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
  const muted = { ...baseFont(t), color: t.c.muted };
  const small = { ...baseFont(t), fontSize: 12, lineHeight: 12 * (t.base.lineHeight / t.base.size), color: t.c.dim };
  return (
    <>
      {Object.entries(fields).map(([k, f]) => {
        const label = f.title ?? k;
        const isRequired = required.includes(k);
        if (f.type === "boolean")
          return (
            <View key={k}>
              <Check label={label} checked={!!values[k]} onChange={(v) => set(k, v)}>
                <Text style={muted}>{label}</Text>
              </Check>
              {f.description ? <Text style={small}>{f.description}</Text> : null}
            </View>
          );
        return (
          <View key={k} style={{ gap: 4, marginVertical: 6 }}>
            <Text style={muted}>
              {label}
              {isRequired ? "" : <Text style={small}> (optional)</Text>}
            </Text>
            {f.type === "string" && f.enum ? (
              <Select label={label} value={String(values[k] ?? "")} options={f.enum} names={f.enumNames} onChange={(v) => set(k, v)} />
            ) : f.type === "string" ? (
              <Input accessibilityLabel={label} multiline numberOfLines={3} value={String(values[k] ?? "")} onChangeText={(v) => set(k, v)} style={{ minHeight: 3 * 24 + 14, textAlignVertical: "top" }} />
            ) : (
              <Input accessibilityLabel={label} keyboardType="numeric" value={String(values[k] ?? "")} onChangeText={(v) => set(k, v)} />
            )}
            {f.description ? <Text style={small}>{f.description}</Text> : null}
          </View>
        );
      })}
      {error ? <Banner kind="bad" style={{ marginBottom: 10 }}>{error}</Banner> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10, marginVertical: 6 }}>
        <View style={{ flex: 1 }} />
        <ContentButton kind="ghost" title={declineLabel} disabled={sent} onPress={onDecline} />
        <ContentButton kind="primary" title={submitLabel} disabled={sent || !!missing} onPress={() => onSubmit(formContent(fields, values))} />
      </View>
    </>
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
export function SessionForms({ sessionId, runs }: { sessionId: string; runs?: ReadonlySet<string> }) {
  return <FormCards forms={useForms(sessionId)} runs={runs} />;
}
