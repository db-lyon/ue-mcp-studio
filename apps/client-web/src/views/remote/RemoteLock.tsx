import { useEffect, useRef, useState, useSyncExternalStore } from "react";
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

const MAX_PIN = 8;
const MIN_PIN = 4;
const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

/**
 * A phone-style number pad: a dot per digit of the PIN, 1 to 9, then delete
 * and 0. It submits on the last digit. No text field, so the device keyboard
 * never opens; a hardware keyboard still types digits and Backspace. An enter
 * key shows only while the computer does not know the PIN's length yet.
 */
function PinForm({ submitLabel, onCancel }: { submitLabel: string; onCancel?: () => void }) {
  const lock = useLock();
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shake, setShake] = useState(0);
  const [waitMs, setWaitMs] = useState<number | undefined>(lock.state?.retryAfterMs);
  const left = useCountdown(waitMs);
  const remaining = lock.state?.remaining;
  const blocked = busy || left > 0 || lock.removed;
  const length = lock.state?.pinLength;
  const max = length ?? MAX_PIN;

  const state = useRef({ pin, blocked, max });
  state.current = { pin, blocked, max };

  const submit = (p = state.current.pin) => {
    if (state.current.blocked || p.length < MIN_PIN) return;
    setBusy(true);
    setError(null);
    void unlockWith(p).then((r) => {
      setBusy(false);
      if (r.ok) return;
      setPin("");
      setError(r.error);
      setWaitMs(r.retryAfterMs);
      setShake((n) => n + 1);
    });
  };
  const press = (d: string) => {
    const { pin: p, blocked: b, max: m } = state.current;
    if (b || p.length >= m) return;
    const next = p + d;
    state.current.pin = next;
    setError(null);
    setPin(next);
    if (length && next.length === length) submit(next);
  };
  const back = () => {
    if (state.current.blocked) return;
    state.current.pin = state.current.pin.slice(0, -1);
    setPin(state.current.pin);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === "Backspace") back();
      else if (e.key === "Enter" && !length) submit();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // press, back and submit read the latest state through the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [length]);

  const dots = length ?? Math.max(MIN_PIN, pin.length);
  return (
    <div className="pin-form">
      <div
        key={shake}
        className={`pin-dots${shake ? " shake" : ""}`}
        role="status"
        aria-label={`${pin.length} of ${length ?? `up to ${MAX_PIN}`} digits entered`}
      >
        {Array.from({ length: dots }, (_, i) => (
          <span key={i} className={`pin-dot${i < pin.length ? " on" : ""}`} />
        ))}
      </div>
      <div className="pin-note" role={error ? "alert" : undefined}>
        {busy && <div>Checking</div>}
        {error && <div className="pin-error">{error}</div>}
        {left > 0 && <div>Try again in {left} s.</div>}
        {remaining !== undefined && remaining <= 5 && !lock.removed && <div>{remaining} {remaining === 1 ? "try" : "tries"} left before this browser is removed.</div>}
      </div>
      <div className={`pin-pad${blocked ? " blocked" : ""}`} role="group" aria-label="PIN keypad">
        {KEYS.map((d) => (
          <button key={d} type="button" className="pin-key" onClick={() => press(d)} disabled={blocked}>{d}</button>
        ))}
        <button type="button" className="pin-key pin-key-fn" onClick={back} disabled={blocked || pin.length === 0} aria-label="Delete">
          <svg width="26" height="20" viewBox="0 0 26 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
            <path d="M8 2h15a1.5 1.5 0 0 1 1.5 1.5v13A1.5 1.5 0 0 1 23 18H8l-6.5-8z" />
            <path d="M12 7l6 6M18 7l-6 6" strokeLinecap="round" />
          </svg>
        </button>
        <button type="button" className="pin-key" onClick={() => press("0")} disabled={blocked}>0</button>
        {length ? (
          <span className="pin-key-gap" aria-hidden="true" />
        ) : (
          <button type="button" className="pin-key pin-key-go" onClick={() => submit()} disabled={blocked || pin.length < MIN_PIN} aria-label={submitLabel}>
            <svg width="24" height="20" viewBox="0 0 24 20" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 10.5l6 6L21 4" />
            </svg>
          </button>
        )}
      </div>
      {onCancel && (
        <button type="button" className="pin-cancel" onClick={onCancel} disabled={busy}>Cancel</button>
      )}
    </div>
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
