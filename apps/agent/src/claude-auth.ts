/**
 * Studio has no Claude sign-in of its own. It reads the login the user made with
 * Claude Code (`claude /login`) through the unmodified runtime's `auth status`,
 * and never reads, receives or stores a Claude credential.
 */
import { spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import type { StudioSignIn } from "@ue-mcp-studio/shared";
import { ensureRuntime, installedRuntime } from "./runtime.js";

/** The user's own Claude home: their Claude Code login, and the conversations of Studio's sessions. */
export const claudeHome = (): string => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
/** The Claude home Studio 0.1.3 to 0.1.22 kept apart from Claude Code. */
export const studioClaudeHome = (): string => process.env.STUDIO_CLAUDE_HOME || path.join(os.homedir(), ".ue-mcp", "studio", "claude");

/** How Studio names itself to the Agent SDK. */
export const CLIENT_APP = "ue-mcp-studio";

/**
 * The binary's environment: the user's own, plus Studio's client name, and the
 * account's claude.ai connectors left out. Studio's turns allow only its own
 * tools, so a connector could never be called, yet its definitions went out
 * with every model call: 21 tools and three quarters of the tool text on an
 * account with Drive and Docs connected.
 */
export function claudeEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  return { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: CLIENT_APP, ENABLE_CLAUDEAI_MCP_SERVERS: "false", ...extra };
}

/** Who the binary says is signed in: its method (claude.ai, api_key, ...) and plan. */
export interface ClaudeLogin {
  method: string;
  subscription: string | null;
  keySource: string | null;
}

export const loginLabel = (l: ClaudeLogin): string =>
  l.method === "claude.ai" ? `Claude ${l.subscription ?? "subscription"}` : l.method === "api_key" ? `Claude, API key from ${l.keySource ?? "the environment"}` : `Claude (${l.method})`;

let cached: ClaudeLogin | null = null;
let probing: Promise<ClaudeLogin | null> | null = null;

/** The last answer from `auth status`; null before the first or when signed out. */
export const claudeLogin = (): ClaudeLogin | null => cached;

/** Run one of the binary's auth commands with no input; resolves with its exit code and output. */
function runAuth(exe: string, args: string[]): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    const child = spawn(exe, ["auth", ...args], { env: claudeEnv(), stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    child.stdout?.on("data", (b: Buffer) => (stdout += b.toString()));
    child.once("error", () => resolve({ code: null, stdout }));
    child.once("exit", (code) => resolve({ code, stdout }));
  });
}

/** Ask the binary who is signed in. No runtime yet means nobody is. */
export function refreshClaudeLogin(): Promise<ClaudeLogin | null> {
  probing ??= (async () => {
    const exe = installedRuntime();
    if (!exe) return (cached = null);
    const { stdout } = await runAuth(exe, ["status", "--json"]);
    try {
      const s = JSON.parse(stdout) as { loggedIn?: boolean; authMethod?: string; subscriptionType?: string; apiKeySource?: string };
      cached = s.loggedIn ? { method: String(s.authMethod ?? "unknown"), subscription: s.subscriptionType ?? null, keySource: s.apiKeySource ?? null } : null;
    } catch {
      cached = null;
    }
    return cached;
  })().finally(() => {
    probing = null;
  });
  return probing;
}

/** The runtime's own login, for a user without Claude Code to run in a terminal. */
export function terminalCommand(exe: string, platform = process.platform): string {
  return platform === "win32" ? `& "${exe}" auth login --claudeai` : `"${exe}" auth login --claudeai`;
}

const POLL_MS = 3000;

/**
 * The Claude row of the sign-ins. Nothing to start: the user signs in with
 * Claude Code in a terminal, and this notices when they have.
 */
export class ClaudeLoginCheck {
  private lastPoll = 0;
  private fetching = false;

  constructor(private readonly onDone: () => void) {}

  view(): StudioSignIn {
    const exe = installedRuntime();
    // The runtime answers `auth status`, so fetch it once rather than report nobody signed in.
    if (!exe) {
      if (!this.fetching) {
        this.fetching = true;
        void ensureRuntime().then(() => this.poll(true), () => {}).finally(() => (this.fetching = false));
      }
      return { state: "idle" };
    }
    const login = claudeLogin();
    if (login) return { state: "done", login: loginLabel(login) };
    this.poll();
    return { state: "idle", terminal: terminalCommand(exe) };
  }

  async start(): Promise<StudioSignIn> {
    return this.view();
  }

  cancel(): void {}

  private poll(now = false): void {
    if (!now && Date.now() - this.lastPoll < POLL_MS) return;
    this.lastPoll = Date.now();
    const before = claudeLogin();
    void refreshClaudeLogin().then((login) => {
      if (!before && login) this.onDone();
    });
  }
}
