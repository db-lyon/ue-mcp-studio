/**
 * TURN relay servers for the live viewport, asked of the gateway with the
 * account's token. The video goes peer to peer; across networks (mobile data,
 * carrier-grade NAT) only a relay gets it through, and relaying is what the
 * Pro plan pays for, so the gateway mints short-lived credentials for Pro
 * accounts only:
 *
 *   POST /v1/viewport/turn   ->  { iceServers, ttlSeconds }
 *
 * Kept until half their lifetime has passed. Anything else (signed out, no
 * Pro, the gateway without a TURN provider, the gateway down) is no servers:
 * the viewer then connects directly, and says so if that fails.
 */
import { iceServersOf, type IceServer } from "@ue-mcp-studio/shared";

export type TurnFetch = (url: string, init: { method: string; headers: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;

/** A failed ask is not repeated for this long, so every join does not wait on a gateway that has none. */
const RETRY_AFTER_MS = 60_000;
const ASK_TIMEOUT_MS = 6_000;

export class TurnCredentials {
  private cached: { servers: IceServer[]; until: number } | null = null;
  private pending: Promise<IceServer[]> | null = null;

  constructor(
    private readonly o: {
      token: () => Promise<string | null>;
      gatewayUrl: () => string;
      fetch?: TurnFetch;
      now?: () => number;
      log?: (message: string) => void;
    },
  ) {}

  /** The relay servers to offer a viewer, or none. Never throws. */
  async get(): Promise<IceServer[]> {
    if (this.cached && this.now() < this.cached.until) return this.cached.servers;
    this.pending ??= this.ask()
      .then(
        (r) => {
          this.cached = r;
          return r.servers;
        },
        () => [] as IceServer[],
      )
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }

  /** The servers last handed out while still valid, without asking: for the streamer's config. */
  known(): IceServer[] {
    return this.cached && this.now() < this.cached.until ? this.cached.servers : [];
  }

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  private async ask(): Promise<{ servers: IceServer[]; until: number }> {
    const none = { servers: [], until: this.now() + RETRY_AFTER_MS };
    let token: string | null;
    try {
      token = await this.o.token();
    } catch {
      token = null;
    }
    if (!token) return none;
    try {
      const f = this.o.fetch ?? (fetch as TurnFetch);
      const res = await f(`${this.o.gatewayUrl().replace(/\/+$/, "")}/v1/viewport/turn`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: unknown };
        this.o.log?.(`viewport: no TURN relay (${res.status}${typeof body.error === "string" ? `: ${body.error}` : ""}); viewers connect directly`);
        return none;
      }
      const body = (await res.json()) as { iceServers?: unknown; ttlSeconds?: unknown };
      const servers = iceServersOf(body.iceServers).filter((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]).some((u) => /^turns?:/i.test(u)));
      const ttl = typeof body.ttlSeconds === "number" && body.ttlSeconds > 0 ? body.ttlSeconds : 600;
      return servers.length ? { servers, until: this.now() + (ttl * 1000) / 2 } : none;
    } catch (e) {
      this.o.log?.(`viewport: could not ask the gateway for a TURN relay: ${e instanceof Error ? e.message : String(e)}`);
      return none;
    }
  }
}
