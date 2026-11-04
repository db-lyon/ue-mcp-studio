/**
 * Diagnostics (client-web Status and Logs views): the editors with start,
 * stop, restart and rebuild, the daemon, and its events newest first, each
 * payload one line until opened.
 */
import { useEffect, useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import type { DaemonHealth } from "ue-mcp/daemon";
import { Button, Card, Dot, Input, Spacer, font, labelFont, T, useTheme } from "../../ui";
import { CardLabel, Head, Txt } from "../settings/controls";
import { DT } from "../settings/ProjectSection";
import { useProjectEvents, useSettingsApi } from "../settings/hooks";
import { useProjectNav } from "../../nav";
import { useEventLog } from "./event-log";

const CAUSE: Record<string, string> = { closed: "closed normally", crashed: "crashed", restarting: "restarting", rebuild: "rebuilding", unknown: "connection dropped" };

/** The payload as one line for the closed row, and indented for the opened one. */
export function eventPayload(data: unknown): { line: string; full: string } {
  if (data === undefined || data === null) return { line: "", full: "" };
  return { line: JSON.stringify(data), full: JSON.stringify(data, null, 2) };
}

export function DiagnosticsSection() {
  return (
    <>
      <Head title="Diagnostics" lead="Editor and daemon status, and recent daemon events." />
      <StatusView />
      <LogsView />
    </>
  );
}

function useHealth(): DaemonHealth | null {
  const api = useSettingsApi();
  const [health, setHealth] = useState<DaemonHealth | null>(null);
  useEffect(() => void api.health().then(setHealth, () => undefined), [api]);
  useProjectEvents((e) => {
    if (/^(editor|client|daemon)\./.test(e.type)) void api.health().then(setHealth, () => undefined);
  });
  return health;
}

function StatusView() {
  const api = useSettingsApi();
  const t = useTheme();
  const h = useHealth();
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const run = (op: "start" | "stop" | "restart" | "rebuild") => {
    setBusy(op);
    setResult(null);
    api
      .editor(op)
      .then(
        (r) => setResult(((r.steps as Array<{ step: string; ok: boolean }> | undefined) ?? []).map((s) => `${s.step}: ${s.ok ? "ok" : "failed"}`).join(", ")),
        (e: Error) => setResult(e.message),
      )
      .finally(() => setBusy(null));
  };
  if (!h) return <Txt tone="muted" style={{ marginVertical: t.base.size }}>Connecting to the daemon...</Txt>;
  const any = h.editors.some((e) => e.connected);
  return (
    <View style={{ gap: 14 }}>
      <Card>
        <CardLabel>Editors</CardLabel>
        {h.editors.map((e) => (
          <View key={e.name} style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 10, marginVertical: 6 }}>
            <Dot kind={e.connected ? "ok" : "warn"} />
            <Txt weight={700}>{e.name}</Txt>
            <Txt tone="muted">
              port {e.port}
              {e.pid ? `, pid ${e.pid}` : ""}
            </Txt>
            <Spacer />
            {!e.connected && e.lastDisconnect ? (
              <Txt tone="muted">
                {CAUSE[e.lastDisconnect.cause] ?? e.lastDisconnect.cause} at {new Date(e.lastDisconnect.at).toLocaleTimeString()}
              </Txt>
            ) : null}
          </View>
        ))}
        <View style={{ flexDirection: "row", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
          {(["start", "stop", "restart", "rebuild"] as const).map((op) => (
            <Button key={op} title={busy === op ? `${op}...` : op[0].toUpperCase() + op.slice(1)} disabled={busy !== null || (op === "start" ? any : !any)} onPress={() => run(op)} />
          ))}
        </View>
        {result ? <Txt tone="muted" style={{ marginVertical: t.base.size }}>{result}</Txt> : null}
      </Card>
      <Card>
        <CardLabel>Daemon</CardLabel>
        {(
          [
            ["Version", `${h.version} (API ${h.apiVersion})`],
            ["Process", `pid ${h.pid}, since ${new Date(h.startedAt).toLocaleString()}`],
            ["MCP clients connected now", `${h.clients}${h.inflight ? `, ${h.inflight} call(s) in flight` : ""}`],
            ["Extensions", h.extensions.map((x) => `${x.name} ${x.version}`).join(", ") || "none"],
            ["UI", h.ui ?? "development server"],
          ] as const
        ).map(([k, v]) => (
          <View key={k}>
            <DT>{k}</DT>
            <Txt style={{ marginBottom: 8 }}>{v}</Txt>
          </View>
        ))}
        <DT>Project</DT>
        <Txt mono style={{ marginBottom: 8 }}>
          {h.projectRoot}
        </Txt>
      </Card>
    </View>
  );
}

function LogsView() {
  const t = useTheme();
  const { project } = useProjectNav();
  const events = useEventLog(project);
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
      {shown.length === 0 ? <Txt tone="muted" style={{ marginVertical: t.base.size }}>No events yet.</Txt> : null}
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
          <Pressable accessibilityRole="button" accessibilityLabel={`Payload of ${type}`} accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} style={{ paddingVertical: 13, marginVertical: -6 }}>
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
