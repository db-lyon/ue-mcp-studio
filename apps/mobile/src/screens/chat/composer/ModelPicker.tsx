/**
 * The web client's views/ModelPicker.tsx for the app: the model picker, the
 * effort, and both as one chip when the composer bar narrows. The app is a
 * paired browser, so signing in and keys stay on the computer: those forms
 * say so, as the web client's do on a paired page.
 * styles.css: .picker, .picker-menu, .picker-item, .picker-effort, .effort.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Modal, Pressable, ScrollView, Text, View, useWindowDimensions, type HostInstance } from "react-native";
import {
  EFFORTS,
  EFFORT_NAMES,
  KEY_PROVIDER_IDS,
  PROVIDERS,
  anythingConnected,
  endpointIdOf,
  type Effort,
  type KeyProviderId,
  type ModelCatalog,
  type SignInId,
  type StudioSettings,
  type VendorId,
} from "@ue-mcp-studio/shared";
import { findModel as find, runsVia, viaName, VIA_LABEL } from "@ue-mcp-studio/client-core";
import { useProjectNav } from "../../../nav";
import { Banner, Sheet, font, labelFont, useStyles, useTheme, type Theme } from "../../../ui";
import { atMost, useBarTier } from "./barTier";
import { REMOTE_CHANGE_NOTE } from "../../../views/settings/RemoteReadOnly";

export { runsVia, viaName, VIA_LABEL };

type Catalog = ModelCatalog;

export function useCatalog(settings: StudioSettings | null): Catalog | null {
  const { api } = useProjectNav();
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  useEffect(() => {
    if (settings) api.models().then(setCatalog, () => setCatalog(null));
  }, [settings?.connected, settings?.provider, settings?.model]);
  return catalog;
}

/**
 * A picker for a model that follows the main agent's unless one is chosen:
 * the main agent's vendor only, with the follow choice first.
 */
export interface Follow<T> {
  /** The chosen value; null follows the main agent. */
  value: T | null;
  /** What null is called, such as "Same as main agent". */
  same: string;
  onPick: (v: T | null) => Promise<unknown>;
  /** Names the control for a screen reader. */
  label: string;
}

/** Where a menu opens from: the button's place on the screen. */
interface Anchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The model picker: every model once, under its vendor. Picking one that
 * nothing connected can run says where to connect it; with follow, it picks a
 * model of the main agent's vendor, or none, through follow.onPick instead of
 * the main model.
 */
