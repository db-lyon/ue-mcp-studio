/**
 * Signing in to the Studio account from the panel. The same GitHub device flow
 * `ue-mcp login` runs: the page shows a code, the user approves it on GitHub,
 * and the GitHub token is traded at the registry for the account token the
 * gateway accepts. The account token is saved like any other secret; the
 * GitHub token is used once and dropped.
 */
import type { StudioSignIn } from "@ue-mcp-studio/shared";

/** The ue-mcp GitHub App's public device flow client id, the one `ue-mcp login` uses. */
const CLIENT_ID = process.env.UE_MCP_OAUTH_CLIENT_ID || "Iv23li9lpE9A0FqmXlJH";
const registryBase = () => (process.env.UE_MCP_REGISTRY || "https://plugins.ue-mcp.com").replace(/\/+$/, "");

const GITHUB_HEADERS = { accept: "application/json", "content-type": "application/json", "user-agent": "ue-mcp-studio" };

export class StudioSignInFlow {
  private state: StudioSignIn = { state: "idle" };
  private run = 0;

  constructor(
    private readonly save: (token: string, login: string) => void,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  view(): StudioSignIn {
    return this.state;
  }

  /** Start a sign-in, replacing any that is pending. Resolves once the code is ready to show. */
  async start(): Promise<StudioSignIn> {
    const run = ++this.run;
    const res = await this.fetchImpl("https://github.com/login/device/code", {
      method: "POST",
      headers: GITHUB_HEADERS,
      body: JSON.stringify({ client_id: CLIENT_ID }),
    });
    if (!res.ok) {
      this.state = { state: "error", error: `GitHub refused the sign-in request (${res.status}).` };
      return this.state;
    }
    const d = (await res.json()) as { device_code: string; user_code: string; verification_uri: string; expires_in: number; interval: number };
    const expiresAt = Date.now() + d.expires_in * 1000;
    this.state = { state: "pending", url: d.verification_uri, userCode: d.user_code, expiresAt: new Date(expiresAt).toISOString() };
    void this.poll(run, d.device_code, Math.max(d.interval, 5), expiresAt);
    return this.state;
  }

  cancel(): void {
    this.run++;
    this.state = { state: "idle" };
  }

  private async poll(run: number, deviceCode: string, interval: number, expiresAt: number): Promise<void> {
    try {
      while (Date.now() < expiresAt) {
        await this.sleep(interval * 1000);
        if (run !== this.run) return;
        const res = await this.fetchImpl("https://github.com/login/oauth/access_token", {
          method: "POST",
          headers: GITHUB_HEADERS,
          body: JSON.stringify({ client_id: CLIENT_ID, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
        });
        const body = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string; interval?: number };
        if (run !== this.run) return;
        if (body.access_token) {
          const { token, login } = await this.exchange(body.access_token);
          if (run !== this.run) return;
          this.save(token, login);
          this.state = { state: "done", login };
          return;
        }
        if (body.error === "slow_down") interval = body.interval ?? interval + 5;
        else if (body.error === "access_denied") return this.fail(run, "The sign-in was declined on GitHub.");
        else if (body.error && body.error !== "authorization_pending") return this.fail(run, `GitHub: ${body.error}`);
      }
      this.fail(run, "The code expired before it was approved. Start again.");
    } catch (e) {
      this.fail(run, e instanceof Error ? e.message : String(e));
    }
  }

  private fail(run: number, error: string): void {
    if (run === this.run) this.state = { state: "error", error };
  }

  private async exchange(githubToken: string): Promise<{ token: string; login: string }> {
    const res = await this.fetchImpl(`${registryBase()}/api/cli/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ githubToken }),
    });
    const data = (await res.json().catch(() => ({}))) as { token?: string; login?: string; error?: string };
    if (!res.ok || !data.token) throw new Error(`The UE-MCP account service refused the sign-in: ${data.error ?? res.status}`);
    return { token: data.token, login: data.login ?? "unknown" };
  }
}
