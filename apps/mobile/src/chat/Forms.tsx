// STUB: owned by chat-core. The web client's chat/Forms.tsx FieldsForm: a control per field and the form's buttons.
import { useState } from "react";
import { Text, View } from "react-native";
import type { FormField } from "@ue-mcp-studio/shared";
import { Banner, Button, Check, Input, Row, Spacer, T, useTheme } from "../ui";

const initial = (fields: Record<string, FormField>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, f.default ?? (f.type === "boolean" ? false : f.type === "string" && f.enum ? f.enum[0] : "")]));

export function formContent(fields: Record<string, FormField>, values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== "").map(([k, v]) => {
    const f = fields[k];
    return [k, f && (f.type === "number" || f.type === "integer") ? Number(v) : v];
  }));
}

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
  const [values, setValues] = useState<Record<string, unknown>>(() => ({ ...initial(fields), ...prefill }));
  const set = (k: string, v: unknown) => setValues((cur) => ({ ...cur, [k]: v }));
  const missing = requireFilled && required.some((k) => values[k] === "" || values[k] === undefined);
  return (
    <View>
      {Object.entries(fields).map(([k, f]) => {
        const label = f.title ?? k;
        return f.type === "boolean" ? (
          <Check key={k} checked={!!values[k]} onChange={(v) => set(k, v)} label={label}>{label}</Check>
        ) : (
          <View key={k} style={{ gap: 4, marginVertical: 6 }}>
            <T tone="muted">{label}{required.includes(k) ? "" : <Text style={{ color: t.c.dim, fontSize: 12 }}> (optional)</Text>}</T>
            <Input accessibilityLabel={label} value={String(values[k] ?? "")} onChangeText={(v) => set(k, v)} multiline={f.type === "string" && !f.enum} keyboardType={f.type === "number" || f.type === "integer" ? "numeric" : "default"} />
            {f.description ? <T tone="dim" size={12}>{f.description}</T> : null}
          </View>
        );
      })}
      {error ? <Banner kind="bad">{error}</Banner> : null}
      <Row>
        <Spacer />
        <Button title={declineLabel} variant="ghost" disabled={sent} onPress={onDecline} />
        <Button title={submitLabel} variant="primary" disabled={sent || !!missing} onPress={() => onSubmit(formContent(fields, values))} />
      </Row>
    </View>
  );
}

// STUB: owned by transcript (area-c): the pending forms and their cards.
import type { PendingForm } from "@ue-mcp-studio/shared";
import type { DaemonState } from "./hooks";

export function useForms(_daemon: Pick<DaemonState, "events" | "streaming">, _sessionId: string | null): PendingForm[] {
  return [];
}

export function FormCards(_props: { forms: PendingForm[]; runs?: ReadonlySet<string> }) {
  return null;
}
