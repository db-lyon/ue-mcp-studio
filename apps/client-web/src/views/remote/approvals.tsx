import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { REMOTE_PIN_ATTEMPTS, formatPairingCode, type RemoteApproval, type RemoteBrowser } from "@ue-mcp-studio/shared";
import { api } from "../../api";
import { onRemotePage } from "../../connection";
import { subscribeEvent } from "../../extensions/events";

/** How often the open approvals are read again besides the events that announce them. */
export const APPROVAL_POLL_MS = 10_000;

const APPROVAL_EVENTS = new Set(["studio.remote.approval", "studio.remote.paired"]);

/**
 * Browsers waiting for the owner to allow them, read from the agent and kept
 * current by its events. A route that is not there (no plan, remote control
 * not offered) reads as none.
 */
export function useRemoteApprovals(): { approvals: RemoteApproval[]; decide: (id: string, allow: boolean) => Promise<string | null> } {
  const [approvals, setApprovals] = useState<RemoteApproval[]>([]);
  const load = useCallback(() => {
    api.remoteApprovals().then((r) => setApprovals(r.approvals), () => setApprovals([]));
  }, []);
  useEffect(() => {
    // A paired browser can never read or decide approvals (remote control's own routes are refused to it): nothing to ask.
    if (onRemotePage()) return;
    load();
    const t = setInterval(load, APPROVAL_POLL_MS);
    const off = subscribeEvent((e) => {
      if (APPROVAL_EVENTS.has(e.type)) load();
    });
    return () => {
      clearInterval(t);
      off();
    };
  }, [load]);
  // Drop one at its expiry without waiting for the next read.
  useEffect(() => {
    if (approvals.length === 0) return;
    const next = Math.min(...approvals.map((a) => Date.parse(a.expiresAt))) - Date.now();
    const t = setTimeout(load, Math.max(0, next) + 50);
    return () => clearTimeout(t);
  }, [approvals, load]);
  const decide = useCallback(
    async (id: string, allow: boolean): Promise<string | null> => {
      try {
        await api.decideRemoteApproval(id, allow);
        setApprovals((list) => list.filter((a) => a.id !== id));
        return null;
      } catch (e) {
        load();
        return e instanceof Error ? e.message : String(e);
      }
    },
    [load],
  );
  return { approvals, decide };
}

/** The last browser allowed while this Studio was open, for the notice that says so. */
export function usePairedNotice(): { paired: { label: string } | null; dismiss: () => void } {
  const [paired, setPaired] = useState<{ label: string } | null>(null);
  useEffect(
    () =>
      subscribeEvent((e) => {
        if (e.type === "studio.remote.paired") setPaired({ label: String((e.data as { label?: unknown } | undefined)?.label ?? "A browser") });
      }),
    [],
  );
  return { paired, dismiss: () => setPaired(null) };
}

/** The last browser removed for too many wrong PINs while this Studio was open. */
export function useLockoutNotice(): { removed: { label: string } | null; dismiss: () => void } {
  const [removed, setRemoved] = useState<{ label: string } | null>(null);
  useEffect(
    () =>
      subscribeEvent((e) => {
        if (e.type === "studio.remote.lockout") setRemoved({ label: String((e.data as { label?: unknown } | undefined)?.label ?? "A browser") });
      }),
    [],
  );
  return { removed, dismiss: () => setRemoved(null) };
}

/** "<label> entered a wrong PIN 10 times and was removed." */
export function LockoutNotice({ label, onDismiss }: { label: string; onDismiss: () => void }) {
  return (
    <div className="banner bad remote-lockout" role="alert">
      <span className="grow">{label} entered a wrong PIN {REMOTE_PIN_ATTEMPTS} times in a row and was removed. Pair it again if that was you.</span>
      <button className="ghost" aria-label="Dismiss" onClick={onDismiss}>×</button>
    </div>
  );
}

/**
 * One browser asking to be allowed: its name, the six digits it shows, and
 * Allow or Deny. The digits are what tells the owner's own phone from anyone
 * else's who got hold of the code.
 */
