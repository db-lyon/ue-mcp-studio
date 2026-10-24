/**
 * Model settings and secrets, per project, under the extension's data dir.
 *
 * Secrets (each provider's key, the account token) live in their own files,
 * written with mode 600. They are read only to make a request: never logged,
 * never returned by a route. The settings route reports whether each one is set.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_DIALOG_POLICY,
  EFFORTS,
  MAX_DIALOG_MINUTES,
  type DialogPolicy,
  KEY_PROVIDER_IDS,
  STUDIO_THEMES,
  type Effort,
  type KeyProviderId,
  type StudioSettingsUpdate,
  type StudioTheme,
} from "@ue-mcp-studio/shared";

export const DEFAULT_MODEL = "claude-opus-5-5";
export const DEFAULT_EFFORT: Effort = "high";
export const DEFAULT_GATEWAY_URL = "https://gateway.ue-mcp.com";

interface StoredSettings {
  provider: KeyProviderId;
  model: string;
  effort: Effort;
  gatewayUrl: string;
  theme: StudioTheme;
  askBeforeChanges: boolean;
  reviewTurns: boolean;
  composerHeight: number | null;
  dialogPolicy: DialogPolicy;
}

/** A stored or requested dialog policy, or null when it is not one. */
export function dialogPolicyOf(v: unknown): DialogPolicy | null {
  if (!v || typeof v !== "object") return null;
  const p = v as { kind?: unknown; minutes?: unknown };
  if (p.kind === "wait") return { kind: "wait" };
  if ((p.kind === "agent" || p.kind === "safe") && typeof p.minutes === "number" && Number.isFinite(p.minutes)
    && p.minutes > 0 && p.minutes <= MAX_DIALOG_MINUTES) {
    return { kind: p.kind, minutes: p.minutes };
  }
  return null;
}

/** The tallest composer height kept; anything larger is a mistake, not a layout. */
const MAX_COMPOSER_HEIGHT = 4000;
const composerHeightOf = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v > 0 && v <= MAX_COMPOSER_HEIGHT ? Math.round(v) : null;

/**
 * The selected model's vendor. Settings written before vendors were named said
 * byok, gateway or studio, all of which ran Claude models.
 */
function vendorOf(raw: unknown): KeyProviderId {
  return KEY_PROVIDER_IDS.includes(raw as KeyProviderId) ? (raw as KeyProviderId) : "anthropic";
}

const keyFile = (p: KeyProviderId) => `${p}.key`;

/** Vendor keys every project uses, like the sign-ins: enter a key once. */
export const globalKeysDir = (): string => process.env.STUDIO_KEYS_HOME || path.join(os.homedir(), ".ue-mcp", "studio", "keys");

export class SettingsStore {
  constructor(private readonly dir: string, private readonly keysDir = globalKeysDir()) {
    fs.mkdirSync(dir, { recursive: true });
  }

  private file(name: string): string {
    return path.join(this.dir, name);
  }

  /** A vendor key: the global one, or a key this project kept from before keys were global. */
  private readKey(p: KeyProviderId): string | null {
    return this.readSecretAt(path.join(this.keysDir, keyFile(p))) ?? this.readSecret(keyFile(p));
  }

  /** A new key, or its removal, applies to every project. */
  private writeKey(p: KeyProviderId, value: string): void {
    fs.mkdirSync(this.keysDir, { recursive: true });
    this.writeSecretAt(path.join(this.keysDir, keyFile(p)), value);
    this.writeSecret(keyFile(p), "");
  }

