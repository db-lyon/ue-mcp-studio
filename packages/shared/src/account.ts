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
