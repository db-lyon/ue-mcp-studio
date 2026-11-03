import { useEffect, useRef, useState } from "react";
import { REMOTE_NO_PLAN, REMOTE_SUMMARY, STUDIO_PLAN_URL, type RemoteBrowser, type RemotePairing, type RemoteStatus } from "@ue-mcp-studio/shared";
import { ApiError, api } from "../../api";
import { Head } from "../SettingsHub";
import { Card, Row, Switch } from "./controls";

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
  if (s.state === "off") return "Nothing reaches this project from outside this computer.";
  if (s.state === "error" && s.code === "no-plan") return s.relay;
  return s.reason ?? s.relay;
}

/** Remote control for an account without a paid plan, while the plan is offered: what it does and where the plans are. Nothing that runs. */
export function RemoteUpsell() {
  return (
    <>
      <Head title="Remote control" lead={REMOTE_SUMMARY} />
      <p className="remote-plan-note">
        Needs a Pro or Studio plan. <a href={STUDIO_PLAN_URL} target="_blank" rel="noreferrer">See plans</a>
      </p>
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

  const head = <Head title="Remote control" lead="Use this project from a phone or another computer's browser. What they exchange with this computer is encrypted end to end; the relay cannot read it." />;
  if (remoteOnly) {
    return (
      <>
        {head}
        <div className="banner warn" role="status">Remote control is turned on and paired from the computer running the project, not from a paired browser.</div>
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
        <Row title="Remote control" help="While it is on, this project stays reachable from browsers paired with this computer, and the daemon keeps running.">
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
        <p className="muted small">Scan the code on the device, or open the link there. It works once, for ten minutes, and pairs the device with every project on this computer.{online ? "" : " Turn remote control on and wait for it to connect first."}</p>
        {pairing && (
          <div className="remote-qr">
            <div className="qr" role="img" aria-label="Pairing QR code" dangerouslySetInnerHTML={{ __html: pairing.svg }} />
            <a className="path" href={pairing.url} target="_blank" rel="noreferrer">{pairing.url}</a>
          </div>
        )}
      </Card>
      <Card label="Paired browsers">
        {!browsers && !error && <p className="muted small">Loading</p>}
        {browsers && browsers.length === 0 && <p className="muted small">No browsers paired.</p>}
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
    </>
  );
}