export function ModelPicker({
  settings,
  onSettings,
  up = false,
  follow,
  merged = false,
  disabled = false,
}: {
  settings: StudioSettings;
  onSettings: (s: StudioSettings) => void;
  /** Open above the button, for the composer at the bottom of the panel. */
  up?: boolean;
  follow?: Follow<string>;
  /** The effort too: the button names both and the menu has an Effort section under the models. */
  merged?: boolean;
  disabled?: boolean;
}) {
  const t = useTheme();
  const s = useStyles(styles);
  const { api } = useProjectNav();
  const tier = useBarTier();
  const win = useWindowDimensions();
  const [open, setOpen] = useState<Anchor | null>(null);
  const catalog = useCatalog(settings);
  const [connecting, setConnecting] = useState<{ vendor: VendorId; model: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const button = useRef<HostInstance>(null);

  const done = () => {
    setOpen(null);
    setConnecting(null);
  };
  const select = (vendor: VendorId, model: string | null) =>
    (follow
      ? follow.onPick(model).then(done)
      : api.saveSettings({ provider: vendor, model: model! }).then((x) => {
          onSettings(x);
          done();
        })).catch((e: Error) => setError(e.message));
  const toggle = () => {
    if (open) return done();
    const el = button.current;
    if (!el?.measureInWindow) return setOpen({ x: 0, y: 0, width: 0, height: 0 });
    el.measureInWindow((x: number, y: number, width: number, height: number) => setOpen({ x, y, width, height }));
  };

  // Following, only the main agent's vendor is offered: the worker runs on its sign-in or key.
  const providers = follow
    ? (catalog?.providers ?? []).filter((p) => p.id === settings.provider && KEY_PROVIDER_IDS.includes(p.id as KeyProviderId))
    : catalog?.providers ?? [];
  const current = follow
    ? follow.value === null ? null : find(catalog, settings.provider, follow.value)
    : find(catalog, settings.provider, settings.model);
  const via = follow ? null : settings.route;
  const shown = follow
    ? follow.value === null ? follow.same : current?.model.name ?? follow.value
    // Nothing connected yet: no vendor is chosen for the user.
    : anythingConnected(settings) ? current?.model.name ?? settings.model : "Choose a model";

  // A model with no route has no effort to set, as the separate Effort control is then disabled.
  const withEffort = merged && !follow && settings.route !== null;
  const label = withEffort ? `${shown} · ${EFFORT_NAMES[settings.effort]}` : shown;
  // In the composer bar below full, the route badge goes (barTier.ts).
  const showVia = via && tier === "full";
  const viaText = via ? viaName(via, current?.vendor.name ?? (via === "key" ? PROVIDERS[settings.provider as KeyProviderId]?.name ?? settings.provider : settings.provider)) : "";

  // The menu: above the button in the composer, across the whole bar at its narrowest.
  const narrowest = tier === "narrowest";
  const menuWidth = Math.min(320, win.width - 24);
  const place = open
    ? {
        left: narrowest ? 10 : Math.max(0, Math.min(open.x, win.width - menuWidth)),
        ...(narrowest ? { right: 10 } : { width: menuWidth }),
        ...(up ? { bottom: win.height - open.y + 6 } : { top: open.y + open.height + 6 }),
        maxHeight: win.height * 0.6,
      }
    : null;

  return (
    <View style={[s.picker, merged && s.pickerBar]}>
      <Pressable
        ref={button}
        accessibilityRole="button"
        accessibilityState={{ disabled, expanded: !!open }}
        accessibilityLabel={follow ? `${follow.label}: ${shown}` : withEffort ? `Model and effort: ${shown}, ${EFFORT_NAMES[settings.effort]}` : label}
        accessibilityHint={withEffort ? "Model and effort" : "Model"}
        disabled={disabled}
        onPress={toggle}
        style={({ pressed }) => [s.button, pressed && !disabled && s.buttonPressed, disabled && { borderColor: t.c.disabledLine }]}
      >
        <Text style={[s.label, disabled && { color: t.c.dim }]} numberOfLines={1}>{label}</Text>
        {showVia ? <View style={s.viaBadge}><Text style={s.via}>{viaText}</Text></View> : null}
        <Text style={s.caret} aria-hidden>{"▾"}</Text>
      </Pressable>
      <Modal visible={!!open} transparent animationType="none" onRequestClose={done} statusBarTranslucent navigationBarTranslucent>
        <Pressable accessibilityLabel="Close the menu" style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }} onPress={done} />
        {place && (
          <View style={[s.menu, place]}>
            <ScrollView style={{ flexGrow: 0 }} keyboardShouldPersistTaps="handled">
              {error ? (
                <Pressable onPress={() => setError(null)}>
                  <Banner kind="bad"><Text style={[s.small, { color: t.c.badText }]}>{error}</Text></Banner>
                </Pressable>
              ) : null}
              {connecting && catalog ? (
                <View style={s.connectBox}>
                  <Pressable accessibilityRole="button" accessibilityLabel="Models" onPress={() => setConnecting(null)} style={s.back}>
                    <Text style={s.backText}>{"‹"} Models</Text>
                  </Pressable>
                  <ConnectModel catalog={catalog} vendor={connecting.vendor} model={connecting.model} onConnected={() => void select(connecting.vendor, connecting.model)} />
                </View>
              ) : (
                <View accessibilityRole="list" accessibilityLabel="Model">
                  {follow && (
                    <PickerItem selected={follow.value === null} onPress={() => void select(settings.provider, null)} name={follow.same} />
                  )}
                  {providers.map((p, i) => (
                    <View key={p.id} style={i > 0 || follow ? s.groupNext : undefined}>
                      <View style={s.groupHead}>
                        <Text style={labelFont(t)}>{p.name}</Text>
                      </View>
                      {p.models.map((m) => {
                        const selected = follow ? follow.value === m.id : settings.provider === p.id && settings.model === m.id;
                        const runs = runsVia(catalog!, p, m);
                        return (
                          <PickerItem
                            key={m.id}
                            selected={selected}
                            locked={!runs}
                            name={m.name}
                            via={runs ? viaName(runs, p.name) : m.signIns.length ? "sign in" : "connect"}
                            onPress={() => (runs ? void select(p.id, m.id) : setConnecting({ vendor: p.id, model: m.id }))}
                          />
                        );
                      })}
                    </View>
                  ))}
                </View>
              )}
              {withEffort && !connecting && <EffortSegments settings={settings} onSettings={onSettings} />}
              {!catalog && !error ? <Text style={[s.small, { color: t.c.muted, marginVertical: 12 }]}>Loading models</Text> : null}
            </ScrollView>
          </View>
        )}
      </Modal>
    </View>
  );
}