export function ApprovalPrompt({ approval, onDecide }: { approval: RemoteApproval; onDecide: (id: string, allow: boolean) => Promise<string | null> }) {
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const answer = (allow: boolean) => {
    setBusy(allow ? "allow" : "deny");
    setError(null);
    void onDecide(approval.id, allow).then((e) => {
      setBusy(null);
      setError(e);
    });
  };
  return (
    <div className="banner warn remote-approval" role="alertdialog" aria-label={`${approval.label} wants to control ${approval.project}`}>
      <div className="remote-approval-text">
        <div><strong>{approval.label}</strong> wants to control {approval.project}.</div>
        <div className="remote-approval-code-line">
          Code <span className="remote-approval-code">{formatPairingCode(approval.code)}</span>
        </div>
        <div className="dim small">Allow it only if your device shows the same code. An allowed device can use Studio in every project on this computer.</div>
        {error && <div className="small remote-err" role="alert">{error}</div>}
      </div>
      <div className="remote-approval-actions">
        <button className="primary" disabled={busy !== null} onClick={() => answer(true)}>{busy === "allow" ? "Allowing" : "Allow"}</button>
        <button disabled={busy !== null} onClick={() => answer(false)}>{busy === "deny" ? "Denying" : "Deny"}</button>
      </div>
    </div>
  );
}

/** "Android (Chrome) can now control ..." after an Allow, with the way back if it was a mistake. */
export function PairedNotice({ label, onDismiss }: { label: string; onDismiss: () => void }) {
  return (
    <div className="banner ok remote-paired" role="status">
      <span className="grow">{label} is paired and can use Studio in every project on this computer. Remove it under Paired devices if that was not you.</span>
      <button className="ghost" aria-label="Dismiss" onClick={onDismiss}>×</button>
    </div>
  );
}

// While a /remote reply is on screen it shows the requests itself, so the Studio-wide banner leaves them to it.
let cardsShown = 0;
const cardListeners = new Set<() => void>();
const cardsChanged = () => cardListeners.forEach((l) => l());

/** Call from the /remote reply while it is mounted. */
export function useApprovalsInCard(): void {
  useEffect(() => {
    cardsShown++;
    cardsChanged();
    return () => {
      cardsShown--;
      cardsChanged();
    };
  }, []);
}

function useCardShown(): boolean {
  return useSyncExternalStore(
    (l) => {
      cardListeners.add(l);
      return () => void cardListeners.delete(l);
    },
    () => cardsShown > 0,
  );
}

/** Studio-wide: every waiting browser and the notice after one is allowed, wherever the owner is in Studio. */
export function RemoteApprovalBanner() {
  const { approvals, decide } = useRemoteApprovals();
  const { paired, dismiss } = usePairedNotice();
  const lockout = useLockoutNotice();
  const inCard = useCardShown();
  const shown = inCard ? [] : approvals;
  if (shown.length === 0 && !paired && !lockout.removed) return null;
  return (
    <div className="remote-approvals">
      {shown.map((a) => <ApprovalPrompt key={a.id} approval={a} onDecide={decide} />)}
      {paired && <PairedNotice label={paired.label} onDismiss={dismiss} />}
      {lockout.removed && <LockoutNotice label={lockout.removed.label} onDismiss={lockout.dismiss} />}
    </div>
  );
}

/** The browsers paired with this computer, each with Remove: in the /remote reply, where the owner looks. */
export function PairedBrowsers() {
  const [browsers, setBrowsers] = useState<RemoteBrowser[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.remoteBrowsers().then((b) => setBrowsers(b.browsers), (e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    load();
    return subscribeEvent((e) => {
      if (e.type === "studio.remote.paired" || e.type === "studio.remote.unpaired") load();
    });
  }, [load]);
  const remove = (b: RemoteBrowser) => {
    setBusy(b.id);
    setError(null);
    api.revokeRemoteBrowser(b.id).then(
      () => setBrowsers((list) => list?.filter((x) => x.id !== b.id) ?? null),
      (e: Error) => setError(e.message),
    ).finally(() => setBusy(null));
  };
  if (!browsers) return error ? <p className="small remote-err">{error}</p> : null;
  return (
    <div className="remote-browsers">
      <div className="remote-browsers-title small">Paired devices</div>
      {browsers.length === 0 && <p className="muted small">No devices paired yet.</p>}
      {browsers.map((b) => (
        <div key={b.id} className="remote-browser-row">
          <div className="grow">
            <div>{b.label}</div>
            <div className="dim small">Paired {new Date(b.addedAt).toLocaleDateString()}</div>
          </div>
          <button disabled={busy === b.id} onClick={() => remove(b)}>{busy === b.id ? "Removing" : "Remove"}</button>
        </div>
      ))}
      {error && <p className="small remote-err" role="alert">{error}</p>}
    </div>
  );
}
