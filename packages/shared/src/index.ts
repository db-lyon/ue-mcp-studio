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
export type SignInId = "chatgpt" | "claude" | "studio";
export const SIGN_IN_IDS: readonly SignInId[] = ["chatgpt", "claude", "studio"];

/** Whether the panel offers the Studio plan sign-in. Off: it is hidden everywhere. */
export const STUDIO_PLAN_AVAILABLE = false;

/** The sign-ins the panel offers now. */
export const OFFERED_SIGN_INS: readonly SignInId[] = SIGN_IN_IDS.filter((s) => s !== "studio" || STUDIO_PLAN_AVAILABLE);

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
  chatgpt: { id: "chatgpt", name: "ChatGPT" },
  claude: { id: "claude", name: "Claude subscription" },
  studio: { id: "studio", name: "Studio" },
  anthropic: { id: "anthropic", name: "Anthropic", keyPlaceholder: "sk-ant-...", keyUrl: "https://console.anthropic.com/settings/keys" },
  openai: { id: "openai", name: "OpenAI", keyPlaceholder: "sk-...", keyUrl: "https://platform.openai.com/api-keys" },
  google: { id: "google", name: "Google", keyPlaceholder: "AIza...", keyUrl: "https://aistudio.google.com/apikey" },
};

/** How the UI looks: the ue-mcp.com look, a light variant, or the editor's own colors. */
export type StudioTheme = "ue-mcp" | "editor-orange" | "editor";
export const STUDIO_THEMES: readonly StudioTheme[] = ["ue-mcp", "editor-orange", "editor"];

/** How long the model reasons before it answers. A vendor without a level takes its nearest one. */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];
export const EFFORT_NAMES: Record<Effort, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };

/** GET /v1/ext/studio/settings. Secrets are reported by presence only, never returned. */
export interface StudioSettings {
  /** The selected model and its vendor. */
  provider: KeyProviderId;
  model: string;
  /** How the selected model runs now, or null when nothing that can run it is connected. */
  route: ModelRoute;
  effort: Effort;
  gatewayUrl: string;
  theme: StudioTheme;
  /** Ask the user before the agent runs a command or edits a file. */
  askBeforeChanges: boolean;
  /** The height dragged on the chat composer's divider, in pixels, or null for the default. */
  composerHeight: number | null;
  /** When an editor dialog needs an answer. */
  dialogPolicy: DialogPolicy;
  /** Which sign-ins are done and which vendor keys are saved. */
  connected: Record<ProviderId, boolean>;
  /** The Studio account's login, when signed in. */
  account: { login: string; via: "studio" | "ue-mcp-login" } | null;
}

