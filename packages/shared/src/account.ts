/**
 * The account a Studio sign-in reports, as the agent reads it from the
 * account service, and the headers the agent sends with model requests that
 * go through that service. The sign-in itself is hidden while
 * STUDIO_PLAN_AVAILABLE is off.
 */

export interface Plan {
  id: string;
  name: string;
  /** Models this plan may run. The first is the default. */
  models: string[];
}

export type EntitlementStatus = "active" | "past_due" | "canceled" | "none";

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

/** GET /v1/account/usage on the account service. */
export interface AccountUsage {
  userId: string;
  login: string;
  plan: Plan;
  status: EntitlementStatus;
  periodStart: string;
  periodEnd: string;
  used: UsageTotals;
  /** Weighted tokens counted against the quota. */
  billableTokens: number;
  quota: number;
  remaining: number;
}

/** Plans that include remote control: Remote, and Pro, which includes everything Remote has. */
export const PAID_PLAN_IDS: readonly string[] = ["remote", "pro"];

/**
 * Whether Studio offers the Remote plan to accounts that do not have it. On: a
 * signed-out computer sees remote control with the sign-in, and a free account
 * sees it with the Upgrade action, in Settings and from /remote. Off: only a
 * paid account sees remote control. Independent of STUDIO_PLAN_AVAILABLE,
 * which gates the Studio model plan sign-in.
 */
export const REMOTE_PLAN_OFFERED = true;

/**
 * Whether Studio offers the Pro plan. Off: no Pro checkout or Pro wording is
 * shown, and remote control is sold as the Remote plan alone. A Pro account
 * still gets remote control either way.
 */
export const PRO_PLAN_OFFERED = false;

/** The plans remote control needs, as Studio names them. */
export const REMOTE_PLANS = PRO_PLAN_OFFERED ? "the Remote or Pro plan" : "the Remote plan";

/** What the Remote plan costs, as the gateway sells it. Tax is added at checkout. */
export const REMOTE_PRICE = "$5 a month or $50 a year, before tax";

/** The Upgrade action's billing choice, each with its price before tax. */
export const REMOTE_INTERVAL_NAMES: Readonly<Record<BillingInterval, string>> = { month: "$5/month", year: "$50/year" };

/**
 * Whether the account holds a plan with remote control at `now`: plan remote
 * or pro, status active or past_due, period end not passed. The gateway's own rule.
 */
export function hasPaidPlan(u: Pick<AccountUsage, "plan" | "status" | "periodEnd">, now: Date = new Date()): boolean {
  if (u.status !== "active" && u.status !== "past_due") return false;
  const end = new Date(u.periodEnd).getTime();
  if (!Number.isFinite(end) || end < now.getTime()) return false;
  return PAID_PLAN_IDS.includes(u.plan?.id);
}

/**
 * GET /v1/ext/studio/account on the daemon: the agent's view of the account,
 * read with the token the agent holds. The UI never sees the token.
 */
export type StudioAccountResponse =
  | { signedIn: false; reason: string }
  | { signedIn: true; usage: AccountUsage; manageUrl: string | null };

/** Header carrying the agent's session id on every request through the account service. */
export const GATEWAY_SESSION_HEADER = "x-ue-mcp-session";
/** Header naming the client. */
export const GATEWAY_CLIENT_HEADER = "x-ue-mcp-client";
export const GATEWAY_CLIENT_PREFIX = "studio-agent/";
/** The tool every agent request declares: the agent's single entry into ue-mcp. */
export const STUDIO_AGENT_TOOL = "ue_mcp";

/** Where remote control and billing send a computer with no ue-mcp account signed in. */
export const ACCOUNT_SIGNED_OUT = "Not signed in. Sign in to your ue-mcp account in Settings > General.";

/** The plans and billing intervals the gateway sells. */
export type BillingPlan = "remote" | "pro";
export type BillingInterval = "month" | "year";
export const BILLING_PLANS: readonly BillingPlan[] = ["remote", "pro"];
export const BILLING_INTERVALS: readonly BillingInterval[] = ["month", "year"];

/** POST /v1/ext/studio/billing/checkout on the daemon, passed on to the gateway with the account token. */
export interface BillingCheckoutRequest {
  plan: BillingPlan;
  interval: BillingInterval;
}

/**
 * What /billing/checkout and /billing/portal answer: a page on the payment
 * provider, opened in the system browser, never inside Studio.
 */
export interface BillingLink {
  url: string;
  provider?: string;
}

/**
 * Why a billing route refused, when the UI acts on it: "signed-out" (no
 * account), "subscribed" (checkout for an account that already has a
 * subscription: open the portal instead), "no-subscription" (portal for an
 * account without one), "unavailable" (billing is not set up on the gateway).
 */
export type BillingRefusal = "signed-out" | "subscribed" | "no-subscription" | "unavailable";
export interface BillingError {
  error: string;
  code?: BillingRefusal;
}

/** What the account sign-in is called outside Models. */
export const ACCOUNT_NAME = "your ue-mcp account";

