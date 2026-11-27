/**
 * The Playtest Hub's lease bar on the phone (client-web held.tsx): while the
 * hub holds the editor, every tab says so and offers Release the editor.
 */
import { useEffect, useState } from "react";
import { View } from "react-native";
import { LEASE_COPY, leaseOfEvent } from "@ue-mcp-studio/client-core";
import type { EditorLease } from "ue-mcp/daemon";
import { useProjectNav } from "./nav";
import type { DaemonState } from "./state";
import { Banner, Button, T, font, useTheme } from "./ui";
import { SHELL_BANNER } from "./views/VersionNotice";

/** The hub's lease: read when the stream comes up, then replaced by each hub.lease. */
export function useLease(daemon: Pick<DaemonState, "events" | "streaming">): EditorLease | null {
  const { api } = useProjectNav();
  const [lease, setLease] = useState<EditorLease | null>(null);
  useEffect(() => {
    if (!daemon.streaming) return;
    // A daemon without the hub has no route: nothing is leased then.
    api.hubLease().then((r) => setLease(r?.lease ?? null), () => setLease(null));
  }, [daemon.streaming, api]);
  const last = [...daemon.events].reverse().find((e) => leaseOfEvent(e) !== null);
  useEffect(() => {
    const next = last ? leaseOfEvent(last) : null;
    if (next) setLease(next.lease);
  }, [last?.id]);
  return lease;
}

/** The bar while the Playtest Hub holds the editor: what it runs, and Release the editor. */
export function LeaseBar({ lease }: { lease: EditorLease | null }) {
  const t = useTheme();
  const { api } = useProjectNav();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!lease) return null;
  const release = () => {
    setBusy(true);
    setError(null);
    api.hubRelease().catch((e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
  return (
    <Banner role="status" style={[SHELL_BANNER, { flexDirection: "column", alignItems: "stretch", gap: 8 }]}>
      <T style={{ color: t.c.text }}>
        <T weight={700} style={{ color: t.c.text }}>{LEASE_COPY.holding}</T> {lease.purpose}
      </T>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        <Button size="small" label={LEASE_COPY.releaseHelp} disabled={busy} onPress={release} style={{ minWidth: 44, borderColor: t.c.bad }}>
          <T style={[font(t, t.editor ? "sans" : "mono", t.editor ? 400 : 500, 11, 1.2), { color: busy ? t.c.dim : t.c.bad, letterSpacing: 0 }]}>{LEASE_COPY.release}</T>
        </Button>
      </View>
      {error ? <T accessibilityRole="alert" style={{ color: t.c.badText }}>{error}</T> : null}
    </Banner>
  );
}
