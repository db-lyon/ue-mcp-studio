/**
 * The Playtest Hub's lease bar: while the hub holds the editor, every tab
 * says so and offers Release the editor.
 */
import { useEffect, useState } from "react";
import type { EditorLease } from "ue-mcp/daemon";
import { LEASE_COPY, leaseOfEvent } from "@ue-mcp-studio/client-core";
import { api } from "./api";
import type { DaemonState } from "./state";

/** The hub's lease: read when the stream comes up, then replaced by each hub.lease. */
export function useLease(daemon: Pick<DaemonState, "events" | "streaming">): EditorLease | null {
  const [lease, setLease] = useState<EditorLease | null>(null);
  useEffect(() => {
    if (!daemon.streaming) return;
    // A daemon without the hub has no route: nothing is leased then.
    api.hubLease().then((r) => setLease(r?.lease ?? null), () => setLease(null));
  }, [daemon.streaming]);
  const last = [...daemon.events].reverse().find((e) => leaseOfEvent(e) !== null);
  useEffect(() => {
    const next = last ? leaseOfEvent(last) : null;
    if (next) setLease(next.lease);
  }, [last?.id]);
  return lease;
}

/** The bar while the Playtest Hub holds the editor: what it runs, and Release the editor. */
export function LeaseBar({ lease }: { lease: EditorLease | null }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!lease) return null;
  const release = () => {
    setBusy(true);
    setError(null);
    api.hubRelease().catch((e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
  return (
    <div className="banner lease-bar" role="region" aria-label={LEASE_COPY.holding}>
      <span className="held-text">
        <strong>{LEASE_COPY.holding}</strong>
        <span className="held-instruction">{lease.purpose}</span>
      </span>
      <span className="spacer" />
      <button className="small-button danger-button" disabled={busy} title={LEASE_COPY.releaseHelp} onClick={release}>{LEASE_COPY.release}</button>
      {error && <span className="held-error small" role="alert">{error}</span>}
    </div>
  );
}
