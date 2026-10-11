/**
 * Sign in with ChatGPT: the user's ChatGPT plan pays for OpenAI model calls.
 * Studio takes OpenAI's path for open-source, locally hosted apps: the first
 * sign-in registers this install (client id dynamic_agent_client, a stable
 * host id), and later ones reuse the client id it was issued. The browser
 * approves, OpenAI redirects to a one-off listener on 127.0.0.1 with a code,
 * and the code is exchanged with PKCE (no client secret). The ID token is
 * checked against OpenAI's published keys before anything is kept.
 *
 * Tokens live in Studio's own folder under the user's home, shared by every
 * project, written with mode 600 and never returned by a route.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { StudioSignIn } from "@ue-mcp-studio/shared";

const AUTH = "https://auth.openai.com";
export const AUTHORIZE_URL = `${AUTH}/api/accounts/authorize`;
export const TOKEN_URL = `${AUTH}/api/accounts/oauth/token`;
const OPENID_CONFIG = `${AUTH}/.well-known/openid-configuration`;
export const RESOURCE = "https://api.openai.com/v1";
const SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const AGENT_NAME = "UE-MCP Studio";
const CALLBACK_PATH = "/auth/callback";
const SIGN_IN_MS = 10 * 60_000;

export const chatgptHome = (): string => process.env.STUDIO_CHATGPT_HOME || path.join(os.homedir(), ".ue-mcp", "studio", "chatgpt");

interface Saved {
  clientId: string;
  hostId: string;
  accessToken: string;
  refreshToken: string;
  /** Epoch ms. */
  expiresAt: number;
  scope: string;
  sub: string;
  email: string | null;
}

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

const PAGE = (text: string) =>
  `<!doctype html><meta charset="utf-8"><title>UE-MCP Studio</title><body style="font:15px system-ui;background:#0c0c0b;color:#ece9e3;display:grid;place-items:center;height:90vh"><p>${text}</p></body>`;

/** The ID token's claims once its signature, issuer, audience, expiry and nonce check out. */
export async function verifyIdToken(idToken: string, clientId: string, nonce: string, fetchImpl: typeof fetch): Promise<{ sub: string; email: string | null }> {
  const [h, p, s] = idToken.split(".");
  if (!h || !p || !s) throw new Error("the ID token is malformed");
  const header = JSON.parse(fromB64url(h).toString()) as { kid?: string; alg?: string };
  if (header.alg !== "RS256") throw new Error(`unexpected ID token algorithm ${header.alg}`);
  const config = (await (await fetchImpl(OPENID_CONFIG)).json()) as { jwks_uri: string; issuer: string };
  const jwks = (await (await fetchImpl(config.jwks_uri)).json()) as { keys: Array<crypto.JsonWebKey & { kid?: string }> };
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("the ID token's signing key is not among OpenAI's published keys");
  const key = crypto.createPublicKey({ key: jwk, format: "jwk" });
  if (!crypto.verify("RSA-SHA256", Buffer.from(`${h}.${p}`), key, fromB64url(s))) throw new Error("the ID token's signature does not verify");
  const claims = JSON.parse(fromB64url(p).toString()) as { iss?: string; aud?: string | string[]; exp?: number; nonce?: string; sub?: string; email?: string };
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== config.issuer) throw new Error("the ID token is from another issuer");
  if (!aud.includes(clientId)) throw new Error("the ID token is for another app");
  if (!claims.exp || claims.exp * 1000 < Date.now() - 60_000) throw new Error("the ID token has expired");
  if (claims.nonce !== nonce) throw new Error("the ID token answers another sign-in");
  if (!claims.sub) throw new Error("the ID token names no account");
  return { sub: claims.sub, email: claims.email ?? null };
}

/** The saved ChatGPT sign-in, its access token kept fresh. */
export class ChatGptAuth {
  private refreshing: Promise<string> | null = null;

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  private file(name: string): string {
    return path.join(chatgptHome(), name);
  }

