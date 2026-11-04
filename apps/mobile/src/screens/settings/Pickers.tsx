/**
 * Settings > Agents' model and effort controls (client-web ModelPicker and
 * EffortPicker): the picker button with the route it runs on and a caret, and
 * the effort box. Each opens its choices in a sheet. A model nothing connected
 * can run says that signing in runs on the computer.
 */
import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { REMOTE_CHANGE_NOTE, findModel, runsVia, viaName } from "@ue-mcp-studio/client-core";
import { EFFORTS, EFFORT_NAMES, KEY_PROVIDER_IDS, PROVIDERS, anythingConnected, type Effort, type KeyProviderId, type ModelCatalog, type StudioSettings, type VendorId } from "@ue-mcp-studio/shared";
import { Banner, Sheet, bannerText, font, labelFont, T, useTheme } from "../../ui";
import { Txt } from "./controls";
import { useSettingsApi } from "./hooks";

/** A picker that follows the main agent's choice unless one is picked. */
export interface Follow<T> {
  value: T | null;
  same: string;
  onPick: (v: T | null) => Promise<unknown>;
  label: string;
}

export function useCatalog(settings: StudioSettings | null): ModelCatalog | null {
  const api = useSettingsApi();
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  useEffect(() => {
    if (settings) api.models().then(setCatalog, () => setCatalog(null));
  }, [api, settings?.connected, settings?.provider, settings?.model]);
  return catalog;
}

/** button.picker-button: 44px tall at a finger, the model, its route in a pill, a caret. */
export function ModelPicker({ settings, onSettings, follow, disabled }: { settings: StudioSettings; onSettings: (s: StudioSettings) => void; follow?: Follow<string>; disabled?: boolean }) {
  const api = useSettingsApi();
  const t = useTheme();
  const catalog = useCatalog(settings);
  const [open, setOpen] = useState(false);
  const [locked, setLocked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const providers = follow ? (catalog?.providers ?? []).filter((p) => p.id === settings.provider && KEY_PROVIDER_IDS.includes(p.id as KeyProviderId)) : catalog?.providers ?? [];
  const current = follow ? (follow.value === null ? null : findModel(catalog, settings.provider, follow.value)) : findModel(catalog, settings.provider, settings.model);
  const via = follow ? null : settings.route;
  const shown = follow ? (follow.value === null ? follow.same : current?.model.name ?? follow.value) : anythingConnected(settings) ? current?.model.name ?? settings.model : "Choose a model";
  const done = () => {
    setOpen(false);
    setLocked(null);
  };
  const select = (vendor: VendorId, model: string | null) =>
    (follow ? follow.onPick(model).then(done) : api.saveSettings({ provider: vendor, model: model! }).then((s) => (onSettings(s), done()))).catch((e: Error) => setError(e.message));
  return (
    <>
      <Box
        label={follow ? `${follow.label}: ${shown}` : "Model"}
        disabled={disabled}
        onPress={() => setOpen(true)}
        text={shown}
        via={via ? viaName(via, current?.vendor.name ?? (via === "key" ? PROVIDERS[settings.provider as KeyProviderId]?.name ?? settings.provider : settings.provider)) : null}
      />
      <Sheet open={open} title={follow ? follow.label : "Model"} onClose={done}>
        {error ? (
          <Banner kind="bad">
            <Txt size={12} style={{ color: bannerText(t, "bad") }}>
              {error}
            </Txt>
          </Banner>
        ) : null}
        {follow ? <Item text={follow.same} current={follow.value === null} onPress={() => void select(settings.provider, null)} /> : null}
        {providers.map((p) => (
          <View key={p.id} style={{ borderTopWidth: 1, borderTopColor: t.c.line, marginTop: 4, paddingTop: 4 }}>
            <T style={[labelFont(t), { paddingTop: 6, paddingHorizontal: 8, paddingBottom: 4 }]}>{p.name}</T>
            {p.models.map((m) => {
              const runs = catalog ? runsVia(catalog, p, m) : null;
              const selected = follow ? follow.value === m.id : settings.provider === p.id && settings.model === m.id;
              return (
                <View key={m.id}>
                  <Item text={m.name} current={selected} locked={!runs} via={runs ? viaName(runs, p.name) : m.signIns.length ? "sign in" : "connect"} onPress={() => (runs ? void select(p.id, m.id) : setLocked(`${p.id}:${m.id}`))} />
                  {locked === `${p.id}:${m.id}` ? (
                    <Txt size={12} tone="dim" style={{ paddingHorizontal: 8, paddingBottom: 6 }}>
                      {REMOTE_CHANGE_NOTE}
                    </Txt>
                  ) : null}
                </View>
              );
            })}
          </View>
        ))}
        {!catalog ? <Txt size={12} tone="muted">Loading models</Txt> : null}
      </Sheet>
    </>
  );
}

/** How long the model reasons: the effort box, its choices in a sheet. */
export function EffortPicker({ settings, onSettings, follow, disabled }: { settings: StudioSettings; onSettings: (s: StudioSettings) => void; follow?: Follow<Effort>; disabled?: boolean }) {
  const api = useSettingsApi();
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const off = disabled || settings.route === null;
  const value = follow ? follow.value : settings.effort;
  const pick = (effort: Effort | null) => {
    setOpen(false);
    void (follow ? follow.onPick(effort) : api.saveSettings({ effort: effort! }).then(onSettings)).catch(() => undefined);
  };
  return (
    <>
      <Pressable accessibilityRole="button" accessibilityLabel={follow?.label ?? "Effort"} accessibilityState={{ disabled: off }} disabled={off} onPress={() => setOpen(true)} style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: 10, paddingRight: 4, borderWidth: 1, borderColor: t.c.line, borderRadius: 6, backgroundColor: t.c.panel, alignSelf: "flex-start", marginRight: 14 }}>
        {/* A label keeps the page's 14px after it, so the box wraps under the model where the web page's does. */}
        <T style={[font(t, "sans", 500, 12, 1), { color: t.c.dim }]}>Effort</T>
        {/* The select: as wide as its longest choice, plus the 28px the page keeps for its arrow and the 20px the browser adds. */}
        <View style={{ minHeight: 44, paddingLeft: 8, paddingRight: 44.3, justifyContent: "center" }}>
          <View style={{ height: 0, overflow: "hidden" }} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
            {[...(follow ? [follow.same] : []), ...EFFORTS.map((x) => EFFORT_NAMES[x])].map((n) => (
              <T key={n} style={font(t, "sans", 500, 16, 1.2)}>
                {n}
              </T>
            ))}
          </View>
          <T numberOfLines={1} style={[font(t, "sans", 500, 16, 1.2), { color: t.c.text }]}>
            {value === null ? follow?.same : EFFORT_NAMES[value]}
          </T>
          <View style={{ position: "absolute", right: 4, top: 0, bottom: 0, justifyContent: "center" }}>
            <Chevron color={t.c.text} />
          </View>
        </View>
      </Pressable>
      <Sheet open={open} title={follow?.label ?? "Effort"} onClose={() => setOpen(false)}>
        {follow ? <Item text={follow.same} current={value === null} onPress={() => pick(null)} /> : null}
        {EFFORTS.map((x) => (
          <Item key={x} text={EFFORT_NAMES[x]} current={value === x} onPress={() => pick(x)} />
        ))}
      </Sheet>
    </>
  );
}

