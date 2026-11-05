import { useEffect, useState } from "react";
import type { RemotePairing } from "@ue-mcp-studio/shared";
import { pairingExpired, timeLeft } from "@ue-mcp-studio/client-core";

// The code's clock is client-core's, shared with the mobile app.
export { pairingExpired, timeLeft };

/**
 * A pairing code: the QR to scan, the link to open on the device, and how long
 * it has left. Once it runs out the QR goes and onRenew offers a new one.
 * Settings, Remote control and the /remote chat reply both show this.
 */
export function PairingCode({ pairing, onRenew, busy }: { pairing: RemotePairing; onRenew: () => void; busy?: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!pairing.expiresAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [pairing.expiresAt]);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(pairing.url).then(() => setCopied(true), () => {});
  };
  if (pairingExpired(pairing, now)) {
    return (
      <div className="remote-qr expired" role="status">
        <p className="muted small">This code has expired.</p>
        <button className="primary" disabled={busy} onClick={onRenew}>{busy ? "Making a code" : "New code"}</button>
      </div>
    );
  }
  const left = timeLeft(pairing, now);
  return (
    <div className="remote-qr">
      <div className="qr" role="img" aria-label="Pairing QR code" dangerouslySetInnerHTML={{ __html: pairing.svg }} />
      <a className="path" href={pairing.url} target="_blank" rel="noreferrer">{pairing.url}</a>
      <div className="remote-qr-meta">
        {left && <span className="muted small">{`Works once, for ${left} more.`}</span>}
        <button className="ghost small-button" onClick={copy}>{copied ? "Copied" : "Copy link"}</button>
      </div>
    </div>
  );
}
