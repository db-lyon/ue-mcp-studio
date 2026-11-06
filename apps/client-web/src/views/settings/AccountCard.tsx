import { useEffect, useState } from "react";
import { ACCOUNT_NAME, ACCOUNT_SIGN_IN_GITHUB, type StudioSettings } from "@ue-mcp-studio/shared";
import { api } from "../../api";
import { subscribeEvent } from "../../extensions/events";
import { SignInForm } from "../ModelPicker";
import { Card, useMessage } from "./controls";
import { ManagePlanButton } from "../Upgrade";
import { useRemoteAvailable } from "./remote-available";
import { onRemotePage } from "../../connection";

/**
 * The ue-mcp account on this computer: sign in with GitHub, who is signed in,
 * sign out. An account from `ue-mcp login` is shown, and signed out there.
 * An account with a paid plan also gets Manage plan, its customer portal; one
 * without sees nothing about plans here.
 */
export function AccountCard() {
  const [settings, setSettings] = useState<StudioSettings | null>(null);
  const msg = useMessage();
  const load = () => void api.settings().then(setSettings, msg.fail);
  useEffect(() => {
    load();
    return subscribeEvent((e) => {
      if (e.type === "studio.settings.changed") load();
    });
  }, []);
  const account = settings?.account ?? null;
  // A paid plan is what remote control checks for; the same answer, asked once.
  const paid = useRemoteAvailable(false).available === true;
  const signOut = () => api.saveSettings({ signOut: "studio" }).then(setSettings, msg.fail);
  return (
    <Card label="Account" className="account-card">
      {msg.node}
      <div className="toggle-row inline account-row">
        <span className={`dot ${account ? "ok" : ""}`} style={{ marginTop: 6 }} />
        <div className="grow">
          <div className="t">
            <strong>ue-mcp account</strong> <span className="muted small">{!settings ? "Loading" : account ? `Signed in as @${account.login}` : "Not signed in"}</span>
          </div>
          {settings && !account && <SignInForm id="studio" name={ACCOUNT_NAME} about={ACCOUNT_SIGN_IN_GITHUB} onDone={load} />}
        </div>
        {account && paid && <ManagePlanButton />}
        {account?.via === "studio" ? (
          onRemotePage() ? null : <button onClick={() => void signOut()}>Sign out</button>
        ) : account ? (
          <span className="dim small">from ue-mcp login</span>
        ) : null}
      </div>
    </Card>
  );
}
