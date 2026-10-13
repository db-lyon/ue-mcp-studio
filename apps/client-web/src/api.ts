/**
 * The daemon API, same origin. In the editor and the browser fallback the page
 * authenticates by the cookie the daemon set; under `npm run dev` the proxy
 * adds the token.
 */
import type { DaemonEvent, DaemonHealth, StatusReport } from "ue-mcp/daemon";
import type {
  ApprovalDecision,
  AssetOpenResponse,
  AssetRef,
  AssetResolveResponse,
  BusyState,
  DialogAnswer,
  DialogsState,
  FeedbackReport,
  FeedbackResult,
  ModelCatalog,
  SessionDetail,
  Attachment,
  AttachmentUpload,
  SessionSummary,
  VcsChange,
  VcsStatus,
  SessionUpdate,
  SignInId,
  StudioAbout,
  StudioConfigFile,
  StudioSettings,
  StudioSettingsUpdate,
  StudioSignIn,
  AgentSettings,
  DialogMode,
  FeedbackMode,
  PendingForm,
} from "@ue-mcp-studio/shared";

/** A plugin the project's ue-mcp.yml declares, as the daemon reads it. */
export interface InstalledPlugin {
  name: string;
  version: string | null;
  pinned: string | null;
  status: "ok" | "missing" | "invalid";
  categories: string[];
  problems: string[];
}

/** A plugin the registry publishes. */
export interface CatalogPlugin {
  slug: string;
  name: string;
  packageName?: string;
  tagline?: string;
  description?: string;
  readme?: string;
  category?: string;
  tags?: string[];
  repoUrl?: string;
  homepageUrl?: string;
}

/** What an install, update or uninstall did. */
export interface PluginCommandResult {
  ok: boolean;
  exitCode: number | null;
  output: string;
  restartRequired: boolean;
}

