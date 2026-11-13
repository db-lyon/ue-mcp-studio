/**
 * The working line above the composer while a turn runs: a spinner, what the
 * agent is doing right now, and how long the turn has run, ticking each second.
 * The web client's .working-line.
 */
import { useEffect, useState } from "react";
import { View } from "react-native";
import type { SessionDetail } from "@ue-mcp-studio/shared";
import { turnElapsed as formatElapsed, workingStatus } from "@ue-mcp-studio/client-core";
import { font, Spinner, T, useTheme } from "../ui";

export function WorkingLine({ detail }: { detail: (Pick<SessionDetail, "status" | "waitingCause" | "transcript"> & Partial<Pick<SessionDetail, "working" | "mainFree">>) | null | undefined }) {
  const t = useTheme();
  const status = workingStatus(detail);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!status) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [!!status]);
  if (!status) return null;
  return (
    <View accessibilityRole="text" accessibilityLiveRegion="polite" style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8, paddingHorizontal: 16, borderTopWidth: 1, borderTopColor: t.c.line }}>
      <Spinner />
      <T numberOfLines={1} style={[font(t, "sans", 500, 13), { flexShrink: 1, color: t.c.text }]}>{status.label}</T>
      {status.since !== null ? <T style={[font(t, "sans", 400, 13), { color: t.c.muted, fontVariant: ["tabular-nums"] }]}>{formatElapsed(now - status.since)}</T> : null}
    </View>
  );
}
