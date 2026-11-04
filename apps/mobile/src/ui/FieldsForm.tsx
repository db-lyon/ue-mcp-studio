/**
 * Forms.tsx FieldsForm: a control per field (a box for text, a picker for a
 * choice, a number box, a checkbox) and the form's buttons, for an
 * elicitation form and for /flow's inputs. `prefill` overrides the fields'
 * defaults; with `requireFilled`, Submit waits for every required field.
 */
import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { FormField } from "@ue-mcp-studio/shared";
import { Button, Banner, Sheet, T, font, useTheme } from "./index";
import { Chevron } from "./glyphs";
import { smallFont } from "./type";

const initial = (fields: Record<string, FormField>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, f.default ?? (f.type === "boolean" ? false : f.type === "string" && f.enum ? f.enum[0] : "")]));

/** What a form sends: the filled-in values, numbers as numbers, blanks left out. */
export function formContent(fields: Record<string, FormField>, values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values)
      .filter(([, v]) => v !== "")
      .map(([k, v]) => {
        const f = fields[k];
        return [k, f && (f.type === "number" || f.type === "integer") ? Number(v) : v];
      }),
  );
}

export function FieldsForm({
  fields,
  required,
  prefill,
  sent,
  error,
  submitLabel = "Submit",
  declineLabel = "Decline",
  requireFilled,
  topMargin = 6,
  onSubmit,
  onDecline,
}: {
  fields: Record<string, FormField>;
  required: string[];
  prefill?: Record<string, unknown>;
  sent: boolean;
  error: string | null;
  submitLabel?: string;
  declineLabel?: string;
  requireFilled?: boolean;
  /** Space above the first field: the 6 of its own margin, or 0 under a paragraph whose margin it collapses into. */
  topMargin?: number;
  onSubmit: (content: Record<string, unknown>) => void;
  onDecline: () => void;
}) {
  const t = useTheme();
  const [values, setValues] = useState<Record<string, unknown>>(() => ({ ...initial(fields), ...prefill }));
  const [picking, setPicking] = useState<string | null>(null);
  const set = (k: string, v: unknown) => setValues((cur) => ({ ...cur, [k]: v }));
  const missing = requireFilled && required.some((k) => values[k] === "" || values[k] === undefined);
  const base = { ...font(t, "sans", 400, t.base.size), lineHeight: t.base.lineHeight };
  const small = { ...smallFont(t), color: t.c.dim };
  // A field's text: 16 px on the body's line ratio; a text box is three of those lines tall.
  const line = 16 * (t.base.lineHeight / t.base.size);
  const box = { backgroundColor: t.c.panel2, color: t.c.text, borderColor: t.c.lineStrong, borderWidth: 1, borderRadius: t.radius, paddingVertical: 6, paddingHorizontal: 10, ...font(t, "sans", 400, 16), lineHeight: line, alignSelf: "stretch" as const };
  const picked = picking ? fields[picking] : null;
  return (
    <>
      {Object.entries(fields).map(([k, f], i) => {
        const first = i === 0 ? { marginTop: topMargin } : null;
        const label = f.title ?? k;
        if (f.type === "boolean") {
          const on = !!values[k];
          return (
            <Pressable key={k} accessibilityRole="checkbox" accessibilityLabel={label} accessibilityState={{ checked: on }} onPress={() => set(k, !on)} style={[s.toggle, first]}>
              <View style={[s.check, { borderColor: on ? t.c.accent : t.c.muted, backgroundColor: on ? t.c.accent : t.c.panel2 }]}>{on ? <Text style={{ color: "#ffffff", fontSize: 14, lineHeight: 16, fontWeight: "700" }}>{"✓"}</Text> : null}</View>
              <Text style={[base, { color: t.c.muted }]}>{label}</Text>
              {f.description ? <Text style={[small, { flex: 1, minWidth: 0 }]}>{f.description}</Text> : null}
            </Pressable>
          );
        }
        const optional = !required.includes(k);
        return (
          <View key={k} style={[s.field, first]}>
            <Text style={[base, { color: t.c.muted, textAlign: "center" }]}>
              {label}
              {optional ? <Text style={small}> (optional)</Text> : null}
            </Text>
            {f.type === "string" && f.enum ? (
              <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={() => setPicking(k)} style={[box, s.select]}>
                <Text style={{ ...font(t, "sans", 400, 16), color: t.c.text, flex: 1, paddingTop: 1.5 }} numberOfLines={1}>
                  {f.enumNames?.[f.enum.indexOf(String(values[k]))] ?? String(values[k] ?? "")}
                </Text>
                <Chevron open color={t.c.text} size={12} />
              </Pressable>
            ) : f.type === "string" ? (
              <TextInput accessibilityLabel={label} multiline numberOfLines={3} value={String(values[k] ?? "")} onChangeText={(v) => set(k, v)} placeholderTextColor={t.c.dim} selectionColor={t.c.selection} style={[box, { height: line * 3 + 14, textAlignVertical: "top" }]} />
            ) : (
              <TextInput accessibilityLabel={label} keyboardType="numeric" value={String(values[k] ?? "")} onChangeText={(v) => set(k, v)} selectionColor={t.c.selection} style={[box, { minHeight: 44 }]} />
            )}
            {f.description ? <Text style={[small, { textAlign: "center" }]}>{f.description}</Text> : null}
          </View>
        );
      })}
      {error ? (
        <Banner kind="bad">
          <T size={12} lh={1.55} style={{ color: t.c.badText }}>
            {error}
          </T>
        </Banner>
      ) : null}
      <View style={s.row}>
        <View style={{ flex: 1 }} />
        <Button title={declineLabel} disabled={sent} onPress={onDecline} />
        <Button title={submitLabel} variant="primary" disabled={sent || !!missing} onPress={() => onSubmit(formContent(fields, values))} />
      </View>
      <Sheet open={!!picked} title={picked?.title ?? picking ?? ""} onClose={() => setPicking(null)}>
        {picked && picked.type === "string"
          ? (picked.enum ?? []).map((v, i) => (
              <Pressable
                key={v}
                accessibilityRole="menuitem"
                accessibilityState={{ selected: values[picking!] === v }}
                onPress={() => {
                  set(picking!, v);
                  setPicking(null);
                }}
                style={[s.option, values[picking!] === v && { backgroundColor: t.c.accentWash }]}
              >
                <T>{picked.enumNames?.[i] ?? v}</T>
              </Pressable>
            ))
          : null}
      </Sheet>
    </>
  );
}

const s = StyleSheet.create({
  // Block margins collapse on the web: each control keeps 6 below and none above, so two read 6 apart.
  field: { flexDirection: "column", alignItems: "center", gap: 4, marginBottom: 6 },
  select: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 8 },
  toggle: { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: 10, marginBottom: 6, flexWrap: "wrap" },
  check: { width: 20, height: 20, marginTop: 1, marginLeft: 4, marginRight: 3, borderRadius: 3, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  row: { flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 6 },
  option: { minHeight: 44, justifyContent: "center", paddingHorizontal: 12, borderRadius: 6 },
});
