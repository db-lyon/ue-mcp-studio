/**
 * Requests from other sessions to stop, restart, rebuild or patch the editor
 * that ue-mcp's consent gate is holding, above every view, drawn natively
 * (apps/client-web views/PendingDisruptions.tsx). It takes no focus. Each
 * shows who asks, what for, and every session's answer, with Approve and
 * Deny; approving goes through the PIN, as the editor routes do.
 */
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { CONSENT_FEATURE, PENDING_COPY, STUDIO_REQUESTER, answerLines, applyDisruptionEvent, isPendingForPerson, requestTitle, requestsOf, type EditorDisruptionRequest } from "@ue-mcp-studio/client-core";
import { Banner, Button, Card, T, useTheme } from "../ui";
import { useProjectNav } from "../nav";
import type { DaemonState } from "../state";

export interface PendingApi {
  disruptions(): Promise<unknown>;
  approveDisruption(id: string, by: string): Promise<unknown>;
  denyDisruption(id: string, by: string): Promise<unknown>;
}

/** The open requests a person can answer: read once the stream is up, then kept from its events. */
export function usePendingDisruptions(daemon: Pick<DaemonState, "health" | "streaming" | "events">, source: Pick<PendingApi, "disruptions">): EditorDisruptionRequest[] {
  const on = (daemon.health?.features ?? []).includes(CONSENT_FEATURE);
  const [pending, setPending] = useState<EditorDisruptionRequest[]>([]);
  const seen = useRef(0);
  useEffect(() => {
    if (!on || !daemon.streaming) return;
    void source.disruptions().then((b) => setPending(requestsOf(b).filter(isPendingForPerson)), () => undefined);
  }, [on, daemon.streaming, source]);
  useEffect(() => {
    const fresh = daemon.events.filter((e) => typeof e.id === "number" && e.id > seen.current);
    if (fresh.length === 0) return;
    seen.current = Math.max(...fresh.map((e) => e.id as number));
    setPending((list) => fresh.reduce((l, e) => applyDisruptionEvent(l, e), list));
  }, [daemon.events]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (pending.length === 0) return;
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [pending.length]);
  return on ? pending.filter((r) => !(Date.parse(r.expiresAt) <= now)) : [];
}

export function PendingDisruptions({ daemon, client }: { daemon: Pick<DaemonState, "health" | "streaming" | "events">; client?: PendingApi }) {
  const { api } = useProjectNav();
  const c = client ?? api;
  const pending = usePendingDisruptions(daemon, c);
  if (pending.length === 0) return null;
  return (
    <View accessibilityLabel={PENDING_COPY.region} testID="pending-disruptions" style={{ gap: 8, paddingHorizontal: 6, paddingTop: 6 }}>
      {pending.map((r) => <DisruptionCard key={r.id} request={r} client={c} />)}
    </View>
  );
}

export function DisruptionCard({ request: r, client }: { request: EditorDisruptionRequest; client: Pick<PendingApi, "approveDisruption" | "denyDisruption"> }) {
  const t = useTheme();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answer = (decision: "approve" | "deny") => {
    setSending(true);
    setError(null);
    const send = decision === "approve" ? client.approveDisruption(r.id, STUDIO_REQUESTER) : client.denyDisruption(r.id, STUDIO_REQUESTER);
    // The card goes when the daemon says the request is decided; until then it stays, so a failure can be read.
    void send.catch((e: Error) => setError(e.message || PENDING_COPY.notSent)).finally(() => setSending(false));
  };
  const tone = { ok: t.c.ok, warn: t.c.warn, bad: t.c.bad };
  return (
    <Card testID="disruption-card" style={{ borderLeftWidth: 2, borderLeftColor: t.c.warn }}>
      <T weight={600}>{requestTitle(r)}</T>
      {r.reason ? <T size={12} style={{ color: t.c.muted, marginTop: 2 }}>{r.reason}</T> : null}
      {answerLines(r).map((a) => (
        <T key={a.session} size={12} style={{ marginTop: 4 }}>
          <T weight={700} size={12}>{a.label}</T>: <T size={12} style={{ color: tone[a.tone] }}>{a.state}</T>
          {a.reason ? <T size={12} style={{ color: t.c.muted }}>, {a.reason}</T> : null}
        </T>
      ))}
      {error ? (
        <Banner kind="bad" role="alert" style={{ marginTop: 8 }}>
          <T size={12} style={{ color: t.c.badText }}>{error}</T>
        </Banner>
      ) : null}
      <View style={{ flexDirection: "row", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
        <Button variant="primary" title={PENDING_COPY.approve} disabled={sending} onPress={() => answer("approve")} />
        <Button variant="ghost" title={PENDING_COPY.deny} disabled={sending} onPress={() => answer("deny")} />
      </View>
    </Card>
  );
}
