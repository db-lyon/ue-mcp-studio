/**
 * One session: its main thread as the web client draws it (client-core's
 * mainTimeline), the turn's text as it streams, the queued messages, and the
 * composer with send, send now, queue, stop and the model picker. Calls to
 * approve and editor dialogs wait as cards under the thread; a turn's review
 * opens its own screen, and the header opens the checkpoints.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, KeyboardAvoidingView, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { agentStatus, mainTimeline, OUTCOME_LABEL, summarize, TOOL_TAG, toolLabel, type MainItem } from "@ue-mcp-studio/client-core";
import type { StudioSettings, TranscriptEntry, TurnReview } from "@ue-mcp-studio/shared";
import { useProjectNav } from "../nav";
import { ApprovalCard, DialogCard, useDialogs } from "../Cards";
import { Markdown, useTheme } from "../ui";
import { useSession, useSettings } from "../session";
import { Composer } from "../chat/Composer";
import { useAttachments } from "../chat/attachments";
import { MentionText, type MentionSearchFn } from "../chat/MentionMenu";
import { ModelAndEffort } from "../views/ModelPicker";
import { Dot, s as ui, Spinner, tap } from "../legacy-ui";
import { colors } from "../theme";

const STATUS_LABEL: Record<string, string> = { idle: "Idle", running: "Working", waiting: "Waiting", error: "Error", stopped: "Stopped" };

export function SessionScreen({ id }: { id: string }) {
  const { project, api: studio, pop: onBack, push } = useProjectNav();
  const { detail, streaming, error, setError, api } = useSession(project, studio, id);
  const dialogs = useDialogs(project, studio);
  const mine = (dialogs.state?.dialogs ?? []).filter((d) => d.sessionId === id);
  const { settings } = useSettings(project, studio);
  const [ownSettings, setOwnSettings] = useState<StudioSettings | null>(null);
  const shownSettings = ownSettings ?? settings;
  const attach = useAttachments(id);
  const loadFlows = useCallback(() => studio.flows().then((r) => r.flows), [studio]);
  const loadActions = useCallback(() => studio.actions().then((r) => r.actions), [studio]);
  const searchMentions = useCallback<MentionSearchFn>((request, signal) => studio.searchMentions(request, signal), [studio]);
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const loadedDraft = useRef(false);
  const list = useRef<FlatList<Row>>(null);

  useEffect(() => {
    if (detail && !loadedDraft.current) {
      loadedDraft.current = true;
      setDraft((cur) => cur || detail.draft || "");
    }
  }, [detail]);

  const busy = detail?.status === "running" || detail?.status === "waiting";
  const rows = useMemo<Row[]>(() => {
    if (!detail) return [];
    const items: Row[] = mainTimeline(detail.transcript, detail.status).map((item, i) => ({ key: `i${i}`, item }));
    if (streaming) items.push({ key: "streaming", item: { kind: "entry", entry: { kind: "assistant", text: streaming, at: "" } }, live: true });
    return items;
  }, [detail, streaming]);

  const dispatch = async (how: "send" | "now" | "queue") => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setDraft("");
    attach.clear();
    try {
      if (how === "queue") await api.queue(text);
      else await api.send(text, how === "now");
      void api.saveDraft("").catch(() => undefined);
      setTimeout(() => list.current?.scrollToEnd({ animated: true }), 200);
    } catch (e) {
      setDraft(text);
      setError(String((e as Error).message ?? e));
    } finally {
      setSending(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: theme.c.panel }} behavior="padding">
      <View style={[st.head, { paddingTop: insets.top + 8 }]}>
        <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
          <Pressable accessibilityRole="button" onPress={onBack} hitSlop={8} style={tap}>
            <Text style={ui.link}>Sessions</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={() => push({ name: "checkpoints", sessionId: id })} hitSlop={8} style={tap}>
            <Text style={ui.link}>Checkpoints</Text>
          </Pressable>
        </View>
        <Text style={[ui.name, { fontSize: 17, marginTop: 6 }]} numberOfLines={1}>
          {detail?.title || "New session"}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 4 }}>
          <Dot state={busy ? "busy" : detail?.status === "error" ? "error" : project.live === "live" ? "on" : "off"} />
          <Text style={ui.sub}>
            {detail ? STATUS_LABEL[detail.status] ?? detail.status : "Loading"}
            {project.live !== "live" ? ". Reconnecting" : ""}
          </Text>
        </View>
      </View>
      {error ? <Text style={[ui.error, { paddingHorizontal: 16 }]}>{error}</Text> : null}
      <FlatList
        ref={list}
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 12 }}
        data={rows}
        keyExtractor={(r) => r.key}
        renderItem={({ item }) => <Item row={item} transcript={detail?.transcript ?? []} waiting={detail?.status === "waiting"} onReview={(review) => push({ name: "review", sessionId: id, review })} />}
        ListFooterComponent={
          <View>
            {mine.map((d) => (
              <DialogCard key={d.id} api={studio} dialog={d} now={dialogs.now} />
            ))}
            {(detail?.approvals ?? []).map((a) => (
              <ApprovalCard key={a.id} api={studio} sessionId={id} approval={a} />
            ))}
          </View>
        }
        ListEmptyComponent={detail ? <Text style={[ui.sub, { marginTop: 24 }]}>Ask Studio something to start.</Text> : <View style={{ marginTop: 24 }}><Spinner /></View>}
        onContentSizeChange={() => list.current?.scrollToEnd({ animated: false })}
      />
      {detail?.queue?.length ? (
        <View style={st.queue}>
          <Text style={ui.section}>Queued</Text>
          {detail.queue.map((q, i) => (
            <View key={q.id} style={st.queued}>
              <Text style={[ui.sub, { flex: 1, color: colors.text }]} numberOfLines={2}>
                {q.text}
              </Text>
              {i === 0 && !busy ? (
                <Pressable accessibilityRole="button" onPress={() => void api.sendQueued().catch((e) => setError(String(e?.message ?? e)))} hitSlop={8} style={tap}>
                  <Text style={ui.link}>Send</Text>
                </Pressable>
              ) : null}
              <Pressable accessibilityRole="button" accessibilityLabel="Remove from queue" onPress={() => void api.removeQueued(q.id).catch((e) => setError(String(e?.message ?? e)))} hitSlop={8} style={tap}>
                <Text style={{ color: colors.danger, fontSize: 15 }}>Remove</Text>
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}
      {/* TEMPORARY: the ported Composer in place of this screen's own, until chat-core's views/Chat.tsx lands. */}
      <Composer
        draft={draft}
        onDraft={setDraft}
        onBlur={() => void api.saveDraft(draft).catch(() => undefined)}
        placeholder={busy ? "The agent is working. Write the next message to queue it." : "Ask for something in the editor, or drop files here"}
        busy={busy}
        canSend={!!draft.trim() && !sending && !attach.uploading}
        onSend={() => void dispatch("send")}
        onQueue={() => void dispatch("queue")}
        onSendNow={() => void dispatch("now")}
        onStop={() => void api.stop().catch((e) => setError(String(e?.message ?? e)))}
        files={attach.files}
        onAddFiles={attach.add}
        onRemoveFile={attach.remove}
        flows={loadFlows}
        actions={loadActions}
        mentions={searchMentions}
        picker={shownSettings ? <ModelAndEffort settings={shownSettings} onSettings={setOwnSettings} /> : null}
      />
    </KeyboardAvoidingView>
  );
}

