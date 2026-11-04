/**
 * Playtests started outside Studio's sessions, shown in whichever session is
 * open and kept current from studio.qa.changed (web: chat/Qa.tsx OutsideRuns).
 */
import { useEffect, useState } from "react";
import { ScrollView } from "react-native";
import type { QaRun } from "@ue-mcp-studio/shared";
import { useProjectNav } from "../../nav";
import { QaCard } from "./QaCard";

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