  load(): Saved | null {
    try {
      return JSON.parse(fs.readFileSync(this.file("session.json"), "utf-8")) as Saved;
    } catch {
      return null;
    }
  }

  save(s: Saved): void {
    fs.mkdirSync(chatgptHome(), { recursive: true });
    const target = this.file("session.json");
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
    fs.renameSync(tmp, target);
  }

  /** This install's host id: made once, kept, and opaque. */
  hostId(): string {
    const f = this.file("host-id");
    try {
      const v = fs.readFileSync(f, "utf-8").trim();
      if (v) return v;
    } catch {
      // Made below.
    }
    fs.mkdirSync(chatgptHome(), { recursive: true });
    const id = `urn:uuid:${crypto.randomUUID()}`;
    fs.writeFileSync(f, id, { mode: 0o600 });
    return id;
  }

  /** The client id this install was issued, kept past a sign-out so the next sign-in reuses it. */
  clientId(): string | null {
    try {
      return fs.readFileSync(this.file("client-id"), "utf-8").trim() || null;
    } catch {
      return null;
    }
  }

  saveClientId(id: string): void {
    fs.mkdirSync(chatgptHome(), { recursive: true });
    fs.writeFileSync(this.file("client-id"), id, { mode: 0o600 });
  }

  signedIn(): { email: string | null } | null {
    const s = this.load();
    return s ? { email: s.email } : null;
  }

  /** A current access token, refreshed when it is about to expire. Refreshes never overlap: the refresh token rotates. */
  async accessToken(): Promise<string> {
    const s = this.load();
    if (!s) throw new Error("Sign in with ChatGPT to run this model: open the model picker.");
    if (s.expiresAt - Date.now() > 60_000) return s.accessToken;
    this.refreshing ??= this.refresh(s).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async refresh(s: Saved): Promise<string> {
    const res = await this.fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: s.clientId, refresh_token: s.refreshToken, resource: RESOURCE }).toString(),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string };
    if (!res.ok || !body.access_token) {
      if (body.error === "invalid_grant") this.clear();
      throw new Error(`ChatGPT sign-in expired (${body.error ?? res.status}). Sign in again from the model picker.`);
    }
    this.save({
      ...s,
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? s.refreshToken,
      expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
      scope: body.scope ?? s.scope,
    });
    return body.access_token;
  }

  clear(): void {
    fs.rmSync(this.file("session.json"), { force: true });
  }

  /** Revoke the refresh token at OpenAI, then forget the sign-in. Clears it even when OpenAI cannot be reached. */
  async signOut(): Promise<{ revoked: boolean }> {
    const s = this.load();
    let revoked = false;
    if (s) {
      try {
        const config = (await (await this.fetchImpl(OPENID_CONFIG)).json()) as { revocation_endpoint?: string };
        if (config.revocation_endpoint) {
          const res = await this.fetchImpl(config.revocation_endpoint, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ token: s.refreshToken, token_type_hint: "refresh_token", client_id: s.clientId }).toString(),
          });
          revoked = res.ok;
        }
      } catch {
        // Not confirmed; the local sign-in is cleared regardless.
      }
    }
    this.clear();
    return { revoked };
  }
}

/** One sign-in at a time: the loopback listener, the PKCE values, and the exchange when the browser returns. */
export class ChatGptSignInFlow {
  private state: StudioSignIn = { state: "idle" };
  private server: http.Server | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly auth: ChatGptAuth,
    private readonly onDone: () => void,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  view(): StudioSignIn {
    if (this.state.state !== "pending") {
      const s = this.auth.signedIn();
      if (s) return { state: "done", login: s.email ?? "ChatGPT" };
    }
    return this.state;
  }

