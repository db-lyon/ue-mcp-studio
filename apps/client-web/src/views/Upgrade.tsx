import { useState } from "react";
import type { BillingInterval } from "@ue-mcp-studio/shared";
import { ApiError, api } from "../api";
import { openExternal } from "../native";
import { Seg } from "./settings/controls";
import { watchForCheckout } from "./settings/remote-available";

const INTERVALS: ReadonlyArray<{ id: BillingInterval; name: string }> = [
  { id: "month", name: "Monthly" },
  { id: "year", name: "Yearly" },
];

/** What the row says once the payment page is open. */
export const CHECKOUT_OPENED = "Checkout opened in your browser. Remote control turns on here once the payment goes through.";

/** The /remote reply once the plan shows. */
export const REMOTE_NOW_ON = "Remote control is on for this account.";

/**
 * Buy the Pro plan: monthly or yearly, then the provider's checkout in the
 * system browser. An account that already has a subscription gets its portal
 * instead. The plan is then asked every few seconds until it shows (watchForCheckout).
 */
export function UpgradeAction() {
  const [interval, setInterval] = useState<BillingInterval>("month");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const upgrade = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const link = await api.billingCheckout({ plan: "pro", interval }).catch(async (e: unknown) => {
        if (e instanceof ApiError && e.status === 409) return api.billingPortal();
        throw e;
      });
      openExternal(link.url);
      watchForCheckout();
      setNote(CHECKOUT_OPENED);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="upgrade">
      <div className="upgrade-row">
        <Seg label="Billing interval" value={interval} options={INTERVALS} onChange={setInterval} compact disabled={busy} />
        <button className="primary" disabled={busy} onClick={() => void upgrade()}>{busy ? "Opening checkout" : "Upgrade to Pro"}</button>
      </div>
      {note && <p className="dim small" role="status">{note}</p>}
      {error && <div className="banner bad small" role="alert">{error}</div>}
    </div>
  );
}

/** The customer portal for a paid account, in the system browser. */
export function ManagePlanButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const manage = () => {
    setBusy(true);
    setError(null);
    api.billingPortal().then((l) => openExternal(l.url), (e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
  return (
    <>
      <button disabled={busy} onClick={manage}>{busy ? "Opening" : "Manage plan"}</button>
      {error && <div className="banner bad small" role="alert">{error}</div>}
    </>
  );
}
