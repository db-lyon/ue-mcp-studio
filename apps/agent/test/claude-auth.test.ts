/**
 * Studio's Claude sign-in goes through the runtime's own auth commands only:
 * no output read from the login, nothing written to its input, no credential
 * file read or removed, and the user's environment passed through untouched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface Spawned {
  args: string[];
  options: { env: Record<string, string | undefined>; stdio: unknown; cwd: string };
  child: FakeChild;
}
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  killed = false;
  kill() {
    this.killed = true;
    return true;
  }
}

const bin = vi.hoisted(() => ({
  spawned: [] as Spawned[],
  /** What `auth status --json` prints. */
  status: { loggedIn: false, authMethod: "none" } as Record<string, unknown>,
  /** Whether a login child exits by itself, and how. */
  loginExit: null as number | null,
  logoutWorks: true,
}));

vi.mock("node:child_process", () => ({
  spawn: (_exe: string, args: string[], options: Spawned["options"]) => {
    const child = new FakeChild();
    bin.spawned.push({ args, options, child });
    const sub = args.slice(0, 2).join(" ");
    setTimeout(() => {
      if (sub === "auth status") {
        child.stdout.emit("data", Buffer.from(JSON.stringify(bin.status)));
        child.emit("exit", bin.status.loggedIn ? 0 : 1);
      } else if (sub === "auth logout") {
        if (bin.logoutWorks) bin.status = { loggedIn: false, authMethod: "none" };
        child.emit("exit", 0);
      } else if (sub === "auth login" && bin.loginExit !== null) {
        if (bin.loginExit === 0) bin.status = { loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" };
        child.emit("exit", bin.loginExit);
      }
    }, 5);
    return child;
  },
}));
vi.mock("../src/runtime.js", () => ({ ensureRuntime: async () => "C:\\rt\\claude.exe", installedRuntime: () => "C:\\rt\\claude.exe" }));

const { ClaudeSignInFlow, claudeEnv, claudeLogin, refreshClaudeLogin, terminalCommand, CLIENT_APP } = await import("../src/claude-auth.js");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await sleep(5);
  expect(check()).toBe(true);
};
const authCalls = () => bin.spawned.map((s) => s.args.join(" "));

let home: string;
const env = { ...process.env };

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "studio-claude-auth-"));
  process.env.STUDIO_CLAUDE_HOME = home;
  bin.spawned = [];
  bin.status = { loggedIn: false, authMethod: "none" };
  bin.loginExit = null;
  bin.logoutWorks = true;
  await refreshClaudeLogin();
  bin.spawned = [];
});

afterEach(() => {
  process.env = { ...env };
  fs.rmSync(home, { recursive: true, force: true });
});

describe("Claude sign-in status", () => {
  it("comes from the runtime's auth status, never a credential file", async () => {
    // A credentials file says signed in; the runtime says not. Studio believes the runtime.
    fs.writeFileSync(path.join(home, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "x", subscriptionType: "max" } }));
    expect(await refreshClaudeLogin()).toBeNull();
    expect(authCalls()).toEqual(["auth status --json"]);

    bin.status = { loggedIn: true, authMethod: "claude.ai", subscriptionType: "pro", email: "a@b.c" };
    expect(await refreshClaudeLogin()).toEqual({ method: "claude.ai", subscription: "pro", keySource: null });
    expect(claudeLogin()).toEqual({ method: "claude.ai", subscription: "pro", keySource: null });
  });

  it("reports the method the runtime chose, such as an API key in the user's environment", async () => {
    bin.status = { loggedIn: true, authMethod: "api_key", apiKeySource: "ANTHROPIC_API_KEY" };
    expect(await refreshClaudeLogin()).toEqual({ method: "api_key", subscription: null, keySource: "ANTHROPIC_API_KEY" });
    expect(new ClaudeSignInFlow(() => {}).view()).toEqual({ state: "done", login: "Claude, API key from ANTHROPIC_API_KEY" });
  });
});

