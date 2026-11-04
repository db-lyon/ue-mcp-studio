/**
 * Playtests the chat shows beside the session: runs started outside Studio's
 * sessions (kept current from studio.qa.changed), and a /playtest's progress
 * through its flow or why it made no playtest (web: chat/Qa.tsx OutsideRuns,
 * chat/Transcript.tsx PlaytestProgress and PlaytestFailed).
 */
import { createContext, useContext, useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import type { PlaytestRequest, PlaytestStage, QaRun, TranscriptEntry } from "@ue-mcp-studio/shared";
import { useProjectNav } from "../../nav";
import { Banner, T, bannerText, font, useStyles, useTheme, type Theme } from "../../ui";
import { QaCard } from "./QaCard";
import { SmallButton } from "./parts";

/** The runs started outside Studio's sessions, read again when one changes and when the stream is back. */
export function useOutsideRuns(events: Array<{ id: number; type: string; data: Record<string, unknown> }>, streaming: boolean): { runs: QaRun[]; dismiss: (runId: string) => void } {
  const { api } = useProjectNav();
  const [runs, setRuns] = useState<QaRun[]>([]);
  const last = [...events].reverse().find((e) => e.type === "studio.qa.changed" && !(e.data.run as QaRun | undefined)?.sessionId);
  useEffect(() => {
    if (!streaming) return;
    // An older Studio agent has no route; nothing shows then.
    api.qaRuns().then((r) => setRuns(Array.isArray(r?.runs) ? r.runs : []), () => setRuns([]));
  }, [api, streaming, last?.id]);
  const dismiss = (runId: string) => {
    setRuns((cur) => cur.filter((r) => r.runId !== runId));
    void api.qaDismiss(runId).catch(() => undefined);
  };
  return { runs, dismiss };
}

/** Runs another client started, shown in whichever session is open. */
export function OutsideRuns({ runs, onDismiss }: { runs: QaRun[]; onDismiss: (runId: string) => void }) {
  if (runs.length === 0) return null;
  return (
    <ScrollView style={{ maxHeight: "50%" }} contentContainerStyle={{ gap: 10, paddingTop: 10, paddingHorizontal: 16 }} accessibilityLabel="Playtests">
      {runs.map((r) => (
        <QaCard key={r.runId} run={r} onDismiss={() => onDismiss(r.runId)} />
      ))}
    </ScrollView>
  );
}

/** Runs a /playtest from a button: Retry on a failed one. `busy` while a turn runs. Null where nothing can be sent. */
export const PlaytestCommandContext = createContext<{ busy: boolean; run: (req: PlaytestRequest) => void } | null>(null);

const STAGES: Array<[PlaytestStage, string]> = [
  ["gathering", "Gathering"],
  ["drafting", "Drafting"],
  ["checking", "Checking"],
  ["created", "Created"],
];

/** A /playtest while its flow runs: the stages, the one in progress marked, and the draft's attempt after a retry. */
export function PlaytestProgress({ entry }: { entry: Extract<TranscriptEntry, { kind: "playtest" }> }) {
  const t = useTheme();
  const s = useStyles(styles);
  const at = STAGES.findIndex(([stage]) => stage === entry.state);
  return (
    <View style={s.progress} accessibilityLabel="Playtest progress">
      <View style={s.stages}>
        {STAGES.map(([stage, label], i) => {
          const done = i < at || entry.state === "created";
          const active = !done && i === at;
          return (
            <T key={stage} style={[s.small, { color: done ? t.c.ok : active ? t.c.text : t.c.dim }, active && { fontFamily: font(t, "sans", 600, 12).fontFamily }]} accessibilityState={{ selected: active }}>
              {done ? "✓  " : active ? "●  " : ""}
              {label}
              {stage === "drafting" && entry.attempt > 1 ? ` (attempt ${entry.attempt})` : ""}
            </T>
          );
        })}
      </View>
    </View>
  );
}

/** A /playtest that saved no script: that it failed, the flow's errors, and Retry. */
export function PlaytestFailed({ errors, request }: { errors: string[]; request: PlaytestRequest }) {
  const t = useTheme();
  const s = useStyles(styles);
  const playtest = useContext(PlaytestCommandContext);
  const color = bannerText(t, "bad");
  return (
    <Banner kind="bad" style={{ gap: 4 }}>
      <View style={s.row}>
        <T style={{ ...font(t, "sans", 700, t.base.size), lineHeight: t.base.lineHeight, color }}>No playtest was made.</T>
        <View style={{ flex: 1 }} />
        {playtest ? <SmallButton title="Retry" disabled={playtest.busy} onPress={() => playtest.run(request)} /> : null}
      </View>
      {errors.length === 1 ? (
        <T style={[s.small, { color }]}>{errors[0]}</T>
      ) : (
        errors.map((e, i) => (
          <T key={i} style={[s.small, { color, paddingLeft: 18 }]}>
            <Text>{"• "}</Text>
            {e}
          </T>
        ))
      )}
    </Banner>
  );
}

const styles = (t: Theme) => ({
  progress: { paddingVertical: 9, paddingHorizontal: 12, borderRadius: 8, marginBottom: 10, borderWidth: 1, borderColor: t.c.line, backgroundColor: t.c.panel2 },
  stages: { flexDirection: "row" as const, flexWrap: "wrap" as const, alignItems: "center" as const, gap: 14, marginVertical: 6 },
  small: font(t, "sans", 400, 12, 1.55),
  row: { flexDirection: "row" as const, alignItems: "center" as const, flexWrap: "wrap" as const, gap: 10, marginVertical: 6 },
});