/** PUT /v1/ext/studio/settings. An absent secret is left as it is; an empty string clears it. */
export interface StudioSettingsUpdate {
  provider?: KeyProviderId;
  model?: string;
  effort?: Effort;
  gatewayUrl?: string;
  theme?: StudioTheme;
  askBeforeChanges?: boolean;
  composerHeight?: number | null;
  dialogPolicy?: DialogPolicy;
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
  | { state: "pending"; url: string; userCode?: string; needsCode?: boolean; expiresAt: string }
  | { state: "done"; login: string }
  | { state: "error"; error: string };

export type TurnStatus = "idle" | "running" | "waiting" | "stopped" | "error";

/** A tool call the agent made, as the UI lists it. */
export interface ToolCallRecord {
  id: string;
  name: string;
  input: unknown;
  /**
   * unknown: the editor went away while it ran, so whether it took effect is
   * not known. stopped: the user stopped it (a whole turn, or one subagent).
   * declined: the user did not allow it, so it never ran.
   */
  outcome: "pending" | "done" | "error" | "unknown" | "stopped" | "declined";
  result?: string;
  /** The images the model was shown with the result, kept as the session's files. */
  images?: Attachment[];
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
/**
 * One line of the conversation. `parent` is the id of the agent call whose
 * subagent wrote it; the main agent's entries have none.
 */
/** A file the user dropped or pasted into a message. */
export interface Attachment {
  id: string;
  name: string;
  /** MIME type, as the browser reported it. */
  type: string;
  size: number;
}

/** POST /v1/ext/studio/sessions/:id/attachments: one file, its bytes as base64. */
export interface AttachmentUpload {
  name: string;
  type: string;
  data: string;
}

export type TranscriptEntry = (
  | { kind: "user"; text: string; at: string; attachments?: Attachment[] }
  | { kind: "assistant"; text: string; at: string }
  | { kind: "tool"; call: ToolCallRecord }
  | { kind: "note"; text: string; at: string }
  | { kind: "dialog"; dialog: EditorDialog }
) & { parent?: string };

export interface SessionSummary {
  id: string;
  title: string;
  status: TurnStatus;
  createdAt: string;
  updatedAt: string;
  /** Why a waiting turn is waiting. */
  waitingCause: string | null;
  /** Hidden from the session list until restored. */
  archived: boolean;
  /** The session's subagents: how many there are, and how many are still running. */
  agents: { total: number; running: number };
  /** Tool calls waiting for the user to allow or deny them. */
  awaiting: number;
  /** The model of its last turn, by name. */
  model?: string;
  /** How that model was reached: a sign-in or a key. */
  route?: string;
}

/** PUT /v1/ext/studio/sessions/:id: rename, archive or restore. */
export interface SessionUpdate {
  title?: string;
  archived?: boolean;
}

export interface SessionDetail extends SessionSummary {
  transcript: TranscriptEntry[];
  touched: TouchedItem[];
  draft: string;
  /** The subagent threads the user has opened. */
  seen: string[];
  error: string | null;
  /** Tool calls waiting for the user, oldest first. */
  approvals: ApprovalRequest[];
}

/** One line of a diff: kept, removed or added. A gap stands for unchanged lines left out. */
export type DiffLine = { op: " " | "-" | "+"; text: string } | { op: "gap"; count: number };

/** A command or a file change the agent wants to make, waiting for the user. */
export interface ApprovalRequest {
  id: string;
  /** The tool call it belongs to. */
  toolUseId: string;
  tool: "shell" | "write_file" | "edit_file";
  /** The agent call of the subagent that asked, when a subagent did. */
  parent: string | null;
  /** That subagent's short task name. */
  subagent?: string;
  /** shell: the command and where it runs. */
  command?: string;
  cwd?: string;
  /** write_file and edit_file: the file, absolute, and the change. */
  path?: string;
  diff?: DiffLine[];
  /** write_file: the file does not exist yet. */
  creates?: boolean;
  at: string;
}

/** POST /v1/ext/studio/sessions/:id/approvals/:approvalId. session: allow this kind of call for the rest of the session. */
export type ApprovalDecision = "allow" | "session" | "deny";

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

/** GET /v1/ext/studio/vcs: the project's source control, or null when it has none Studio can see. */
export interface VcsStatus {
  kind: "git" | "perforce" | "plastic" | "svn";
  /** Its product name, for display. */
  name: string;
  /** The branch, stream or workspace the project is on. */
  branch: string | null;
  /** More about where it is, such as the Perforce workspace of a stream. */
  detail?: string;
  /** Changed (Git, Plastic, Subversion) or opened (Perforce) files; null when the tool is not installed. */
  changes: number | null;
  /** Git only: commits ahead of and behind the upstream branch. */
  ahead?: number;
  behind?: number;
  root: string;
}

/** GET /v1/ext/studio/vcs/changes: one changed file. */
export interface VcsChange {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted";
  changelist?: string;
}

/** POST /v1/ext/studio/feedback: a report for Studio's GitHub tracker. */
export interface FeedbackReport {
  kind: "problem" | "idea";
  title: string;
  description: string;
  /** Add the installed versions, the engine, the OS and the model in use. Never keys or paths. */
  includeEnvironment: boolean;
}

/** Filed as an issue, or a prefilled new-issue link for the user to finish when it could not be. */
export type FeedbackResult =
  | { filed: true; url: string; number: number }
  | { filed: false; reason: string; link: string };

/** How many unchanged lines a diff keeps around each change. */
export const DIFF_CONTEXT = 3;

/**
 * A line diff of two texts, unchanged runs cut to DIFF_CONTEXT lines around
 * each change. Past a size where the table would be too large, it shows the
 * old text removed and the new one added.
 */
export function lineDiff(before: string, after: string, context = DIFF_CONTEXT): DiffLine[] {
  const lines = (t: string): string[] => {
    const l = t === "" ? [] : t.replace(/\r\n/g, "\n").split("\n");
    if (l[l.length - 1] === "") l.pop();
    return l;
  };
  const a = lines(before);
  const b = lines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const ma = a.slice(start, endA);
  const mb = b.slice(start, endB);
  const mid: DiffLine[] = [];
  if (ma.length * mb.length > 4_000_000) {
    for (const t of ma) mid.push({ op: "-", text: t });
    for (const t of mb) mid.push({ op: "+", text: t });
  } else {
    // Longest common subsequence, walked from the front.
    const n = ma.length;
    const m = mb.length;
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] = ma[i] === mb[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && ma[i] === mb[j]) {
        mid.push({ op: " ", text: ma[i++] });
        j++;
      } else if (i < n && (j >= m || lcs[(i + 1) * w + j] >= lcs[i * w + j + 1])) {
        // Removed lines before added ones, as a diff reads.
        mid.push({ op: "-", text: ma[i++] });
      } else {
        mid.push({ op: "+", text: mb[j++] });
      }
    }
  }
  const all: DiffLine[] = [...a.slice(0, start).map((text) => ({ op: " " as const, text })), ...mid, ...a.slice(endA).map((text) => ({ op: " " as const, text }))];
  // Keep only the unchanged lines near a change.
  const near = new Array<boolean>(all.length).fill(false);
  all.forEach((l, k) => {
    if (l.op === " ") return;
    for (let x = Math.max(0, k - context); x <= Math.min(all.length - 1, k + context); x++) near[x] = true;
  });
  const out: DiffLine[] = [];
  let skipped = 0;
  all.forEach((l, k) => {
    if (near[k]) {
      if (skipped) out.push({ op: "gap", count: skipped });
      skipped = 0;
      out.push(l);
    } else skipped++;
  });
  if (skipped && out.length) out.push({ op: "gap", count: skipped });
  return out;
}

