/**
 * Diagnostics (client-web Status and Logs views): the editors and the daemon
 * (EditorStatus, from the editor controls' port), and the daemon's events
 * newest first, each payload one line until opened.
 */
import { useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { Card, Input, Spacer, font, labelFont, T, useTheme } from "../../ui";
import { Head, Txt } from "../settings/controls";
import { EditorStatus } from "../editor/EditorStatus";
import type { DaemonState } from "../../state";

/** The payload as one line for the closed row, and indented for the opened one. */
export function eventPayload(data: unknown): { line: string; full: string } {
  if (data === undefined || data === null) return { line: "", full: "" };
  return { line: JSON.stringify(data), full: JSON.stringify(data, null, 2) };
}

export function DiagnosticsSection({ daemon }: { daemon: DaemonState }) {
  return (
    <>
      <Head title="Diagnostics" lead="Editor and daemon status, and recent daemon events." />
      <EditorStatus />
      <LogsView daemon={daemon} />
    </>
  );
}

function LogsView({ daemon }: { daemon: DaemonState }) {
  const t = useTheme();
  const events = daemon.events;
  const [filter, setFilter] = useState("");
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const all = events.slice().reverse();
    return f ? all.filter((e) => e.type.toLowerCase().includes(f) || JSON.stringify(e.data).toLowerCase().includes(f)) : all;
  }, [events, filter]);
  const mono = font(t, "mono", 400, 12 * 0.92, 1.55);
  return (
    <Card testID="log">
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8, marginVertical: 6 }}>
        <T accessibilityRole="header" style={labelFont(t)}>
          Events
        </T>
        <Spacer />
        <Input accessibilityLabel="Filter events" placeholder="Filter" value={filter} onChangeText={setFilter} style={{ flexGrow: 1, flexShrink: 1, flexBasis: 160, maxWidth: 280, minWidth: 0 }} />
      </View>
      <View accessibilityLabel="Events, newest first">
        {shown.map((e, i) => (
          <Event key={`${e.id}-${e.type}`} testID={`event-${i + 1}`} at={e.at} type={e.type} data={e.data} mono={mono} />
        ))}
      </View>
      {/* Its margin collapses through the empty list into the row's 6px above. */}
      {shown.length === 0 ? <Txt tone="muted" style={{ marginTop: t.base.size - 6, marginBottom: t.base.size }}>No events yet.</Txt> : null}
    </Card>
  );
}

function Event({ at, type, data, mono, testID }: { at: string; type: string; data: unknown; mono: ReturnType<typeof font>; testID: string }) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const p = eventPayload(data);
  return (
    <View testID={testID} style={{ paddingVertical: 6, paddingHorizontal: 8, borderBottomWidth: 1, borderBottomColor: t.c.line, minWidth: 0 }}>
      <View style={{ flexDirection: "row", gap: 10, alignItems: "baseline", minWidth: 0 }}>
        <T style={[mono, { color: t.c.dim }]}>{new Date(at).toLocaleTimeString()}</T>
        <T style={[mono, { color: t.c.accentHi, flexShrink: 1 }]}>{type}</T>
      </View>
      {p.line ? (
        <View style={{ marginTop: 2, minWidth: 0 }}>
          <Pressable accessibilityRole="button" accessibilityLabel={`Payload of ${type}`} accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} style={{ minHeight: 44, paddingVertical: 13, marginVertical: -6 }}>
            <T numberOfLines={1} style={[font(t, "mono", 400, 12 * 0.92, 1.55), { color: open ? t.c.dim : t.c.muted }]}>
              {p.line}
            </T>
          </Pressable>
          {open ? (
            <View style={{ marginTop: 4, paddingVertical: 8, paddingHorizontal: 10, backgroundColor: t.c.codeBg, borderWidth: 1, borderColor: t.c.line, borderRadius: 6 }}>
              <T style={[font(t, "mono", 400, 12 * 0.92, 1.55), { color: t.c.codeText }]}>{p.full}</T>
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
