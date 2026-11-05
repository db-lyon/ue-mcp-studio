/**
 * Navigation on a phone (apps/client-web views/NavDrawer.tsx): a panel that
 * slides over the page from the left, opened from the top bar's menu button.
 * It holds New session, the tabs, the recent sessions and, at the foot, the
 * bar's tools. A pick, the scrim, or Android back closes it. The recent
 * sessions are read each time it opens.
 */
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useBack } from "../back";
import { Animated, Easing, Pressable, StyleSheet, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import type { SessionSummary } from "@ue-mcp-studio/shared";
import { font, T, useInsets, useStyles, useTheme, type Theme } from "../ui";
import { useProjectNav } from "../nav";

export type NavTab = "Chat" | "Playtests" | "Plugins" | "Settings";
const TABS: NavTab[] = ["Chat", "Plugins", "Settings"];

/** A session's state in a list: needs-you while an approval waits, else its status. */
export const listState = (s: Pick<SessionSummary, "status" | "awaiting">): string => (s.awaiting ? "needs-you" : s.status);

const DRAWER_W = 304;

/** The closed drawer: unseen and its shadow gone, its foot's sheets still mounted. `visibility` reaches the web build; a native Modal draws in its own window, so opacity hides the rest. */
const HIDDEN = { opacity: 0, visibility: "hidden" } as object;

const DrawerClose = createContext<() => void>(() => undefined);

/** Closes the drawer: what a tool at its foot calls when it opens its own sheet or page. Outside the drawer it does nothing. */
export const useDrawerClose = () => useContext(DrawerClose);

/** .brand: the mark, ue-mcp and Studio. */
export function Brand() {
  const t = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "baseline", gap: 7 }}>
      {t.markGlow ? (
        <View style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: t.c.accent, alignSelf: "center", shadowColor: t.c.accent, shadowOpacity: 0.55, shadowRadius: 5, shadowOffset: { width: 0, height: 0 } }} />
      ) : null}
      <T style={t.editor ? { ...font(t, "sans", 700, 13, 1), color: t.c.text } : { ...font(t, "mono", 700, 13, 1), letterSpacing: 0.13, color: t.c.text }}>ue-mcp</T>
      <T style={t.editor ? { ...font(t, "sans", 700, 13, 1), color: t.c.accent } : { ...font(t, "serif", 400, 18, 1, true), color: t.c.accent }}>Studio</T>
    </View>
  );
}

/** .tab-dot: an update waits. */
export function TabDot({ style, label }: { style?: object; label?: string }) {
  const t = useTheme();
  return <View accessibilityLabel={label} style={[{ width: 6, height: 6, borderRadius: 3, backgroundColor: t.c.accent }, style]} />;
}

