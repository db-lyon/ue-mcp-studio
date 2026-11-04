/**
 * Settings as a paired browser shows it at phone width (client-web
 * SettingsHub, narrow): the list of sections in their groups, each with its
 * state in a line, and a section opened full width under "All settings".
 * Extension sections are left out: an extension's settings are a web page
 * bundle the app cannot draw.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Pressable, ScrollView, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { HttpError, SECTION_NAMES, SETTINGS_GROUPS, sectionOf, sectionStatus, strategyLine, type BuiltinSection, type SectionExtra, type SettingsSection } from "@ue-mcp-studio/client-core";
import { STUDIO_PLAN_AVAILABLE, remoteSurface, type StudioSettings, type StudioTheme } from "@ue-mcp-studio/shared";
import type { DaemonState } from "../../state";
import { Button, font, labelFont, T, useTheme } from "../../ui";
import { useSettingsApi } from "./hooks";
import { GeneralSection } from "./GeneralSection";
import { RemoteSection } from "./RemoteSection";
import { AgentsSection } from "./AgentsSection";
import { ModelsSection } from "./ModelsSection";
import { ApprovalsSection } from "./ApprovalsSection";
import { ProjectSection } from "./ProjectSection";
import { DiagnosticsSection } from "./DiagnosticsSection";

const ICONS: Record<BuiltinSection, string> = {
  agents: "M5.5 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM2 13c0-2 1.6-3.5 3.5-3.5S9 11 9 13M11 7.5a1.7 1.7 0 1 0 0-3.4M12 9.6c1.3.4 2 1.6 2 3.4",
  models: "M4 4h8v8H4zM6 1.5V4M10 1.5V4M6 12v2.5M10 12v2.5M1.5 6H4M1.5 10H4M12 6h2.5M12 10h2.5",
  approvals: "M8 1.5l5 2v4c0 3.2-2.2 5.6-5 7-2.8-1.4-5-3.8-5-7v-4zM5.5 8l1.7 1.7L10.7 6",
  project: "M1.5 4.5h4l1.5 1.5h7.5v7.5h-13z",
  general: "M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4",
  remote: "M5 1.5h6v13H5zM7.3 12.5h1.4",
  diagnostics: "M1.5 8.5h3l2-5 3 9 2-4h3",
};

export function Icon({ d, color, size = 16 }: { d: string; color: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round">
      <Path d={d} />
    </Svg>
  );
}

/** Whether this account's remote control is listed: a paired client is refused its routes, which reads as on (remote-available.ts). */
function useRemoteListed(): boolean {
  const api = useSettingsApi();
  const [answer, setAnswer] = useState<{ available: boolean; signedIn: boolean } | null>(null);
  useEffect(() => {
    api.remoteAvailable(true).then(
      (a) => setAnswer({ available: a.available === true, signedIn: a.signedIn !== false }),
      (e) => setAnswer({ available: e instanceof HttpError && e.status === 403, signedIn: true }),
    );
  }, [api]);
  return remoteSurface(STUDIO_PLAN_AVAILABLE, answer?.available ?? null, answer?.signedIn ?? true) !== "hidden";
}

/** Each section's line and dot, read when Settings opens; the daemon's health from the shell's. */
function useSectionStatus(updates: number, daemon: DaemonState) {
  const api = useSettingsApi();
  const [settings, setSettings] = useState<StudioSettings | null>(null);
  const [extra, setExtra] = useState<SectionExtra>({});
  useEffect(() => {
    api.settings().then(setSettings, () => setSettings(null));
    api.contextStrategy().then((c) => setExtra((e) => ({ ...e, ...strategyLine(c) })), () => undefined);
    api.install().then((r) => setExtra((e) => ({ ...e, ready: r.ok })), () => undefined);
    api.models().then((m) => setExtra((e) => ({ ...e, models: m })), () => undefined);
  }, [api]);
  try {
    return sectionStatus(updates, daemon.health, settings, extra);
  } catch {
    return { dots: {}, lines: {} };
  }
}

/**
 * The section list, or one section. `section` is a location's section name
 * (old names map to the new); null opens the list.
 */