/** One ue-mcp call the editor is working on, as GET /v1/ext/studio/busy reports it. */
export interface BusyCall {
  id: number;
  category: string;
  action: string;
  /** Daemon clock, epoch ms. */
  startedAt: number;
  /** studio: Studio's agent made it; client: another MCP client did. */
  source: "studio" | "client";
  sessionId?: string;
  client?: string;
  /** The turn waiting on it was stopped; the editor finishes the call regardless. */
  stopped: boolean;
}

/**
 * An editor restart, rebuild, start or stop the daemon is running, step by
 * step: editor.stop_editor, project.build, editor.start_editor,
 * editor.restart_editor, then "connect" while the started editor attaches.
 */
export interface EditorOperation {
  op: "start" | "stop" | "restart" | "rebuild";
  step: string;
  /** Daemon clock, epoch ms. */
  startedAt: number;
  stepStartedAt: number;
}

/** How the last editor operation ended when it did not bring the editor back. */
export interface EditorOperationFailure {
  op: EditorOperation["op"];
  step: string;
  /** What went wrong, in one or two sentences. */
  reason: string;
  /** Daemon clock, epoch ms. */
  at: number;
}

/** GET /v1/ext/studio/busy, and the data of studio.busy.changed. `now` is the daemon's clock. */
export interface BusyState {
  now: number;
  calls: BusyCall[];
  /** The editor operation in progress, when there is one. */
  operation?: EditorOperation;
  /** The last operation's failure, until the editor connects or another operation starts. */
  failure?: EditorOperationFailure;
}

/** POST /v1/ext/studio/window: open Studio's own window for this project. */
export interface WindowRequest {
  /** The editor process the window follows. The connected editor's when not given. */
  editorPid?: number;
  /** Opened from the editor: the window closes when that editor exits. */
  fromEditor?: boolean;
  /** Switch to this mode and keep it for the project: over the editor's dock tab, or a window of its own. */
  mode?: "docked" | "window";
}

