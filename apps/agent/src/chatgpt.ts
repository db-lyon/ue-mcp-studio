/**
 * Sign in with ChatGPT: the user's ChatGPT plan pays for OpenAI model calls.
 * The flow is pi-ai's (pi-auth.ts): OpenAI's path for open-source, locally
 * hosted apps, where each sign-in registers this install (client id
 * dynamic_agent_client, a stable host id), the browser approves, OpenAI
 * redirects to a listener on 127.0.0.1:1455 with a code, and the code is
 * exchanged with PKCE (no client secret).
 *
 * The credential lives in pi-ai's credential store shape, in Studio's own
 * folder under the user's home: shared by every project, written with mode
 * 600, never returned by a route. Writes take a lock file, so daemons of two
 * projects never refresh the same rotating refresh token at once. A sign-in
 * an earlier Studio saved (session.json) moves into it on first read.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { StudioSignIn } from "@ue-mcp-studio/shared";
import { rememberWindow } from "./context-windows.js";
import { writeFileAtomic } from "./atomic-write.js";
import { CHATGPT_PROVIDER, chatgptOAuth, type AuthInteraction, type ChatGptOAuth, type Credential, type CredentialStore } from "./pi-auth.js";

const AUTH = "https://auth.openai.com";
export const TOKEN_URL = `${AUTH}/api/accounts/oauth/token`;
const OPENID_CONFIG = `${AUTH}/.well-known/openid-configuration`;
export const RESOURCE = "https://api.openai.com/v1";
const AGENT_NAME = "UE-MCP Studio";
const SIGN_IN_MS = 10 * 60_000;
/** The loopback port pi-ai's ChatGPT sign-in listens on (the one OpenAI redirects to). */
export const CALLBACK_PORT = 1455;
/** A lock older than this is from a process that died holding it. */
const STALE_LOCK_MS = 30_000;

export const chatgptHome = (): string => process.env.STUDIO_CHATGPT_HOME || path.join(os.homedir(), ".ue-mcp", "studio", "chatgpt");

/** The ChatGPT credential as stored: pi-ai's OAuth credential, with the account's email kept for display. */
export interface ChatGptCredential {
  type: "oauth";
  access: string;
  refresh: string;
  /** Epoch ms. */
  expires: number;
  clientId: string;
  scopes?: string[];
  email?: string | null;
  sub?: string;
  [key: string]: unknown;
}

/** What an earlier Studio saved. */
interface LegacySession {
  clientId: string;
  hostId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
  sub: string;
  email: string | null;
}

const fromB64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/** The email in an OpenAI access token's profile claim, for display only: the token came straight from OpenAI's token endpoint. */
export function emailOf(accessToken: string): string | null {
  try {
    const claims = JSON.parse(fromB64url(accessToken.split(".")[1] ?? "").toString()) as Record<string, unknown>;
    const profile = claims["https://api.openai.com/profile"] as { email?: unknown } | undefined;
    const email = profile?.email ?? claims.email;
    return typeof email === "string" && email ? email : null;
  } catch {
    return null;
  }
}

/**
 * pi-ai's credential store on a JSON file: one credential per provider id.
 * Reads are of the file as it is; every write is a read-modify-write under a
 * lock file shared by every Studio process on the machine.
 */
