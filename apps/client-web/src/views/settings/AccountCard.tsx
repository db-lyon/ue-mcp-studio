import { useEffect, useState } from "react";
import { ACCOUNT_NAME, ACCOUNT_SIGN_IN_GITHUB, accountLastMethod, accountMethods, accountSignedInAs, isLastMethod, type StudioSettings } from "@ue-mcp-studio/shared";
import { api } from "../../api";
import { subscribeEvent } from "../../extensions/events";
import { SignInForm } from "../ModelPicker";
import { AppSignIn, type SignInCalls } from "../AppSignIn";
import { Card, useMessage } from "./controls";
import { ManagePlanButton } from "../Upgrade";
import { useRemoteAvailable } from "./remote-available";
import { onRemotePage } from "../../connection";
import { EmailCodeForm } from "./AccountSignIn";
import { REMOTE_CHANGE_NOTE } from "./RemoteReadOnly";

const GITHUB_LINK: SignInCalls = { view: () => api.githubLink(), start: () => api.startGitHubLink(), cancel: () => api.cancelGitHubLink() };

/**
 * The ue-mcp account on this computer: sign in (email or GitHub), who is
 * signed in and the account's ways to sign in, sign out. An account from
 * `ue-mcp login` is shown, and signed out there. An account with a paid plan
 * also gets Manage plan, its customer portal; one without sees nothing about
 * plans here.
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
  // What the account service says now; the agent keeps it and says when it changed.
  useEffect(() => {
    if (account && !onRemotePage()) api.accountProfile().catch(() => {});
  }, [account?.via, account?.login]);
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
            <strong>ue-mcp account</strong> <span className="muted small">{!settings ? "Loading" : account ? accountSignedInAs(account) : "Not signed in"}</span>
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
      {account?.via === "studio" && <SignInMethods account={account} onChanged={load} />}
    </Card>
  );
}

type Account = NonNullable<StudioSettings["account"]>;

/**
 * The account's ways to sign in, email and GitHub, each added, linked or
 * removed here. The last one left cannot be removed. Read only in a paired
 * browser, and absent for an agent from before email sign-in.
 */
function SignInMethods({ account, onChanged }: { account: Account; onChanged: () => void }) {
  const [open, setOpen] = useState<"email" | "github" | null>(null);
  const [busy, setBusy] = useState<"email" | "github" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const methods = accountMethods(account);
  if (methods.length === 0) return null;
  const remote = onRemotePage();
  const finished = () => {
    setOpen(null);
    onChanged();
  };
  const remove = (kind: "email" | "github") => {
    setBusy(kind);
    setError(null);
    (kind === "email" ? api.removeAccountEmail() : api.unlinkGitHub()).then(onChanged, (e: Error) => setError(e.message)).finally(() => setBusy(null));
  };
  return (
    <div className="account-methods">
      <div className="account-methods-head small muted">Ways to sign in</div>
      {methods.map((m) => {
        const last = isLastMethod(account, m.kind);
        return (
          <div key={m.kind} className="account-method">
            <div className="account-method-row">
              <span className="account-method-name small">{m.label}</span>
              <span className={`account-method-value small ${m.value ? "" : "dim"}`}>{m.value ?? (m.kind === "email" ? "No email" : "Not linked")}</span>
              {!remote && open !== m.kind && (
                <span className="account-method-actions">
                  {m.kind === "email" && !m.value && <button onClick={() => setOpen("email")}>Add email</button>}
                  {m.kind === "email" && m.value && <button onClick={() => setOpen("email")}>Change</button>}
                  {m.kind === "email" && m.value && (
                    <button disabled={last || busy !== null} title={last ? accountLastMethod("email") : undefined} onClick={() => remove("email")}>{busy === "email" ? "Removing" : "Remove email"}</button>
                  )}
                  {m.kind === "github" && !m.value && <button onClick={() => setOpen("github")}>Link GitHub</button>}
                  {m.kind === "github" && m.value && (
                    <button disabled={last || busy !== null} title={last ? accountLastMethod("github") : undefined} onClick={() => remove("github")}>{busy === "github" ? "Unlinking" : "Unlink GitHub"}</button>
                  )}
                </span>
              )}
            </div>
            {!remote && m.value && last && <p className="dim small account-last-note">{accountLastMethod(m.kind)}</p>}
            {open === "email" && m.kind === "email" && <EmailCodeForm mode="add" onDone={finished} onCancel={() => setOpen(null)} />}
            {open === "github" && m.kind === "github" && (
              <div className="account-link">
                <AppSignIn id="studio" name="this account" primary label="Link GitHub" about="" calls={GITHUB_LINK} doneText="GitHub is linked." autoStart onDone={finished} />
                <button className="ghost small-button" onClick={() => setOpen(null)}>Cancel</button>
              </div>
            )}
          </div>
        );
      })}
      {error && <div className="banner bad small" role="alert">{error}</div>}
      {remote && <p className="dim small remote-readonly-note">{REMOTE_CHANGE_NOTE}</p>}
    </div>
  );
}
