import { useEffect, useRef, useState } from "react";
import { REMOTE_NO_PLAN, REMOTE_PLAN_NOTE, REMOTE_SUMMARY, type RemoteBrowser, type RemotePairing, type RemoteStatus } from "@ue-mcp-studio/shared";
import { ApiError, api } from "../../api";
import { Head } from "../SettingsHub";
import { Card, Row, Switch } from "./controls";
import { SignInForm } from "../ModelPicker";
import { UpgradeAction } from "../Upgrade";
import { ACCOUNT_NAME } from "./AccountCard";
import { PairingCode } from "../remote/PairingCode";
import { PinLockCard } from "./PinLockCard";

/** How often the section rereads the connection and the paired browsers while it is open. */
export const REMOTE_POLL_MS = 3000;

export const NO_PLAN_TEXT = REMOTE_NO_PLAN;

const STATE: Record<RemoteStatus["state"], { name: string; dot: string }> = {
  off: { name: "Off", dot: "" },
  connecting: { name: "Connecting", dot: "warn" },
  online: { name: "Online", dot: "ok" },
  error: { name: "Not connected", dot: "bad" },
};

function detail(s: RemoteStatus): string {
  if (s.state === "online") return `Signed in as ${s.login}, through ${s.relay}`;
  if (s.state === "off") return "Paired devices cannot reach this project.";
  if (s.state === "error" && s.code === "no-plan") return s.relay;
  return s.reason ?? s.relay;
}

/** Remote control for an account without a paid plan, while the plan is offered: what it does and the Upgrade action. Nothing that runs. */
export function RemoteUpsell() {
  return (
    <>
      <Head title="Remote control" lead={REMOTE_SUMMARY} />
      <Card label="Plan">
        <p className="remote-plan-note">{REMOTE_PLAN_NOTE}</p>
        <UpgradeAction />
      </Card>
    </>
  );
}

/** Remote control on a computer with no ue-mcp account signed in, while the plan is offered: the account sign-in, inline. */
export function RemoteSignIn({ onDone }: { onDone: () => void }) {
  return (
    <>
      <Head title="Remote control" lead={REMOTE_SUMMARY} />
      <Card label="Account">
        <p className="cfg-note">Sign in to your ue-mcp account to use remote control.</p>
        <SignInForm id="studio" name={ACCOUNT_NAME} about="Sign in with GitHub." onDone={onDone} />
      </Card>
    </>
  );
}

/** Remote control: reach this project from a phone or another browser, through the relay, sealed end to end. */
export function RemoteSection({ onUnavailable }: { onUnavailable?: () => void } = {}) {
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [browsers, setBrowsers] = useState<RemoteBrowser[] | null>(null);
  const [pairing, setPairing] = useState<RemotePairing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [remoteOnly, setRemoteOnly] = useState(false);
  const [busy, setBusy] = useState<"toggle" | "pair" | string | null>(null);
  const alive = useRef(true);

  const load = async () => {
    try {
      const [s, b] = await Promise.all([api.remoteStatus(), api.remoteBrowsers()]);
      if (!alive.current) return;
      setStatus(s);
      setBrowsers(b.browsers);
      setError(null);
    } catch (e) {
      if (!alive.current) return;
      // A paired browser is refused these routes: they are set up on the computer itself.
      if (e instanceof ApiError && e.status === 403) setRemoteOnly(true);
      // The agent stopped offering it (the plan lapsed): Settings asks again and drops the section.
      else if (e instanceof ApiError && e.status === 404 && onUnavailable) onUnavailable();
      else setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    alive.current = true;
    void load();
    const t = setInterval(() => void load(), REMOTE_POLL_MS);
    return () => {
      alive.current = false;
      clearInterval(t);
    };
  }, []);

  const toggle = (on: boolean) => {
    setBusy("toggle");
    if (!on) setPairing(null);
    api.setRemote(on).then(
      (s) => {
        setStatus(s);
        setError(null);
      },
      (e: Error) => setError(e.message),
    ).finally(() => setBusy(null));
  };

  const pair = () => {
    setBusy("pair");
    setPairing(null);
    api.pairRemote().then(
      (p) => {
        setPairing(p);
        setError(null);
      },
      (e: Error) => setError(e instanceof ApiError && e.status === 403 ? NO_PLAN_TEXT : e.message),
    ).finally(() => setBusy(null));
  };

  const revoke = (b: RemoteBrowser) => {
    setBusy(b.id);
    api.revokeRemoteBrowser(b.id).then(
      () => setBrowsers((list) => list?.filter((x) => x.id !== b.id) ?? null),
      (e: Error) => setError(e.message),
    ).finally(() => setBusy(null));
  };

  const head = <Head title="Remote control" lead="Use this project from a phone or another computer. Requests and answers between a paired device and this computer are encrypted end to end, so the relay cannot read them." />;
  if (remoteOnly) {
    return (
      <>
        {head}
        <div className="banner warn" role="status">Remote control is turned on and paired from the computer running the project, not from a paired device.</div>
      </>
    );
  }

  const noPlan = status?.state === "error" && status.code === "no-plan";
  const online = status?.state === "online";
  const state = status ? STATE[status.state] : null;
  return (
    <>
      {head}
      {noPlan && <div className="banner bad remote-no-plan" role="alert">{NO_PLAN_TEXT}</div>}
      {error && !(noPlan && error === NO_PLAN_TEXT) && (
        <div className="banner bad row" role="alert">
          <span className="grow">{error}</span>
          <button onClick={() => void load()}>Retry</button>
        </div>
      )}
      <Card label="Connection">
        <Row title="Remote control" help="While it is on and connected, devices paired with this computer can reach this project, and the daemon does not stop for being idle.">
          <Switch on={!!status?.enabled} onChange={toggle} label="Remote control" disabled={!status || busy === "toggle"} />
        </Row>
        <div className="toggle-row inline remote-state">
          <span className={`dot ${state?.dot ?? ""}`} style={{ marginTop: 6 }} />
          <div className="grow">
            <div className="t">{state?.name ?? "Loading"}</div>
            {status && <div className="d">{detail(status)}</div>}
          </div>
        </div>
      </Card>
      <Card label="Pair a phone or browser" actions={<button className="primary" disabled={!online || busy === "pair"} onClick={pair}>{busy === "pair" ? "Making a code" : "New code"}</button>}>
        <p className="muted small">Scan the code on the device or open the link there, then allow the device when Studio here asks. A code works once, for 10 minutes. The device is paired with every project on this computer.{online ? "" : " Turn remote control on and wait for it to connect first."}</p>
        {pairing && <PairingCode pairing={pairing} onRenew={pair} busy={busy === "pair"} />}
      </Card>
      <Card label="Paired devices">
        {!browsers && !error && <p className="muted small">Loading</p>}
        {browsers && browsers.length === 0 && <p className="muted small">No devices paired.</p>}
        {browsers?.map((b) => (
          <div key={b.id} className="toggle-row inline remote-browser">
            <div className="grow">
              <div className="t">{b.label}</div>
              <div className="d">Paired {new Date(b.addedAt).toLocaleDateString()}</div>
            </div>
            <button disabled={busy === b.id} onClick={() => revoke(b)}>{busy === b.id ? "Removing" : "Remove"}</button>
          </div>
        ))}
      </Card>
      <PinLockCard onUnpaired={() => void load()} />
    </>
  );
}