export class FileCredentialStore implements CredentialStore {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly dir: () => string = chatgptHome) {}

  private get file(): string {
    return path.join(this.dir(), "credentials.json");
  }

  /** Every stored credential, after moving a sign-in an earlier Studio saved. */
  all(): Record<string, Credential> {
    this.migrate();
    try {
      const v = JSON.parse(fs.readFileSync(this.file, "utf-8")) as unknown;
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, Credential>) : {};
    } catch {
      return {};
    }
  }

  peek(providerId: string): Credential | undefined {
    return this.all()[providerId];
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return this.peek(providerId);
  }

  async list(): Promise<Array<{ providerId: string; type: Credential["type"] }>> {
    return Object.entries(this.all()).map(([providerId, c]) => ({ providerId, type: c.type }));
  }

  async modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: { signal?: AbortSignal }): Promise<Credential | undefined> {
    return this.serial(async () => {
      await this.lock(options?.signal);
      try {
        const all = this.all();
        const current = all[providerId];
        const next = await fn(current);
        if (next === undefined) return current;
        // A refresh answers with tokens only: the account it is for stays the same.
        const kept = current?.type === "oauth" && next.type === "oauth"
          ? { ...(current.email !== undefined ? { email: current.email } : {}), ...(current.sub !== undefined ? { sub: current.sub } : {}) }
          : {};
        all[providerId] = { ...kept, ...next } as Credential;
        this.write(all);
        return all[providerId];
      } finally {
        this.unlock();
      }
    });
  }

  async delete(providerId: string): Promise<void> {
    await this.serial(async () => {
      await this.lock();
      try {
        const all = this.all();
        if (!(providerId in all)) return;
        delete all[providerId];
        this.write(all);
      } finally {
        this.unlock();
      }
    });
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work, work);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private write(all: Record<string, Credential>): void {
    fs.mkdirSync(this.dir(), { recursive: true });
    writeFileAtomic(this.file, JSON.stringify(all), { mode: 0o600 });
  }

  private get lockDir(): string {
    return path.join(this.dir(), "credentials.lock");
  }

  private async lock(signal?: AbortSignal): Promise<void> {
    fs.mkdirSync(this.dir(), { recursive: true });
    for (;;) {
      signal?.throwIfAborted();
      try {
        fs.mkdirSync(this.lockDir);
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        try {
          if (Date.now() - fs.statSync(this.lockDir).mtimeMs > STALE_LOCK_MS) fs.rmSync(this.lockDir, { recursive: true, force: true });
        } catch {
          // Released meanwhile.
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }

  private unlock(): void {
    fs.rmSync(this.lockDir, { recursive: true, force: true });
  }

  /**
   * A sign-in an earlier Studio saved moves in once: its tokens, client id and
   * email. session.json is renamed, not deleted, so it is never read twice.
   */
  private migrate(): void {
    const old = path.join(this.dir(), "session.json");
    if (!fs.existsSync(old)) return;
    try {
      const s = JSON.parse(fs.readFileSync(old, "utf-8")) as LegacySession;
      let all: Record<string, Credential> = {};
      try {
        all = JSON.parse(fs.readFileSync(this.file, "utf-8")) as Record<string, Credential>;
      } catch {
        // No store yet.
      }
      if (!all[CHATGPT_PROVIDER] && s.accessToken && s.refreshToken && s.clientId) {
        all[CHATGPT_PROVIDER] = {
          type: "oauth",
          access: s.accessToken,
          refresh: s.refreshToken,
          expires: s.expiresAt,
          clientId: s.clientId,
          scopes: (s.scope ?? "").split(/\s+/).filter(Boolean),
          email: s.email ?? null,
          ...(s.sub ? { sub: s.sub } : {}),
        } as Credential;
        this.write(all);
      }
      fs.renameSync(old, path.join(this.dir(), "session.json.migrated"));
    } catch {
      // Unreadable: it stays, and the user signs in again.
    }
  }
}

/** The saved ChatGPT sign-in, its access token kept fresh by pi-ai. */
export class ChatGptAuth {
  readonly store: FileCredentialStore;
  readonly oauth: ChatGptOAuth;

  constructor(private readonly fetchImpl: typeof fetch = fetch, oauth?: ChatGptOAuth) {
    this.store = new FileCredentialStore();
    this.oauth = oauth ?? chatgptOAuth(this.store);
  }

  private file(name: string): string {
    return path.join(chatgptHome(), name);
  }

  load(): ChatGptCredential | null {
    const c = this.store.peek(CHATGPT_PROVIDER);
    return c?.type === "oauth" ? (c as ChatGptCredential) : null;
  }

  /** This install's host id, `urn:uuid:<uuid>`: made once, kept, and opaque. */
  hostId(): string {
    const f = this.file("host-id");
    try {
      const v = fs.readFileSync(f, "utf-8").trim();
      if (/^urn:uuid:[0-9a-f-]{36}$/i.test(v)) return v;
    } catch {
      // Made below.
    }
    fs.mkdirSync(chatgptHome(), { recursive: true });
    const id = `urn:uuid:${crypto.randomUUID()}`;
    fs.writeFileSync(f, id, { mode: 0o600 });
    return id;
  }

  /** The host id's UUID, which pi-ai's sign-in sends as the agent host. */
  deviceId(): string {
    return this.hostId().slice("urn:uuid:".length);
  }

  /** The client id the current sign-in was issued. */
  clientId(): string | null {
    return this.load()?.clientId ?? null;
  }

  signedIn(): { email: string | null } | null {
    const s = this.load();
    return s ? { email: s.email ?? null } : null;
  }

  /** A current access token, refreshed when it is about to expire. Refreshes never overlap, across processes too: the refresh token rotates. */
  async accessToken(): Promise<string> {
    let token: string | undefined;
    try {
      token = await this.oauth.accessToken();
    } catch (e) {
      const why = [e, (e as { cause?: unknown })?.cause].map((x) => (x instanceof Error ? x.message : "")).join(" ");
      // A refresh token OpenAI no longer accepts cannot recover: forget it, so Studio shows the sign-in again.
      if (/invalid_grant|refresh_token_(expired|reused|invalidated)/.test(why)) await this.store.delete(CHATGPT_PROVIDER);
      throw new Error(`ChatGPT sign-in expired (${why.trim() || "refresh failed"}). Sign in again from the model picker.`);
    }
    if (!token) throw new Error("Sign in with ChatGPT to run this model: open the model picker.");
    return token;
  }

  clear(): Promise<void> {
    return this.store.delete(CHATGPT_PROVIDER);
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
            body: new URLSearchParams({ token: s.refresh, token_type_hint: "refresh_token", client_id: s.clientId }).toString(),
          });
          revoked = res.ok;
        }
      } catch {
        // Not confirmed; the local sign-in is cleared regardless.
      }
    }
    await this.clear();
    return { revoked };
  }
}

