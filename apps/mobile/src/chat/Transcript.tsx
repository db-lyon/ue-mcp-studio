// STUB: owned by transcript
/**
 * The conversation, as far as the chat needs it before the transcript's port
 * lands: messages, replies, the review card, a line per tool call and subagent.
 */
import { createContext, memo } from "react";
import { Pressable, ScrollView, View } from "react-native";
import type { PlaytestRequest, TranscriptEntry, TurnStatus } from "@ue-mcp-studio/shared";
import { describe, mainTimeline, toolLabel, type Call } from "@ue-mcp-studio/client-core";
import { Banner, Button, Markdown, T, useTheme } from "../ui";
import { useFollow } from "./hooks";
import { TurnReviewCard } from "./TurnReview";

export type EditMode = "rewind" | "fork";
export const EditMessageContext = createContext<((index: number, text: string, mode: EditMode) => void) | null>(null);
export const PlaytestCommandContext = createContext<{ busy: boolean; run: (req: PlaytestRequest) => void } | null>(null);

export const Entry = memo(function Entry({ entry }: { entry: TranscriptEntry }) {
  const t = useTheme();
  if (entry.kind === "user") {
    return (
      <View style={{ alignSelf: "flex-end", maxWidth: "86%", paddingVertical: 10, paddingHorizontal: 13, borderRadius: 10, backgroundColor: t.c.accentWash, borderWidth: 1, borderColor: t.c.accentLine }}>
        <T>{entry.text}</T>
      </View>
    );
  }
  if (entry.kind === "assistant") return <View style={{ paddingLeft: 2 }}><Markdown text={entry.text} /></View>;
  if (entry.kind === "note") return <Banner kind="warn">{entry.text}</Banner>;
  if (entry.kind === "review") return <TurnReviewCard review={entry.review} />;
  if (entry.kind !== "tool") return null;
  return <T role="mono" size={12} tone="muted">{toolLabel(entry.call)}</T>;
});

export const MainTranscript = memo(function MainTranscript({ transcript, status, streaming, waitingCause, error, onOpen, sent }: {
  transcript: TranscriptEntry[];
  status: TurnStatus;
  streaming: string;
  waitingCause: string | null;
  error: string | null;
  onOpen: (id: string) => void;
  hidden: boolean;
  sent?: number;
}) {
  const t = useTheme();
  const items = mainTimeline(transcript, status);
  const follow = useFollow(`${transcript.length}:${streaming.length}:${status}`, sent);
  return (
    <ScrollView {...follow.props} style={{ flex: 1 }} contentContainerStyle={{ gap: 12, paddingTop: 14, paddingHorizontal: 12, paddingBottom: 10 }}>
      {items.map((item, i) => {
        if (item.kind === "entry") return <Entry key={i} entry={item.entry} />;
        if (item.kind === "progress") return <View key={i} style={{ gap: 10 }}>{item.entries.map((e, j) => <Entry key={j} entry={e} />)}</View>;
        return (
          <View key={item.calls[0].id} style={{ gap: 6 }}>
            {item.calls.map((c: Call) => (
              <Pressable key={c.id} accessibilityRole="button" onPress={() => onOpen(c.id)} style={{ borderWidth: 1, borderColor: t.c.line, borderRadius: 8, padding: 10 }}>
                <T role="mono" size={12}>{describe(c)}</T>
              </Pressable>
            ))}
          </View>
        );
      })}
      {streaming ? <T>{streaming}</T> : null}
      {status === "waiting" ? <Banner kind="warn">{`Waiting for editor: ${waitingCause ?? "not connected"}. The turn continues when it is back.`}</Banner> : null}
      {status === "error" && error ? <Banner kind="bad">{error}</Banner> : null}
      {follow.behind ? <Button title={"New messages ↓"} onPress={follow.jump} /> : null}
    </ScrollView>
  );
});

export function SubagentThread({ call, onBack }: { call: Call; transcript: TranscriptEntry[]; sessionWaiting: boolean; onBack: () => void; onStop: (id: string) => void }) {
  return (
    <View style={{ flex: 1, padding: 12, gap: 8 }}>
      <Button title="Back" variant="ghost" onPress={onBack} />
      <T weight={600}>{describe(call)}</T>
    </View>
  );
}
