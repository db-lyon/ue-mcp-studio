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
 * Whether Studio offers the Pro plan. Off: no Pro checkout or Pro wording is
 * shown, and remote control is sold as the Remote plan alone. A Pro account
 * still gets remote control either way.
 */
export const PRO_PLAN_OFFERED = false;

/** The plans remote control needs, as Studio names them. */
export const REMOTE_PLANS = PRO_PLAN_OFFERED ? "the Remote or Pro plan" : "the Remote plan";

/** What the Remote plan costs, as the gateway sells it. Tax is added at checkout. */
export const REMOTE_PRICE = "$5 a month or $50 a year, before tax";

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
