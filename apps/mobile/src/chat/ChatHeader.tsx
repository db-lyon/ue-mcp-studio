/**
 * The single header over a conversation on the phone. Back goes up one level:
 * from a subagent's thread to the main thread, from the main thread to the
 * session list. The title is the thread on screen, with the session above it
 * in small type while a subagent's thread is open, and that thread's state
 * and Stop, and the context ring at the right end. Checkpoints, the subagents
 * and Attach are in the composer bar.
 */
import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import type { SessionAgent } from "@ue-mcp-studio/shared";
import { STATE_LABEL, agentView, describe, isActive, type AgentState } from "@ue-mcp-studio/client-core";
import { font, lineBox, T, useTheme, type Theme } from "../ui";
import { useNow } from "./hooks";
import { buttonText } from "./styles";

/** An agent state's dot and label colours (.state-* .agents-dot, .agents-state). */
export function stateColors(t: Theme, state: AgentState | "main"): { dot: string; label: string } {
  switch (state) {
    case "main":
      return { dot: t.c.text, label: t.c.muted };
    case "working":
      return { dot: t.c.accent, label: t.c.accentHi };
    case "waiting":
    case "approval":
      return { dot: t.c.warn, label: t.c.warn };
    case "unknown":
      return { dot: t.c.warn, label: t.c.warn };
    case "done":
      return { dot: t.c.ok, label: t.c.ok };
    case "failed":
      return { dot: t.c.bad, label: t.c.bad };
    default:
      return { dot: t.c.muted, label: t.c.muted };
  }
}

/**
 * .chat-back on a touch screen: the coarse-pointer rule trims it to 44 px with
 * no vertical padding, so its buttons' 44 px targets set the height.
 */
export const HEADER_ROW = (t: Theme) => ({ flexDirection: "row" as const, alignItems: "center" as const, gap: 6, minHeight: 44, paddingLeft: 4, paddingRight: 8, borderBottomWidth: 1, borderBottomColor: t.c.line, flexShrink: 0 });

/**
 * The back button's 0.02em at its 16 px font size, which the label inherits.
 * The editor themes' button rule outranks the 16 px and sets no spacing.
 */
const backSpacing = (t: Theme) => (t.editor ? 0 : 0.32);

export function ChatHeader({ title, thread, onSessions, onMain, onStop, onTitleLongPress, trailing }: {
  title: string;
  /** At the right end of the row: the context ring. */
  trailing?: ReactNode;
  /** The subagent whose thread is open, from the daemon's list; null on the main thread. */
  thread: SessionAgent | null;
  onSessions: () => void;
  onMain: () => void;
  onStop: (id: string) => void;
  /** A long press on the title: shows or hides the diagnostics strip. */
  onTitleLongPress?: () => void;
}) {
  const t = useTheme();
  const now = useNow(!!thread && isActive(thread.state));
  const st = thread ? agentView(thread, now) : null;
  const ghost = ({ pressed }: { pressed: boolean }) => ({ minHeight: 44, flexDirection: "row" as const, alignItems: "center" as const, borderRadius: t.radius, borderWidth: 1, borderColor: pressed ? t.c.line : "transparent", backgroundColor: pressed ? t.c.panel2 : "transparent" });
  return (
    <View style={HEADER_ROW(t)}>
      <Pressable accessibilityRole="button" accessibilityLabel={thread ? "Back to the main thread" : "Back to sessions"} onPress={thread ? onMain : onSessions} style={(s) => [ghost(s), { gap: 4, paddingVertical: 6, paddingHorizontal: 8 }]}>
        <T style={[buttonText(t), t.editor ? null : { fontSize: 16, lineHeight: lineBox(16, 1.2), letterSpacing: backSpacing(t) }, { color: t.c.muted }]}>{"‹"}</T>
        <T style={[font(t, "mono", 500, 12, 1), { letterSpacing: backSpacing(t), color: t.c.muted }]}>{thread ? "Main" : "Sessions"}</T>
      </Pressable>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        {thread ? (
          <T numberOfLines={1} style={{ fontSize: 11, lineHeight: lineBox(11, t.base.lineHeight / t.base.size), color: t.c.dim }}>
            {title}
          </T>
        ) : null}
        <T weight={600} numberOfLines={1} onLongPress={onTitleLongPress} style={{ lineHeight: t.base.lineHeight }}>
          {thread ? describe(thread.call) : title}
        </T>
      </View>
      {st && thread ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 0 }}>
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: stateColors(t, st.state).dot }} />
          <T style={{ fontSize: 11, lineHeight: lineBox(11, t.base.lineHeight / t.base.size), color: stateColors(t, st.state).label }}>{STATE_LABEL[st.state]}</T>
        </View>
      ) : null}
      {st && thread && isActive(st.state) ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Stop" onPress={() => onStop(thread.id)} style={{ minHeight: 44, justifyContent: "center", paddingVertical: 6, paddingHorizontal: 12, backgroundColor: t.c.panel2, borderWidth: 1, borderColor: t.c.lineStrong, borderRadius: t.radius }}>
          <T style={[buttonText(t), { color: t.c.bad }]}>Stop</T>
        </Pressable>
      ) : null}
      {trailing ? <View style={{ flexShrink: 0, marginRight: -4 }}>{trailing}</View> : null}
    </View>
  );
}
