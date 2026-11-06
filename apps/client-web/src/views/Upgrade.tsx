import { useState } from "react";
import { BILLING_INTERVALS, REMOTE_INTERVAL_NAMES, UPGRADE_LABEL, type BillingInterval } from "@ue-mcp-studio/shared";
import { ApiError, api } from "../api";
import { openExternal } from "../native";
import { Seg } from "./settings/controls";
import { watchForCheckout } from "./settings/remote-available";

/** Monthly or yearly, each named by its price before tax. */
const INTERVALS: ReadonlyArray<{ id: BillingInterval; name: string }> = BILLING_INTERVALS.map((id) => ({ id, name: REMOTE_INTERVAL_NAMES[id] }));

/** What the row says once the payment page is open. */
export const CHECKOUT_OPENED = "Checkout opened in your browser. Remote control shows here once the payment goes through.";

/** What the row says when the account already has a subscription, so its portal opened instead. */
export const PORTAL_OPENED = "This account already has a subscription. Its billing page opened in your browser.";

/** The /remote reply once the plan shows. */
export const REMOTE_NOW_ON = "This account's plan includes remote control.";


/**
 * Buy the Remote plan: monthly or yearly, then the provider's checkout in the
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
      let portal = false;
      const link = await api.billingCheckout({ plan: "remote", interval }).catch(async (e: unknown) => {
        if (e instanceof ApiError && e.status === 409) {
          portal = true;
          return api.billingPortal();
        }
        throw e;
      });
      openExternal(link.url);
      watchForCheckout();
      setNote(portal ? PORTAL_OPENED : CHECKOUT_OPENED);
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
        <button className="primary" disabled={busy} onClick={() => void upgrade()}>{busy ? "Opening checkout" : UPGRADE_LABEL}</button>
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
