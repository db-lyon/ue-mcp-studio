import { useEffect, useState, type FormEvent } from "react";
import { REMOTE_LOCK_IDLE_CHOICES, type RemoteLockSettings } from "@ue-mcp-studio/shared";
import { api, notThere } from "../../api";
import { Card, Row, Seg, Switch } from "./controls";

const PIN = /^\d{4,8}$/;

/** Set or change the PIN: twice, digits only. */
function PinFields({ changing, onDone, onCancel }: { changing: boolean; onDone: (s: RemoteLockSettings) => void; onCancel: () => void }) {
  const [pin, setPin] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const digits = (v: string) => v.replace(/\D/g, "").slice(0, 8);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!PIN.test(pin)) return setError("A PIN is 4 to 8 digits.");
    if (pin !== again) return setError("The two PINs differ.");
    setBusy(true);
    setError(null);
    api.setRemotePin(pin).then(onDone, (e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
  return (
    <form className="pin-set" onSubmit={submit}>
      <label className="pin-set-field">
        <span>{changing ? "New PIN" : "PIN"}</span>
        <input type="password" inputMode="numeric" pattern="[0-9]*" autoComplete="new-password" maxLength={8} value={pin} onChange={(e) => setPin(digits(e.target.value))} autoFocus disabled={busy} />
      </label>
      <label className="pin-set-field">
        <span>Same PIN again</span>
        <input type="password" inputMode="numeric" pattern="[0-9]*" autoComplete="new-password" maxLength={8} value={again} onChange={(e) => setAgain(digits(e.target.value))} disabled={busy} />
      </label>
      {error && <div className="small remote-err" role="alert">{error}</div>}
      <div className="pin-set-actions">
        <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="primary" disabled={busy || pin.length < 4 || again.length < 4}>{busy ? "Saving" : changing ? "Change PIN" : "Set PIN"}</button>
      </div>
    </form>
  );
}

/**
 * The remote PIN lock, on the computer only: a PIN, then either or both of
 * locking the whole paired browser and asking for sensitive actions. Off
 * until a PIN is set and a switch is turned on.
 */
export function PinLockCard() {
  const [lock, setLock] = useState<RemoteLockSettings | null>(null);
  const [gone, setGone] = useState(false);
  const [editing, setEditing] = useState(false);
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

  if (gone) return null;
  return (
    <Card label="PIN lock" className="pin-lock">
      <p className="muted small">Ask for a PIN on paired browsers, like a phone's lock screen. The computer checks it, so a browser cannot skip it. Ten wrong PINs in a row remove that browser.</p>
      {error && <div className="banner bad small" role="alert">{error}</div>}
      {!lock && !error && <p className="muted small">Loading</p>}
      {lock && (editing || !lock.pin) && (editing ? (
        <PinFields changing={lock.pin} onDone={(s) => { setLock(s); setEditing(false); }} onCancel={() => setEditing(false)} />
      ) : (
        <div className="pin-lock-actions">
          <button className="primary" onClick={() => setEditing(true)}>Set a PIN</button>
        </div>
      ))}
      {lock?.pin && !editing && (
        <>
          <Row title="Lock the whole browser" help={`A paired browser asks for the PIN to open Studio, and again after ${lock.idleMinutes} minutes without use.`}>
            <Switch on={lock.whole} onChange={(v) => save("whole", api.setRemoteLock({ whole: v }))} label="Lock the whole browser" disabled={busy !== null} />
          </Row>
          {lock.whole && (
            <div className="pin-idle">
              <span className="pin-idle-label">Lock again after</span>
              <Seg
                label="Lock again after"
                compact
                value={String(lock.idleMinutes)}
                options={REMOTE_LOCK_IDLE_CHOICES.map((m) => ({ id: String(m), name: m === 60 ? "1 hour" : `${m} min` }))}
                onChange={(v) => save("idle", api.setRemoteLock({ idleMinutes: Number(v) }))}
                disabled={busy !== null}
              />
            </div>
          )}
          <Row title="Ask for sensitive actions" help="Answering approvals, restarting the editor, running flows and playtests, undoing changes, changing settings, and sending messages while shell commands or file changes run without asking. One PIN covers five minutes.">
            <Switch on={lock.sensitive} onChange={(v) => save("sensitive", api.setRemoteLock({ sensitive: v }))} label="Ask for sensitive actions" disabled={busy !== null} />
          </Row>
          <div className="pin-lock-actions">
            <button onClick={() => setEditing(true)} disabled={busy !== null}>Change PIN</button>
            <button onClick={() => save("remove", api.removeRemotePin())} disabled={busy !== null}>{busy === "remove" ? "Removing" : "Remove PIN"}</button>
          </div>
        </>
      )}
    </Card>
  );
}
