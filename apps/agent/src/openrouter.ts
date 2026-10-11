/**
 * OpenRouter: a sign-in that runs most vendors' models on the user's own
 * OpenRouter account, with no key to copy. Sign-in is OAuth with PKCE: the
 * browser approves, OpenRouter redirects to a one-off listener on this machine
 * with a code, and the code is exchanged for a key issued to this app.
 */
import * as crypto from "node:crypto";
import * as http from "node:http";
import type { KeyProviderId, StudioSignIn } from "@ue-mcp-studio/shared";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** Model ids compare without case and with dots as dashes: claude-opus-5.5 is claude-opus-5-5. */
const norm = (id: string) => id.toLowerCase().replace(/\./g, "-");

interface Listed {
  id: string;
  name?: string;
  created?: number;
}

/** OpenRouter's public model list: which vendors' models it runs, under which ids, newest first. */
export class OpenRouterModels {
  private ids = new Map<string, string>();
  private list: Listed[] = [];
  private loadedAt = 0;

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async refresh(): Promise<void> {
    if (Date.now() - this.loadedAt < 60 * 60_000) return;
    const res = await this.fetchImpl(`${OPENROUTER_BASE_URL}/models`);
    if (!res.ok) return;
    const body = (await res.json()) as { data?: Listed[] };
    const ids = new Map<string, string>();
    for (const m of body.data ?? []) ids.set(norm(m.id), m.id);
    this.ids = ids;
    this.list = (body.data ?? []).filter((m) => !m.id.includes(":")).sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
    this.loadedAt = Date.now();
  }

  /**
   * A vendor's models as OpenRouter lists them, newest first, under the
   * vendor's own ids (Anthropic writes claude-opus-5-5 where OpenRouter writes
   * claude-opus-5.5) and without the "Vendor: " prefix on names.
   */
  modelsOf(vendor: KeyProviderId): Array<{ id: string; name?: string }> {
    return this.list
      .filter((m) => m.id.startsWith(`${vendor}/`))
      .map((m) => {
        const id = m.id.slice(vendor.length + 1);
        return { id: vendor === "anthropic" ? id.replace(/\./g, "-") : id, name: m.name?.replace(/^[^:]+:\s*/, "") };
      });
  }

  /** The OpenRouter id for a vendor's model, or null when OpenRouter does not run it. */
  idFor(vendor: KeyProviderId, model: string): string | null {
    return this.ids.get(norm(`${vendor}/${model}`)) ?? null;
  }
}

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const PAGE = (text: string) =>
  `<!doctype html><meta charset="utf-8"><title>UE-MCP Studio</title><body style="font:15px system-ui;background:#0c0c0b;color:#ece9e3;display:grid;place-items:center;height:90vh"><p>${text}</p></body>`;

export class OpenRouterSignInFlow {
  private state: StudioSignIn = { state: "idle" };
  private server: http.Server | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly save: (key: string) => void,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  view(): StudioSignIn {
    return this.state;
  }

  /** Listen for the redirect on a free local port and return the page to approve on. */
  async start(): Promise<StudioSignIn> {
    this.cancel();
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
    const server = http.createServer((req, res) => void this.callback(req, res, server, verifier));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const port = (server.address() as { port: number }).port;
    const callback = `http://localhost:${port}/callback`;
    const url = `https://openrouter.ai/auth?callback_url=${encodeURIComponent(callback)}&code_challenge=${challenge}&code_challenge_method=S256`;
    const expiresAt = Date.now() + 10 * 60_000;
    this.timer = setTimeout(() => {
      this.stop();
      if (this.state.state === "pending") this.state = { state: "error", error: "The sign-in was not finished in time. Start again." };
    }, expiresAt - Date.now());
    this.timer.unref();
    this.state = { state: "pending", url, expiresAt: new Date(expiresAt).toISOString() };
    return this.state;
  }

  cancel(): void {
    this.stop();
    this.state = { state: "idle" };
  }

  private stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.server?.close();
    this.server = null;
  }

  private async callback(req: http.IncomingMessage, res: http.ServerResponse, server: http.Server, verifier: string): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const code = url.pathname === "/callback" ? url.searchParams.get("code") : null;
    if (!code || server !== this.server) {
      res.writeHead(404).end();
      return;
    }
    try {
      const r = await this.fetchImpl(`${OPENROUTER_BASE_URL}/auth/keys`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
      });
      const body = (await r.json().catch(() => ({}))) as { key?: string; error?: { message?: string } };
      if (!r.ok || !body.key) throw new Error(body.error?.message ?? `OpenRouter answered ${r.status}`);
      this.save(body.key);
      this.state = { state: "done", login: "OpenRouter" };
      res.writeHead(200, { "content-type": "text/html" }).end(PAGE("Signed in to OpenRouter. Return to Unreal."));
    } catch (e) {
      this.state = { state: "error", error: e instanceof Error ? e.message : String(e) };
      res.writeHead(500, { "content-type": "text/html" }).end(PAGE("The sign-in did not complete. Return to Unreal and try again."));
    } finally {
      this.stop();
    }
  }
}
