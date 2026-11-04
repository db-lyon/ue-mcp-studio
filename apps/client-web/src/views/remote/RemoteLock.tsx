import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { onRemotePage } from "../../connection";
import { cancelPrompt, installLockGuard, lockView, refreshLock, subscribeLock, unlockWith, type LockView } from "../../remote-lock";

function useLock(): LockView {
  return useSyncExternalStore(subscribeLock, lockView, lockView);
}

/** Seconds left of a wait the computer set, counting down. */
function useCountdown(ms: number | undefined): number {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (!ms || ms <= 0) return setLeft(0);
    const end = Date.now() + ms;
    const tick = () => setLeft(Math.max(0, Math.ceil((end - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 250);
    return () => clearInterval(t);
  }, [ms]);
  return left;
}

/** The digits field and the button: shared by the lock screen and the sheet. */
function PinForm({ submitLabel, onCancel, autoFocus = true }: { submitLabel: string; onCancel?: () => void; autoFocus?: boolean }) {
  const lock = useLock();
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [waitMs, setWaitMs] = useState<number | undefined>(lock.state?.retryAfterMs);
  const left = useCountdown(waitMs);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus]);
  const remaining = lock.state?.remaining;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy || left > 0 || pin.length < 4) return;
    setBusy(true);
    setError(null);
    void unlockWith(pin).then((r) => {
      setBusy(false);
      if (r.ok) return;
      setPin("");
      setError(r.error);
      setWaitMs(r.retryAfterMs);
      input.current?.focus();
    });
  };
  return (
    <form className="pin-form" onSubmit={submit}>
      <label className="pin-label" htmlFor="remote-pin">PIN</label>
      <input
        id="remote-pin"
        ref={input}
        className="pin-input"
        type="password"
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete="off"
        maxLength={8}
        value={pin}
        disabled={busy || lock.removed}
        aria-describedby="remote-pin-note"
        onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))}
      />
      <div id="remote-pin-note" className="pin-note" role={error ? "alert" : undefined}>
        {error && <div className="pin-error">{error}</div>}
        {left > 0 && <div>Try again in {left} s.</div>}
        {remaining !== undefined && remaining <= 5 && !lock.removed && <div>{remaining} {remaining === 1 ? "try" : "tries"} left before this browser is removed.</div>}
      </div>
      <div className="pin-actions">
        {onCancel && <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>}
        <button type="submit" className="primary" disabled={busy || left > 0 || pin.length < 4 || lock.removed}>{busy ? "Checking" : submitLabel}</button>
      </div>
    </form>
  );
}

/** The whole client is locked: everything but this waits for the PIN. */
export function LockScreen() {
  const lock = useLock();
  return (
    <div className="lock-screen" role="dialog" aria-modal="true" aria-labelledby="lock-title">
      <div className="lock-card">
        <LockGlyph />
        <h1 id="lock-title" className="lock-title">{lock.removed ? "This browser was removed" : "Studio is locked"}</h1>
        {lock.removed ? (
          <p className="lock-lead">Too many wrong PINs. Pair this browser again from Studio on the computer.</p>
        ) : (
          <>
            <p className="lock-lead">Enter the PIN set in Studio on your computer.</p>
            <PinForm submitLabel="Unlock" />
          </>
        )}
      </div>
    </div>
  );
}

/** A sensitive action asked for the PIN: it goes ahead once the PIN is in. */
export function PinSheet() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancelPrompt();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="pin-sheet-backdrop" onClick={(e) => e.target === e.currentTarget && cancelPrompt()}>
      <div className="pin-sheet" role="dialog" aria-modal="true" aria-labelledby="pin-sheet-title">
        <h2 id="pin-sheet-title" className="pin-sheet-title">Enter your PIN</h2>
        <p className="pin-sheet-lead">This action needs the PIN set in Studio on your computer.</p>
        <PinForm submitLabel="Continue" onCancel={cancelPrompt} />
      </div>
    </div>
  );
}

function LockGlyph() {
  return (
    <svg className="lock-glyph" width="40" height="40" viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="9" y="18" width="22" height="16" rx="3" />
      <path d="M14 18v-5a6 6 0 0 1 12 0v5" />
    </svg>
  );
}

/**
 * The PIN lock in a paired browser's page: installs the fetch guard, asks the
 * computer how the lock stands, and shows the lock screen or the PIN sheet
 * when a request needs the PIN. Nothing on the computer's own Studio.
 */
export function RemoteLock({ remote = onRemotePage() }: { remote?: boolean }) {
  const lock = useLock();
  useEffect(() => {
    if (!remote) return;
    installLockGuard();
    void refreshLock();
  }, [remote]);
  if (!remote) return null;
  if (lock.screen) return <LockScreen />;
  if (lock.prompt) return <PinSheet />;
  return null;
}