/** button.picker-item: a model's name, a check when it is the one in use, and how it runs. */
function PickerItem({ name, via, selected, locked, onPress }: { name: string; via?: string; selected: boolean; locked?: boolean; onPress: () => void }) {
  const t = useTheme();
  const s = useStyles(styles);
  return (
    <Pressable accessibilityRole="menuitem" accessibilityState={{ selected }} accessibilityLabel={name} onPress={onPress} style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [s.item, (pressed || hovered) && { backgroundColor: t.c.panel2 }, selected && { backgroundColor: t.c.accentWash }]}>
      <View style={{ flexDirection: "row", alignItems: "baseline", flexShrink: 1, minWidth: 0 }}>
        {selected ? <Text style={[s.itemName, { color: t.c.accent, marginRight: 6 }]}>{"✓"}</Text> : null}
        <Text style={[s.itemName, locked && !selected && { color: t.c.muted }]}>{name}</Text>
      </View>
      {via ? <Text style={[s.via, locked && { color: t.c.accent }]}>{via}</Text> : null}
    </Pressable>
  );
}

/**
 * Connect something that runs this model: each sign-in that can, first one
 * foremost, and the vendor's API key as the fallback. On the app these stay on
 * the computer, so each says so.
 */
export function ConnectModel({ catalog, vendor, model }: {
  catalog: Catalog;
  vendor: VendorId;
  model: string;
  onConnected: () => void;
}) {
  const t = useTheme();
  const s = useStyles(styles);
  const [keyOpen, setKeyOpen] = useState(false);
  const found = find(catalog, vendor, model);
  // A custom endpoint has no sign-in or key to connect here: it is set up, or it is gone.
  if (endpointIdOf(vendor) !== null) {
    const endpoint = catalog.providers.find((p) => p.id === vendor);
    return (
      <View style={s.connect}>
        <Text style={[s.small, s.strong]}>{model}</Text>
        <Text style={[s.small, { color: t.c.dim }]}>
          {found
            ? `${found.vendor.name} runs this model.`
            : endpoint
              ? `${endpoint.name} no longer lists this model. Add it in the endpoint's Edit, in Settings, Models & accounts, or choose another model.`
              : "The custom endpoint that ran this model is no longer set up. Add it again in Settings, Models & accounts, or choose another model."}
        </Text>
      </View>
    );
  }
  const keyVendor = vendor as KeyProviderId;
  const signIns = found?.model.signIns ?? [];
  const name = found?.model.name ?? model;
  return (
    <View style={s.connect}>
      <Text style={[s.small, s.strong]}>{name}</Text>
      {signIns.map((x) => <SignInForm key={x} id={x} onDone={() => undefined} />)}
      {signIns.length > 0 ? (
        <View>
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: keyOpen }} onPress={() => setKeyOpen(!keyOpen)} style={{ minHeight: 44, justifyContent: "center" }}>
            <Text style={[s.small, { color: t.c.dim }]}>{keyOpen ? "▾" : "▸"} Use your own {PROVIDERS[keyVendor].name} API key instead</Text>
          </Pressable>
          {keyOpen ? <KeyForm provider={keyVendor} onSaved={() => undefined} /> : null}
        </View>
      ) : (
        <>
          <Text style={[s.small, { color: t.c.dim }]}>Connect {PROVIDERS[keyVendor].name} with an API key.</Text>
          <KeyForm provider={keyVendor} onSaved={() => undefined} />
        </>
      )}
    </View>
  );
}

/** A key goes into Studio on the computer, never through the phone. */
export function KeyForm(_props: { provider: KeyProviderId; onSaved: () => void }) {
  return <RemoteNote />;
}

/** Sign-ins put credentials on the computer; a paired phone cannot start one. */
export function SignInForm(_props: { id: SignInId; primary?: boolean; onDone: () => void; name?: string; about?: string }) {
  return <RemoteNote />;
}

function RemoteNote() {
  const t = useTheme();
  const s = useStyles(styles);
  return <Text style={[s.small, { color: t.c.dim }]}>{REMOTE_CHANGE_NOTE}</Text>;
}

/** Why the Claude row has no sign-in button. */
export const CLAUDE_LOGIN_WHY =
  "Anthropic does not allow apps it has not approved to offer Claude sign-in themselves. You sign in with Claude Code, and Studio runs Claude on that login. Studio never sees your Claude credentials.";

