/**
 * Messages written while a turn ran, in the order they will go, under the
 * conversation. Each can be changed or removed until it is sent. A turn that
 * finishes sends the next one; after a Stop or an error the queue waits, and
 * Send next starts it again.
 */
import { useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";
import { useWindowDimensions } from "react-native";
import type { QueuedMessage } from "@ue-mcp-studio/shared";
import { font, T, useTheme } from "../ui";
import { buttonText, small } from "./styles";

/** button.small-button at a finger's size: 44 tall, 10 either side. */
export function SmallButton({ title, onPress, variant = "default", disabled, label }: { title: string; onPress: () => void; variant?: "default" | "primary" | "ghost"; disabled?: boolean; label?: string }) {
  const t = useTheme();
  const primary = variant === "primary";
  const ghost = variant === "ghost";
  const bg = disabled ? (primary ? "transparent" : ghost ? "transparent" : t.c.panel2) : primary ? t.c.accent : ghost ? "transparent" : t.c.panel2;
  const line = disabled ? (ghost ? "transparent" : t.c.disabledLine) : primary ? t.c.accent : ghost ? "transparent" : t.c.lineStrong;
  const color = disabled ? t.c.dim : primary ? t.c.onAccent : ghost ? t.c.muted : t.c.text;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label ?? title} accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => ({ minHeight: 44, paddingHorizontal: 10, justifyContent: "center", alignItems: "center", borderRadius: t.radius, borderWidth: 1, borderColor: pressed && !disabled ? (primary ? t.c.accentHi : t.c.accentLine) : line, backgroundColor: pressed && !disabled ? (primary ? t.c.accentHi : t.c.panel3) : bg })}>
      <T style={[buttonText(t, primary && !disabled ? 600 : 500), { color }]}>{title}</T>
    </Pressable>
  );
}

export function QueuedMessages({ queue, busy, onEdit, onRemove, onSendNext }: {
  queue: QueuedMessage[];
  busy: boolean;
  onEdit: (id: string, text: string) => void;
  onRemove: (id: string) => void;
  onSendNext: () => void;
}) {
  const t = useTheme();
  const { height } = useWindowDimensions();
  if (queue.length === 0) return null;
  return (
    <ScrollView accessibilityLabel="Queued messages" style={{ flexGrow: 0, maxHeight: height * 0.28, borderTopWidth: 1, borderTopColor: t.c.line, backgroundColor: t.c.composerBg }} contentContainerStyle={{ gap: 2, paddingVertical: 6, paddingHorizontal: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingTop: 2, paddingBottom: 4 }}>
        <T style={[small(t), { color: t.c.dim, flex: 1 }]}>
          Queued ({queue.length}){busy ? ", sent one by one as each turn completes" : ""}
        </T>
        {!busy ? <SmallButton title="Send next" variant="ghost" onPress={onSendNext} /> : null}
      </View>
      {queue.map((q, i) => (
        <QueuedRow key={q.id} q={q} n={i + 1} onEdit={onEdit} onRemove={onRemove} />
      ))}
    </ScrollView>
  );
}

function QueuedRow({ q, n, onEdit, onRemove }: { q: QueuedMessage; n: number; onEdit: (id: string, text: string) => void; onRemove: (id: string) => void }) {
  const t = useTheme();
  const [editing, setEditing] = useState<string | null>(null);
  const box = { paddingVertical: 3, paddingHorizontal: 8, borderWidth: 1, borderColor: t.c.accentLine, borderRadius: 6, backgroundColor: t.c.accentWash };
  if (editing !== null) {
    const save = () => {
      if (editing.trim()) onEdit(q.id, editing);
      setEditing(null);
    };
    return (
      <View style={[box, { gap: 8 }]}>
        <TextInput
          accessibilityLabel={`Edit queued message ${n}`}
          value={editing}
          autoFocus
          multiline
          numberOfLines={Math.min(8, Math.max(2, editing.split("\n").length))}
          onChangeText={setEditing}
          selectionColor={t.c.selection}
          style={{ width: "100%", paddingVertical: 6, paddingHorizontal: 8, borderRadius: 6, backgroundColor: t.c.panel2, color: t.c.text, borderWidth: 1, borderColor: t.c.accentLine, ...font(t, "sans", 400, 16, 1.5), textAlignVertical: "top" }}
        />
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <View style={{ flex: 1 }} />
          <SmallButton title="Cancel" variant="ghost" onPress={() => setEditing(null)} />
          <SmallButton title="Save" variant="primary" disabled={!editing.trim()} onPress={save} />
        </View>
      </View>
    );
  }
  return (
    <View style={[box, { flexDirection: "row", alignItems: "center", gap: 8, borderStyle: "dashed" }]}>
      <T style={[small(t), { width: 14, textAlign: "right", color: t.c.dim }]}>{n}</T>
      <T numberOfLines={1} style={{ flex: 1, minWidth: 0, fontSize: 13 }}>
        {q.text || <T style={{ fontSize: 13, color: t.c.dim }}>(files only)</T>}
      </T>
      {q.attachments.length > 0 ? <T style={[small(t), { color: t.c.dim }]}>{`${q.attachments.length} ${q.attachments.length === 1 ? "file" : "files"}`}</T> : null}
      <SmallButton title="Edit" variant="ghost" label={`Edit queued message ${n}`} onPress={() => setEditing(q.text)} />
      <Pressable accessibilityRole="button" accessibilityLabel={`Remove queued message ${n}`} onPress={() => onRemove(q.id)} style={({ pressed }) => ({ minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: t.radius, backgroundColor: pressed ? t.c.panel3 : "transparent" })}>
        {({ pressed }) => <T style={{ fontSize: 13, lineHeight: 16, color: pressed ? t.c.bad : t.c.muted }}>{"×"}</T>}
      </Pressable>
    </View>
  );
}
