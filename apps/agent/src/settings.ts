/**
 * Model settings and secrets, per project, under the extension's data dir.
 *
 * Secrets (the BYOK key, the account token) live in their own files, written
 * with mode 600. They are read only to make a request: never logged, never
 * returned by a route. The settings route reports whether each one is set.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { STUDIO_THEMES, type ProviderKind, type StudioSettings, type StudioSettingsUpdate, type StudioTheme } from "@ue-mcp-studio/shared";

export const DEFAULT_MODEL = "claude-opus-5-5";
export const DEFAULT_GATEWAY_URL = "https://gateway.ue-mcp.com";

interface StoredSettings {
  provider: ProviderKind;
  model: string;
  gatewayUrl: string;
  theme: StudioTheme;
}

export class SettingsStore {
  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  private file(name: string): string {
    return path.join(this.dir, name);
  }

  private stored(): StoredSettings {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file("settings.json"), "utf-8")) as Partial<StoredSettings>;
      return {
        provider: raw.provider === "gateway" ? "gateway" : "byok",
        model: typeof raw.model === "string" && raw.model ? raw.model : DEFAULT_MODEL,
        gatewayUrl: typeof raw.gatewayUrl === "string" && raw.gatewayUrl ? raw.gatewayUrl : DEFAULT_GATEWAY_URL,
        theme: STUDIO_THEMES.includes(raw.theme as StudioTheme) ? (raw.theme as StudioTheme) : "ue-mcp",
      };
    } catch {
      return { provider: "byok", model: DEFAULT_MODEL, gatewayUrl: DEFAULT_GATEWAY_URL, theme: "ue-mcp" };
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

  /** What the UI may see. */
  view(): StudioSettings {
    const s = this.stored();
    return {
      ...s,
      hasApiKey: this.readSecret("anthropic.key") !== null,
      hasAccountToken: this.readSecret("account.token") !== null,
    };
  }

  update(u: StudioSettingsUpdate): StudioSettings {
    const s = this.stored();
    if (u.provider !== undefined) {
      if (u.provider !== "byok" && u.provider !== "gateway") throw new Error("provider must be byok or gateway");
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
    fs.writeFileSync(this.file("settings.json"), JSON.stringify(s, null, 2));
    if (u.apiKey !== undefined) this.writeSecret("anthropic.key", u.apiKey.trim());
    if (u.accountToken !== undefined) this.writeSecret("account.token", u.accountToken.trim());
    return this.view();
  }

  /** For the provider only. */
  apiKey(): string | null {
    return this.readSecret("anthropic.key");
  }

  accountToken(): string | null {
    return this.readSecret("account.token");
  }

  model(): string {
    return this.stored().model;
  }

  provider(): ProviderKind {
    return this.stored().provider;
  }

  gatewayUrl(): string {
    return this.stored().gatewayUrl;
  }
}
