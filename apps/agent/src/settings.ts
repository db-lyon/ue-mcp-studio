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
  DEFAULT_USAGE,
  EFFORTS,
  IMAGE_EDGES,
  MAX_DIALOG_MINUTES,
  MAX_SUBAGENTS_PER_TURN,
  SUBAGENT_MODES,
  type DialogPolicy,
  KEY_PROVIDER_IDS,
  STUDIO_THEMES,
  type Effort,
  type KeyProviderId,
  type StudioSettingsUpdate,
  type StudioTheme,
  type UsageSettings,
  APPROVAL_KINDS,
  PROJECT_SCOPED_KINDS,
  approvalRuleFits,
  type ApprovalKind,
  DEFAULT_APPROVALS,
  type Approvals,
  DEFAULT_ROUTE_ORDER,
  ROUTE_ORDERS,
  isVendorId,
  type RouteOrder,
  type VendorId,
  usageOf,
  dialogPolicyOf,
  approvalsOf,
  subagentModelOf,
  subagentsPerTurnOf,
} from "@ue-mcp-studio/shared";

export const DEFAULT_MODEL = "claude-opus-5-5";
export const DEFAULT_EFFORT: Effort = "high";
export const DEFAULT_GATEWAY_URL = "https://gateway.ue-mcp.com";

interface StoredSettings {
  provider: VendorId;
  model: string;
  routeOrder: RouteOrder;
  effort: Effort;
  gatewayUrl: string;
  theme: StudioTheme;
  askBeforeChanges: boolean;
  reviewTurns: boolean;
  composerHeight: number | null;
  dialogPolicy: DialogPolicy;
  usage: UsageSettings;
  /** What each kind of action does first: ask, or go ahead. Replaces askBeforeChanges, which is still written for an older Studio. */
  approvals: Approvals;
}

export { usageOf, dialogPolicyOf, approvalsOf };

/** A usage update applied to the stored settings; throws on a field that is not valid. */
export function applyUsage(current: UsageSettings, u: Partial<UsageSettings>): UsageSettings {
  if (!u || typeof u !== "object") throw new Error("usage must be an object");
  const next = { ...current };
  if (u.subagents !== undefined) {
    if (!SUBAGENT_MODES.includes(u.subagents)) throw new Error(`usage.subagents must be one of ${SUBAGENT_MODES.join(", ")}`);
    next.subagents = u.subagents;
  }
  if (u.subagentModel !== undefined) {
    const m = subagentModelOf(u.subagentModel);
    if (m === undefined) throw new Error("usage.subagentModel must be null or { provider, model }");
    next.subagentModel = m;
  }
  if (u.subagentEffort !== undefined) {
    if (u.subagentEffort !== null && !EFFORTS.includes(u.subagentEffort)) throw new Error(`usage.subagentEffort must be null or one of ${EFFORTS.join(", ")}`);
    next.subagentEffort = u.subagentEffort;
  }
  if (u.subagentsPerTurn !== undefined) {
    const n = subagentsPerTurnOf(u.subagentsPerTurn);
    if (n === undefined) throw new Error(`usage.subagentsPerTurn must be -1 for no limit, or a whole number from 1 to ${MAX_SUBAGENTS_PER_TURN}`);
    next.subagentsPerTurn = n;
  }
  if (u.projectInstructions !== undefined) {
    if (typeof u.projectInstructions !== "boolean") throw new Error("usage.projectInstructions must be a boolean");
    next.projectInstructions = u.projectInstructions;
  }
  if (u.imageSize !== undefined) {
    if (!(u.imageSize in IMAGE_EDGES)) throw new Error(`usage.imageSize must be one of ${Object.keys(IMAGE_EDGES).join(", ")}`);
    next.imageSize = u.imageSize;
  }
  return next;
}

/** The tallest composer height kept; anything larger is a mistake, not a layout. */
const MAX_COMPOSER_HEIGHT = 4000;
const composerHeightOf = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v > 0 && v <= MAX_COMPOSER_HEIGHT ? Math.round(v) : null;

/**
 * The selected model's vendor: a named vendor or a custom endpoint. Settings
 * written before vendors were named said byok, gateway or studio, all of which
 * ran Claude models.
 */
function vendorOf(raw: unknown): VendorId {
  return isVendorId(raw) ? raw : "anthropic";
}

const keyFile = (p: KeyProviderId) => `${p}.key`;

/** Vendor keys every project uses, like the sign-ins: enter a key once. */
export const globalKeysDir = (): string => process.env.STUDIO_KEYS_HOME || path.join(os.homedir(), ".ue-mcp", "studio", "keys");

/** A secret file's value, or null when it is missing or empty. */
export function readSecretFile(file: string): string | null {
  try {
    const v = fs.readFileSync(file, "utf-8").trim();
    return v || null;
  } catch {
    return null;
  }
}

