/**
 * One session in the list: open it, or from its menu rename, mute its
 * notifications, archive (or restore) and delete it. Delete asks once more before it removes anything.
 */
import { useBack } from "../back";
import { useEffect, useRef, useState } from "react";
import { Pressable, TextInput, View, useWindowDimensions, type HostInstance } from "react-native";
import type { SessionSummary, SessionUpdate } from "@ue-mcp-studio/shared";
import { listState, sessionLine } from "@ue-mcp-studio/client-core";
import { useProjectNav } from "../nav";
import { useSettingsApi } from "../screens/settings/hooks";
import { saveProjectNotify, useProjectNotify } from "../notifications/state";
import Svg, { Path } from "react-native-svg";
import { font, T, useSheetInsets, useTheme } from "../ui";
import { buttonText, small } from "./styles";

export { listState, sessionLine };

/** The row menu's height: four 44 px items, its padding and border. */
const MENU_H = 4 * 44 + 10;

/** .session-dot: shown while the session runs, waits or needs the user, or stopped on an error. */
function SessionDot({ state }: { state: string }) {
  const t = useTheme();
  const color = state === "running" ? t.c.accent : state === "waiting" || state === "needs-you" ? t.c.warn : state === "error" ? t.c.bad : null;
  if (!color) return null;
  return <View style={{ width: 6, height: 6, borderRadius: 3, marginRight: 7, marginBottom: 1, backgroundColor: color }} />;
}

export function SessionRow({ s, selected, onOpen, onChanged }: { s: SessionSummary; selected: boolean; onOpen: () => void; onChanged: (deleted?: string) => void }) {
  const t = useTheme();
  const { api } = useProjectNav();
  const [menu, setMenu] = useState(false);
  useBack(menu ? () => setMenu(false) : null, { overlay: true });
  // A row near the foot of the screen opens its menu upward, so the menu never sits under the navigation bar.
  const [up, setUp] = useState(false);
  const row = useRef<HostInstance>(null);
  const win = useWindowDimensions();
  const insets = useSheetInsets();
  const [confirm, setConfirm] = useState(false);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(s.title);
  const settings = useSettingsApi();
  // Read when the menu first opens; the open project has usually read it already for its notifications.
  const notify = useProjectNotify(settings, menu);
  const muted = !!notify?.prefs.mutedSessions.includes(s.id);

  useEffect(() => setTitle(s.title), [s.title]);

  const update = (u: SessionUpdate) => api.updateSession(s.id, u).then(() => onChanged(), () => onChanged());
  const rename = () => {
    if (!editing) return;
    setEditing(false);
    if (title.trim() && title.trim() !== s.title) void update({ title: title.trim() });
    else setTitle(s.title);
  };
  const remove = () => {
    setMenu(false);
    setConfirm(false);
    return api.deleteSession(s.id).then(() => onChanged(s.id), () => onChanged());
  };
  const item = (label: string, onPress: () => void, danger = false) => (
    <Pressable
      key={label}
      accessibilityRole="menuitem"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({ minHeight: 44, justifyContent: "center", paddingVertical: 10, paddingHorizontal: 12, borderRadius: t.radius, borderWidth: 1, borderColor: "transparent", backgroundColor: danger && confirm ? t.c.bad : pressed ? t.c.panel2 : "transparent" })}
    >
      <T style={[buttonText(t), { color: danger ? (confirm ? "#fff" : t.c.bad) : t.c.text }]}>{label}</T>
    </Pressable>
  );

  return (
    <View ref={row} style={{ zIndex: menu ? 5 : 0, opacity: s.archived ? 0.7 : 1 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={s.title}
        accessibilityState={{ selected }}
        onPress={() => !editing && onOpen()}
        style={({ pressed }) => ({
          paddingVertical: 9,
          paddingLeft: 10,
          paddingRight: 48,
          marginHorizontal: -4,
          marginBottom: 2,
          borderRadius: 7,
          borderWidth: 1,
          borderColor: selected ? t.c.accentLine : "transparent",
          backgroundColor: selected ? t.c.accentWash : pressed ? t.c.panel2 : "transparent",
        })}
      >
        {editing ? (
          <TextInput
            accessibilityLabel="Session title"
            autoFocus
            value={title}
            onChangeText={setTitle}
            onBlur={rename}
            onSubmitEditing={rename}
            selectionColor={t.c.selection}
            style={{ width: "100%", minHeight: 44, paddingVertical: 3, paddingHorizontal: 6, backgroundColor: t.c.panel2, color: t.c.text, borderWidth: 1, borderColor: t.c.accentLine, borderRadius: t.radius, ...font(t, "sans", 600, 16) }}
          />
        ) : (
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <SessionDot state={listState(s)} />
            <T weight={600} numberOfLines={1} style={{ flexShrink: 1, lineHeight: t.base.lineHeight }}>
              {s.title}
            </T>
            {muted ? (
              <View accessible accessibilityRole="image" accessibilityLabel="Notifications muted" style={{ marginLeft: 6 }}>
                <Svg width={11} height={11} viewBox="0 0 16 16" fill="none" stroke={t.c.dim} strokeWidth={1.6} strokeLinecap="round">
                  <Path d="M4 11.5V7a4 4 0 0 1 8 0v4.5l1.5 1.5h-11zM6.5 13.5a1.5 1.5 0 0 0 3 0M2 2l12 12" />
                </Svg>
              </View>
            ) : null}
          </View>
        )}
        <T style={[small(t), { color: t.c.muted }]}>{sessionLine(s)}</T>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Session actions"
        accessibilityState={{ expanded: menu }}
        onPress={() => {
          if (!menu) row.current?.measureInWindow?.((_x, y) => setUp(y + 48 + MENU_H > win.height - insets.bottom && y - MENU_H > insets.top));
          setMenu(!menu);
          setConfirm(false);
        }}
        style={({ pressed }) => ({ position: "absolute", top: 4, right: -2, width: 44, height: 44, borderRadius: t.radius, alignItems: "center", justifyContent: "center", backgroundColor: menu || pressed ? t.c.panel3 : "transparent" })}
      >
        <T style={{ fontSize: 16, lineHeight: 16, color: menu ? t.c.text : t.c.muted }}>{"⋯"}</T>
      </Pressable>
      {menu ? (
        <View
          accessibilityRole="menu"
          style={{ position: "absolute", ...(up ? { bottom: "100%" as const } : { top: 48 }), right: 2, zIndex: 5, minWidth: 150, padding: 4, backgroundColor: t.c.panel, borderWidth: 1, borderColor: t.c.lineStrong, borderRadius: 8, shadowColor: "#000", shadowOpacity: 0.35, shadowRadius: 12, shadowOffset: { width: 0, height: 8 }, elevation: 8 }}
        >
          {item("Rename", () => {
            setMenu(false);
            setEditing(true);
          })}
          {notify
            ? item(muted ? "Unmute notifications" : "Mute notifications", () => {
                setMenu(false);
                void saveProjectNotify(settings, muted ? { unmute: [s.id] } : { mute: [s.id] }).catch(() => undefined);
              })
            : null}
          {item(s.archived ? "Restore" : "Archive", () => {
            setMenu(false);
            void update({ archived: !s.archived });
          })}
          {item(confirm ? "Are you sure?" : "Delete", () => (confirm ? void remove() : setConfirm(true)), true)}
        </View>
      ) : null}
    </View>
  );
}
