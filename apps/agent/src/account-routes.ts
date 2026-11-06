/**
 * The ue-mcp account's own routes, passed on to the account service (the
 * account host, auth-url.ts). The UI never sees the account token: sign-ins keep it
 * here (SettingsStore.signIn), and the account routes send it.
 *
 *   GET    /auth/methods          { email, github }: which sign-ins the service offers; email is the rollout flag
 *   POST   /auth/email/start      { email }: email a 6-digit code
 *   POST   /auth/email/verify     { email, code }: sign in, or create the account; { ok, login, email, created }
 *   GET    /account/profile       the signed-in account's view: { userId, login, email, emailVerified, github }
 *   POST   /account/email/start   { email }: email a code to add or change the account's address
 *   POST   /account/email/verify  { email, code }: the address is the account's now; the account view
 *   DELETE /account/email         remove the address (refused when GitHub is not linked); the account view
 *   GET    /account/github/link   linking GitHub: the device flow's progress (StudioSignIn)
 *   POST   /account/github/link   start it; the GitHub token goes to the account, not traded for a new one
 *   DELETE /account/github/link   cancel it
 *   DELETE /account/github        unlink GitHub (refused without a verified email); the account view
 *
 * Refusals keep the service's status and message; a 429 carries retryAfter in seconds.
 */
import type { DaemonExtensionApi } from "ue-mcp/daemon";
import {
  ACCOUNT_CODE_ERROR,
  ACCOUNT_EMAIL_MALFORMED,
  ACCOUNT_SIGNED_OUT,
  isEmailAddress,
  isEmailCode,
  type AccountRouteError,
  type AuthMethods,
  type EmailCodeSent,
  type EmailSignedIn,
  type RegistryAccountView,
} from "@ue-mcp-studio/shared";
import { GitHubDeviceFlow } from "./signin.js";
import { authBasesNow, authFetch } from "./auth-url.js";
import type { AccountProfile } from "./settings.js";

export interface AccountRoutesOptions {
  /** Where the panel's sign-in is kept. */
  settings: {
    accountToken(): string | null;
    signIn(token: string, login: string, profile?: AccountProfile): void;
    saveAccountProfile(login: string, profile: AccountProfile): boolean;
  };
  /** After the account token or what is shown of the account changed. */
  changed: () => void;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** The account hosts to try, in order (auth-url.ts). */
  authBases?: () => string[];
}

const TIMEOUT_MS = 15_000;

type Reply<T> = { status?: number; body: T | AccountRouteError };

const refused = (status: number, error: string, retryAfter?: number): Reply<never> => ({ status, body: retryAfter !== undefined ? { error, retryAfter } : { error } });

const profileOf = (v: RegistryAccountView): AccountProfile => ({ email: v.email ?? null, github: v.github?.login ?? null });

/** The account service's answer as the UI gets it: the body on success, its refusal otherwise. */
async function replyOf<T>(res: Response): Promise<Reply<T> & { ok: boolean }> {
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok) return { ok: true, body: body as T };
  const error = typeof body.error === "string" ? body.error : `The UE-MCP account service answered HTTP ${res.status}.`;
  if (res.status === 429) {
    const after = typeof body.retryAfter === "number" ? body.retryAfter : Number(res.headers.get("retry-after"));
    return { ok: false, ...refused(429, error, Number.isFinite(after) && after > 0 ? Math.ceil(after) : 60) };
  }
  if (res.status === 401) return { ok: false, ...refused(401, ACCOUNT_SIGNED_OUT) };
  // The service's own refusals (a bad address or code, a conflict, email not offered) pass on as they are.
  return { ok: false, ...refused([400, 409, 503].includes(res.status) ? res.status : 502, error) };
}