/** What POST /v1/ext/studio/window did: Studio's window, the system browser where there is none, or nothing. */
export interface WindowLaunch {
  opened: "window" | "browser" | "none";
  pid?: number;
  reason?: string;
}
export * from "./assets.js";

/**
 * When an editor dialog needs an answer, per project:
 *   wait   ask me and wait
 *   agent  ask me, then let the agent decide after `minutes`
 *   safe   ask me, then press the safe default (Cancel or Keep) after `minutes`
 */
export type DialogPolicy = { kind: "wait" } | { kind: "agent" | "safe"; minutes: number };
export const DEFAULT_DIALOG_POLICY: DialogPolicy = { kind: "agent", minutes: 2 };
/** The longest a policy waits before acting, in minutes. */
export const MAX_DIALOG_MINUTES = 120;

/** Seconds a destructive answer the agent chose waits, so the user can override it. */
export const DESTRUCTIVE_HOLD_SECONDS = 10;

/** Answers that discard work. In auto mode the agent's pick of one is held for a countdown. */
export function isDestructiveAnswer(button: string): boolean {
  return /^don['’]?t save\b|\bdelete\b|\bdiscard\b|\brevert\b/i.test(button.trim());
}

/** The button the safe-default policy presses: Cancel, or one that keeps things as they are. Null when there is none. */
export function safeButton(buttons: string[]): string | null {
  const t = buttons.map((b) => b.trim());
  return t.find((b) => /^cancel$/i.test(b))
    ?? t.find((b) => /^keep\b/i.test(b))
    ?? (t.length === 1 && /^(ok|close)$/i.test(t[0]) ? t[0] : null);
}

/**
 * A modal dialog in the editor, as Studio shows it: a card in the chat while
 * it is open, and a line in the transcript of the session whose call met it.
 * Times are the daemon's clock, epoch ms.
 */
export interface EditorDialog {
  id: string;
  editor: string;
  title: string;
  message: string;
  /** In the order the dialog lays them out. */
  buttons: string[];
  /** Rows the dialog asks about one by one, such as each unsaved asset. */
  items?: Array<{ index: number; label: string; cells: string[]; checked: boolean }>;
  /** Who answers: auto the agent, interactive the user here, defer the user in the editor. Null when unknown. */
  mode: "auto" | "interactive" | "defer" | null;
  openedAt: number;
  /** The session, call and subagent that met it, when it was a Studio call. */
  sessionId: string | null;
  toolUseId: string | null;
  parent: string | null;
  subagent?: string;
  /** The action that met it, e.g. editor.stop_editor. */
  call: string | null;
  /** Studio is asking the user: the card's buttons answer it. */
  asking: null | {
    since: number;
    /** The buttons stay disabled until since + minHumanMs. */
    minHumanMs: number;
    policy: DialogPolicy;
    /** When the policy acts; null for wait. */
    deadline: number | null;
    /** What the safe policy presses, when it can. */
    safeButton: string | null;
  };
  /** auto: the agent picked an answer that discards work, held until `until` unless overridden. */
  held: null | { button: string; until: number };
  /** Every transition, oldest first: asked, handed to the agent and why, the agent's choice, the press. */
  steps: Array<{ at: number; text: string }>;
  /** How it ended; delegated means the agent is deciding now. */
  outcome: null | {
    kind: "pressed" | "delegated" | "closed";
    button?: string;
    by?: "you" | "agent" | "policy";
    at: number;
  };
}

/** GET /v1/ext/studio/dialogs, and the data of studio.dialog.changed. */
export interface DialogsState {
  now: number;
  /** The dialogs open now. */
  dialogs: EditorDialog[];
  /** The daemon lets Studio answer its own calls' dialogs (ue-mcp 1.4.1 and later). */
  supported: boolean;
}

/** POST /v1/ext/studio/dialogs/:id */
export type DialogAnswer =
  | { answer: "press"; button: string; items?: Array<{ index: number; checked: boolean }> }
  | { answer: "delegate" }
  | { answer: "release" };

/** One field of a form ue-mcp asks the user to fill in. */
export type FormField =
  | { type: "string"; title?: string; description?: string; enum?: string[]; enumNames?: string[]; default?: string }
  | { type: "number" | "integer"; title?: string; description?: string; default?: number }
  | { type: "boolean"; title?: string; description?: string; default?: boolean };

/** A form ue-mcp raised during a turn, such as approving a feedback report, waiting for the user. */
export interface PendingForm {
  id: string;
  sessionId: string;
  /** The call that raised it, as category(action). */
  call: string;
  at: string;
  message: string;
  fields: Record<string, FormField>;
  required: string[];
}

/** How ue-mcp files feedback: ask first, file without asking, or keep it to review later. */
export type FeedbackMode = "interactive" | "auto-approve" | "defer";
/** Who answers an editor dialog: the user, the agent, or nobody until the user does it in the editor. */
export type DialogMode = "interactive" | "auto" | "defer";

/** The agent settings ue-mcp owns. A mode is null when this ue-mcp cannot set it from Studio. */
export interface AgentSettings {
  feedbackTool: boolean;
  /** project: this project sets it, else it is the per-user one. */
  feedbackMode: { mode: FeedbackMode; project: boolean } | null;
  /** mode null: left to each client. */
  dialogMode: { mode: DialogMode | null; project: boolean } | null;
  restarting?: boolean;
}

/** An actor or asset the editor's "Chat about this" hands to a quick ask. */
export interface QuickContextItem {
  kind: "actor" | "asset" | "location" | "graph" | "node";
  /** For a location, the actor the cursor was over; may be empty. */
  label: string;
  /**
   * The object path: /Game/Maps/L.L:PersistentLevel.Actor, or /Game/Dir/Asset.Asset.
   * For a location, the world point and surface normal under the cursor.
   */
  path: string;
  /** The actor's or node's class; for a location, the map it is in; for a graph, the asset that owns it. */
  class?: string;
  /** For a graph, the cursor's position in it. */
  at?: string;
}

/** One step of a quick ask's thread, as the editor's pill lists it. */
export interface QuickStep {
  label: string;
  state: "running" | "done" | "failed" | "stopped";
}

/** GET /v1/ext/studio/quick/:id: a session as the editor's pill shows it. */
export interface QuickThread {
  sessionId: string;
  status: TurnStatus;
  /** The steps of the turn, newest last, at most QUICK_STEPS of them. */
  steps: QuickStep[];
  /** Steps left out ahead of those. */
  earlier: number;
  /** The reply so far: the text streaming now, else the agent's last message. */
  reply: string;
  /** The reply as Unreal rich text markup: <b> bold, <c> code, lists and headings laid out. */
  replyMarkup: string;
  /** What the turn waits on the user for, which only the Studio panel can answer. */
  needsYou: string | null;
  error: string | null;
}

/** POST /v1/ext/studio/quick: a new session whose first message is `text`, with the context ahead of it. */
export interface QuickRequest {
  text: string;
  context?: QuickContextItem[];
}

/** The quick ask's session. Studio's UI is sent to it with studio.session.focus. */
export interface QuickResponse {
  sessionId: string;
}

/** Where the installed editor plugin came from: Fab installs and updates through the Fab Library, never Studio. */
export type StudioPluginSource = "fab" | "github";

/** The Fab Library, for a Fab install that names no listing. */
export const FAB_LIBRARY_URL = "https://www.fab.com/library";

/** The editor plugin in GET /v1/ext/studio/updates. */
export interface StudioPluginUpdate {
  installed: string | null;
  latest: string | null;
  /** Update can install the newer plugin itself. Never true for a Fab install. */
  available: boolean;
  /** A newer plugin exists, whether or not Update can install it. */
  newer?: boolean;
  /** project: in the project's Plugins folder. engine: anywhere else, such as the engine. */
  location: "project" | "engine" | "none";
  engine: string | null;
  /** The installed plugin is older than this Studio needs. */
  required?: boolean;
  source?: StudioPluginSource;
  /** The plugin's Fab listing, from the record the plugin writes at startup. */
  fabUrl?: string;
}
