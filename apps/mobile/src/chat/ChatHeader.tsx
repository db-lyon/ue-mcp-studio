/**
 * The single header over a conversation on the phone. Back goes up one level:
 * from a subagent's thread to the main thread, from the main thread to the
 * session list. The title is the thread on screen, with the session above it
 * in small type while a subagent's thread is open. `onAgents`, when given,
 * adds a button for the session's subagents.
 */
import { Pressable, View } from "react-native";
import type { TranscriptEntry } from "@ue-mcp-studio/shared";
import { STATE_LABEL, agentStatus, describe, isActive, type AgentState, type Call } from "@ue-mcp-studio/client-core";
import { font, lineBox, T, useTheme, type Theme } from "../ui";
import { useNow } from "./hooks";
import { useAsked } from "./asked";
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

/** Two people: the subagents button's glyph, 16 px in currentColor. */
export function AgentsGlyph({ color }: { color: string }) {
  const head = (left: number) => <View style={{ position: "absolute", left, top: 2.3, width: 5.4, height: 5.4, borderRadius: 2.7, borderWidth: 1.4, borderColor: color }} />;
  const body = (left: number) => <View style={{ position: "absolute", left, top: 9.5 - 0.7, width: 8.4, height: 8.4, borderRadius: 4.2, borderWidth: 1.4, borderColor: color, borderBottomColor: "transparent", borderLeftColor: color, borderRightColor: color, transform: [{ scaleY: 1 }] }} />;
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: 16, height: 16, overflow: "hidden" }}>
      {head(2.3)}
      {head(8.3)}
      <View style={{ position: "absolute", left: 0, top: 0, width: 16, height: 13.7, overflow: "hidden" }}>
        {body(0.8)}
        {body(6.8)}
      </View>
    </View>
  );
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

export function ChatHeader({ title, thread, transcript, sessionWaiting, agents, onSessions, onMain, onStop, onAgents, onReview }: {
  title: string;
  thread: Call | null;
  transcript: TranscriptEntry[];
  sessionWaiting: boolean;
  /** How many subagents the session has started. */
  agents: number;
  onSessions: () => void;
  onMain: () => void;
  onStop: (id: string) => void;
  onAgents?: () => void;
  /** Opens the session's review switch and checkpoint timeline. */
  onReview?: () => void;
}) {
  const t = useTheme();
  const now = useNow(thread?.outcome === "pending");
  const asked = useAsked();
  const st = thread ? agentStatus(thread, transcript, sessionWaiting, now, asked) : null;
  const ghost = ({ pressed }: { pressed: boolean }) => ({ minHeight: 44, flexDirection: "row" as const, alignItems: "center" as const, borderRadius: t.radius, borderWidth: 1, borderColor: pressed ? t.c.line : "transparent", backgroundColor: pressed ? t.c.panel2 : "transparent" });
  return (
    <View style={HEADER_ROW(t)}>
      <Pressable accessibilityRole="button" accessibilityLabel={thread ? "Back to the main thread" : "Back to sessions"} onPress={thread ? onMain : onSessions} style={(s) => [ghost(s), { gap: 4, paddingVertical: 6, paddingHorizontal: 8 }]}>
        <T style={[buttonText(t), t.editor ? null : { fontSize: 16, lineHeight: lineBox(16, 1.2), letterSpacing: backSpacing(t) }, { color: t.c.muted }]}>{"‹"}</T>
        <T style={[font(t, "mono", 500, 12, 1), { letterSpacing: backSpacing(t), color: t.c.muted }]}>{thread ? "Main" : "Sessions"}</T>
      </Pressable>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        {thread ? (
          <T numberOfLines={1} style={{ fontSize: 11, lineHeight: t.editor ? 16.5 : 17.05, color: t.c.dim }}>
            {title}
          </T>
        ) : null}
        <T weight={600} numberOfLines={1} style={{ lineHeight: t.base.lineHeight }}>
          {thread ? describe(thread) : title}
        </T>
      </View>
      {st && thread ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 0 }}>
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: stateColors(t, st.state).dot }} />
          <T style={{ fontSize: 11, lineHeight: 17, color: stateColors(t, st.state).label }}>{STATE_LABEL[st.state]}</T>
        </View>
      ) : null}
      {st && thread && isActive(st.state) ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Stop" onPress={() => onStop(thread.id)} style={{ minHeight: 44, justifyContent: "center", paddingVertical: 6, paddingHorizontal: 12, backgroundColor: t.c.panel2, borderWidth: 1, borderColor: t.c.lineStrong, borderRadius: t.radius }}>
          <T style={[buttonText(t), { color: t.c.bad }]}>Stop</T>
        </Pressable>
      ) : null}
      {onReview && !thread ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Checkpoints" accessibilityHint="Review and checkpoints" onPress={onReview} style={(s) => [ghost(s), { paddingVertical: 6, paddingHorizontal: 12 }]}>
          <T style={[buttonText(t), { color: t.c.muted }]}>Checkpoints</T>
        </Pressable>
      ) : null}
      {onAgents && agents > 0 ? (
        <Pressable accessibilityRole="button" accessibilityLabel={`Subagents (${agents})`} onPress={onAgents} style={(s) => [ghost(s), { gap: 6, paddingVertical: 6, paddingHorizontal: 8 }]}>
          <AgentsGlyph color={t.c.muted} />
          <T style={[buttonText(t), { color: t.c.muted }]}>{agents}</T>
        </Pressable>
      ) : null}
    </View>
  );
}