export function registerAccountRoutes(api: Pick<DaemonExtensionApi, "route">, o: AccountRoutesOptions): { refresh(): Promise<void> } {
  const f = o.fetch ?? fetch;

  const ask = async <T>(method: string, path: string, body?: unknown, token?: string | null): Promise<Reply<T> & { ok: boolean }> => {
    const headers: Record<string, string> = { accept: "application/json", "user-agent": "ue-mcp-studio" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (token) headers.authorization = `Bearer ${token}`;
    const init = () => ({ method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
    const res = await authFetch(f, path, init, (o.authBases ?? authBasesNow)()).catch(() => null);
    if (!res) return { ok: false, ...refused(502, "Could not reach the UE-MCP account service.") };
    return replyOf<T>(res);
  };

  /** An account route with the panel's token: the account view, kept and shown. */
  const authed = async (method: string, path: string, body?: unknown): Promise<Reply<RegistryAccountView>> => {
    const token = o.settings.accountToken();
    if (!token) return refused(401, ACCOUNT_SIGNED_OUT);
    const r = await ask<RegistryAccountView>(method, path, body, token);
    if (r.ok) keep(r.body as RegistryAccountView);
    return { status: r.status, body: r.body };
  };

  const keep = (v: RegistryAccountView) => {
    if (v && typeof v.login === "string" && o.settings.saveAccountProfile(v.login, profileOf(v))) o.changed();
  };

  /** Read the account view again and keep what it says, after a sign-in. */
  const refresh = async () => {
    await authed("GET", "/api/account");
  };

  const emailOf = (b: unknown) => ((b ?? {}) as { email?: unknown }).email;
  const codeOf = (b: unknown) => ((b ?? {}) as { code?: unknown }).code;

  api.route("GET", "/auth/methods", async () => {
    const r = await ask<Partial<AuthMethods>>("GET", "/api/auth/methods");
    // A service from before email sign-in, or one that cannot be reached: GitHub alone, as before.
    const email = r.ok && (r.body as Partial<AuthMethods>).email === true;
    const out: AuthMethods = { email, github: true };
    return { body: out };
  });

  api.route("POST", "/auth/email/start", async (req) => {
    const email = emailOf(req.body);
    if (!isEmailAddress(email)) return refused(400, ACCOUNT_EMAIL_MALFORMED);
    const r = await ask<EmailCodeSent>("POST", "/api/auth/email/start", { email: email.trim() });
    return { status: r.status, body: r.body };
  });

  api.route("POST", "/auth/email/verify", async (req) => {
    const email = emailOf(req.body);
    const code = codeOf(req.body);
    if (!isEmailAddress(email)) return refused(400, ACCOUNT_EMAIL_MALFORMED);
    if (!isEmailCode(code)) return refused(400, ACCOUNT_CODE_ERROR);
    const r = await ask<{ token?: string; login?: string; email?: string; created?: boolean }>("POST", "/api/auth/email/verify", { email: email.trim(), code: code.trim() });
    if (!r.ok) return { status: r.status, body: r.body };
    const d = r.body as { token?: string; login?: string; email?: string; created?: boolean };
    if (typeof d.token !== "string" || !d.token) return refused(502, "The UE-MCP account service sent no account token.");
    const login = d.login ?? email.trim();
    o.settings.signIn(d.token, login, { email: d.email ?? email.trim(), github: null });
    o.changed();
    // Whether GitHub is linked too (an address that matched a GitHub account) is the account view's to say.
    await refresh();
    const out: EmailSignedIn = { ok: true, login, email: d.email ?? email.trim(), created: d.created === true };
    return { body: out };
  });

  api.route("GET", "/account/profile", () => authed("GET", "/api/account"));

  api.route("POST", "/account/email/start", async (req) => {
    const email = emailOf(req.body);
    if (!isEmailAddress(email)) return refused(400, ACCOUNT_EMAIL_MALFORMED);
    const token = o.settings.accountToken();
    if (!token) return refused(401, ACCOUNT_SIGNED_OUT);
    const r = await ask<EmailCodeSent>("POST", "/api/account/email/start", { email: email.trim() }, token);
    return { status: r.status, body: r.body };
  });

  api.route("POST", "/account/email/verify", (req) => {
    const email = emailOf(req.body);
    const code = codeOf(req.body);
    if (!isEmailAddress(email)) return refused(400, ACCOUNT_EMAIL_MALFORMED);
    if (!isEmailCode(code)) return refused(400, ACCOUNT_CODE_ERROR);
    return authed("POST", "/api/account/email/verify", { email: email.trim(), code: code.trim() });
  });

  api.route("DELETE", "/account/email", () => authed("DELETE", "/api/account/email"));
  api.route("DELETE", "/account/github", () => authed("DELETE", "/api/account/github"));

  // Linking GitHub runs the sign-in's device flow, and gives the GitHub token to the signed-in account.
  const link = new GitHubDeviceFlow(async (githubToken) => {
    const r = await authed("POST", "/api/account/github", { githubToken });
    if (r.status !== undefined) throw new Error((r.body as AccountRouteError).error);
    const v = r.body as RegistryAccountView;
    return v.github?.login ?? v.login;
  }, f, o.sleep);

  api.route("GET", "/account/github/link", () => ({ body: link.view() }));
  api.route("POST", "/account/github/link", async () => {
    if (!o.settings.accountToken()) return refused(401, ACCOUNT_SIGNED_OUT);
    return { body: await link.start() };
  });
  api.route("DELETE", "/account/github/link", () => {
    link.cancel();
    return { status: 204 };
  });

  return { refresh };
}
