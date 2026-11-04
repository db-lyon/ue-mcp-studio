/**
 * Buying and managing a plan: POST /billing/checkout and GET /billing/portal
 * pass the gateway's hosted checkout and customer portal links on to the UI.
 * The agent sends the account token (./account-source.ts); the UI never sees
 * it, and opens the links in the system browser.
 */
import type { DaemonExtensionApi } from "ue-mcp/daemon";
import { BILLING_INTERVALS, BILLING_PLANS, ACCOUNT_SIGNED_OUT, type BillingCheckoutRequest, type BillingError, type BillingLink, type BillingRefusal } from "@ue-mcp-studio/shared";
import type { AccountSource } from "./account-source.js";

export type BillingFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<Response>;

export interface BillingOptions {
  account: AccountSource;
  gatewayUrl: () => string;
  fetch?: BillingFetch;
}

const TIMEOUT_MS = 15_000;

type Reply = { status?: number; body: BillingLink | BillingError };

const refused = (status: number, error: string, code?: BillingRefusal): Reply => ({ status, body: code ? { error, code } : { error } });

/** What a gateway answer means to the UI: the link, or the refusal in Studio's words. */
export async function billingReply(res: Response, kind: "checkout" | "portal"): Promise<Reply> {
  const body = (await res.json().catch(() => ({}))) as { url?: unknown; provider?: unknown; error?: unknown };
  if (res.ok) {
    if (typeof body.url !== "string" || !/^https:\/\//.test(body.url)) return refused(502, "The account service sent no payment page.");
    return { body: { url: body.url, ...(typeof body.provider === "string" ? { provider: body.provider } : {}) } };
  }
  if (res.status === 401) return refused(401, ACCOUNT_SIGNED_OUT, "signed-out");
  if (kind === "checkout" && res.status === 409) return refused(409, "This account already has a subscription.", "subscribed");
  if (kind === "portal" && res.status === 404) return refused(404, "This account has no subscription to manage.", "no-subscription");
  if (res.status === 503) return refused(503, kind === "checkout" ? "Plans cannot be bought yet." : "Billing is not available yet.", "unavailable");
  return refused(502, typeof body.error === "string" ? body.error : `The account service answered HTTP ${res.status}.`);
}

export function registerBilling(api: Pick<DaemonExtensionApi, "route">, o: BillingOptions): void {
  const f: BillingFetch = o.fetch ?? ((url, init) => fetch(url, init));
  const at = (p: string) => `${o.gatewayUrl().replace(/\/+$/, "")}${p}`;

  const ask = async (kind: "checkout" | "portal", init: { method: string; body?: string }): Promise<Reply> => {
    const token = await o.account.token();
    if (!token) return refused(401, ACCOUNT_SIGNED_OUT, "signed-out");
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: "application/json" };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    const res = await f(at(`/v1/billing/${kind}`), { ...init, headers, signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => null);
    if (!res) return refused(502, "Could not reach the account service.");
    return billingReply(res, kind);
  };

  api.route("POST", "/billing/checkout", async (req) => {
    const b = (req.body ?? {}) as Partial<BillingCheckoutRequest>;
    if (!BILLING_PLANS.includes(b.plan as never)) return refused(400, `plan must be one of ${BILLING_PLANS.join(", ")}`);
    const interval = b.interval ?? "month";
    if (!BILLING_INTERVALS.includes(interval)) return refused(400, `interval must be one of ${BILLING_INTERVALS.join(", ")}`);
    return ask("checkout", { method: "POST", body: JSON.stringify({ plan: b.plan, interval }) });
  });
  api.route("GET", "/billing/portal", () => ask("portal", { method: "GET" }));
}
