/**
 * Model settings and secrets, per project, under the extension's data dir.
 *
 * Secrets (each provider's key, the account token) live in their own files,
 * written with mode 600. They are read only to make a request: never logged,
 * never returned by a route. The settings route reports whether each one is set.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  KEY_PROVIDER_IDS,
  STUDIO_THEMES,
  type KeyProviderId,
  type StudioSettingsUpdate,
  type StudioTheme,
} from "@ue-mcp-studio/shared";

export const DEFAULT_MODEL = "claude-opus-5-5";
export const DEFAULT_GATEWAY_URL = "https://gateway.ue-mcp.com";

interface StoredSettings {
  provider: KeyProviderId;
  model: string;
  gatewayUrl: string;
  theme: StudioTheme;
}

/**
 * The selected model's vendor. Settings written before vendors were named said
 * byok, gateway or studio, all of which ran Claude models.
 */
function vendorOf(raw: unknown): KeyProviderId {
  return KEY_PROVIDER_IDS.includes(raw as KeyProviderId) ? (raw as KeyProviderId) : "anthropic";
}

const keyFile = (p: KeyProviderId) => `${p}.key`;

export class SettingsStore {
  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  private file(name: string): string {
    return path.join(this.dir, name);
  }

  private stored(): StoredSettings {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file("settings.json"), "utf-8")) as Record<string, unknown>;
      return {
        provider: vendorOf(raw.provider),
        model: typeof raw.model === "string" && raw.model ? raw.model : DEFAULT_MODEL,
        gatewayUrl: typeof raw.gatewayUrl === "string" && raw.gatewayUrl ? raw.gatewayUrl : DEFAULT_GATEWAY_URL,
        theme: STUDIO_THEMES.includes(raw.theme as StudioTheme) ? (raw.theme as StudioTheme) : "ue-mcp",
      };
    } catch {
      return { provider: "anthropic", model: DEFAULT_MODEL, gatewayUrl: DEFAULT_GATEWAY_URL, theme: "ue-mcp" };
    }
  }

  private readSecret(name: string): string | null {
    try {
      const v = fs.readFileSync(this.file(name), "utf-8").trim();
      return v || null;
    } catch {
      return null;
    }
  }

  private writeSecret(name: string, value: string): void {
    const target = this.file(name);
    if (value === "") {
      fs.rmSync(target, { force: true });
      return;
    }
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, value, { mode: 0o600 });
    fs.renameSync(tmp, target);
    // A rename keeps the temp file's mode; set it again in case the file pre-existed with another.
    fs.chmodSync(target, 0o600);
  }

  /** The stored choices, without secrets. The route adds which providers are connected. */
  view(): StoredSettings & { keys: Record<KeyProviderId, boolean> } {
    const keys = Object.fromEntries(KEY_PROVIDER_IDS.map((p) => [p, this.readSecret(keyFile(p)) !== null])) as Record<KeyProviderId, boolean>;
    return { ...this.stored(), keys };
  }

  update(u: StudioSettingsUpdate): void {
    const s = this.stored();
    if (u.provider !== undefined) {
      if (!KEY_PROVIDER_IDS.includes(u.provider)) throw new Error(`provider must be one of ${KEY_PROVIDER_IDS.join(", ")}`);
      s.provider = u.provider;
    }
    if (u.model !== undefined) {
      if (typeof u.model !== "string" || !u.model.trim()) throw new Error("model must be a non-empty string");
      s.model = u.model.trim();
    }
    if (u.gatewayUrl !== undefined) {
      if (!/^https?:\/\//.test(u.gatewayUrl)) throw new Error("gatewayUrl must be an http(s) URL");
      s.gatewayUrl = u.gatewayUrl.replace(/\/+$/, "");
    }
    if (u.theme !== undefined) {
      if (!STUDIO_THEMES.includes(u.theme)) throw new Error(`theme must be one of ${STUDIO_THEMES.join(", ")}`);
      s.theme = u.theme;
    }
    for (const [p, v] of Object.entries(u.keys ?? {})) {
      if (!KEY_PROVIDER_IDS.includes(p as KeyProviderId)) throw new Error(`no key provider ${p}`);
      if (typeof v !== "string") throw new Error(`the ${p} key must be a string`);
    }
    fs.writeFileSync(this.file("settings.json"), JSON.stringify(s, null, 2));
    for (const [p, v] of Object.entries(u.keys ?? {})) this.writeSecret(keyFile(p as KeyProviderId), (v as string).trim());
    if (u.signOut === "studio") {
      this.writeSecret("account.token", "");
      fs.rmSync(this.file("account.json"), { force: true });
    } else if (u.signOut === "claude") {
      throw new Error("Sign out of Claude in Claude Code: run claude, then /logout.");
    } else if (u.signOut !== undefined) {
      throw new Error("signOut must be studio");
    }
  }

  /** After an in-panel sign-in: the account token, and the login to show beside it. */
  signIn(token: string, login: string): void {
    this.writeSecret("account.token", token);
    fs.writeFileSync(this.file("account.json"), JSON.stringify({ login }));
  }

  accountLogin(): string | null {
    try {
      const v = (JSON.parse(fs.readFileSync(this.file("account.json"), "utf-8")) as { login?: unknown }).login;
      return typeof v === "string" ? v : null;
    } catch {
      return null;
    }
  }

  /** For the providers only. */
  key(p: KeyProviderId): string | null {
    return this.readSecret(keyFile(p));
  }

  accountToken(): string | null {
    return this.readSecret("account.token");
  }

  model(): string {
    return this.stored().model;
  }

  provider(): KeyProviderId {
    return this.stored().provider;
  }

  gatewayUrl(): string {
    return this.stored().gatewayUrl;
  }
}