  async start(): Promise<StudioSignIn> {
    this.cancel();
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
    const stateParam = b64url(crypto.randomBytes(16));
    const nonce = b64url(crypto.randomBytes(16));
    const known = this.auth.clientId();
    const server = http.createServer((req, res) => void this.callback(req, res, server, { verifier, stateParam, nonce, known }));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const port = (server.address() as { port: number }).port;
    const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
    const q = new URLSearchParams({
      client_id: known ?? "dynamic_agent_client",
      ...(known ? {} : { agent_name_hint: AGENT_NAME }),
      ext_agent_host_id: this.auth.hostId(),
      response_type: "code",
      redirect_uri: redirectUri,
      scope: SCOPE,
      resource: RESOURCE,
      state: stateParam,
      nonce,
      code_challenge_method: "S256",
      code_challenge: challenge,
    });
    const email = this.auth.load()?.email;
    if (email) q.set("login_hint", email);
    this.timer = setTimeout(() => {
      this.stop();
      if (this.state.state === "pending") this.state = { state: "error", error: "The sign-in was not finished in time. Start again." };
    }, SIGN_IN_MS);
    this.timer.unref();
    this.state = { state: "pending", url: `${AUTHORIZE_URL}?${q.toString()}`, expiresAt: new Date(Date.now() + SIGN_IN_MS).toISOString() };
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

  private async callback(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    server: http.Server,
    p: { verifier: string; stateParam: string; nonce: string; known: string | null },
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== CALLBACK_PATH || server !== this.server) {
      res.writeHead(404).end();
      return;
    }
    const fail = (error: string) => {
      this.state = { state: "error", error };
      res.writeHead(400, { "content-type": "text/html" }).end(PAGE("The sign-in did not complete. Return to Unreal and try again."));
      this.stop();
    };
    if (url.searchParams.get("state") !== p.stateParam) return fail("The sign-in answered another request. Start again.");
    if (url.searchParams.get("error")) return fail(url.searchParams.get("error") === "access_denied" ? "The sign-in was declined." : `ChatGPT: ${url.searchParams.get("error")}`);
    const code = url.searchParams.get("code");
    const issued = url.searchParams.get("client_id");
    const clientId = p.known ?? issued;
    if (!code || !clientId) return fail("ChatGPT returned no code. Start again.");
    if (p.known && issued && issued !== p.known) return fail("ChatGPT answered for another app. Start again.");
    try {
      const redirectUri = `http://127.0.0.1:${(server.address() as { port: number }).port}${CALLBACK_PATH}`;
      const r = await this.fetchImpl(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: p.verifier, redirect_uri: redirectUri, resource: RESOURCE }).toString(),
      });
      const t = (await r.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; id_token?: string; expires_in?: number; scope?: string; error?: string };
      if (!r.ok || !t.access_token || !t.refresh_token || !t.id_token) throw new Error(t.error === "invalid_grant" ? "The code expired. Start again." : `ChatGPT refused the sign-in (${t.error ?? r.status}).`);
      const who = await verifyIdToken(t.id_token, clientId, p.nonce, this.fetchImpl);
      const scope = t.scope ?? "";
      if (!scope.split(" ").includes(PLAN_SCOPE)) throw new Error("The sign-in did not grant use of your ChatGPT plan, so it cannot run models. Approve plan usage when you sign in.");
      if (!p.known) this.auth.saveClientId(clientId);
      this.auth.save({
        clientId,
        hostId: this.auth.hostId(),
        accessToken: t.access_token,
        refreshToken: t.refresh_token,
        expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000,
        scope,
        sub: who.sub,
        email: who.email,
      });
      this.state = { state: "done", login: who.email ?? "ChatGPT" };
      res.writeHead(200, { "content-type": "text/html" }).end(PAGE("Signed in with ChatGPT. Return to Unreal."));
      this.stop();
      this.onDone();
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
  }
}

/** The OpenAI models this ChatGPT account may use, in the server's order. */
export async function chatgptModels(token: string, fetchImpl: typeof fetch = fetch): Promise<Array<{ id: string; name: string }>> {
  const res = await fetchImpl(`${RESOURCE}/models`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`ChatGPT models: ${res.status}`);
  const body = (await res.json()) as { models?: Array<{ slug: string; display_name?: string; visibility?: string }> };
  return (body.models ?? []).filter((m) => m.visibility === "list").map((m) => ({ id: m.slug, name: m.display_name ?? m.slug }));
}