export function SettingsScreen({ daemon, section, onSection, onTheme, updates = 0 }: { daemon: DaemonState; section: string | null; onSection: (s: SettingsSection | null) => void; onTheme: (t: StudioTheme) => void; updates?: number }) {
  const listed = useRemoteListed();
  const named = sectionOf(section);
  const open = named && !named.startsWith("ext:") ? (named as BuiltinSection) : null;
  return (
    <ScrollView testID="settings" style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 10 }} keyboardShouldPersistTaps="handled">
      {open ? <Section id={open} daemon={daemon} onSection={onSection} onTheme={onTheme} /> : <SectionList listed={listed} updates={updates} daemon={daemon} onSection={onSection} />}
    </ScrollView>
  );
}

function SectionList({ listed, updates, daemon, onSection }: { listed: boolean; updates: number; daemon: DaemonState; onSection: (s: SettingsSection) => void }) {
  const t = useTheme();
  const { dots, lines } = useSectionStatus(updates, daemon);
  const groups = listed ? SETTINGS_GROUPS : SETTINGS_GROUPS.map((g) => ({ ...g, items: g.items.filter((s) => s.id !== "remote") }));
  return (
    <View accessibilityRole="menu" accessibilityLabel="Settings sections" style={{ gap: 14 }}>
      {groups.map((g) => (
        <View key={g.label} style={{ gap: 2 }}>
          <T style={[labelFont(t, t.c.dim), { paddingHorizontal: 10, paddingBottom: 4 }]}>{g.label}</T>
          {g.items.map((s, i) => {
            const first = i === 0;
            const last = i === g.items.length - 1;
            return (
              <Pressable
                key={s.id}
                accessibilityRole="button"
                accessibilityLabel={s.name}
                onPress={() => onSection(s.id)}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 9,
                  paddingVertical: 13,
                  paddingHorizontal: 12,
                  minHeight: 44,
                  backgroundColor: t.c.panel,
                  borderWidth: 1,
                  borderColor: t.c.line,
                  borderTopColor: first ? t.c.line : "transparent",
                  borderTopLeftRadius: first ? t.radiusLg : 0,
                  borderTopRightRadius: first ? t.radiusLg : 0,
                  borderBottomLeftRadius: last ? t.radiusLg : 0,
                  borderBottomRightRadius: last ? t.radiusLg : 0,
                }}
              >
                <Icon d={ICONS[s.id]} color={t.c.dim} />
                <View style={{ flexShrink: 1, minWidth: 0 }}>
                  <T style={[font(t, "sans", 500, 13, 1.2), { color: t.c.muted }]}>{s.name}</T>
                  <T style={[font(t, "sans", 400, 11.5, 1.2), { color: t.c.dim, marginTop: 2 }]}>{dots[s.id] ?? lines[s.id] ?? s.sub}</T>
                </View>
                {dots[s.id] ? <View accessibilityLabel={dots[s.id]} style={{ marginLeft: "auto", width: 7, height: 7, borderRadius: 4, backgroundColor: t.c.warn }} /> : null}
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}

function Section({ id, daemon, onSection, onTheme }: { id: BuiltinSection; daemon: DaemonState; onSection: (s: SettingsSection | null) => void; onTheme: (t: StudioTheme) => void }) {
  let body: ReactNode = null;
  if (id === "general") body = <GeneralSection onTheme={onTheme} />;
  else if (id === "remote") body = <RemoteSection />;
  else if (id === "agents") body = <AgentsSection onSection={onSection} />;
  else if (id === "models") body = <ModelsSection />;
  else if (id === "approvals") body = <ApprovalsSection />;
  else if (id === "project") body = <ProjectSection onSection={onSection} />;
  else if (id === "diagnostics") body = <DiagnosticsSection daemon={daemon} />;
  return (
    <View testID={`settings-${id}`} accessibilityLabel={SECTION_NAMES[id]} style={{ gap: 14 }}>
      <Button variant="ghost" title={"‹ All settings"} label="All settings" onPress={() => onSection(null)} style={{ alignSelf: "flex-start", paddingLeft: 0, alignItems: "flex-start", justifyContent: "flex-start" }} />
      {body}
    </View>
  );
}

