/**
 * The threads of the session, in the Subagents sheet on the phone: the main
 * agent, the subagents still running (each with a stop button), and the
 * finished ones in a section that starts collapsed. Finished ones this viewer
 * has not opened are marked new. A row switches the conversation to that
 * thread. A finished row can be dismissed, one at a time or all at once; the
 * session keeps the dismissals, and the subagent's line in the conversation
 * stays. Each row shows that agent's context now, or what it spent. The rows
 * are the daemon's subagent list (SessionDetail.subagents), never worked out
 * from the page of the transcript the phone holds.
 */
import { useState } from "react";
import { Pressable, View } from "react-native";
import type { ContextUsage, SessionAgent } from "@ue-mcp-studio/shared";
import { STATE_LABEL, agentView, describe, formatDuration, isActive, listedSubagents, summarize, tokenCount, type AgentState } from "@ue-mcp-studio/client-core";
import { font, T, useTheme } from "../ui";
import { useNow } from "./hooks";
import { stateColors } from "./ChatHeader";
import { buttonText, small } from "./styles";

const EMPTY: ReadonlySet<string> = new Set();

export function Threads({ agents, thread, onThread, onStop, seen, dismissed = EMPTY, onDismiss, tokens = {}, context = {} }: {
  agents: SessionAgent[];
  thread: string | null;
  onThread: (id: string | null) => void;
  onStop: (id: string) => void;
  seen: ReadonlySet<string>;
  dismissed?: ReadonlySet<string>;
  onDismiss?: (ids: string[]) => void;
  /** Tokens the main agent spent this session, under "main". */
  tokens?: Record<string, number>;
  /** The main agent's current context, under "main". */
  context?: Record<string, ContextUsage>;
}) {
  const t = useTheme();
  const now = useNow(agents.some((a) => isActive(a.state)));
  const [showFinished, setShowFinished] = useState(false);
  // The open thread keeps its row until it is closed, so a dismissal never pulls the list out from under it.
  const listed = listedSubagents(agents, dismissed, thread);
  // With no subagents there is no list: the composer's context meter has the main agent's numbers.
  if (listed.length === 0) return null;
  const byId = new Map(agents.map((a) => [a.id, a]));

  const dimSmall = [small(t), { color: t.c.dim }];
  // .agents-meta and .agents-tokens: `.dim.small` inside .agents-open, so the row's mono at 12 px, never wrapped.
  const rowMeta = [font(t, "mono", 400, 12, 1.5), { color: t.c.dim, flexShrink: 0 }];
  /** An agent's line: its context now when measured, else what it spent this session. */
  const usage = (key: string) => {
    const a = byId.get(key);
    const c = a ? a.context : context[key];
    const spent = (a ? a.tokens : tokens[key]) ?? 0;
    return <T numberOfLines={1} style={rowMeta} accessibilityHint={`${spent.toLocaleString("en-US")} input and output tokens spent this session`}>{c ? `context ${tokenCount(c.input + c.output)}` : `${tokenCount(spent)} spent`}</T>;
  };
  const rows = listed.map((a) => ({ call: a.call, steps: a.steps, ...agentView(a, now) }));
  const active = rows.filter((r) => isActive(r.state));
  const finished = rows.filter((r) => !isActive(r.state));
  const failed = finished.filter((r) => r.state === "failed" || r.state === "unknown").length;
  const fresh = finished.filter((r) => !seen.has(r.call.id)).length;
  const open = showFinished || finished.some((r) => r.call.id === thread);

  const rowBox = (current: boolean, children: React.ReactNode, key: string) => (
    <View key={key} style={{ flexDirection: "row", alignItems: "center", borderRadius: 6, backgroundColor: current ? t.c.accentWash : "transparent", overflow: "hidden" }}>
      {current ? <View style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 2, backgroundColor: t.c.accent }} /> : null}
      {children}
    </View>
  );
  const openStyle = { flex: 1, minWidth: 0, flexDirection: "row" as const, alignItems: "center" as const, gap: 8, minHeight: 44, paddingVertical: 3, paddingHorizontal: 8 };
  const rowText = font(t, "mono", 400, 12, 1.5);
  const iconButton = (label: string, glyph: string, size: number, onPress: () => void) => (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => ({ minWidth: 44, minHeight: 44, marginRight: 4, borderRadius: t.radius, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? t.c.panel3 : "transparent" })}>
      <T style={{ fontSize: size, lineHeight: size + 4, color: t.c.muted }}>{glyph}</T>
    </Pressable>
  );

  const row = (r: (typeof rows)[number]) => {
    const calls = r.steps;
    const isNew = !isActive(r.state) && !seen.has(r.call.id);
    const colors = stateColors(t, r.state as AgentState);
    return rowBox(
      thread === r.call.id,
      <>
        <Pressable accessibilityRole="tab" accessibilityState={{ selected: thread === r.call.id }} accessibilityLabel={describe(r.call)} onPress={() => onThread(r.call.id)} style={openStyle}>
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.dot }} />
          <T numberOfLines={1} style={[rowText, { flexShrink: 1, color: t.c.text }]}>{describe(r.call)}</T>
          {isNew ? (
            <View style={{ paddingHorizontal: 5, borderRadius: 8, backgroundColor: t.c.accentWash }}>
              <T style={[font(t, "mono", 400, 10, 1.5), { color: t.c.accentHi }]}>new</T>
            </View>
          ) : null}
          <T style={[rowText, { fontSize: 11, color: colors.label }]}>{STATE_LABEL[r.state]}</T>
          {r.activity ? <T numberOfLines={1} style={[font(t, "mono", 400, 11, 1.5), { flex: 1, minWidth: 0, color: t.c.dim }]}>{r.activity}</T> : <View style={{ flex: 1 }} />}
          <T numberOfLines={1} style={rowMeta}>{`${calls} ${calls === 1 ? "call" : "calls"}, ${formatDuration(r.secs)}`}</T>
          {usage(r.call.id)}
        </Pressable>
        {isActive(r.state) ? iconButton(`Stop ${describe(r.call)}`, "■", 9, () => onStop(r.call.id)) : null}
        {!isActive(r.state) && onDismiss ? iconButton(`Dismiss ${describe(r.call)}`, "×", 13, () => onDismiss([r.call.id])) : null}
      </>,
      r.call.id,
    );
  };

  return (
    <View accessibilityRole="tablist" style={{ gap: 2 }}>
      <T style={[dimSmall, { paddingTop: 2, paddingHorizontal: 2, paddingBottom: 4 }]}>Subagents: {summarize(rows.map((r) => r.state))}</T>
      {rowBox(
        thread === null,
        <Pressable accessibilityRole="tab" accessibilityState={{ selected: thread === null }} accessibilityLabel="Main" onPress={() => onThread(null)} style={openStyle}>
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: t.c.text }} />
          <T numberOfLines={1} style={[rowText, { flexShrink: 1, color: t.c.text }]}>Main</T>
          {usage("main")}
        </Pressable>,
        "main",
      )}
      {active.map(row)}
      {finished.length > 0 ? (
        <>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={`Finished (${finished.length})`} onPress={() => setShowFinished(!open)} style={({ pressed }) => ({ flex: 1, flexDirection: "row", alignItems: "center", gap: 6, minHeight: 44, paddingVertical: 4, paddingHorizontal: 8, marginTop: 2, borderRadius: t.radius, backgroundColor: pressed ? t.c.panel2 : "transparent" })}>
              <T style={[buttonText(t), { fontSize: 12, width: 10, color: t.c.dim }]}>{open ? "▾" : "▸"}</T>
              <T style={[buttonText(t), { fontSize: 12, color: t.c.dim }]}>
                Finished ({finished.length})
                {fresh > 0 ? <T style={[buttonText(t), { fontSize: 12, color: t.c.accentHi }]}>, {fresh} new</T> : null}
                {failed > 0 ? <T style={[buttonText(t), { fontSize: 12, color: t.c.bad }]}>, {failed} failed</T> : null}
              </T>
            </Pressable>
            {onDismiss ? (
              <Pressable accessibilityRole="button" accessibilityLabel="Clear finished" onPress={() => onDismiss(finished.map((r) => r.call.id))} style={({ pressed }) => ({ marginLeft: "auto", marginRight: 4, minHeight: 44, justifyContent: "center", paddingHorizontal: 10, borderRadius: t.radius, backgroundColor: pressed ? t.c.panel2 : "transparent" })}>
                <T style={[buttonText(t), { fontSize: 12, color: t.c.dim }]}>Clear finished</T>
              </Pressable>
            ) : null}
          </View>
          {open ? finished.map(row) : null}
        </>
      ) : null}
    </View>
  );
}
