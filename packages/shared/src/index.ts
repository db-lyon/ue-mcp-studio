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

/** Model vendors: each model belongs to one, and each can take the user's own API key. */
export type KeyProviderId = "anthropic" | "openai" | "google";
export const KEY_PROVIDER_IDS: readonly KeyProviderId[] = ["anthropic", "openai", "google"];

/**
 * Accounts the user signs in to instead of pasting a key. Claude (experimental)
 * runs Claude models on the user's Claude plan through their Claude Code login;
 * Studio runs the models its plan includes. A sign-in is the default way to run
 * a model; a vendor key is the fallback.
 */
export type SignInId = "claude" | "studio";
export const SIGN_IN_IDS: readonly SignInId[] = ["claude", "studio"];

export type ProviderId = SignInId | KeyProviderId;
export const PROVIDER_IDS: readonly ProviderId[] = [...SIGN_IN_IDS, ...KEY_PROVIDER_IDS];

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  /** For vendors: what the key looks like and where to get one. */
  keyPlaceholder?: string;
  keyUrl?: string;
}

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  claude: { id: "claude", name: "Claude subscription" },
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
  /** The selected model and its vendor. */
  provider: KeyProviderId;
  model: string;
  /** How the selected model runs now, or null when nothing that can run it is connected. */
  route: ModelRoute;
  gatewayUrl: string;
  theme: StudioTheme;
  /** Which sign-ins are done and which vendor keys are saved. */
  connected: Record<ProviderId, boolean>;
  /** The Studio account's login, when signed in. */
  account: { login: string; via: "studio" | "ue-mcp-login" } | null;
}

/** PUT /v1/ext/studio/settings. An absent secret is left as it is; an empty string clears it. */
export interface StudioSettingsUpdate {
  provider?: KeyProviderId;
  model?: string;
  gatewayUrl?: string;
  theme?: StudioTheme;
  keys?: Partial<Record<KeyProviderId, string>>;
  signOut?: SignInId;
}

/** How a model runs: a sign-in, or the vendor key. Sign-ins come first. */
export type ModelRoute = SignInId | "key" | null;

export interface ModelOption {
  id: string;
  name: string;
  /** The sign-ins that can run this model, in the order they are preferred. */
  signIns: SignInId[];
}

/** GET /v1/ext/studio/models: every vendor's models, each listed once, for the picker. */
export interface ModelCatalog {
  /** Which sign-ins are done. */
  signedIn: Record<SignInId, boolean>;
  providers: Array<{
    id: KeyProviderId;
    name: string;
    /** The user's own key is saved. */
    connected: boolean;
    /** live: listed by the vendor for this key; default: a starting list until a key is saved. */
    source: "live" | "default";
    models: ModelOption[];
  }>;
}

/** GET and POST /v1/ext/studio/signin/:id: signing in to Studio from the panel. */
export type StudioSignIn =
  | { state: "idle" }
  /** Open `url` to sign in; a device-code sign-in also shows `userCode` to enter there. */
  | { state: "pending"; url: string; userCode?: string; expiresAt: string }
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
