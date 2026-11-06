/**
 * Calls to the ue-mcp account's host (packages/shared authBases): the
 * override from UE_MCP_AUTH_URL alone, or the default host and, when it
 * cannot be reached at all, the registry host once, which serves the same
 * routes and tokens. An HTTP answer of any status is the answer.
 */
import { AUTH_URL_ENV, authBases } from "@ue-mcp-studio/shared";

/** The account hosts to try now, from the environment. */
export const authBasesNow = (): string[] => authBases(process.env[AUTH_URL_ENV]);

/** `init` is built per attempt, so a timed-out first try does not abort the retry. */
export async function authFetch(f: typeof fetch, path: string, init: () => RequestInit, bases: string[] = authBasesNow()): Promise<Response> {
  let failure: unknown = new Error("No UE-MCP account host is configured.");
  for (const base of bases) {
    try {
      return await f(`${base}${path}`, init());
    } catch (e) {
      failure = e;
    }
  }
  throw failure;
}