/** Under the account's sign-in button while the account service offers no email sign-in: that button runs GitHub's. */
export const ACCOUNT_SIGN_IN_GITHUB = "Uses your GitHub account. The first time creates your ue-mcp account.";

/** The heading of the account sign-in once email sign-in is offered. */
export const ACCOUNT_SIGN_IN_HEADING = "Create an account or sign in";

/** Under the email field: how email sign-in works. */
export const ACCOUNT_EMAIL_ABOUT = "Studio emails you a 6-digit code. There is no password. A new address creates a new ue-mcp account.";

/** Refused before the account service is asked. */
export const ACCOUNT_EMAIL_MALFORMED = "Enter an email address, like name@example.com.";

/**
 * A wrong, expired or unknown code, in Studio's words: it names the Resend
 * code control. The account service's own message for these is mapped to it.
 */
export const ACCOUNT_CODE_ERROR = "That code is wrong or has expired. Resend the code to get a new one.";

/** Why Remove email or Unlink GitHub is disabled: that method is the account's only way to sign in, and what to set up first. */
export function accountLastMethod(kind: "email" | "github"): string {
  return kind === "email"
    ? "Email is the only way to sign in to this account, so it cannot be removed. Link GitHub first."
    : "GitHub is the only way to sign in to this account, so it cannot be unlinked. Add an email first.";
}

/**
 * GET /v1/ext/studio/auth/methods: the sign-ins the account service offers.
 * `email` is the rollout flag: false until the service can send email, and
 * Studio then shows GitHub alone.
 */
export interface AuthMethods {
  email: boolean;
  github: boolean;
}

/** The account service's account view, as the agent passes it on (never with the token). */
export interface RegistryAccountView {
  userId: string;
  login: string;
  email: string | null;
  emailVerified: boolean;
  github: { login: string } | null;
}

/** POST /v1/ext/studio/auth/email/start and /account/email/start. */
export interface EmailCodeSent {
  ok: true;
  expiresInSeconds: number;
}

/** POST /v1/ext/studio/auth/email/verify: signed in; the agent kept the token. */
export interface EmailSignedIn {
  ok: true;
  login: string;
  email: string;
  /** This sign-in created the account. */
  created: boolean;
}

/** A refusal from the account routes. `retryAfter`: seconds to wait, on a 429. */
export interface AccountRouteError {
  error: string;
  retryAfter?: number;
}

/** Whether `s` looks like an email address: something, one @, a domain with a dot. */
export function isEmailAddress(s: unknown): s is string {
  return typeof s === "string" && s.length <= 254 && /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(s.trim());
}

/** Whether `s` is a 6-digit one-time code. */
export const isEmailCode = (s: unknown): s is string => typeof s === "string" && /^\d{6}$/.test(s.trim());

/**
 * How an account's login reads: "@octocat" when the account view says it is
 * the GitHub login, otherwise as given. The login alone never earns the @:
 * an email account's login is its address, and `github` unknown (the view
 * not read yet, or an agent from before email sign-in) shows it plain.
 */
export function accountHandle(login: string, github?: string | null): string {
  return typeof github === "string" && github === login ? `@${login}` : login;
}

/** The account line's status: "Signed in as @octocat" or "Signed in as dev@example.com". */
export const accountSignedInAs = (a: { login: string; github?: string | null }): string => `Signed in as ${accountHandle(a.login, a.github)}`;

/** The account's ways to sign in, as both clients list them under the account. Empty for an agent from before email sign-in. */
export function accountMethods(a: { email?: string | null; github?: string | null }): Array<{ kind: "email" | "github"; label: string; value: string | null }> {
  if (a.email === undefined && a.github === undefined) return [];
  return [
    { kind: "email", label: "Email", value: a.email ?? null },
    { kind: "github", label: "GitHub", value: a.github ? `@${a.github}` : null },
  ];
}

/** Whether removing this way to sign in would leave the account with none. */
export const isLastMethod = (a: { email?: string | null; github?: string | null }, kind: "email" | "github"): boolean =>
  kind === "email" ? !a.github : !a.email;

/** Seconds as the resend button counts them down: "42 s", "1 min 5 s". */
export function waitText(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}`;
}

/** Where the ue-mcp account's endpoints live: /api/auth/*, /api/account* and /api/cli/exchange. */
export const AUTH_URL_DEFAULT = "https://accounts.ue-mcp.com";
/** The registry host, which serves the same account routes and tokens: tried once when the default cannot be reached. */
export const AUTH_URL_FALLBACK = "https://plugins.ue-mcp.com";
/** The environment variable that moves the account endpoints elsewhere. Set, it is the only host asked. */
export const AUTH_URL_ENV = "UE_MCP_AUTH_URL";

/**
 * The hosts to ask for an account call, in order, without trailing slashes:
 * the override alone when one is set, otherwise the default and then the
 * fallback, which a caller tries only after a network failure (no answer at
 * all, not an HTTP status).
 */
export function authBases(override?: string | null): string[] {
  const o = override?.trim();
  return (o ? [o] : [AUTH_URL_DEFAULT, AUTH_URL_FALLBACK]).map((u) => u.replace(/\/+$/, ""));
}