export function NavDrawer({ open, onClose, tab, session, updates, playtestsWaiting = 0, onTab, onSession, onNewSession, children }: {
  open: boolean;
  onClose: () => void;
  tab: NavTab;
  /** The open session, if the chat shows one. */
  session: string | null;
  updates: number;
  /** Playtests across the project that wait for the user. */
  playtestsWaiting?: number;
  onTab: (t: NavTab) => void;
  onSession: (id: string) => void;
  onNewSession: () => void;
  children?: ReactNode;
}) {
  const t = useTheme();
  const s = useStyles(styles);
  const { api } = useProjectNav();
  const insets = useInsets();
  const [recent, setRecent] = useState<SessionSummary[] | null>(null);
  const slide = useRef(new Animated.Value(open ? 1 : 0)).current;
  const [shown, setShown] = useState(open);

  useEffect(() => {
    if (open) setShown(true);
    Animated.timing(slide, { toValue: open ? 1 : 0, duration: 240, easing: Easing.bezier(0.2, 0.8, 0.2, 1), useNativeDriver: true }).start(({ finished }) => {
      if (finished && !open) setShown(false);
    });
  }, [open, slide]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    api.sessions().then((r) => live && setRecent(r.sessions.filter((x) => !x.archived)), () => live && setRecent([]));
    return () => {
      live = false;
    };
  }, [open]);
  useBack(open ? onClose : null, { overlay: true });

  const pick = (f: () => void) => () => {
    f();
    onClose();
  };

  // Closed, it stays mounted but unseen, as the web's drawer-root goes visibility: hidden, so a sheet a foot tool opened outlives it.
  const hidden = !shown && !open;
  return (
    <View
      style={[StyleSheet.absoluteFill, { zIndex: 70 }, hidden && HIDDEN]}
      pointerEvents={open ? "auto" : "none"}
      accessibilityElementsHidden={!open}
      importantForAccessibility={open ? "auto" : "no-hide-descendants"}
    >
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(0, 0, 0, 0.55)", opacity: slide }]}>
        <Pressable accessibilityLabel="Close navigation" style={StyleSheet.absoluteFill} onPress={onClose} />
      </Animated.View>
      <Animated.View
        accessibilityViewIsModal
        accessibilityLabel="Navigation"
        // Over the whole screen: its brand under the status bar, its foot above the navigation bar.
        style={[s.drawer, { paddingTop: 10 + insets.top, paddingBottom: 10 + insets.bottom, paddingLeft: 10 + insets.left }, { transform: [{ translateX: slide.interpolate({ inputRange: [0, 1], outputRange: [-DRAWER_W - 1, 0] }) }] }]}
      >
        <View style={s.head}>
          <Brand />
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="New session" onPress={pick(onNewSession)} style={({ pressed }) => [s.item, s.newItem, pressed && s.pressed]}>
          <View style={s.plus}>
            <Svg width={18} height={18} viewBox="0 0 16 16" fill="none" stroke={t.c.onAccent} strokeWidth={1.6} strokeLinecap="round">
              <Path d="M8 3v10M3 8h10" />
            </Svg>
          </View>
          <T style={[s.itemText, s.newText]}>New session</T>
        </Pressable>
        <View style={s.nav} accessibilityLabel="Sections">
          {TABS.map((x) => {
            const active = x === tab;
            return (
              <Pressable
                key={x}
                accessibilityRole="button"
                accessibilityLabel={x}
                accessibilityState={{ selected: active }}
                onPress={pick(() => onTab(x))}
                style={({ pressed }) => [s.item, active && s.active, pressed && !active && s.pressed]}
              >
                <TabGlyph tab={x} color={active ? t.c.accentHi : t.c.muted} />
                <T style={s.itemText}>{x}</T>
                {x === "Settings" && updates > 0 ? <TabDot style={{ marginLeft: -4 }} label={`${updates} ${updates === 1 ? "update" : "updates"} available`} /> : null}
                {x === "Playtests" && playtestsWaiting > 0 ? (
                  <View accessibilityLabel={`${playtestsWaiting} need you`} style={s.count}>
                    <T style={s.countText}>{playtestsWaiting}</T>
                  </View>
                ) : null}
              </Pressable>
            );
          })}
        </View>
        <View style={s.recents}>
          <T style={s.label}>Recents</T>
          {recent === null ? <T style={s.note}>Loading</T> : null}
          {recent?.length === 0 ? <T style={s.note}>No sessions yet.</T> : null}
          {recent?.map((x) => {
            const state = listState(x);
            const active = tab === "Chat" && x.id === session;
            const dot = state === "running" ? t.c.accent : state === "waiting" || state === "needs-you" ? t.c.warn : state === "error" ? t.c.bad : null;
            return (
              <Pressable
                key={x.id}
                accessibilityRole="button"
                accessibilityLabel={x.awaiting ? `${x.title}, waiting on your approval` : x.title || "Untitled"}
                onPress={pick(() => onSession(x.id))}
                style={({ pressed }) => [s.item, s.session, active && s.active, pressed && !active && s.pressed]}
              >
                {dot ? <View style={[s.dot, { backgroundColor: dot }]} /> : null}
                <T numberOfLines={1} style={[s.sessionText, active && { color: t.c.text }]}>
                  {x.title || "Untitled"}
                </T>
              </Pressable>
            );
          })}
        </View>
        {/* A tool in the foot (the Git chip, Feedback, Docs) opens its own sheet or page: the drawer gets out of its way. */}
        {children ? (
          <DrawerClose.Provider value={onClose}>
            <View style={s.foot}>{children}</View>
          </DrawerClose.Provider>
        ) : null}
      </Animated.View>
    </View>
  );
}

