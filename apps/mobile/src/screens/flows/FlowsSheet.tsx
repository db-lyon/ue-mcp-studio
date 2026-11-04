/**
 * The project's flows in a sheet, for a phone where typing /flow is slow:
 * each name opens the flow launcher on it, which asks for the flow's inputs
 * and runs it in the session.
 */
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { FlowListing, FlowRunRequest } from "@ue-mcp-studio/shared";
import { Sheet, T, font, useTheme } from "../../ui";
import { useProjectNav } from "../../nav";
import { FlowLauncher } from "../../chat/FlowCommand";

export function FlowsSheet({ open, sessionId, onClose, onRan }: { open: boolean; sessionId: string; onClose: () => void; onRan?: () => void }) {
  const t = useTheme();
  const { api } = useProjectNav();
  const [flows, setFlows] = useState<FlowListing[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return setPicked(null);
    let live = true;
    setFlows(null);
    api.flows().then(
      (r) => live && (setFlows(r.flows), setError(null)),
      (e: Error) => live && setError(e.message),
    );
    return () => void (live = false);
  }, [open, api]);

  const run = (request: FlowRunRequest) => api.flow(sessionId, request).then(() => onRan?.());

  return (
    <Sheet open={open} title="Flows" onClose={onClose}>
      {picked ? (
        <FlowLauncher key={picked} text={`/flow ${picked}`} run={run} onClose={onClose} />
      ) : (
        <View style={{ paddingHorizontal: 4, paddingBottom: 8 }}>
          {error ? <T tone="bad">{error}</T> : null}
          {!flows && !error ? <T tone="dim">Loading</T> : null}
          {flows?.length === 0 ? <T tone="muted">This project has no flows.</T> : null}
          {flows?.map((f) => (
            <Pressable key={f.name} accessibilityRole="button" accessibilityLabel={`Run flow ${f.name}`} onPress={() => setPicked(f.name)} style={[s.item, { borderBottomColor: t.c.line }]}>
              <Text style={[font(t, "mono", 500, t.base.size * 0.92), { color: t.c.text }]}>{f.name}</Text>
              {f.description ? <T size={12} lh={1.55} tone="dim">{f.description}</T> : null}
            </Pressable>
          ))}
        </View>
      )}
    </Sheet>
  );
}

const s = StyleSheet.create({
  item: { minHeight: 44, justifyContent: "center", paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
});