interface Row {
  key: string;
  item: MainItem;
  live?: boolean;
}

function SmallButton({ title, onPress, primary, danger, disabled }: { title: string; onPress: () => void; primary?: boolean; danger?: boolean; disabled?: boolean }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} disabled={disabled} style={({ pressed }) => [st.small, primary && st.smallPrimary, (pressed || disabled) && { opacity: 0.5 }]}>
      <Text style={[st.smallText, primary && { color: colors.onAccent }, danger && { color: colors.danger }]}>{title}</Text>
    </Pressable>
  );
}

function Item({ row, transcript, waiting, onReview }: { row: Row; transcript: TranscriptEntry[]; waiting: boolean; onReview: (r: TurnReview) => void }) {
  const [open, setOpen] = useState(false);
  const { item } = row;
  if (item.kind === "agents") {
    const now = Date.now();
    const states = item.calls.map((c) => agentStatus(c, transcript, waiting, now).state);
    return <Line tag="agents" text={`${item.calls.length === 1 ? "1 subagent" : `${item.calls.length} subagents`}: ${summarize(states)}`} />;
  }
  if (item.kind === "progress")
    return (
      <Pressable onPress={() => setOpen((o) => !o)}>
        <Line tag="progress" text={`${item.entries.length} progress ${item.entries.length === 1 ? "message" : "messages"}${open ? "" : ", tap to show"}`} />
        {open ? item.entries.map((e, i) => <Entry key={i} entry={e} onReview={onReview} />) : null}
      </Pressable>
    );
  return <Entry entry={item.entry} live={row.live} onReview={onReview} />;
}