/** A tool at the drawer's foot: Feedback, Docs. */
export function DrawerTool({ title, onPress, label }: { title: string; onPress: () => void; label?: string }) {
  const s = useStyles(styles);
  const close = useDrawerClose();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label ?? title}
      onPress={() => {
        onPress();
        close();
      }}
      style={({ pressed }) => [s.item, s.tool, pressed && s.pressed]}>
      <T style={s.toolText}>{title}</T>
    </Pressable>
  );
}

function TabGlyph({ tab, color }: { tab: NavTab; color: string }) {
  const path = {
    Chat: "M3 4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v5a1.5 1.5 0 0 1-1.5 1.5H7l-3 2.5V11h0.5A1.5 1.5 0 0 1 3 9.5z",
    Playtests: "M5 3.5h6M6 3.5v3.2L3.4 11.6A1.3 1.3 0 0 0 4.5 13.5h7a1.3 1.3 0 0 0 1.1-1.9L10 6.7V3.5M5 10h6",
    Plugins: "M6 2.5v3M10 2.5v3M4 5.5h8v2.5a4 4 0 0 1-8 0zM8 12v1.5",
    Settings: "M3 5h10M3 11h10M6 3.5v3M10 9.5v3",
  }[tab];
  return (
    <Svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round">
      <Path d={path} />
    </Svg>
  );
}

const styles = (t: Theme) => ({
  drawer: {
    position: "absolute" as const,
    top: 0,
    bottom: 0,
    left: 0,
    width: DRAWER_W,
    maxWidth: "86%" as const,
    gap: 2,
    padding: 10,
    backgroundColor: t.c.panel,
    borderRightWidth: 1,
    borderRightColor: t.c.lineStrong,
    shadowColor: "#000",
    shadowOpacity: 0.45,
    shadowRadius: 20,
    shadowOffset: { width: 16, height: 0 },
    elevation: 16,
  },
  head: { flexDirection: "row" as const, alignItems: "center" as const, minHeight: 40, paddingHorizontal: 8, paddingBottom: 6 },
  item: { flexDirection: "row" as const, alignItems: "center" as const, gap: 12, width: "100%" as const, minHeight: 44, paddingHorizontal: 10, borderRadius: t.radiusLg },
  pressed: { backgroundColor: t.c.panel2 },
  active: { backgroundColor: t.c.accentWash },
  // The editor themes' button rule (400 12px/1.2) outranks the drawer's own sizes, except at the foot.
  itemText: { ...(t.editor ? font(t, "sans", 400, 12, 1.2) : font(t, "sans", 500, 14.5, 1.2)), color: t.c.text },
  newItem: { marginBottom: 6 },
  newText: { ...(t.editor ? font(t, "sans", 400, 12, 1.2) : font(t, "sans", 600, 14.5, 1.2)), color: t.c.accentHi },
  plus: { width: 24, height: 24, borderRadius: 12, backgroundColor: t.c.accent, alignItems: "center" as const, justifyContent: "center" as const },
  nav: { gap: 2 },
  count: { minWidth: 16, height: 16, marginLeft: 6, paddingHorizontal: 4, borderRadius: 8, backgroundColor: t.c.warn, alignItems: "center" as const, justifyContent: "center" as const },
  countText: { ...font(t, "mono", 700, 10), lineHeight: 16, color: "#1a1200" },
  recents: { flex: 1, minHeight: 0, marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: t.c.line, gap: 1, overflow: "hidden" as const },
  label: { ...font(t, "sans", 600, 12, 1.3), color: t.c.dim, paddingHorizontal: 10, paddingBottom: 6 },
  note: { ...font(t, "sans", 400, 12, t.editor ? 1.5 : 1.55), color: t.c.dim, paddingHorizontal: 10 },
  session: { gap: 0 },
  dot: { width: 6, height: 6, borderRadius: 3, marginRight: 7 },
  sessionText: { ...font(t, "sans", 400, t.editor ? 12 : 14, 1.2), color: t.c.muted, flexShrink: 1, minWidth: 0 },
  foot: { paddingTop: 6, borderTopWidth: 1, borderTopColor: t.c.line, gap: 1 },
  tool: {},
  toolText: { ...font(t, "sans", 500, 14, 1.2), color: t.c.muted },
});
