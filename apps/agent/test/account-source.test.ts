/** The one ue-mcp account chat, the Account tab, remote control and billing read: panel sign-in first, then `ue-mcp login`. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { AccountSource } from "../src/account-source.js";
import { SettingsStore } from "../src/settings.js";

class Panel {
  token: string | null = null;
  accountToken = () => this.token;
  accountLogin = () => null;
}

describe("AccountSource", () => {
  it("prefers the panel sign-in, then the ue-mcp login account, then none", async () => {
    const panel = new Panel();
    let registry: { login: string; token: string } | null = { login: "cli", token: "uemcp_cli" };
    const a = new AccountSource(panel, async () => registry);
    expect(await a.token()).toBe("uemcp_cli");
    panel.token = "uemcp_panel";
    expect(await a.token()).toBe("uemcp_panel");
    expect(a.current()).toBe("uemcp_panel");
    panel.token = null;
    registry = null;
    expect(await a.token()).toBeNull();
  });

  it("reads ue-mcp login again on every token(), and keeps its login for display", async () => {
    let reads = 0;
    const a = new AccountSource(new Panel(), async () => {
      reads++;
      return { login: "cli", token: "uemcp_cli" };
    });
    await a.token();
    await a.token();
    expect(reads).toBe(2);
    expect(a.registryLogin()).toEqual({ login: "cli", token: "uemcp_cli" });
  });

  it("tells its listeners when the token changes, by the panel or by ue-mcp login, and only then", async () => {
    const panel = new Panel();
    let registry: { login: string; token: string } | null = null;
    const a = new AccountSource(panel, async () => registry);
    let heard = 0;
    const off = a.onChange(() => heard++);
    await a.refresh();
    expect(heard).toBe(0);
    panel.token = "uemcp_panel";
    a.changed();
    a.changed();
    expect(heard).toBe(1);
    registry = { login: "cli", token: "uemcp_cli" };
    await a.refresh();
    expect(heard).toBe(1);
    panel.token = null;
    a.changed();
    expect(heard).toBe(2);
    registry = null;
    await a.refresh();
    expect(heard).toBe(3);
    off();
    panel.token = "x";
    a.changed();
    expect(heard).toBe(3);
  });

  it("a registry that throws reads as signed out", async () => {
    const a = new AccountSource(new Panel(), async () => {
      throw new Error("unreadable");
    });
    expect(await a.token()).toBeNull();
  });

  it("reads the panel sign-in the settings store saves, and its sign-out", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-account-"));
    try {
      const settings = new SettingsStore(dir);
      const a = new AccountSource(settings, async () => ({ login: "cli", token: "uemcp_cli" }));
      expect(await a.token()).toBe("uemcp_cli");
      settings.signIn("uemcp_panel", "dev");
      expect(await a.token()).toBe("uemcp_panel");
      settings.update({ signOut: "studio" });
      expect(await a.token()).toBe("uemcp_cli");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