describe("the binary's environment", () => {
  it("is the user's own plus Studio's config folder and client name, with no sign-in method removed", () => {
    process.env.ANTHROPIC_API_KEY = "sk-user";
    process.env.ANTHROPIC_AUTH_TOKEN = "tok-user";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-user";
    process.env.BROWSER = "firefox";
    const e = claudeEnv();
    expect(e).toMatchObject({ ANTHROPIC_API_KEY: "sk-user", ANTHROPIC_AUTH_TOKEN: "tok-user", CLAUDE_CODE_OAUTH_TOKEN: "oauth-user", BROWSER: "firefox", CLAUDE_CONFIG_DIR: home, CLAUDE_AGENT_SDK_CLIENT_APP: CLIENT_APP });
    expect(CLIENT_APP).toBe("ue-mcp-studio");
  });
});

describe("Claude sign-in", () => {
  it("runs the runtime's login with no input or output connected and no browser override", async () => {
    delete process.env.BROWSER;
    const flow = new ClaudeSignInFlow(() => {});
    const s = await flow.start();
    expect(s).toMatchObject({ state: "pending", terminal: terminalCommand("C:\\rt\\claude.exe") });
    expect(s).not.toHaveProperty("url");
    const login = bin.spawned.find((x) => x.args[1] === "login")!;
    expect(login.args).toEqual(["auth", "login", "--claudeai"]);
    expect(login.options.stdio).toBe("ignore");
    expect(login.options.env.BROWSER).toBeUndefined();
    expect(login.options.env.CLAUDE_CONFIG_DIR).toBe(home);
    flow.cancel();
    expect(login.child.killed).toBe(true);
  });

  it("finishes when the runtime's login exits signed in, by asking auth status", async () => {
    let done = 0;
    const flow = new ClaudeSignInFlow(() => done++);
    bin.loginExit = 0;
    await flow.start();
    await waitFor(() => flow.view().state === "done");
    expect(flow.view()).toEqual({ state: "done", login: "Claude max" });
    expect(done).toBe(1);
    expect(authCalls()).toEqual(["auth login --claudeai", "auth status --json"]);
  });

  it("finishes when the sign-in completed elsewhere, such as the terminal command", async () => {
    let done = 0;
    const flow = new ClaudeSignInFlow(() => done++);
    await flow.start();
    const login = bin.spawned.find((x) => x.args[1] === "login")!;
    bin.status = { loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" };
    flow.view();
    await waitFor(() => done === 1);
    expect(flow.view()).toEqual({ state: "done", login: "Claude max" });
    expect(login.child.killed).toBe(true);
  });

  it("offers the terminal command when the login fails", async () => {
    const flow = new ClaudeSignInFlow(() => {});
    bin.loginExit = 1;
    await flow.start();
    await waitFor(() => flow.view().state === "error");
    expect(flow.view()).toMatchObject({ state: "error", terminal: terminalCommand("C:\\rt\\claude.exe") });
  });

  it("gives a terminal command for the platform's shell", () => {
    expect(terminalCommand("C:\\rt\\claude.exe", "win32")).toBe(`$env:CLAUDE_CONFIG_DIR = "${home}"; & "C:\\rt\\claude.exe" auth login --claudeai`);
    expect(terminalCommand("/rt/claude", "darwin")).toBe(`CLAUDE_CONFIG_DIR="${home}" "/rt/claude" auth login --claudeai`);
  });
});

describe("Claude sign-out", () => {
  it("runs the runtime's logout and touches no credential file", async () => {
    bin.status = { loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" };
    await refreshClaudeLogin();
    const file = path.join(home, ".credentials.json");
    fs.writeFileSync(file, "{}");
    bin.spawned = [];
    await new ClaudeSignInFlow(() => {}).signOut();
    expect(authCalls()).toEqual(["auth logout", "auth status --json"]);
    expect(claudeLogin()).toBeNull();
    expect(fs.existsSync(file)).toBe(true);
  });

  it("says so when the runtime is still signed in afterwards", async () => {
    bin.status = { loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" };
    bin.logoutWorks = false;
    await expect(new ClaudeSignInFlow(() => {}).signOut()).rejects.toThrow("did not sign out");
    expect(authCalls()).toEqual(["auth logout", "auth status --json"]);
  });
});
