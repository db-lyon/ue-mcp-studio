/**
 * Settings > Diagnostics' status: each editor with its connection, Start,
 * Stop, Restart and Rebuild, and the daemon's version, process, clients,
 * extensions, UI and project. A paired phone restarts and rebuilds the editor
 * here; the PIN lock asks first when the computer says so.
 */
import { useState, type ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { DISCONNECT_CAUSE, EDITOR_OPS, stepsLine, type EditorOp } from "@ue-mcp-studio/client-core";
import { Button, Card, Dot, Label, T, font, useTheme } from "../../ui";
import { useProjectNav } from "../../nav";
import { useHealth } from "./state";
import { cardFrame, monoFont } from "../../ui/type";

const title = (op: EditorOp) => op[0].toUpperCase() + op.slice(1);

export function EditorStatus() {
  const t = useTheme();
  const { api } = useProjectNav();
  const h = useHealth();
  const [busy, setBusy] = useState<EditorOp | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const run = (op: EditorOp) => {
    setBusy(op);
    setResult(null);
    api.editor(op).then(
      (r) => setResult(stepsLine(r)),
      (e: Error) => setResult(e.message),
    ).finally(() => {
      setBusy(null);
      h.reload();
    });
  };

  const raw = h.raw as Record<string, unknown> | null;
  if (!raw) return <T tone="muted">Connecting to ue-mcp</T>;
  const anyUp = h.editors.some((e) => e.connected);
  const exts = Array.isArray(raw.extensions) ? (raw.extensions as Array<{ name: string; version?: string }>) : [];
  const strong = font(t, "sans", 700, t.base.size);
  const card = [s.card, cardFrame(t)];
  return (
    <View style={s.stack} testID="editor-status">
      <View testID="editor-status-editors">
      <Card style={card}>
        <Label style={s.h2}>Editors</Label>
        {h.editors.map((e, i) => (
          <View key={e.name} style={[s.row, i > 0 && { marginTop: 6 }]}>
            <View style={e.connected && t.name === "ue-mcp" ? ({ boxShadow: "0px 0px 8px rgba(108, 192, 139, 0.6)", borderRadius: 4 } as object) : null}>
              <Dot kind={e.connected ? "ok" : "warn"} />
            </View>
            <T style={strong}>{e.name}</T>
            <T tone="muted">
              port {e.port}
              {e.pid ? `, pid ${e.pid}` : ""}
            </T>
            <View style={{ flex: 1 }} />
            {!e.connected && e.lastDisconnect ? (
              <T tone="muted">
                {DISCONNECT_CAUSE[e.lastDisconnect.cause] ?? e.lastDisconnect.cause} at {new Date(e.lastDisconnect.at).toLocaleTimeString()}
              </T>
            ) : null}
          </View>
        ))}
        {/* With no editor row, the heading's 12px margin collapses into the buttons' 14. */}
        <View style={[s.actions, h.editors.length === 0 && { marginTop: 2 }]}>
          {EDITOR_OPS.map((op) => (
            <Button key={op} title={busy === op ? `${op}...` : title(op)} disabled={busy !== null || (op === "start" ? anyUp : !anyUp)} onPress={() => run(op)} />
          ))}
        </View>
        {result ? <T tone="muted" style={{ marginVertical: 13.5 }}>{result}</T> : null}
      </Card>
      </View>
      <View testID="editor-status-daemon">
      <Card style={card}>
        <Label style={s.h2}>Daemon</Label>
        <Grid name="Version">
          {String(raw.version ?? "?")} (API {String(raw.apiVersion ?? "?")})
        </Grid>
        <Grid name="Process">
          pid {String(raw.pid)}, since {new Date(String(raw.startedAt)).toLocaleString()}
        </Grid>
        <Grid name="MCP clients connected now">
          {String(raw.clients)}
          {raw.inflight ? `, ${String(raw.inflight)} call(s) in flight` : ""}
        </Grid>
        <Grid name="Extensions">{exts.map((x) => `${x.name} ${x.version ?? "?"}`).join(", ") || "none"}</Grid>
        <Grid name="UI">{raw.ui ? String(raw.ui) : "development server"}</Grid>
        <Grid name="Project" mono last>
          {String(raw.projectRoot ?? "")}
        </Grid>
      </Card>
      </View>
    </View>
  );
}

/** One dt and dd of the daemon's .grid, stacked as a phone shows it. */
function Grid({ name, children, mono, last }: { name: string; children: ReactNode; mono?: boolean; last?: boolean }) {
  const t = useTheme();
  return (
    <View style={{ marginBottom: last ? 8 : 8 }}>
      <Text style={[t.editor ? font(t, "sans", 400, 12, 1.6) : { ...font(t, "mono", 500, 11, 1.6), letterSpacing: 0.88, textTransform: "uppercase" }, { color: t.c.dim }]}>{name}</Text>
      {mono ? <Text style={[monoFont(t), { color: t.c.text }]}>{children}</Text> : <T>{children}</T>}
    </View>
  );
}

const s = StyleSheet.create({
  stack: { flexDirection: "column", gap: 12 },
  card: { padding: 12 },
  h2: { marginBottom: 12 },
  // The web card is a block: the label, the rows and the buttons collapse their margins into 12, 6 and 14.
  row: { flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" },
  actions: { flexDirection: "row", gap: 8, flexWrap: "wrap", marginTop: 14 },
});