/** A select's arrow. */
export function Chevron({ color }: { color: string }) {
  return (
    <Svg width={9} height={6} viewBox="0 0 9 6" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M1 1l3.5 3.5L8 1" />
    </Svg>
  );
}

function Box({ text, via, label, disabled, onPress }: { text: string; via: string | null; label: string; disabled?: boolean; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress} style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44, paddingHorizontal: 10, borderWidth: 1, borderRadius: t.radius, borderColor: disabled ? t.c.disabledLine : t.c.lineStrong, backgroundColor: t.c.panel2, alignSelf: "flex-start" }}>
      <T numberOfLines={1} style={[font(t, "sans", 500, 12, 1), { color: disabled ? t.c.dim : t.c.text }]}>
        {text}
      </T>
      {via ? (
        <View style={{ paddingVertical: 2, paddingHorizontal: 6, borderWidth: 1, borderColor: t.c.line, borderRadius: 999 }}>
          <T style={[font(t, "sans", 500, 11, 1), { color: t.c.dim }]}>{via}</T>
        </View>
      ) : null}
      <T style={[font(t, "sans", 400, 10, 1), { color: t.c.dim }]}>{"▾"}</T>
    </Pressable>
  );
}

function Item({ text, via, current, locked, onPress }: { text: string; via?: string; current: boolean; locked?: boolean; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable accessibilityRole="radio" accessibilityState={{ checked: current }} accessibilityLabel={text} onPress={onPress} style={{ flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 10, paddingVertical: 7, paddingHorizontal: 8, minHeight: 44, borderRadius: t.radius, backgroundColor: current ? t.c.accentWash : "transparent" }}>
      <Txt tone={locked ? "muted" : "text"}>
        {current ? <Txt tone="accent">{"✓ "}</Txt> : null}
        {text}
      </Txt>
      {via ? <T style={[font(t, "sans", 500, 11, 1), { color: locked ? t.c.accent : t.c.dim }]}>{via}</T> : null}
    </Pressable>
  );
}
