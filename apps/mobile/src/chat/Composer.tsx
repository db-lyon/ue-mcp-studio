// STUB: owned by composer
/**
 * The message box and its bar, as far as the chat needs it before the
 * composer's port lands: the box, the picker slot, Attach, Queue, Send or Stop.
 */
import type { ReactNode, RefObject } from "react";
import { Pressable, TextInput, View } from "react-native";
import type { ActionListing, FlowListing, SlashCommand } from "@ue-mcp-studio/shared";
import { Button, font, useTheme, T } from "../ui";
import type { PendingFile, PickedFile } from "./attachments";
import type { MentionSearchFn } from "./MentionMenu";

export function Composer({ draft, onDraft, onBlur, placeholder, busy, canSend, onSend, onQueue, onStop, picker, extras, children }: {
  draft: string;
  onDraft: (text: string) => void;
  onBlur: () => void;
  placeholder: string;
  busy: boolean;
  canSend: boolean;
  onSend: () => void;
  onQueue?: () => void;
  onSendNow?: () => void;
  onStop: () => void;
  files: PendingFile[];
  onAddFiles: (files: PickedFile[]) => void;
  onRemoveFile: (key: string) => void;
  picker: ReactNode;
  extras?: ReactNode;
  stage?: RefObject<unknown>;
  height?: number | null;
  onHeight?: (h: number | null) => void;
  commands?: readonly SlashCommand[];
  flows?: () => Promise<FlowListing[]>;
  actions?: () => Promise<ActionListing[]>;
  mentions?: MentionSearchFn;
  children?: ReactNode;
}) {
  const t = useTheme();
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: t.c.line, backgroundColor: t.c.composerBg, padding: 10, gap: 8 }}>
      <View style={{ position: "absolute", top: 3, left: "50%", marginLeft: -18, width: 36, height: 4, borderRadius: 2, backgroundColor: t.c.lineStrong }} />
      <TextInput
        accessibilityLabel="Message"
        value={draft}
        onChangeText={onDraft}
        onBlur={onBlur}
        placeholder={placeholder}
        placeholderTextColor={t.c.dim}
        multiline
        editable={!(busy && !onQueue)}
        style={{ backgroundColor: t.c.panel2, color: t.c.text, borderColor: t.c.lineStrong, borderWidth: 1, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 10, minHeight: 66, ...font(t, "sans", 400, 16, 1.5), textAlignVertical: "top" }}
      />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        {picker}
        <Pressable accessibilityRole="button" accessibilityLabel="Attach" style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
          <T tone="muted">{"\u{1F4CE}"}</T>
        </Pressable>
        {extras}
        <View style={{ flex: 1 }} />
        {busy && onQueue ? <Button title="Queue" disabled={!canSend} onPress={onQueue} /> : null}
        {busy ? <Button title="Stop" onPress={onStop} /> : <Button title="Send" variant="primary" disabled={!canSend} onPress={onSend} />}
      </View>
      {children}
    </View>
  );
}

/** A bar button that keeps its words while there is room, else its icon. */
export function BarButton({ label, title, icon, disabled, onClick }: { label: string; title: string; icon: ReactNode; className?: string; disabled?: boolean; onClick: () => void }) {
  return (
    <Button variant="ghost" label={label} disabled={disabled} onPress={onClick}>
      {icon ?? <T>{title}</T>}
    </Button>
  );
}

export function CheckpointsGlyph() {
  return <T tone="muted">{"⚑"}</T>;
}
