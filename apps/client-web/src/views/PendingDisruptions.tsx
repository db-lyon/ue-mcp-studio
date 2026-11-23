/**
 * Requests from other sessions to stop, restart, rebuild or patch the editor
 * that ue-mcp's consent gate is holding (feature "editor.consent"), above
 * every view like a dialog in the editor, so a person sees one whatever they
 * are looking at. It takes no focus. Each shows who asks, what for, and every
 * session's answer, with Approve and Deny, which are a person's override
 * (POST /v1/disruptions/<id>/approve and /deny); on a paired browser approving
 * asks for the PIN. The list follows the daemon's disruption events. The
 * mobile app draws the same in views/PendingDisruptions.tsx.
 */
import { useEffect, useRef, useState } from "react";
import type { DaemonEvent } from "ue-mcp/daemon";
import { CONSENT_FEATURE, PENDING_COPY, STUDIO_REQUESTER, answerLines, applyDisruptionEvent, isPendingForPerson, requestTitle, requestsOf, type EditorDisruptionRequest } from "@ue-mcp-studio/client-core";
import { api } from "../api";
import type { DaemonState } from "../state";

export interface PendingApi {
  disruptions(): Promise<unknown>;
  approveDisruption(id: string, by: string): Promise<unknown>;
  denyDisruption(id: string, by: string): Promise<unknown>;
}

/** The open requests a person can answer: read once the stream is up, then kept from its events. */
export function usePendingDisruptions(daemon: Pick<DaemonState, "health" | "streaming" | "events">, source: Pick<PendingApi, "disruptions"> = api): EditorDisruptionRequest[] {
  const on = ((daemon.health as { features?: string[] } | null)?.features ?? []).includes(CONSENT_FEATURE);
  const [pending, setPending] = useState<EditorDisruptionRequest[]>([]);
  const seen = useRef(0);
  useEffect(() => {
    if (!on || !daemon.streaming) return;
    void source.disruptions().then((b) => setPending(requestsOf(b).filter(isPendingForPerson)), () => undefined);
  }, [on, daemon.streaming]);
  useEffect(() => {
    const fresh = daemon.events.filter((e: DaemonEvent) => typeof e.id === "number" && e.id > seen.current);
    if (fresh.length === 0) return;
    seen.current = Math.max(...fresh.map((e) => e.id as number));
    setPending((list) => fresh.reduce((l, e) => applyDisruptionEvent(l, e), list));
  }, [daemon.events]);
  // A request that ran out of time is gone, whether or not its expiry was announced.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (pending.length === 0) return;
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [pending.length]);
  return on ? pending.filter((r) => !(Date.parse(r.expiresAt) <= now)) : [];
}

export function PendingDisruptions({ daemon, client = api }: { daemon: Pick<DaemonState, "health" | "streaming" | "events">; client?: PendingApi }) {
  const pending = usePendingDisruptions(daemon, client);
  if (pending.length === 0) return null;
  return (
    <div className="pending-disruptions" role="region" aria-label={PENDING_COPY.region} data-testid="pending-disruptions">
      {pending.map((r) => <DisruptionCard key={r.id} request={r} client={client} />)}
    </div>
  );
}

export function DisruptionCard({ request: r, client }: { request: EditorDisruptionRequest; client: Pick<PendingApi, "approveDisruption" | "denyDisruption"> }) {
  const [sending, setSending] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const answer = (decision: "approve" | "deny") => {
    setSending(decision);
    setError(null);
    const send = decision === "approve" ? client.approveDisruption(r.id, STUDIO_REQUESTER) : client.denyDisruption(r.id, STUDIO_REQUESTER);
    // The card goes when the daemon says the request is decided; until then it stays, so a failure can be read.
    void send.catch((e: Error) => setError(e.message || PENDING_COPY.notSent)).finally(() => setSending(null));
  };
  const answers = answerLines(r);
  return (
    <div className="card disruption-card" data-testid="disruption-card">
      <p className="disruption-title">{requestTitle(r)}</p>
      {r.reason ? <p className="disruption-meta small">{r.reason}</p> : null}
      {answers.length > 0 && (
        <ul className="disruption-answers small">
          {answers.map((a) => (
            <li key={a.session}>
              <strong>{a.label}</strong>: <span className={a.tone}>{a.state}</span>{a.reason ? <span className="muted">, {a.reason}</span> : null}
            </li>
          ))}
        </ul>
      )}
      {error && <div className="banner bad small" role="alert">{error}</div>}
      <div className="actions">
        <button className="primary" disabled={sending !== null} onClick={() => answer("approve")}>{PENDING_COPY.approve}</button>
        <button className="ghost" disabled={sending !== null} onClick={() => answer("deny")}>{PENDING_COPY.deny}</button>
      </div>
    </div>
  );
}
