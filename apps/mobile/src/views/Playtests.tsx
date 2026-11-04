// STUB: owned by agent-a; replaced at merge.
import { View } from "react-native";
import type { PlaytestIndexAnswer } from "@ue-mcp-studio/shared";
import type { DaemonState } from "../state";

export function usePlaytestIndex(_daemon: Pick<DaemonState, "events" | "streaming">): { index: PlaytestIndexAnswer | null; error: string | null; reload: (fresh?: boolean) => void } {
  return { index: null, error: null, reload: () => undefined };
}

export function PlaytestsView(_props: { daemon: DaemonState; index: ReturnType<typeof usePlaytestIndex>; onOpenSession: (sessionId: string, runId: string) => void; onChat: () => void }) {
  return <View style={{ flex: 1 }} />;
}