/** "Why?", with the reason read out and shown on a long press. */
export function ClaudeLoginWhy() {
  const t = useTheme();
  const [shown, setShown] = useState(false);
  return (
    <Text accessibilityRole="text" accessibilityLabel={CLAUDE_LOGIN_WHY} onPress={() => setShown(!shown)} style={{ color: t.c.accent, textDecorationLine: "underline", textDecorationStyle: "dotted" }}>
      {shown ? CLAUDE_LOGIN_WHY : "Why?"}
    </Text>
  );
}

/**
 * The model and the effort in the composer bar: two controls while there is
 * room, one chip with one menu when the bar narrows (chat/barTier.ts).
 */
export function ModelAndEffort({ settings, onSettings }: { settings: StudioSettings; onSettings: (s: StudioSettings) => void }) {
  return atMost("merged", useBarTier())
    ? <ModelPicker settings={settings} onSettings={onSettings} up merged />
    : <><ModelPicker settings={settings} onSettings={onSettings} up /><EffortPicker settings={settings} onSettings={onSettings} /></>;
}

/** The effort as a row of choices, in the merged menu. */
function EffortSegments({ settings, onSettings }: { settings: StudioSettings; onSettings: (s: StudioSettings) => void }) {
  const t = useTheme();
  const s = useStyles(styles);
  const { api } = useProjectNav();
  const [error, setError] = useState<string | null>(null);
  const pick = (effort: Effort) => api.saveSettings({ effort }).then(onSettings, (e: Error) => setError(e.message));
  return (
    <View style={s.effortBox}>
      <View style={s.groupHead}><Text style={labelFont(t)} accessibilityRole="header">Effort</Text></View>
      {error ? (
        <Pressable onPress={() => setError(null)}>
          <Banner kind="bad"><Text style={[s.small, { color: t.c.badText }]}>{error}</Text></Banner>
        </Pressable>
      ) : null}
      <View style={s.segments} accessibilityRole="radiogroup" accessibilityLabel="Effort">
        {EFFORTS.map((x) => {
          const on = settings.effort === x;
          return (
            <Pressable key={x} accessibilityRole="radio" accessibilityState={{ checked: on }} accessibilityLabel={EFFORT_NAMES[x]} onPress={() => void pick(x)} style={({ pressed }) => [s.segment, on && s.segmentOn, pressed && !on && s.buttonPressed]}>
              <Text style={[s.segmentText, on && { color: t.c.text }]}>{EFFORT_NAMES[x]}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** How long the model reasons. Every vendor gets the nearest level it has. A select on the web; a sheet of the levels here. */
export function EffortPicker({ settings, onSettings, follow, disabled = false }: { settings: StudioSettings; onSettings: (s: StudioSettings) => void; follow?: Follow<Effort>; disabled?: boolean }) {
  const t = useTheme();
  const s = useStyles(styles);
  const tier = useBarTier();
  const { api } = useProjectNav();
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const off = disabled || settings.route === null;
  const value: Effort | null = follow ? follow.value : settings.effort;
  const pick = (effort: Effort | null) => {
    setOpen(false);
    void (follow ? follow.onPick(effort).catch((x: Error) => setError(x.message)) : api.saveSettings({ effort: effort! }).then(onSettings, (e: Error) => setError(e.message)));
  };
  const shown = value === null ? follow?.same ?? "" : EFFORT_NAMES[value];
  const options: Array<{ key: Effort | null; name: string }> = [...(follow ? [{ key: null, name: follow.same }] : []), ...EFFORTS.map((x) => ({ key: x, name: EFFORT_NAMES[x] }))];
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${follow?.label ?? "Effort"}: ${shown}`}
        accessibilityHint={off && settings.route === null ? "Pick a model that runs first" : error ?? "How long the model reasons before it answers"}
        accessibilityState={{ disabled: off }}
        disabled={off}
        onPress={() => setOpen(true)}
        style={[s.effort, tier !== "full" && { paddingLeft: 4 }]}
      >
        {tier === "full" ? <Text style={s.effortLabel}>Effort</Text> : null}
        <Text style={[s.effortValue, off && { color: t.c.dim }]} numberOfLines={1}>{shown}</Text>
        <Text style={s.caret} aria-hidden>{"▾"}</Text>
      </Pressable>
      <Sheet open={open} title={follow?.label ?? "Effort"} onClose={() => setOpen(false)}>
        {options.map((o) => (
          <PickerItem key={o.key ?? "same"} name={o.name} selected={value === o.key} onPress={() => pick(o.key)} />
        ))}
      </Sheet>
    </>
  );
}

const styles = (t: Theme) => {
  // The editor themes' button rule outweighs the picker's own: 400 12px/1.2.
  const control = t.editor ? font(t, "sans", 400, 12, 1.2) : font(t, "sans", 500, 12, 1);
  const lh = t.editor ? 1.5 : 1.55;
  return {
    picker: { position: "relative" as const, flexShrink: 0 },
    pickerBar: { flexShrink: 1, minWidth: 0 },
    button: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, minHeight: 44, paddingHorizontal: 10, backgroundColor: t.c.panel2, borderWidth: 1, borderColor: t.c.lineStrong, borderRadius: t.radius, maxWidth: "100%" as const, minWidth: 0 },
    buttonPressed: { borderColor: t.c.accentLine, backgroundColor: t.c.panel3 },
    label: { ...control, color: t.c.text, flexShrink: 1, minWidth: 0 },
    viaBadge: { flexShrink: 0, paddingVertical: 2, paddingHorizontal: 6, borderWidth: 1, borderColor: t.c.line, borderRadius: 999 },
    via: { ...font(t, "sans", 500, 11, 1), color: t.c.dim, flexShrink: 0 },
    caret: { ...font(t, "sans", t.editor ? 400 : 500, 10, 1.2), color: t.c.dim, flexShrink: 0 },
    menu: { position: "absolute" as const, padding: 6, backgroundColor: t.c.panel, borderWidth: 1, borderColor: t.c.lineStrong, borderRadius: t.radiusLg, ...(t.shadow ? { boxShadow: "0 20px 40px -24px rgba(0, 0, 0, 0.6)" } : {}) },
    groupNext: { borderTopWidth: 1, borderTopColor: t.c.line, marginTop: 4, paddingTop: 4 },
    groupHead: { flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "space-between" as const, paddingTop: 6, paddingHorizontal: 8, paddingBottom: 4 },
    item: { flexDirection: "row" as const, width: "100%" as const, minHeight: 44, alignItems: "baseline" as const, justifyContent: "space-between" as const, gap: 10, paddingVertical: 7, paddingHorizontal: 8, borderWidth: 1, borderColor: "transparent", borderRadius: t.radius },
    itemName: t.editor ? { ...font(t, "sans", 400, 12, 1.2), color: t.c.text } : { ...font(t, "sans", 400, t.base.size), lineHeight: t.base.lineHeight, color: t.c.text },
    effortBox: { borderTopWidth: 1, borderTopColor: t.c.line, marginTop: 4, paddingTop: 4 },
    segments: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 4, paddingTop: 2, paddingHorizontal: 8, paddingBottom: 6 },
    segment: { flexGrow: 1, flexShrink: 1, flexBasis: "auto" as const, minHeight: 44, minWidth: 44, paddingHorizontal: 8, alignItems: "center" as const, justifyContent: "center" as const, backgroundColor: t.c.panel2, borderWidth: 1, borderColor: t.c.lineStrong, borderRadius: t.radius },
    segmentOn: { backgroundColor: t.c.accentWash, borderColor: t.c.accentLine },
    segmentText: { ...font(t, "sans", 500, 12, 1), color: t.c.text },
    effort: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, minHeight: 44, paddingLeft: 10, paddingRight: 4, borderWidth: 1, borderColor: t.c.line, borderRadius: 6, backgroundColor: t.c.panel, flexShrink: 1, minWidth: 0, overflow: "hidden" as const },
    effortLabel: { ...font(t, "sans", 500, 12, 1), color: t.c.dim },
    effortValue: { ...font(t, "sans", 500, 16, 1.2), color: t.c.text, paddingHorizontal: 4, flexShrink: 1, minWidth: 0 },
    connectBox: { padding: 6, paddingHorizontal: 8 },
    back: { minHeight: 44, justifyContent: "center" as const, alignSelf: "flex-start" as const, paddingHorizontal: 12 },
    backText: { ...(t.editor ? font(t, "sans", 400, 12, 1.2) : { ...font(t, "mono", 500, 11.5, 1.2), letterSpacing: 0.23 }), color: t.c.muted },
    connect: { gap: 6, width: "100%" as const },
    small: { ...font(t, "sans", 400, 12, lh), color: t.c.text },
    strong: { ...font(t, "sans", 700, 12, lh) },
  };
};