function Entry({ entry, live, onReview }: { entry: TranscriptEntry; live?: boolean; onReview?: (r: TurnReview) => void }) {
  switch (entry.kind) {
    case "user":
      return (
        <View style={st.user}>
          <Text style={st.userText} selectable>
            <MentionText text={entry.text} />
          </Text>
        </View>
      );
    case "assistant":
      return (
        <View style={st.assistant}>
          <Markdown text={entry.text} tone={live ? { opacity: 0.7 } : undefined} />
        </View>
      );
    case "tool":
      return <Line tag={TOOL_TAG[entry.call.name] ?? entry.call.name} text={toolLabel(entry.call)} state={OUTCOME_LABEL[entry.call.outcome]} bad={entry.call.outcome === "error"} />;
    case "note":
      return <Text style={[ui.sub, { marginVertical: 6 }]}>{entry.text}</Text>;
    case "dialog":
      return <Line tag="dialog" text={`${entry.dialog.editor}: ${entry.dialog.title}`} />;
    case "qa":
      return <Line tag="playtest" text={`${entry.run.scriptName}: ${entry.run.state}`} />;
    case "playtest":
      return <Line tag="playtest" text={entry.state === "failed" ? "Playtest failed" : `Playtest ${entry.state}`} bad={entry.state === "failed"} />;
    case "playtest-failed":
      return <Line tag="playtest" text={`Playtest failed: ${entry.reason}`} bad />;
    case "review": {
      const left = entry.review.items.filter((i) => i.state === "pending").length;
      return (
        <Pressable accessibilityRole="button" accessibilityLabel="Review this turn's changes" onPress={() => onReview?.(entry.review)} style={st.reviewRow}>
          <Text style={st.tag}>review</Text>
          <Text style={[ui.sub, { flex: 1, color: colors.text }]}>
            {entry.review.items.length === 1 ? "1 change" : `${entry.review.items.length} changes`}
            {left ? `, ${left} to decide` : ", all decided"}
          </Text>
          <Text style={ui.link}>Review</Text>
        </Pressable>
      );
    }
    case "flow":
      return <Line tag="flow" text={`${entry.name}: ${entry.state}`} />;
    default:
      return null;
  }
}

function Line({ tag, text, state, bad }: { tag: string; text: string; state?: string; bad?: boolean }) {
  return (
    <View style={st.line}>
      <Text style={st.tag}>{tag}</Text>
      <Text style={[ui.sub, { flex: 1 }]} numberOfLines={2}>
        {text}
      </Text>
      {state ? <Text style={[ui.sub, bad && { color: colors.danger }]}>{state}</Text> : null}
    </View>
  );
}

const st = StyleSheet.create({
  head: { paddingHorizontal: 16, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  user: { alignSelf: "flex-end", maxWidth: "88%", backgroundColor: colors.panel, borderColor: colors.border, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8, marginVertical: 8 },
  userText: { color: colors.text, fontSize: 15, lineHeight: 21 },
  assistant: { marginVertical: 6 },
  reviewRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 10, paddingHorizontal: 10, marginVertical: 6, borderWidth: 1, borderColor: colors.border, borderRadius: 8, backgroundColor: colors.panel },
  line: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 },
  tag: { color: colors.accent, fontSize: 11, fontWeight: "600", fontFamily: "monospace", minWidth: 56 },
  queue: { paddingHorizontal: 16, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  queued: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 6 },
  composer: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingHorizontal: 12, paddingTop: 8, backgroundColor: colors.bg },
  input: { color: colors.text, fontSize: 15, maxHeight: 140, minHeight: 40, backgroundColor: colors.panel, borderRadius: 10, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12, paddingVertical: 8 },
  bar: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 8, gap: 8 },
  small: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  smallPrimary: { backgroundColor: colors.accent, borderColor: colors.accent },
  smallText: { color: colors.text, fontSize: 14, fontWeight: "600" },
});
