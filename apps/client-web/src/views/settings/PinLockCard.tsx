import { useEffect, useState, type FormEvent } from "react";
import { REMOTE_LOCK_IDLE_CHOICES, type RemoteLockSettings } from "@ue-mcp-studio/shared";
import { api, notThere } from "../../api";
import { Card, Row, Seg, Switch } from "./controls";

const PIN = /^\d{4,8}$/;
const digits = (v: string) => v.replace(/\D/g, "").slice(0, 8);

function PinInput({ label, value, onChange, autoFocus, disabled, current }: { label: string; value: string; onChange: (v: string) => void; autoFocus?: boolean; disabled?: boolean; current?: boolean }) {
  return (
    <label className="pin-set-field">
      <span>{label}</span>
      <input
        type="password"
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete={current ? "current-password" : "new-password"}
        maxLength={8}
        value={value}
        onChange={(e) => onChange(digits(e.target.value))}
        autoFocus={autoFocus}
        disabled={disabled}
      />
    </label>
  );
}

/** Set the first PIN (twice), or change it: the current PIN, then the new one twice. */
function PinFields({ changing, onDone, onCancel }: { changing: boolean; onDone: (s: RemoteLockSettings) => void; onCancel: () => void }) {
  const [current, setCurrent] = useState("");
  const [pin, setPin] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (changing && !PIN.test(current)) return setError("Enter the current PIN.");
    if (!PIN.test(pin)) return setError("A PIN is 4 to 8 digits.");
    if (pin !== again) return setError(changing ? "The two new PINs differ." : "The two PINs differ.");
    setBusy(true);
    setError(null);
    api.setRemotePin(pin, changing ? current : undefined).then(onDone, (e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
  const ready = pin.length >= 4 && again.length >= 4 && (!changing || current.length >= 4);
  return (
    <form className={changing ? "pin-set pin-confirm" : "pin-set"} onSubmit={submit}>
      {changing && <PinInput label="Current PIN" value={current} onChange={setCurrent} autoFocus disabled={busy} current />}
      <PinInput label={changing ? "New PIN" : "PIN"} value={pin} onChange={setPin} autoFocus={!changing} disabled={busy} />
      <PinInput label={changing ? "New PIN again" : "Same PIN again"} value={again} onChange={setAgain} disabled={busy} />
      {error && <div className="small remote-err" role="alert">{error}</div>}
      <div className="pin-set-actions">
        <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="primary" disabled={busy || !ready}>{busy ? "Saving" : changing ? "Change PIN" : "Set PIN"}</button>
      </div>
    </form>
  );
}

/** One change that weakens the lock, held until the current PIN is entered. */
function CurrentPin({ what, confirm, onSubmit, onCancel }: { what: string; confirm: string; onSubmit: (current: string) => Promise<unknown>; onCancel: () => void }) {
  const [current, setCurrent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!PIN.test(current)) return setError("Enter the current PIN.");
    setBusy(true);
    setError(null);
    onSubmit(current).catch((e: Error) => {
      setError(e.message);
      setCurrent("");
      setBusy(false);
    });
  };
  return (
    <form className="pin-set pin-confirm" onSubmit={submit}>
      <div className="small">{what}</div>
      <PinInput label="Current PIN" value={current} onChange={setCurrent} autoFocus disabled={busy} current />
      {error && <div className="small remote-err" role="alert">{error}</div>}
      <div className="pin-set-actions">
        <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="primary" disabled={busy || current.length < 4}>{busy ? "Saving" : confirm}</button>
      </div>
    </form>
  );
}

/** Forgot PIN: the PIN and lock go only with every paired device. */
function ForgotPin({ onDone, onCancel }: { onDone: (s: RemoteLockSettings) => void; onCancel: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = () => {
    setBusy(true);
    setError(null);
    api.forgetRemotePin().then(onDone, (e: Error) => {
      setError(e.message);
      setBusy(false);
    });
  };
  return (
    <div className="pin-set pin-forgot" role="group" aria-label="Forgot PIN">
      <div className="banner warn small">This removes every paired phone and browser; pair them again afterwards. The PIN and both switches go with them.</div>
      {error && <div className="small remote-err" role="alert">{error}</div>}
      <div className="pin-set-actions">
        <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="button" className="danger-button" onClick={go} disabled={busy}>{busy ? "Removing" : "Remove PIN and unpair all"}</button>
      </div>
    </div>
  );
}

/**
 * What "Ask for sensitive actions" guards: sensitiveRequest in the agent's
 * remote/pin-lock.ts (ALWAYS_ROUTES, then TURN_ROUTES while risky). Change
 * both together.
 */
export const SENSITIVE_ACTIONS: readonly string[] = [
  "Answer approvals, editor dialogs and forms",
  "Start, stop, restart or rebuild the editor, or stop turns waiting on it",
  "Run playtests or flows, or change playtest scripts",
  "Run the next queued message",
  "Keep, revert or undo changes",
  "Delete a chat",
  "Change settings, or keep the current Studio version",
  "Start a checkout",
];

/** TURN_ROUTES: asked only while shell commands or file changes run without asking. A /flow or /playtest message always asks (TEXT_ROUTES). */
export const SENSITIVE_TURNS = "A /flow or /playtest message always asks. While shell commands or file changes run without asking, so does sending, queueing or editing any message, or running an action from a chat.";

/** SENSITIVE_GRANT_MS, and what ends it sooner: PinLock.open (an idle lock), setPin, a daemon restart. */
export const SENSITIVE_GRANT = "A right PIN allows these on that device, in that project, for 5 minutes. An idle lock, a PIN change or a daemon restart ends that sooner.";

/** What the card says about who needs the PIN for what: PinLock.configure, setPin and removePin enforce it. */
export const PIN_RULE = "Removing or changing the PIN, turning a switch off or a longer idle time needs the current PIN, here too. Setting the first PIN, turning a switch on or a shorter idle time does not.";

const idleName = (m: number) => (m === 60 ? "1 hour" : `${m} min`);

type Pending =
  | { kind: "set" }
  | { kind: "change" }
  | { kind: "remove" }
  | { kind: "forgot" }
  | { kind: "weaken"; what: string; confirm: string; change: Partial<Pick<RemoteLockSettings, "whole" | "sensitive" | "idleMinutes">> };

/**
 * The remote PIN lock, on the computer only: a PIN, then either or both of
 * locking Studio on paired devices and asking for sensitive actions. Off
 * until a PIN is set and a switch is turned on.
 */
export function PinLockCard({ onUnpaired }: { onUnpaired?: () => void } = {}) {
  const [lock, setLock] = useState<RemoteLockSettings | null>(null);
  const [gone, setGone] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.remoteLock().then(setLock, (e: unknown) => (notThere(e) ? setGone(true) : setError(e instanceof Error ? e.message : String(e))));
  }, []);

  const save = (what: string, p: Promise<RemoteLockSettings>) => {
    setBusy(what);
    setError(null);
    p.then(setLock, (e: Error) => setError(e.message)).finally(() => setBusy(null));
  };
  const done = (s: RemoteLockSettings) => {
    setLock(s);
    setPending(null);
  };
  const weaken = (what: string, confirm: string, change: Extract<Pending, { kind: "weaken" }>["change"]) => {
    setError(null);
    setPending({ kind: "weaken", what, confirm, change });
  };

  const setWhole = (v: boolean) => (v ? save("whole", api.setRemoteLock({ whole: true })) : weaken("Enter the current PIN to stop locking Studio on paired devices.", "Turn off", { whole: false }));
  const setSensitive = (v: boolean) => (v ? save("sensitive", api.setRemoteLock({ sensitive: true })) : weaken("Enter the current PIN to stop asking for sensitive actions.", "Turn off", { sensitive: false }));
  const setIdle = (m: number) =>
    lock && m > lock.idleMinutes
      ? weaken(`Enter the current PIN to lock again after ${idleName(m)} instead of ${idleName(lock.idleMinutes)}.`, "Change", { idleMinutes: m })
      : save("idle", api.setRemoteLock({ idleMinutes: m }));

  if (gone) return null;
  const idle = busy !== null || pending !== null;
  return (
    <Card label="PIN lock" className="pin-lock">
      <p className="muted small">One PIN for paired devices, for every project on this computer. This computer checks it, so a device cannot skip it. Studio here never asks for it to work. 10 wrong PINs in a row remove that device.</p>
      {lock?.pin && <p className="muted small">{PIN_RULE}</p>}
      {error && <div className="banner bad small" role="alert">{error}</div>}
      {!lock && !error && <p className="muted small">Loading</p>}
      {lock && !lock.pin && (pending?.kind === "set" ? (
        <PinFields changing={false} onDone={done} onCancel={() => setPending(null)} />
      ) : (
        <div className="pin-lock-actions">
          <button className="primary" onClick={() => setPending({ kind: "set" })}>Set a PIN</button>
        </div>
      ))}
      {lock?.pin && (
        <>
          <Row title="Lock Studio on paired devices" help={`A paired device needs the PIN to use each project, and again after ${lock.idleMinutes === 60 ? "1 hour" : `${lock.idleMinutes} minutes`} without use, a PIN change or a daemon restart.`}>
            <Switch on={lock.whole} onChange={setWhole} label="Lock Studio on paired devices" disabled={idle} />
          </Row>
          {lock.whole && (
            <div className="pin-idle">
              <span className="pin-idle-label">Lock again after</span>
              <Seg
                label="Lock again after"
                compact
                value={String(lock.idleMinutes)}
                options={REMOTE_LOCK_IDLE_CHOICES.map((m) => ({ id: String(m), name: idleName(m) }))}
                onChange={(v) => setIdle(Number(v))}
                disabled={idle}
              />
            </div>
          )}
          <Row
            title="Ask for sensitive actions"
            help={
              <>
                A paired device needs the PIN to:
                <ul className="pin-sensitive-list">
                  {SENSITIVE_ACTIONS.map((a) => <li key={a}>{a}</li>)}
                </ul>
                {SENSITIVE_TURNS} {SENSITIVE_GRANT}
              </>
            }
          >
            <Switch on={lock.sensitive} onChange={setSensitive} label="Ask for sensitive actions" disabled={idle} />
          </Row>
          {pending?.kind === "weaken" && (
            <CurrentPin what={pending.what} confirm={pending.confirm} onSubmit={(current) => api.setRemoteLock({ ...pending.change, current }).then(done)} onCancel={() => setPending(null)} />
          )}
          {pending?.kind === "change" && <PinFields changing onDone={done} onCancel={() => setPending(null)} />}
          {pending?.kind === "remove" && (
            <CurrentPin what="Enter the current PIN to remove it. Both switches turn off." confirm="Remove PIN" onSubmit={(current) => api.removeRemotePin(current).then(done)} onCancel={() => setPending(null)} />
          )}
          {pending?.kind === "forgot" && (
            <ForgotPin
              onDone={(s) => {
                done(s);
                onUnpaired?.();
              }}
              onCancel={() => setPending(null)}
            />
          )}
          {!pending && (
            <div className="pin-lock-actions">
              <button onClick={() => setPending({ kind: "change" })} disabled={busy !== null}>Change PIN</button>
              <button onClick={() => setPending({ kind: "remove" })} disabled={busy !== null}>Remove PIN</button>
              <button className="pin-forgot-link" onClick={() => setPending({ kind: "forgot" })} disabled={busy !== null}>Forgot PIN</button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
