/**
 * Types the Studio agent and UI share. The daemon's own types come from
 * `ue-mcp/daemon`; these are Studio's routes on top of it.
 */

/** Name the agent registers its routes under: /v1/ext/studio/... */
export const EXTENSION_NAME = "studio";

/** GET /v1/ext/studio/about */
export interface StudioAbout {
  agentVersion: string;
  daemonVersion: string;
  /** Version of the UI bundle the daemon is serving, or null. */
  uiVersion: string | null;
  projectDir: string;
}

/** GET and PUT /v1/ext/studio/config: ue-mcp.yml as text. */
export interface StudioConfigFile {
  path: string;
  exists: boolean;
  text: string;
}

/**
 * Where a model runs. `studio` is the Studio subscription, through the UE-MCP
 * gateway and the account sign-in; the others take the user's own key.
 */
export type ProviderId = "studio" | "anthropic" | "openai" | "google";
export const PROVIDER_IDS: readonly ProviderId[] = ["studio", "anthropic", "openai", "google"];
/** Providers connected with the user's own API key. */
export type KeyProviderId = Exclude<ProviderId, "studio">;
export const KEY_PROVIDER_IDS: readonly KeyProviderId[] = ["anthropic", "openai", "google"];

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  /** For key providers: what the key looks like and where to get one. */
  keyPlaceholder?: string;
  keyUrl?: string;
}

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  studio: { id: "studio", name: "Studio" },
  anthropic: { id: "anthropic", name: "Anthropic", keyPlaceholder: "sk-ant-...", keyUrl: "https://console.anthropic.com/settings/keys" },
  openai: { id: "openai", name: "OpenAI", keyPlaceholder: "sk-...", keyUrl: "https://platform.openai.com/api-keys" },
  google: { id: "google", name: "Google", keyPlaceholder: "AIza...", keyUrl: "https://aistudio.google.com/apikey" },
};

/** How the UI looks: the ue-mcp.com look, a light variant, or the editor's own colors. */
export type StudioTheme = "ue-mcp" | "light" | "editor";
export const STUDIO_THEMES: readonly StudioTheme[] = ["ue-mcp", "light", "editor"];

/** GET /v1/ext/studio/settings. Secrets are reported by presence only, never returned. */
export interface StudioSettings {
  /** The selected model and where it runs. */
  provider: ProviderId;
  model: string;
  gatewayUrl: string;
  theme: StudioTheme;
  /** Which providers can run a request now: signed in for studio, a key saved for the rest. */
  connected: Record<ProviderId, boolean>;
  /** The Studio account's login, when signed in. */
  account: { login: string; via: "studio" | "ue-mcp-login" } | null;
}

/** PUT /v1/ext/studio/settings. An absent secret is left as it is; an empty string clears it. */
export interface StudioSettingsUpdate {
  provider?: ProviderId;
  model?: string;
  gatewayUrl?: string;
  theme?: StudioTheme;
  keys?: Partial<Record<KeyProviderId, string>>;
  /** Signs out of the Studio account when empty. */
  accountToken?: string;
}

export interface ModelOption {
  id: string;
  name: string;
}

/** GET /v1/ext/studio/models: every provider and the models it offers, for the picker. */
export interface ModelCatalog {
  providers: Array<{
    id: ProviderId;
    name: string;
    connected: boolean;
    /** live: listed by the provider for this account; default: a starting list until it is connected. */
    source: "live" | "default";
    models: ModelOption[];
  }>;
}

/** GET and POST /v1/ext/studio/signin: signing in to the Studio account from the panel. */
export type StudioSignIn =
  | { state: "idle" }
  | { state: "pending"; userCode: string; verificationUri: string; expiresAt: string }
  | { state: "done"; login: string }
  | { state: "error"; error: string };

export type TurnStatus = "idle" | "running" | "waiting" | "stopped" | "error";

/** A tool call the agent made, as the UI lists it. */
export interface ToolCallRecord {
  id: string;
  name: string;
  input: unknown;
  /** unknown: the editor went away while it ran, so whether it took effect is not known. */
  outcome: "pending" | "done" | "error" | "unknown";
  result?: string;
  startedAt: string;
  endedAt?: string;
}

/** Something the session changed, tracked so a crash can be reconciled against disk. */
export interface TouchedItem {
  kind: "asset" | "actor";
  path: string;
  saved: boolean;
}

/** A transcript entry the UI renders. */
export type TranscriptEntry =
  | { kind: "user"; text: string; at: string }
  | { kind: "assistant"; text: string; at: string }
  | { kind: "tool"; call: ToolCallRecord }
  | { kind: "note"; text: string; at: string };

export interface SessionSummary {
  id: string;
  title: string;
  status: TurnStatus;
  createdAt: string;
  updatedAt: string;
  /** Why a waiting turn is waiting. */
  waitingCause: string | null;
}

export interface SessionDetail extends SessionSummary {
  transcript: TranscriptEntry[];
  touched: TouchedItem[];
  draft: string;
  error: string | null;
}

/**
 * Event payloads the agent publishes. The daemon prefixes the extension name,
 * so `turn.delta` arrives as `studio.turn.delta`.
 */
export interface TurnDeltaEvent {
  sessionId: string;
  text: string;
}
export interface SessionChangedEvent {
  sessionId: string;
  status: TurnStatus;
  waitingCause: string | null;
}
export * from "./account.js";
