import { createContext, useContext, useState } from "react";
import { Pressable, ScrollView, Text, View, useWindowDimensions, type TextStyle } from "react-native";
import type { TranscriptEntry } from "@ue-mcp-studio/shared";
import { formatDuration, tokenCount } from "@ue-mcp-studio/client-core";
import { baseFont, ContentButton, font, Markdown, Pulse, useTheme, type Theme } from "../../../ui";

type CompactionEntry = Extract<TranscriptEntry, { kind: "compaction" }>;

const TRIGGER: Record<CompactionEntry["trigger"], string> = {
  auto: "automatic",
  manual: "by you",
  overflow: "the request was too long",
};

/** Compact now, for Try again on a failed compaction; null where nothing can be sent. */
export const CompactContext = createContext<(() => void) | null>(null);

const time = (at: string): string => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** button.compaction-line's type: 500 12px/1.4 sans, or the editor themes' 400 12px/1.2. */
const lineFont = (t: Theme): TextStyle => (t.editor ? font(t, "sans", 400, 12, 1.2) : font(t, "sans", 500, 12, 1.4));

/** A 1px dashed rule, drawn the same on every platform: the top edge of a dashed box. */
function DashedRule({ color, opacity = 1 }: { color: string; opacity?: number }) {
  return (
    <View style={{ height: 1, overflow: "hidden", opacity, alignSelf: "stretch" }}>
      <View style={{ height: 3, borderWidth: 1, borderColor: color, borderStyle: "dashed" }} />
    </View>
  );
}

/**
 * Where a conversation was compacted: a rule across the transcript above a row
 * with the tokens before and after and when, opened to show the summary the
 * agent works from since. Everything above it stays on screen; only the
 * model's view was replaced. While it runs it says so; a failure says why,
 * with Try again.
 */
export function CompactionMarker({ entry }: { entry: CompactionEntry }) {
  const t = useTheme();
  const vh = useWindowDimensions().height;
  const [open, setOpen] = useState(false);
  const retry = useContext(CompactContext);
  const running = entry.state === "running";
  const failed = entry.state === "failed";
  const title = running ? "Compacting context" : failed ? "Compaction failed" : entry.method === "truncated" ? "Context trimmed" : "Context compacted";
  const numbers = running
    ? `${tokenCount(entry.before)} tokens, summarising`
    : entry.after !== undefined ? `${tokenCount(entry.before)} → ${tokenCount(entry.after)} tokens` : `${tokenCount(entry.before)} tokens before`;
  const expandable = !running && (!!entry.summary || failed || entry.method === "runtime");
  const lf = lineFont(t);
  const lh = (lf.lineHeight as number) / 12;
  const meta: TextStyle = { ...font(t, "mono", t.editor ? 400 : 500, 11.5, lh), color: t.c.muted };
  const small: TextStyle = { ...baseFont(t), fontSize: 12, lineHeight: 12 * (t.base.lineHeight / t.base.size), color: t.c.dim };
  return (
    <View accessibilityRole="none" accessibilityLabel={`${title}, ${numbers}, ${time(entry.at)}`} style={{ marginVertical: 14 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={expandable ? { expanded: open } : { disabled: true }}
        disabled={!expandable}
        onPress={() => setOpen(!open)}
        style={{ flexDirection: "column", alignItems: "stretch", gap: 6, paddingVertical: 4, minHeight: 44 }}
      >
        <DashedRule color={failed ? t.c.bad : t.c.accentLine} opacity={failed ? 0.5 : 1} />
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", justifyContent: "flex-start", rowGap: 4, columnGap: 8, paddingVertical: 3, paddingHorizontal: 12, borderWidth: 1, borderColor: failed ? t.c.bad : t.c.lineStrong, borderRadius: t.radius, backgroundColor: failed ? "transparent" : t.c.panel2 }}>
          {expandable ? <Text style={{ fontSize: 13, lineHeight: 13, color: t.c.accent, alignSelf: "center" }} importantForAccessibility="no">{open ? "▾" : "▸"}</Text> : null}
          {running ? (
            <Pulse style={{ alignSelf: "center" }}>
              <View style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: t.c.accent }} />
            </Pulse>
          ) : null}
          <Text style={[lf, font(t, "sans", 600, 12, lh), { color: failed ? t.c.badText : t.c.text }]}>{title}</Text>
          <Text style={meta}>{numbers}</Text>
          <Text style={[meta, { color: t.c.dim }]}>{`${TRIGGER[entry.trigger]}, ${time(entry.at)}`}</Text>
          {expandable ? <Text style={{ ...font(t, "mono", 600, 10.5, 1.4), textTransform: "uppercase", letterSpacing: 0.84, color: t.c.accent }}>{open ? "Hide" : failed ? "Why" : "Summary"}</Text> : null}
        </View>
      </Pressable>
      {open ? (
        <View style={{ marginTop: -1, paddingVertical: 10, paddingHorizontal: 14, borderWidth: 1, borderColor: t.c.lineStrong, borderTopWidth: 2, borderTopColor: t.c.accentLine, borderBottomLeftRadius: t.radiusLg, borderBottomRightRadius: t.radiusLg, backgroundColor: t.c.panel2 }}>
          {failed ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
              <Text style={{ ...baseFont(t), fontSize: 12.5, lineHeight: 12.5 * (t.base.lineHeight / t.base.size), color: t.c.badText, flexGrow: 1, flexShrink: 1, flexBasis: 220 }}>
                {`${entry.error ?? "The conversation could not be compacted."} Nothing was cut; the agent still has the whole conversation.`}
              </Text>
              {retry && !entry.parent ? <ContentButton title="Try again" onPress={() => retry()} /> : null}
            </View>
          ) : (
            <Text style={[small, { marginBottom: 8 }]}>
              {entry.method === "runtime" ? "Claude's runtime summarised the conversation" : entry.method === "truncated" ? "The summary could not be written, so the oldest part was cut" : `${entry.model ?? "The model"} summarised the conversation`}
              {entry.ms ? ` in ${formatDuration(Math.max(1, Math.round(entry.ms / 1000)))}` : ""}. The agent works from {entry.method === "truncated" ? "what is below" : "this summary"} and what follows; the transcript above is kept for you.
              {entry.instructions ? ` You asked it to keep: ${entry.instructions}` : ""}
              {entry.method === "truncated" && entry.error ? ` (${entry.error})` : ""}
            </Text>
          )}
          {entry.summary ? (
            <ScrollView nestedScrollEnabled style={{ maxHeight: vh * 0.46 }} contentContainerStyle={{ paddingRight: 4 }}>
              <Markdown text={entry.summary} breaks={false} tone={{ fontSize: 13, lineHeight: 13 * (t.base.lineHeight / t.base.size) }} />
            </ScrollView>
          ) : !failed ? (
            <Text style={[small, { marginBottom: 8 }]}>The runtime did not hand over its summary.</Text>
          ) : null}
          {!failed && entry.summary ? (
            <View style={{ alignItems: "flex-start", marginTop: 8 }}>
              <ContentButton title="Hide summary" small fontSize={t.base.size} onPress={() => setOpen(false)} />
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
