/**
 * The web client's views/Upgrade.tsx, the part the /remote reply shows: buy
 * the Pro plan, monthly or yearly, in the system browser, then wait for it.
 */
import { useState } from "react";
import { Linking, View } from "react-native";
import { HttpError } from "@ue-mcp-studio/client-core";
import type { BillingInterval } from "@ue-mcp-studio/shared";
import { useProjectNav } from "../../../../nav";
import { Banner, Button, Seg, T, useTheme } from "../../../../ui";
import { small } from "../../../../chat/styles";
import { watchForCheckout } from "./remote-available";

const INTERVALS: Array<{ key: BillingInterval; title: string }> = [
  { key: "month", title: "Monthly" },
  { key: "year", title: "Yearly" },
];

/** What the row says once the payment page is open. */
export const CHECKOUT_OPENED = "Checkout opened in your browser. Remote control turns on here once the payment goes through.";

/** The /remote reply once the plan shows. */
export const REMOTE_NOW_ON = "Remote control is on for this account.";

/** The /remote reply on a computer with no ue-mcp account signed in. */
export const REMOTE_SIGN_IN = "Sign in to your ue-mcp account to use remote control.";

export function UpgradeAction() {
  const t = useTheme();
  const { api } = useProjectNav();
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
        if (e instanceof HttpError && e.status === 409) return api.billingPortal();
        throw e;
      });
      void Linking.openURL(link.url);
      watchForCheckout(api);
      setNote(CHECKOUT_OPENED);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    // .upgrade: a column 8 px apart; in the reply it sits flush under the text.
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <Seg label="Billing interval" value={interval} options={INTERVALS} onChange={(k) => !busy && setInterval(k)} />
        <Button title={busy ? "Opening checkout" : "Upgrade to Pro"} variant="primary" disabled={busy} onPress={() => void upgrade()} />
      </View>
      {note ? <T accessibilityLiveRegion="polite" style={[small(t), { color: t.c.dim }]}>{note}</T> : null}
      {error ? (
        <Banner kind="bad" role="alert">
          <T style={[small(t), { color: t.c.badText }]}>{error}</T>
        </Banner>
      ) : null}
    </View>
  );
}
