/** The account service's plan and usage for a `uemcp_` token, read by the plan sign-in and by remote control. */

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;

/** GET /v1/account/usage on the gateway with the account token. */
export function fetchAccountUsage(gatewayUrl: string, token: string, f: FetchLike = fetch, signal?: AbortSignal): Promise<Response> {
  return f(`${gatewayUrl.replace(/\/+$/, "")}/v1/account/usage`, { headers: { authorization: `Bearer ${token}` }, signal });
}