async function pluginCommand(command: "install" | "update" | "uninstall", body: Record<string, string>): Promise<PluginCommandResult> {
  const res = await fetch(`/v1/plugins/${command}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
  });
  const parsed = (await res.json().catch(() => ({}))) as Partial<PluginCommandResult> & { error?: string };
  if (res.status === 200 || res.status === 422) return parsed as PluginCommandResult;
  throw new ApiError(res.status, parsed.error ?? `${res.status} ${res.statusText}`);
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  const text = await res.text();
  const parsed = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const msg = (parsed as { error?: string } | undefined)?.error ?? `${res.status} ${res.statusText}`;
    throw new ApiError(res.status, msg);
  }
  return parsed as T;
}

export interface FlowSummary {
  name: string;
  description?: string;
}

export const api = {
  health: () => call<DaemonHealth>("GET", "/v1/health"),
  install: () => call<StatusReport>("GET", "/v1/install"),
  about: () => call<StudioAbout>("GET", "/v1/ext/studio/about"),
  config: () => call<StudioConfigFile>("GET", "/v1/ext/studio/config"),
  saveConfig: (text: string) => call<StudioConfigFile>("PUT", "/v1/ext/studio/config", { text }),
  flows: () => call<{ flows: FlowSummary[] }>("GET", "/v1/flows"),
  planFlow: (name: string) => call<unknown>("GET", `/v1/flows/${encodeURIComponent(name)}/plan`),
  runFlow: (name: string) => call<unknown>("POST", `/v1/flows/${encodeURIComponent(name)}/run`, {}),
  editor: (op: "start" | "stop" | "restart" | "rebuild") => call<Record<string, unknown>>("POST", `/v1/editor/${op}`),
  settings: () => call<StudioSettings>("GET", "/v1/ext/studio/settings"),
  saveSettings: (u: StudioSettingsUpdate) => call<StudioSettings>("PUT", "/v1/ext/studio/settings", u),
  models: () => call<ModelCatalog>("GET", "/v1/ext/studio/models"),
  signIn: (id: SignInId) => call<StudioSignIn>("GET", `/v1/ext/studio/signin/${id}`),
  startSignIn: (id: SignInId) => call<StudioSignIn>("POST", `/v1/ext/studio/signin/${id}`),
  cancelSignIn: (id: SignInId) => call<void>("DELETE", `/v1/ext/studio/signin/${id}`),
  submitSignInCode: (id: SignInId, code: string) => call<StudioSignIn>("POST", `/v1/ext/studio/signin/${id}/code`, { code }),
  plugins: () => call<{ plugins: InstalledPlugin[] }>("GET", "/v1/plugins"),
  pluginCatalog: () => call<{ plugins: CatalogPlugin[] }>("GET", "/v1/plugins/catalog"),
  installPlugin: (name: string) => pluginCommand("install", { name }),
  updatePlugin: (name?: string) => pluginCommand("update", name ? { name } : {}),
  uninstallPlugin: (name: string) => pluginCommand("uninstall", { name }),
  shutdownDaemon: () => call<unknown>("POST", "/v1/shutdown"),
  vcsChanges: () => call<{ changes: VcsChange[]; truncated: boolean }>("GET", "/v1/ext/studio/vcs/changes"),
  vcsDiff: (path: string) => call<{ diff: string | null; reason?: string }>("GET", `/v1/ext/studio/vcs/diff?path=${encodeURIComponent(path)}`),
  vcs: () => call<{ vcs: VcsStatus | null }>("GET", "/v1/ext/studio/vcs"),
  sessions: () => call<{ sessions: SessionSummary[] }>("GET", "/v1/ext/studio/sessions"),
  newSession: () => call<SessionDetail>("POST", "/v1/ext/studio/sessions"),
  session: (id: string) => call<SessionDetail>("GET", `/v1/ext/studio/sessions/${encodeURIComponent(id)}`),
  updateSession: (id: string, u: SessionUpdate) => call<SessionSummary>("PUT", `/v1/ext/studio/sessions/${encodeURIComponent(id)}`, u),
  deleteSession: (id: string) => call<void>("DELETE", `/v1/ext/studio/sessions/${encodeURIComponent(id)}`),
  markSeen: (id: string, threadId: string) => call<void>("POST", `/v1/ext/studio/sessions/${encodeURIComponent(id)}/seen`, { id: threadId }),
  saveDraft: (id: string, draft: string) => call<void>("PUT", `/v1/ext/studio/sessions/${encodeURIComponent(id)}/draft`, { draft }),
  send: (id: string, text: string, attachments: string[] = []) =>
    call<{ sessionId: string }>("POST", `/v1/ext/studio/sessions/${encodeURIComponent(id)}/messages`, { text, attachments }),
  uploadAttachment: (id: string, upload: AttachmentUpload) =>
    call<Attachment>("POST", `/v1/ext/studio/sessions/${encodeURIComponent(id)}/attachments`, upload),
  stopSubagent: (id: string, callId: string) =>
    call<void>("POST", `/v1/ext/studio/sessions/${encodeURIComponent(id)}/agents/${encodeURIComponent(callId)}/stop`),
  stop: (id: string) => call<void>("POST", `/v1/ext/studio/sessions/${encodeURIComponent(id)}/stop`),
  approve: (id: string, approvalId: string, decision: ApprovalDecision) =>
    call<void>("POST", `/v1/ext/studio/sessions/${encodeURIComponent(id)}/approvals/${encodeURIComponent(approvalId)}`, { decision }),
  busy: () => call<BusyState>("GET", "/v1/ext/studio/busy"),
  agentSettings: () => call<AgentSettings>("GET", "/v1/ext/studio/agent-settings"),
  saveAgentSettings: (u: Partial<{ feedbackTool: boolean; feedbackMode: FeedbackMode; dialogMode: DialogMode }>) => call<AgentSettings>("PUT", "/v1/ext/studio/agent-settings", u),
  forms: (sessionId: string) => call<{ forms: PendingForm[] }>("GET", `/v1/ext/studio/forms?session=${encodeURIComponent(sessionId)}`),
  answerForm: (id: string, answer: { action: "accept"; content: Record<string, unknown> } | { action: "decline" | "cancel" }) =>
    call<void>("POST", `/v1/ext/studio/forms/${encodeURIComponent(id)}`, answer),
  dialogs: () => call<DialogsState>("GET", "/v1/ext/studio/dialogs"),
  answerDialog: (id: string, answer: DialogAnswer) => call<void>("POST", `/v1/ext/studio/dialogs/${encodeURIComponent(id)}`, answer),
  resolveAssets: (refs: AssetRef[], sessionId: string | null) =>
    call<AssetResolveResponse>("POST", "/v1/ext/studio/assets/resolve", sessionId ? { refs, sessionId } : { refs }),
  reportAssetMiss: (name: string, candidates: number) => call<void>("POST", "/v1/ext/studio/assets/missed", { name, candidates }),
  openAsset: (path: string) => call<AssetOpenResponse>("POST", "/v1/ext/studio/assets/open", { path }),
  stopBusy: () => call<{ stopped: string[] }>("POST", "/v1/ext/studio/busy/stop"),
  feedbackEnvironment: () => call<{ body: string }>("GET", "/v1/ext/studio/feedback/environment"),
  sendFeedback: (report: FeedbackReport) => call<FeedbackResult>("POST", "/v1/ext/studio/feedback", report),
};

/**
 * Follow the daemon's event stream, every event type, resuming from the last
 * id after a drop. Read with fetch rather than EventSource, which only delivers
 * named events to listeners registered for each exact name.
 */
export function subscribeEvents(
  onEvent: (e: DaemonEvent) => void,
  onStatus?: (connected: boolean) => void,
): () => void {
  let stopped = false;
  let lastId = 0;
  let controller: AbortController | null = null;

  const run = async (): Promise<void> => {
    for (let attempt = 0; !stopped; attempt++) {
      controller = new AbortController();
      try {
        const res = await fetch("/v1/events", {
          headers: lastId > 0 ? { "last-event-id": String(lastId) } : {},
          credentials: "same-origin",
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`events: ${res.status}`);
        onStatus?.(true);
        attempt = 0;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let cut: number;
          while ((cut = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, cut);
            buf = buf.slice(cut + 2);
            const id = /^id: (\d+)$/m.exec(block)?.[1];
            const type = /^event: (.+)$/m.exec(block)?.[1];
            const data = /^data: (.*)$/m.exec(block)?.[1];
            if (!type || data === undefined) continue;
            if (id) lastId = Number(id);
            const { at, ...rest } = JSON.parse(data) as Record<string, unknown> & { at?: string };
            onEvent({ id: id ? Number(id) : 0, type, at: at ?? new Date().toISOString(), data: rest });
          }
        }
      } catch {
        // Dropped or refused; reconnect below.
      }
      onStatus?.(false);
      if (stopped) return;
      await new Promise((r) => setTimeout(r, Math.min(5000, 250 * 2 ** attempt)));
    }
  };
  void run();
  return () => {
    stopped = true;
    controller?.abort();
  };
}
