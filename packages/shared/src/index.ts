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

/** Which model access the agent uses. */
export type ProviderKind = "byok" | "gateway";

/** How the UI looks: the ue-mcp.com look, a light variant, or the editor's own colors. */
export type StudioTheme = "ue-mcp" | "light" | "editor";
export const STUDIO_THEMES: readonly StudioTheme[] = ["ue-mcp", "light", "editor"];

/** GET /v1/ext/studio/settings. Secrets are reported by presence only, never returned. */
export interface StudioSettings {
  provider: ProviderKind;
  model: string;
  gatewayUrl: string;
  theme: StudioTheme;
  hasApiKey: boolean;
  hasAccountToken: boolean;
}

/** PUT /v1/ext/studio/settings. An absent secret is left as it is; an empty string clears it. */
export interface StudioSettingsUpdate {
  provider?: ProviderKind;
  model?: string;
  gatewayUrl?: string;
  theme?: StudioTheme;
  apiKey?: string;
  accountToken?: string;
}

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
