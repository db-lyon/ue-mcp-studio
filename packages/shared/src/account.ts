/**
 * Accounts, plans, entitlements and usage, shared by the gateway, billing and
 * the UI. The account is the ue-mcp registry identity: the user id the registry
 * resolves a `uemcp_` token to.
 */

export type PlanId = "free" | "pro" | "studio";

export interface Plan {
  id: PlanId;
  name: string;
  /** Tokens (input + output + cache writes; cache reads at their weight) per billing period. */
  monthlyTokenQuota: number;
  /** Token-based rate limit over a sliding minute. */
  tokensPerMinute: number;
  /** Models this plan may run. The first is the default. */
  models: string[];
}

export type EntitlementStatus = "active" | "past_due" | "canceled" | "none";

export interface Entitlement {
  userId: string;
  plan: PlanId;
  status: EntitlementStatus;
  /** ISO timestamps bounding the current billing period. */
  periodStart: string;
  periodEnd: string;
  provider: string | null;
  subscriptionId: string | null;
  customerId: string | null;
  updatedAt: string;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export interface UsageRecord extends UsageTotals {
  userId: string;
  sessionId: string;
  model: string;
  at: string;
}

/** GET /v1/account/usage on the gateway. */
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

/**
 * GET /v1/ext/studio/account on the daemon: the agent's view of the account,
 * proxied from the gateway with the registry token the agent holds. The UI
 * never sees the token.
 */
export type StudioAccountResponse =
  | { signedIn: false; reason: string }
  | { signedIn: true; usage: AccountUsage; manageUrl: string | null };

/** Header carrying the agent's session id on every gateway request. */
export const GATEWAY_SESSION_HEADER = "x-ue-mcp-session";
/** Header naming the client; the gateway serves only the Studio agent. */
export const GATEWAY_CLIENT_HEADER = "x-ue-mcp-client";
export const GATEWAY_CLIENT_PREFIX = "studio-agent/";
/**
 * The tool every agent request declares: the agent's single entry into
 * ue-mcp. A request without it is not the agent's and is refused.
 */
export const STUDIO_AGENT_TOOL = "ue_mcp";

/** Weight of a cache read against the quota, relative to an uncached input token. */
export const CACHE_READ_WEIGHT = 0.1;

export function billableTokens(u: UsageTotals): number {
  return Math.ceil(u.inputTokens + u.outputTokens + u.cacheCreationInputTokens + u.cacheReadInputTokens * CACHE_READ_WEIGHT);
}

export function emptyUsage(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
}

/**
 * Persistence the gateway and billing share. Implementations: in memory for
 * tests, SQLite for the deployed gateway.
 */
export interface AccountStore {
  getEntitlement(userId: string): Promise<Entitlement | null>;
  putEntitlement(e: Entitlement): Promise<void>;
  /** The account a billing customer belongs to, recorded when a checkout links them. */
  userForCustomer(provider: string, customerId: string): Promise<string | null>;
  linkCustomer(provider: string, customerId: string, userId: string): Promise<void>;
  addUsage(r: UsageRecord): Promise<void>;
  usageSince(userId: string, since: string): Promise<UsageTotals>;
  /** True the first time an event id is seen, false for a redelivery. */
  markEventProcessed(provider: string, eventId: string): Promise<boolean>;
}
