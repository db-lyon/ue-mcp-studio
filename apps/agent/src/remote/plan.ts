/**
 * Whether the signed-in ue-mcp account has a paid plan, as the gateway says.
 * Remote control works on that answer alone; REMOTE_PLAN_OFFERED only decides
 * whether the UI tells a signed-out or free account about it.
 * Cached for a few minutes; no token, an error or a free plan reads as no.
 */
import { hasPaidPlan, type AccountUsage } from "@ue-mcp-studio/shared";
import { fetchAccountUsage, type FetchLike } from "../account-usage.js";

export const PLAN_CHECK_TTL_MS = 3 * 60_000;
const ASK_TIMEOUT_MS = 10_000;

export interface PlanCheck {
  /** The cached answer while fresh, else the gateway's. `force` always asks. */
  available(force?: boolean): Promise<boolean>;
  /** Forget the cached answer, so the next read asks. */
  invalidate(): void;
}

export interface PlanCheckOptions {
  token: () => Promise<string | null>;
  gatewayUrl: () => string;
  fetch?: FetchLike;
  now?: () => number;
  ttlMs?: number;
}

export class RemotePlanCheck implements PlanCheck {
  private cached: { value: boolean; at: number } | null = null;
  private pending: Promise<boolean> | null = null;

  constructor(private readonly o: PlanCheckOptions) {}

  async available(force = false): Promise<boolean> {
    const now = this.now();
    if (!force && this.cached && now - this.cached.at < (this.o.ttlMs ?? PLAN_CHECK_TTL_MS)) return this.cached.value;
    this.pending ??= this.ask()
      .then((value) => {
        this.cached = { value, at: this.now() };
        return value;
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }

  invalidate(): void {
    this.cached = null;
  }

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  private async ask(): Promise<boolean> {
    try {
      const token = await this.o.token();
      if (!token) return false;
      const res = await fetchAccountUsage(this.o.gatewayUrl(), token, this.o.fetch, AbortSignal.timeout(ASK_TIMEOUT_MS));
      if (!res.ok) return false;
      return hasPaidPlan((await res.json()) as AccountUsage, new Date(this.now()));
    } catch {
      return false;
    }
  }
}
