/**
 * Studio's Claude sign-in is the unmodified Agent SDK runtime's own `auth login`,
 * `auth status` and `auth logout`. Studio never reads, receives or stores a Claude credential.
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { StudioSignIn } from "@ue-mcp-studio/shared";
import { ensureRuntime, installedRuntime } from "./runtime.js";

/** Studio's own Claude home: its sign-in and its sessions' conversations, shared by every project. */
export const claudeHome = (): string => process.env.STUDIO_CLAUDE_HOME || path.join(os.homedir(), ".ue-mcp", "studio", "claude");
/** The user's own Claude home, where the 0.1.2 betas kept Studio's conversations. */
export const sharedClaudeHome = (): string => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");

/** How Studio names itself to the Agent SDK. */
export const CLIENT_APP = "ue-mcp-studio";

/**
 * The binary's environment: the user's own, untouched, plus Studio's config folder.
 * Nothing is removed, so every sign-in method built into the binary stays available as the user set it up.
 */
export function claudeEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  return { ...process.env, CLAUDE_CONFIG_DIR: claudeHome(), CLAUDE_AGENT_SDK_CLIENT_APP: CLIENT_APP, ...extra };
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
    const child = spawn(exe, ["auth", ...args], { env: claudeEnv(), cwd: claudeHome(), stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
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
    fs.mkdirSync(claudeHome(), { recursive: true });
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

/** The binary's own login, for a terminal: the fallback when it cannot open a browser here. */
export function terminalCommand(exe: string, platform = process.platform): string {
  return platform === "win32"
    ? `$env:CLAUDE_CONFIG_DIR = "${claudeHome()}"; & "${exe}" auth login --claudeai`
    : `CLAUDE_CONFIG_DIR="${claudeHome()}" "${exe}" auth login --claudeai`;
}

const SIGN_IN_MS = 10 * 60_000;
const POLL_MS = 3000;

/**
 * `auth login` opens the browser and finishes on its own local callback. Its input and
 * output stay unconnected, so no URL or code passes through Studio.
 */
export class ClaudeSignInFlow {
  private state: StudioSignIn = { state: "idle" };
  private child: ChildProcess | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastPoll = 0;

  constructor(private readonly onDone: () => void) {}

  view(): StudioSignIn {
    if (this.state.state === "pending") {
      this.poll();
      return this.state;
    }
    const login = claudeLogin();
    return login ? { state: "done", login: loginLabel(login) } : this.state;
  }

  async start(): Promise<StudioSignIn> {
    this.cancel();
    const exe = await ensureRuntime().catch((e: Error) => e);
    if (exe instanceof Error) return (this.state = { state: "error", error: exe.message });
    fs.mkdirSync(claudeHome(), { recursive: true });
    const terminal = terminalCommand(exe);
    const child = spawn(exe, ["auth", "login", "--claudeai"], { env: claudeEnv(), cwd: claudeHome(), stdio: "ignore", windowsHide: true });
    this.child = child;
    const fail = (error: string) => {
      if (child !== this.child) return;
      this.stop();
      this.state = { state: "error", error, terminal };
    };
    child.once("error", (e) => fail(`Claude's sign-in could not start: ${e.message}`));
    child.once("exit", (code) => {
      if (child !== this.child) return;
      void refreshClaudeLogin().then((login) => {
        if (child !== this.child) return;
        if (code === 0 && login) this.finish(login);
        else fail("The sign-in did not complete. Try again, or run Claude's sign-in in a terminal.");
      });
    });
    this.timer = setTimeout(() => fail("The sign-in timed out. Try again, or run Claude's sign-in in a terminal."), SIGN_IN_MS);
    this.timer.unref?.();
    this.state = { state: "pending", terminal, expiresAt: new Date(Date.now() + SIGN_IN_MS).toISOString() };
    return this.state;
  }

  cancel(): void {
    this.stop();
    this.state = { state: "idle" };
  }

  /** Sign out with the binary's `auth logout`. */
  async signOut(): Promise<void> {
    this.cancel();
    const exe = installedRuntime();
    if (exe) await runAuth(exe, ["logout"]);
    const login = await refreshClaudeLogin();
    if (login?.method === "claude.ai") throw new Error("Claude did not sign out. Run its sign-out again.");
  }

  /** A sign-in finished elsewhere, such as the terminal command, ends this one. */
  private poll(): void {
    if (Date.now() - this.lastPoll < POLL_MS) return;
    this.lastPoll = Date.now();
    void refreshClaudeLogin().then((login) => {
      if (this.state.state === "pending" && login?.method === "claude.ai") this.finish(login);
    });
  }

  private finish(login: ClaudeLogin): void {
    this.stop();
    this.state = { state: "done", login: loginLabel(login) };
    this.onDone();
  }

  private stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const c = this.child;
    this.child = null;
    c?.kill();
  }
}