/** pi-ai's errors in Studio's words. */
function signInError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/Port \d+ is in use/.test(m)) return `Another sign-in is using port ${CALLBACK_PORT}: an unfinished Codex CLI login, or a ChatGPT sign-in in another Studio. Finish or cancel it, then start again.`;
  if (/access_denied/.test(m)) return "The sign-in was declined.";
  if (/chatgpt\.tokens\.use\.direct/.test(m)) return "The sign-in did not grant use of your ChatGPT plan, so it cannot run models. Approve plan usage when you sign in.";
  if (/state mismatch/i.test(m)) return "The sign-in answered another request. Start again.";
  if (/invalid_grant/.test(m)) return "The code expired. Start again.";
  return `ChatGPT refused the sign-in: ${m}`;
}

/** One sign-in at a time: pi-ai's flow, its browser address shown while it waits, and the account kept when it ends. */
export class ChatGptSignInFlow {
  private state: StudioSignIn = { state: "idle" };
  private abort: AbortController | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(
    private readonly auth: ChatGptAuth,
    private readonly onDone: () => void,
  ) {}

  view(): StudioSignIn {
    if (this.state.state !== "pending") {
      const s = this.auth.signedIn();
      if (s) return { state: "done", login: s.email ?? "ChatGPT" };
    }
    return this.state;
  }

  /** Starts the sign-in and answers once the browser address is known, or with why it could not start. */
  async start(): Promise<StudioSignIn> {
    await this.stop();
    const abort = new AbortController();
    this.abort = abort;
    let shown!: (url: string) => void;
    const url = new Promise<string>((resolve) => (shown = resolve));
    const interaction: AuthInteraction = {
      signal: abort.signal,
      notify: (e) => {
        if (e.type === "auth_url") shown(e.url);
      },
      // Studio's clients have no field for a pasted address: the loopback listener is the only way back.
      prompt: (p) => new Promise<string>((_, reject) => {
        const signals = [p.signal, abort.signal].filter((s): s is AbortSignal => !!s);
        for (const s of signals) s.addEventListener("abort", () => reject(new Error("Login cancelled")), { once: true });
      }),
    };
    const login = this.auth.oauth.login(interaction, { deviceId: this.auth.deviceId(), agentName: AGENT_NAME });
    const mine = () => this.abort === abort;
    this.running = login.then(
      async (c) => {
        if (!mine()) return;
        const email = emailOf(String((c as { access?: unknown }).access ?? ""));
        await this.auth.store.modify(CHATGPT_PROVIDER, async (cur) => (cur?.type === "oauth" ? ({ ...cur, email } as Credential) : undefined));
        this.finish();
        this.state = { state: "done", login: email ?? "ChatGPT" };
        this.onDone();
      },
      (e: unknown) => {
        if (!mine()) return;
        const timedOut = this.state.state === "pending" && abort.signal.reason === "timeout";
        this.finish();
        this.state = abort.signal.aborted && !timedOut ? { state: "idle" } : { state: "error", error: timedOut ? "The sign-in was not finished in time. Start again." : signInError(e) };
      },
    );
    const first = await Promise.race([url.then((u) => ({ u })), this.running.then(() => null)]);
    if (!first) return this.view();
    this.timer = setTimeout(() => abort.abort("timeout"), SIGN_IN_MS);
    this.timer.unref();
    this.state = { state: "pending", url: first.u, expiresAt: new Date(Date.now() + SIGN_IN_MS).toISOString() };
    return this.state;
  }

  cancel(): void {
    void this.stop();
    this.state = { state: "idle" };
  }

  private finish(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.abort = null;
  }

  /** Ends a sign-in in progress and waits until its listener has let go of the port. */
  private async stop(): Promise<void> {
    const a = this.abort;
    const running = this.running;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.abort = null;
    if (a) {
      a.abort("cancelled");
      await running?.catch(() => undefined);
    }
  }
}

/** The OpenAI models this ChatGPT account may use, in the server's order. */
export async function chatgptModels(token: string, fetchImpl: typeof fetch = fetch): Promise<Array<{ id: string; name: string }>> {
  const res = await fetchImpl(`${RESOURCE}/models`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`ChatGPT models: ${res.status}`);
  const body = (await res.json()) as { models?: Array<{ slug: string; display_name?: string; visibility?: string }> };
  for (const m of body.models ?? []) rememberWindow(m.slug, m);
  return (body.models ?? []).filter((m) => m.visibility === "list").map((m) => ({ id: m.slug, name: m.display_name ?? m.slug }));
}