/** Write a secret with mode 600; an empty value removes the file. */
export function writeSecretFile(target: string, value: string): void {
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
        routeOrder: ROUTE_ORDERS.includes(raw.routeOrder as RouteOrder) ? (raw.routeOrder as RouteOrder) : DEFAULT_ROUTE_ORDER,
        effort: EFFORTS.includes(raw.effort as Effort) ? (raw.effort as Effort) : DEFAULT_EFFORT,
        gatewayUrl: typeof raw.gatewayUrl === "string" && raw.gatewayUrl ? raw.gatewayUrl : DEFAULT_GATEWAY_URL,
        theme: STUDIO_THEMES.includes(raw.theme as StudioTheme) ? (raw.theme as StudioTheme) : "ue-mcp",
        askBeforeChanges: raw.askBeforeChanges !== false,
        reviewTurns: raw.reviewTurns !== false,
        composerHeight: composerHeightOf(raw.composerHeight),
        dialogPolicy: dialogPolicyOf(raw.dialogPolicy) ?? DEFAULT_DIALOG_POLICY,
        usage: usageOf(raw.usage),
        approvals: approvalsOf(raw),
      };
    } catch {
      // No settings yet: a new install, which asks before every kind of change.
      return { provider: "anthropic", model: DEFAULT_MODEL, routeOrder: DEFAULT_ROUTE_ORDER, effort: DEFAULT_EFFORT, gatewayUrl: DEFAULT_GATEWAY_URL, theme: "ue-mcp", askBeforeChanges: true, reviewTurns: true, composerHeight: null, dialogPolicy: DEFAULT_DIALOG_POLICY, usage: { ...DEFAULT_USAGE }, approvals: { ...DEFAULT_APPROVALS } };
    }
  }

  private readSecret(name: string): string | null {
    return this.readSecretAt(this.file(name));
  }

  private readSecretAt(file: string): string | null {
    return readSecretFile(file);
  }

  private writeSecret(name: string, value: string): void {
    this.writeSecretAt(this.file(name), value);
  }

  private writeSecretAt(target: string, value: string): void {
    writeSecretFile(target, value);
  }

  /** The stored choices, without secrets. The route adds which providers are connected. */
  view(): StoredSettings & { keys: Record<KeyProviderId, boolean> } {
    const keys = Object.fromEntries(KEY_PROVIDER_IDS.map((p) => [p, this.readKey(p) !== null])) as Record<KeyProviderId, boolean>;
    return { ...this.stored(), keys };
  }

  update(u: StudioSettingsUpdate): void {
    const s = this.stored();
    if (u.provider !== undefined) {
      if (!isVendorId(u.provider)) throw new Error(`provider must be one of ${KEY_PROVIDER_IDS.join(", ")} or endpoint:<id>`);
      s.provider = u.provider;
    }
    if (u.routeOrder !== undefined) {
      if (!ROUTE_ORDERS.includes(u.routeOrder)) throw new Error(`routeOrder must be one of ${ROUTE_ORDERS.join(", ")}`);
      s.routeOrder = u.routeOrder;
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
      // The old switch, from an older panel: it covered commands and file changes.
      const rule = u.askBeforeChanges ? "ask" : "allow";
      s.approvals = { ...s.approvals, shell: rule, files: rule };
    }
    if (u.approvals !== undefined) {
      if (!u.approvals || typeof u.approvals !== "object") throw new Error("approvals must be an object");
      for (const [k, v] of Object.entries(u.approvals)) {
        if (!(APPROVAL_KINDS as readonly string[]).includes(k)) throw new Error(`no approval ${k}; one of ${APPROVAL_KINDS.join(", ")}`);
        if (!approvalRuleFits(k as ApprovalKind, v)) throw new Error(`approvals.${k} must be ask${PROJECT_SCOPED_KINDS.includes(k as ApprovalKind) ? ", project" : ""} or allow`);
      }
      s.approvals = { ...s.approvals, ...u.approvals };
    }
    // Kept for a Studio from before the rows: it asks before changes when either of its two kinds asks.
    s.askBeforeChanges = s.approvals.shell === "ask" || s.approvals.files === "ask";
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
    if (u.usage !== undefined) s.usage = applyUsage(s.usage, u.usage);
    for (const [p, v] of Object.entries(u.keys ?? {})) {
      if (!KEY_PROVIDER_IDS.includes(p as KeyProviderId)) throw new Error(`no key provider ${p}`);
      if (typeof v !== "string") throw new Error(`the ${p} key must be a string`);
    }
    this.write(s);
    for (const [p, v] of Object.entries(u.keys ?? {})) this.writeKey(p as KeyProviderId, (v as string).trim());
    if (u.signOut === "studio") {
      this.writeSecret("account.token", "");
      fs.rmSync(this.file("account.json"), { force: true });
    } else if (u.signOut !== undefined) {
      throw new Error("signOut must be studio");
    }
  }

  /** The whole file, keeping fields this Studio does not know (a newer one's, or the next phase's). */
  private write(s: StoredSettings): void {
    let extra: Record<string, unknown> = {};
    try {
      extra = JSON.parse(fs.readFileSync(this.file("settings.json"), "utf-8")) as Record<string, unknown>;
    } catch {
      // None yet.
    }
    fs.writeFileSync(this.file("settings.json"), JSON.stringify({ ...extra, ...s }, null, 2));
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

  provider(): VendorId {
    return this.stored().provider;
  }

  /** Which route runs a model a sign-in and a key can both run. */
  routeOrder(): RouteOrder {
    return this.stored().routeOrder;
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

  /** Ask the user before a command runs or a file changes, by either row. */
  askBeforeChanges(): boolean {
    const a = this.stored().approvals;
    return a.shell === "ask" || a.files === "ask";
  }

  /** What each kind of action does first. */
  approvals(): Approvals {
    return this.stored().approvals;
  }

  /** How much a turn may spend, and on what. */
  usage(): UsageSettings {
    return this.stored().usage;
  }

  /**
   * The model subagents run on: the one chosen in Usage while it is of the main
   * model's vendor, so the same sign-in or key runs both; otherwise the main model.
   */
  subagentModel(): string {
    const s = this.stored();
    return s.usage.subagentModel?.provider === s.provider ? s.usage.subagentModel.model : s.model;
  }

  /** Review each turn's changes, for sessions that have not set their own. On unless turned off. */
  reviewTurns(): boolean {
    return this.stored().reviewTurns;
  }
}
