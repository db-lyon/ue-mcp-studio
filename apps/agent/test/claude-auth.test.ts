/**
 * Studio has no Claude sign-in of its own. It reads the user's Claude Code login
 * through the runtime's `auth status` only: no login run, no credential file
 * read, and the user's environment passed through untouched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface Spawned {
  args: string[];
  options: { env: Record<string, string | undefined>; stdio: unknown };
}
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
}

const bin = vi.hoisted(() => ({
  spawned: [] as Spawned[],
  /** What `auth status --json` prints. */
  status: { loggedIn: false, authMethod: "none" } as Record<string, unknown>,
  installed: true,
}));

vi.mock("node:child_process", () => ({
  spawn: (_exe: string, args: string[], options: Spawned["options"]) => {
    const child = new FakeChild();
    bin.spawned.push({ args, options });
    setTimeout(() => {
      child.stdout.emit("data", Buffer.from(JSON.stringify(bin.status)));
      child.emit("exit", bin.status.loggedIn ? 0 : 1);
    }, 5);
    return child;
  },
}));
vi.mock("../src/runtime.js", () => ({
  ensureRuntime: async () => {
    bin.installed = true;
    return "C:\\rt\\claude.exe";
  },
  installedRuntime: () => (bin.installed ? "C:\\rt\\claude.exe" : null),
}));

const { ClaudeLoginCheck, claudeEnv, claudeHome, claudeLogin, refreshClaudeLogin, terminalCommand, CLIENT_APP } = await import("../src/claude-auth.js");

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
  process.env.CLAUDE_CONFIG_DIR = home;
  bin.spawned = [];
  bin.status = { loggedIn: false, authMethod: "none" };
  bin.installed = true;
  await refreshClaudeLogin();
  bin.spawned = [];
});

afterEach(() => {
  process.env = { ...env };
  fs.rmSync(home, { recursive: true, force: true });
});

describe("Claude login status", () => {
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
    expect(new ClaudeLoginCheck(() => {}).view()).toEqual({ state: "done", login: "Claude, API key from ANTHROPIC_API_KEY" });
  });
});

describe("the binary's environment", () => {
  it("is the user's own plus Studio's client name, with no Claude home chosen by Studio", () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    process.env.ANTHROPIC_API_KEY = "sk-user";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-user";
    const e = claudeEnv();
    expect(e).toMatchObject({ ANTHROPIC_API_KEY: "sk-user", CLAUDE_CODE_OAUTH_TOKEN: "oauth-user", CLAUDE_AGENT_SDK_CLIENT_APP: CLIENT_APP });
    expect(e).not.toHaveProperty("CLAUDE_CONFIG_DIR");
    expect(claudeHome()).toBe(path.join(os.homedir(), ".claude"));
    expect(CLIENT_APP).toBe("ue-mcp-studio");
  });

  it("keeps a Claude home the user chose", () => {
    expect(claudeEnv().CLAUDE_CONFIG_DIR).toBe(home);
    expect(claudeHome()).toBe(home);
  });
});

describe("the Claude row", () => {
  it("starts nothing: it names the terminal command and only asks auth status", async () => {
    const check = new ClaudeLoginCheck(() => {});
    expect(await check.start()).toEqual({ state: "idle", terminal: terminalCommand("C:\\rt\\claude.exe") });
    check.cancel();
    await sleep(20);
    expect(authCalls().every((c) => c === "auth status --json")).toBe(true);
  });

  it("notices a login made in a terminal", async () => {
    let done = 0;
    const check = new ClaudeLoginCheck(() => done++);
    check.view();
    await sleep(20);
    bin.status = { loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" };
    (check as unknown as { lastPoll: number }).lastPoll = 0;
    check.view();
    await waitFor(() => done === 1);
    expect(check.view()).toEqual({ state: "done", login: "Claude max" });
  });

  it("fetches the runtime first when it is not here, then reads the login", async () => {
    bin.installed = false;
    bin.status = { loggedIn: true, authMethod: "claude.ai", subscriptionType: "pro" };
    let done = 0;
    const check = new ClaudeLoginCheck(() => done++);
    expect(check.view()).toEqual({ state: "idle" });
    await waitFor(() => done === 1);
    expect(check.view()).toEqual({ state: "done", login: "Claude pro" });
  });

  it("gives the runtime's login for the platform's shell, with no config folder", () => {
    expect(terminalCommand("C:\\rt\\claude.exe", "win32")).toBe(`& "C:\\rt\\claude.exe" auth login --claudeai`);
    expect(terminalCommand("/rt/claude", "darwin")).toBe(`"/rt/claude" auth login --claudeai`);
  });
});