  private stored(): StoredSettings {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file("settings.json"), "utf-8")) as Record<string, unknown>;
      return {
        provider: vendorOf(raw.provider),
        model: typeof raw.model === "string" && raw.model ? raw.model : DEFAULT_MODEL,
        effort: EFFORTS.includes(raw.effort as Effort) ? (raw.effort as Effort) : DEFAULT_EFFORT,
        gatewayUrl: typeof raw.gatewayUrl === "string" && raw.gatewayUrl ? raw.gatewayUrl : DEFAULT_GATEWAY_URL,
        theme: STUDIO_THEMES.includes(raw.theme as StudioTheme) ? (raw.theme as StudioTheme) : "ue-mcp",
        askBeforeChanges: raw.askBeforeChanges !== false,
        reviewTurns: raw.reviewTurns !== false,
        composerHeight: composerHeightOf(raw.composerHeight),
        dialogPolicy: dialogPolicyOf(raw.dialogPolicy) ?? DEFAULT_DIALOG_POLICY,
      };
    } catch {
      return { provider: "anthropic", model: DEFAULT_MODEL, effort: DEFAULT_EFFORT, gatewayUrl: DEFAULT_GATEWAY_URL, theme: "ue-mcp", askBeforeChanges: true, reviewTurns: true, composerHeight: null, dialogPolicy: DEFAULT_DIALOG_POLICY };
    }
  }

  private readSecret(name: string): string | null {
    return this.readSecretAt(this.file(name));
  }

  private readSecretAt(file: string): string | null {
    try {
      const v = fs.readFileSync(file, "utf-8").trim();
      return v || null;
    } catch {
      return null;
    }
  }

  private writeSecret(name: string, value: string): void {
    this.writeSecretAt(this.file(name), value);
  }

  private writeSecretAt(target: string, value: string): void {
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
    const keys = Object.fromEntries(KEY_PROVIDER_IDS.map((p) => [p, this.readKey(p) !== null])) as Record<KeyProviderId, boolean>;
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
    if (u.effort !== undefined) {
      if (!EFFORTS.includes(u.effort)) throw new Error(`effort must be one of ${EFFORTS.join(", ")}`);
      s.effort = u.effort;
    }
    if (u.gatewayUrl !== undefined) {
      if (!/^https?:\/\//.test(u.gatewayUrl)) throw new Error("gatewayUrl must be an http(s) URL");
      s.gatewayUrl = u.gatewayUrl.replace(/\/+$/, "");
    }
    if (u.theme !== undefined) {
      if (!STUDIO_THEMES.includes(u.theme)) throw new Error(`theme must be one of ${STUDIO_THEMES.join(", ")}`);
      s.theme = u.theme;
    }
    if (u.askBeforeChanges !== undefined) {
      if (typeof u.askBeforeChanges !== "boolean") throw new Error("askBeforeChanges must be a boolean");
      s.askBeforeChanges = u.askBeforeChanges;
    }
    if (u.reviewTurns !== undefined) {
      if (typeof u.reviewTurns !== "boolean") throw new Error("reviewTurns must be a boolean");
      s.reviewTurns = u.reviewTurns;
    }
    if (u.composerHeight !== undefined) {
      if (u.composerHeight !== null && composerHeightOf(u.composerHeight) === null) throw new Error(`composerHeight must be null or a number from 1 to ${MAX_COMPOSER_HEIGHT}`);
      s.composerHeight = u.composerHeight === null ? null : composerHeightOf(u.composerHeight);
    }
    if (u.dialogPolicy !== undefined) {
      const policy = dialogPolicyOf(u.dialogPolicy);
      if (!policy) throw new Error(`dialogPolicy must be { kind: "wait" } or { kind: "agent" | "safe", minutes: 1 to ${MAX_DIALOG_MINUTES} }`);
      s.dialogPolicy = policy;
    }
    for (const [p, v] of Object.entries(u.keys ?? {})) {
      if (!KEY_PROVIDER_IDS.includes(p as KeyProviderId)) throw new Error(`no key provider ${p}`);
      if (typeof v !== "string") throw new Error(`the ${p} key must be a string`);
    }
    fs.writeFileSync(this.file("settings.json"), JSON.stringify(s, null, 2));
    for (const [p, v] of Object.entries(u.keys ?? {})) this.writeKey(p as KeyProviderId, (v as string).trim());
    if (u.signOut === "studio") {
      this.writeSecret("account.token", "");
      fs.rmSync(this.file("account.json"), { force: true });
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
    return this.readKey(p);
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

  effort(): Effort {
    return this.stored().effort;
  }

  gatewayUrl(): string {
    return this.stored().gatewayUrl;
  }

  /** When an editor dialog needs an answer. */
  dialogPolicy(): DialogPolicy {
    return this.stored().dialogPolicy;
  }

  /** Ask the user before a command runs or a file changes. On unless turned off. */
  askBeforeChanges(): boolean {
    return this.stored().askBeforeChanges;
  }

  /** Review each turn's changes, for sessions that have not set their own. On unless turned off. */
  reviewTurns(): boolean {
    return this.stored().reviewTurns;
  }
}
