/**
 * The model and effort picker: every vendor's models once, the ones nothing
 * connected can run greyed out (signing in and keys stay on the computer), and
 * the effort under them. The chip names the current pair.
 */
import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { EFFORTS, EFFORT_NAMES, routesInOrder, type Effort, type ModelCatalog, type ModelOption, type StudioSettings } from "@ue-mcp-studio/shared";
import type { StudioApi } from "@ue-mcp-studio/client-core";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { s as ui, Spinner } from "./ui";
import { colors } from "./theme";

type Vendor = ModelCatalog["providers"][number];

/** Whether anything connected runs this model now: its endpoint, a sign-in that is done, or the vendor's saved key. */
function runnable(catalog: ModelCatalog, vendor: Vendor, m: ModelOption): boolean {
  if (vendor.endpoint) return true;
  return routesInOrder(m.signIns, catalog.routeOrder).some((r) => (r === "key" ? vendor.connected : catalog.signedIn[r]));
}

export function modelName(catalog: ModelCatalog | null, settings: StudioSettings): string {
  const v = catalog?.providers.find((p) => p.id === settings.provider);
  return v?.models.find((m) => m.id === settings.model)?.name ?? settings.model ?? "Model";
}

export function ModelPicker({ api, settings, onSave, disabled }: { api: StudioApi; settings: StudioSettings; onSave: (u: { provider?: StudioSettings["provider"]; model?: string; effort?: Effort }) => Promise<unknown>; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const insets = useSafeAreaInsets();

  useEffect(() => {
    api.models().then(setCatalog, () => setCatalog(null));
  }, [api, settings.provider, settings.model, settings.connected]);

  const save = async (u: Parameters<typeof onSave>[0], close: boolean) => {
    setSaving(true);
    setError(null);
    try {
      await onSave(u);
      if (close) setOpen(false);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Pressable accessibilityRole="button" accessibilityLabel="Model and effort" disabled={disabled} onPress={() => setOpen(true)} style={({ pressed }) => [p.chip, (pressed || disabled) && { opacity: 0.6 }]}>
        <Text style={p.chipText} numberOfLines={1}>
          {modelName(catalog, settings)} {"·"} {EFFORT_NAMES[settings.effort] ?? settings.effort}
        </Text>
      </Pressable>
      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <Pressable style={p.backdrop} onPress={() => setOpen(false)} />
        <View style={[p.sheet, { paddingBottom: 16 + insets.bottom }]}>
          <View style={p.sheetHead}>
            <Text style={ui.name}>Model</Text>
            {saving ? <Spinner /> : null}
            <Pressable accessibilityRole="button" onPress={() => setOpen(false)} hitSlop={12}>
              <Text style={ui.link}>Done</Text>
            </Pressable>
          </View>
          {error ? <Text style={ui.error}>{error}</Text> : null}
          <ScrollView style={{ maxHeight: 420 }}>
            {!catalog ? <Spinner /> : null}
            {catalog?.providers.map((v) => (
              <View key={v.id}>
                <Text style={ui.section}>{v.name}</Text>
                {v.models.map((m) => {
                  const can = runnable(catalog, v, m);
                  const current = v.id === settings.provider && m.id === settings.model;
                  return (
                    <Pressable key={m.id} accessibilityRole="button" accessibilityState={{ selected: current, disabled: !can }} disabled={!can || saving} onPress={() => void save({ provider: v.id, model: m.id }, true)} style={({ pressed }) => [p.option, current && p.optionOn, pressed && { opacity: 0.7 }]}>
                      <Text style={[ui.name, !can && { color: colors.faint }]}>{m.name}</Text>
                      {!can ? <Text style={ui.sub}>Connect on your computer</Text> : current ? <Text style={[ui.sub, { color: colors.accent }]}>Selected</Text> : null}
                    </Pressable>
                  );
                })}
              </View>
            ))}
          </ScrollView>
          <Text style={ui.section}>Effort</Text>
          <View style={p.efforts}>
            {EFFORTS.map((e) => (
              <Pressable key={e} accessibilityRole="button" accessibilityState={{ selected: e === settings.effort }} disabled={saving} onPress={() => void save({ effort: e }, false)} style={[p.effort, e === settings.effort && p.effortOn]}>
                <Text style={[ui.sub, e === settings.effort && { color: colors.onAccent, fontWeight: "600" }]}>{EFFORT_NAMES[e]}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      </Modal>
    </>
  );
}

const p = StyleSheet.create({
  chip: { borderWidth: 1, borderColor: colors.border, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5, maxWidth: 220 },
  chipText: { color: colors.muted, fontSize: 12 },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)" },
  sheet: { backgroundColor: colors.panel, borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingHorizontal: 20, paddingTop: 14 },
  sheetHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 6 },
  option: { paddingVertical: 10, paddingHorizontal: 10, borderRadius: 8 },
  optionOn: { backgroundColor: "rgba(232,114,12,0.10)" },
  efforts: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  effort: { borderWidth: 1, borderColor: colors.border, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 6 },
  effortOn: { backgroundColor: colors.accent, borderColor: colors.accent },
});
