import { useEffect, useId, useState } from "react";
import {
  ACCOUNT_CODE_ERROR,
  ACCOUNT_EMAIL_ABOUT,
  ACCOUNT_EMAIL_MALFORMED,
  ACCOUNT_NAME,
  ACCOUNT_SIGN_IN_GITHUB,
  ACCOUNT_SIGN_IN_HEADING,
  isEmailAddress,
  isEmailCode,
  waitText,
  type AuthMethods,
} from "@ue-mcp-studio/shared";
import { api, retryAfterOf } from "../../api";
import { AppSignIn } from "../AppSignIn";

/** Re-render every `ms` while `on`, for a countdown. */
function useNow(on: boolean, ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [on, ms]);
  return now;
}

/**
 * Email and a 6-digit code, inline: the address, Send code, then the code with
 * Resend (held for a rate limit's retryAfter), Change email and the code's
 * expiry. "signin" signs in or creates the account; "add" adds or changes the
 * signed-in account's address.
 */
export function EmailCodeForm({ mode, onDone, onCancel }: { mode: "signin" | "add"; onDone: () => void; onCancel?: () => void }) {
  const id = useId();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expiresAt, setExpiresAt] = useState(0);
  const [waitUntil, setWaitUntil] = useState(0);
  const now = useNow(step === "code" || waitUntil > Date.now());
  const wait = Math.max(0, (waitUntil - now) / 1000);
  const expired = step === "code" && expiresAt > 0 && now >= expiresAt;

  const refused = (e: unknown) => {
    const after = retryAfterOf(e);
    if (after) setWaitUntil(Date.now() + after * 1000);
    setError(e instanceof Error ? e.message : String(e));
  };

  const send = async () => {
    if (!isEmailAddress(email)) return setError(ACCOUNT_EMAIL_MALFORMED);
    setBusy(true);
    setError(null);
    try {
      const sent = await (mode === "signin" ? api.startEmailSignIn(email.trim()) : api.startAccountEmail(email.trim()));
      setExpiresAt(Date.now() + (sent.expiresInSeconds || 600) * 1000);
      setCode("");
      setStep("code");
    } catch (e) {
      refused(e);
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    if (!isEmailCode(code)) return setError(ACCOUNT_CODE_ERROR);
    setBusy(true);
    setError(null);
    try {
      await (mode === "signin" ? api.verifyEmailSignIn(email.trim(), code.trim()) : api.verifyAccountEmail(email.trim(), code.trim()));
      onDone();
    } catch (e) {
      refused(e);
    } finally {
      setBusy(false);
    }
  };

  const banner = error && <div className="banner bad small" role="alert">{error}{wait > 0 ? ` Try again in ${waitText(wait)}.` : ""}</div>;

  if (step === "email") {
    return (
      <form className="connect account-email" noValidate onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <label className="small muted" htmlFor={`${id}-email`}>{mode === "signin" ? "Email" : "New email address"}</label>
        <div className="row">
          <input id={`${id}-email`} type="email" autoComplete="email" inputMode="email" placeholder="name@example.com" value={email} onChange={(e) => { setEmail(e.target.value); setError(null); }} />
          <button className="primary" type="submit" disabled={busy || wait > 0}>{wait > 0 ? `Wait ${waitText(wait)}` : busy ? "Sending" : "Send code"}</button>
          {onCancel && <button type="button" onClick={onCancel}>Cancel</button>}
        </div>
        {banner}
        <p className="dim small">{mode === "signin" ? ACCOUNT_EMAIL_ABOUT : "Studio emails a 6-digit code to the new address."}</p>
      </form>
    );
  }
  const minutes = Math.max(1, Math.ceil((expiresAt - now) / 60_000));
  return (
    <form className="connect account-code" noValidate onSubmit={(e) => { e.preventDefault(); void verify(); }}>
      {/* A paragraph, not a label: settings lay a label out as a row, which splits the address from its sentence. */}
      <p className="small muted" id={`${id}-code-prompt`}>Enter the 6-digit code sent to <strong className="account-address">{email.trim()}</strong>.</p>
      <div className="row">
        <input id={`${id}-code`} aria-labelledby={`${id}-code-prompt`} className="mono account-code-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="123456" value={code}
          onChange={(e) => { setCode(e.target.value.replace(/\D/g, "").slice(0, 6)); setError(null); }} />
        <button className="primary" type="submit" disabled={busy || expired || wait > 0 || code.length !== 6}>{busy ? "Checking" : mode === "signin" ? "Sign in" : "Add email"}</button>
      </div>
      {banner}
      {/* The error already says what to do; the expiry would only repeat it. */}
      {!error && <p className="dim small">{expired ? "The code has expired. Resend the code to get a new one." : `The code expires in ${minutes} min.`}</p>}
      <div className="account-code-actions">
        <button type="button" disabled={busy || wait > 0} onClick={() => void send()}>{wait > 0 ? `Resend in ${waitText(wait)}` : "Resend code"}</button>
        <button type="button" onClick={() => { setStep("email"); setCode(""); setError(null); }}>Change email</button>
        {onCancel && <button type="button" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

/**
 * The ue-mcp account sign-in. With email sign-in offered: create an account
 * or sign in by email, and Continue with GitHub below. Without it (the
 * account service's rollout flag, or an older agent): the GitHub sign-in
 * alone, as before.
 */
export function AccountSignIn({ onDone, name = ACCOUNT_NAME, about = ACCOUNT_SIGN_IN_GITHUB, primary }: { onDone: () => void; name?: string; about?: string; primary?: boolean }) {
  const [methods, setMethods] = useState<AuthMethods | null>(null);
  useEffect(() => {
    api.authMethods().then(setMethods, () => setMethods({ email: false, github: true }));
  }, []);
  if (!methods) return null;
  if (!methods.email) return <AppSignIn id="studio" name={name} about={about} primary={primary} onDone={onDone} />;
  return (
    <div className="account-signin">
      <strong className="account-signin-head">{ACCOUNT_SIGN_IN_HEADING}</strong>
      <EmailCodeForm mode="signin" onDone={onDone} />
      <div className="account-or dim small" role="separator">or</div>
      <AppSignIn id="studio" name={name} primary={false} label="Continue with GitHub" about="" onDone={onDone} />
    </div>
  );
}
