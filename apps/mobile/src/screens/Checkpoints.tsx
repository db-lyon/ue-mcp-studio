/**
 * A session's checkpoint timeline, newest first: Restore to here (and Restore
 * anyway when files were edited after the agent), Undo for a restore, and the
 * session's switch for reviewing each turn.
 */
import { useCallback, useEffect, useState } from "react";
import { Alert, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { outcomeNote } from "@ue-mcp-studio/client-core";
import { reviewOn, type RestoreOutcome, type SessionDetail, type TimelineMark } from "@ue-mcp-studio/shared";
import { useProjectNav } from "../nav";
import { CardButton, c } from "../Cards";
import { Header, s as ui, Spinner } from "../legacy-ui";
import { colors } from "../theme";

export function CheckpointsScreen({ sessionId }: { sessionId: string }) {
  const { api, pop, project } = useProjectNav();
  const [detail, setDetail] = useState<Pick<SessionDetail, "timeline" | "review"> | null>(null);
  const [fallback, setFallback] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api.sessionSync(sessionId);
      setDetail({ timeline: d.timeline ?? [], review: d.review });
      setFallback((await api.reviewStatus()).default);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api, sessionId]);
  useEffect(() => void load(), [load]);
  useEffect(() => project.onEvent((e) => void (e.type === "studio.session.changed" && e.data.sessionId === sessionId && load())), [project, sessionId, load]);

  const run = (call: () => Promise<{ outcome?: RestoreOutcome }>, retry?: () => void) => {
    setBusy(true);
    setError(null);
    setNote(null);
    call()
      .then(
        (r) => {
          const text = r.outcome ? outcomeNote(r.outcome) : null;
          setNote(text);
          if (r.outcome?.conflicts.length && retry)
            Alert.alert("Restore anyway?", `${text ?? ""} Restore anyway puts those files back too and loses the edits made after the agent.`, [
              { text: "Leave them", style: "cancel" },
              { text: "Restore anyway", style: "destructive", onPress: retry },
            ]);
          void load();
        },
        (e: Error) => setError(e.message),
      )
      .finally(() => setBusy(false));
  };
  const restore = (m: TimelineMark, force = false) => run(() => api.timelineRestore(sessionId, m.checkpoint, force), force ? undefined : () => restore(m, true));
  const confirmRestore = (m: TimelineMark) =>
    Alert.alert("Restore to here?", `The project's files go back to how they were at "${m.label}". You can undo it.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Restore", onPress: () => restore(m) },
    ]);
  const undo = (m: TimelineMark) => run(() => api.timelineUndo(sessionId, m.checkpoint));
  const on = detail && fallback !== null ? reviewOn(detail, fallback) : null;
  const toggle = (next: boolean) =>
    run(async () => {
      await api.setSessionReview(sessionId, next === fallback ? null : next);
      return {};
    });

  const marks = [...(detail?.timeline ?? [])].reverse();
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={ui.page}>
      <Header title="Checkpoints" back="Session" onBack={pop} />
      <View style={[ui.row, { borderBottomWidth: 0 }]}>
        <View style={{ flex: 1 }}>
          <Text style={ui.name}>Review each turn</Text>
          <Text style={ui.sub}>{on === null ? "" : detail?.review === null || detail?.review === undefined ? "Follows Settings on your computer." : "Set for this session."}</Text>
        </View>
        <Switch accessibilityLabel="Review each turn" value={!!on} disabled={on === null || busy} onValueChange={toggle} trackColor={{ true: colors.accent, false: colors.border }} thumbColor={colors.text} />
      </View>
      {note ? <Text style={[ui.sub, { color: colors.warnText }]}>{note}</Text> : null}
      {error ? <Text style={ui.error}>{error}</Text> : null}
      {!detail && !error ? <Spinner /> : null}
      {detail && !marks.length ? <Text style={[ui.sub, { marginTop: 12 }]}>No checkpoints yet. Each reviewed turn, restore and playtest attempt adds one.</Text> : null}
      <View style={{ marginTop: 8 }}>
        {marks.map((m, i) => (
          <View key={`${m.kind}-${m.checkpoint}-${i}`} style={t.mark}>
            <View style={[t.dot, m.kind === "restore" && { backgroundColor: colors.warn }, m.undone && { backgroundColor: colors.faint }]} />
            <View style={{ flex: 1 }}>
              <Text style={[ui.name, m.undone && { color: colors.faint, textDecorationLine: "line-through" }]}>{m.label}</Text>
              <Text style={ui.sub}>{new Date(m.at).toLocaleString()}</Text>
              <View style={c.actions}>
                {m.kind !== "restore" ? <CardButton title="Restore to here" label={`Restore to ${m.label}`} disabled={busy} onPress={() => confirmRestore(m)} /> : null}
                {m.kind === "restore" && m.undo && !m.undone ? <CardButton title="Undo restore" disabled={busy} onPress={() => undo(m)} /> : null}
              </View>
            </View>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

const t = StyleSheet.create({
  mark: { flexDirection: "row", gap: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.accent, marginTop: 6 },
});
