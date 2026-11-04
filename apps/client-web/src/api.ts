/**
 * The daemon API, same origin. In the editor and the browser fallback the page
 * authenticates by the cookie the daemon set; under `npm run dev` the proxy
 * adds the token.
 */
import type { DaemonEvent } from "ue-mcp/daemon";
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
  CustomEndpoint,
  CustomEndpointInput,
  CustomEndpointList,
  FlowRunRequest,
  ActionDescription,
  ActionListing,
  ActionRunRequest,
  PlaytestRequest,
  QueuedMessage,
  SessionDetail,
  SessionSync,
  Attachment,
  AttachmentUpload,
  SessionSummary,
  VcsChange,
  VcsStatus,
  SessionUpdate,
  SignInId,
  StudioAbout,
  WindowLaunch,
  StudioConfigFile,
  StudioSettingsUpdate,
  StudioSignIn,
  DialogMode,
  FeedbackMode,
  PendingForm,
  QaRun, QaScriptStep, PlaytestRunsMode, PlaytestIndexAnswer,
  QaVerdict,
  CheckpointChange,
  RestoreOutcome,
  ReviewStatus,
  TimelineMark,
  TurnReview,
  ContextStrategy,
  NativePreview,
  Convention,
  MentionSearchRequest,
  MentionSearchResponse,
  RemoteAvailability,
  BillingCheckoutRequest,
  BillingLink,
  RemoteApproval,
  RemoteBrowser,
  RemoteLockSettings,
  RemoteLockState,
  RemotePairing,
  RemoteStatus,
} from "@ue-mcp-studio/shared";
import { alive, fromUeMcp, recordDiag } from "./diag";
import { agentSettingsOf, catalogOf, contextOf, healthOf, installOf, nativeOf, settingsOf } from "./normalize";

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

/** A route an older agent or daemon does not have: the part it feeds is left out, not reported as a failure. */
export const notThere = (e: unknown): boolean => e instanceof ApiError && e.status === 404;

async function call<T>(method: string, url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    method,
    signal,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  if (fromUeMcp(res.status)) alive();
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

const reviewBase = (sessionId: string, reviewId: string): string =>
  `/v1/ext/studio/sessions/${encodeURIComponent(sessionId)}/reviews/${encodeURIComponent(reviewId)}`;

/** A newer Studio installed by another project than the one this project uses (ue-mcp#1619). */
export interface StudioVersionNotice {
  installed: string;
  current: string;
}

export const api = {
  versionNotice: () => call<{ notice: StudioVersionNotice | null }>("GET", "/v1/ext/studio/version-notice"),
  keepStudio: (version: string) => call<{ notice: StudioVersionNotice | null }>("POST", "/v1/ext/studio/version-notice/keep", { version }),
  useInstalledStudio: (version: string) => call<unknown>("POST", "/v1/ext/studio/version-notice/update", { version }),
  health: () => call<unknown>("GET", "/v1/health").then(healthOf),
  install: () => call<unknown>("GET", "/v1/install").then(installOf),
  about: () => call<StudioAbout>("GET", "/v1/ext/studio/about"),
  openWindow: () => call<WindowLaunch>("POST", "/v1/ext/studio/window", {}),
  config: () => call<StudioConfigFile>("GET", "/v1/ext/studio/config"),
  remoteAvailable: (refresh = false) => call<RemoteAvailability>("GET", `/v1/ext/studio/remote/available${refresh ? "?refresh=1" : ""}`),
  /** The payment provider's checkout, or customer portal, for the signed-in account: open it with openExternal. */
  billingCheckout: (r: BillingCheckoutRequest) => call<BillingLink>("POST", "/v1/ext/studio/billing/checkout", r),
  billingPortal: () => call<BillingLink>("GET", "/v1/ext/studio/billing/portal"),
  remoteStatus: () => call<RemoteStatus>("GET", "/v1/ext/studio/remote/status"),
  setRemote: (enabled: boolean) => call<RemoteStatus>("PUT", "/v1/ext/studio/remote/config", { enabled }),
  pairRemote: () => call<RemotePairing>("POST", "/v1/ext/studio/remote/pair"),
  remoteBrowsers: () => call<{ browsers: RemoteBrowser[] }>("GET", "/v1/ext/studio/remote/browsers"),
  remoteApprovals: () => call<{ approvals: RemoteApproval[] }>("GET", "/v1/ext/studio/remote/approvals"),
  decideRemoteApproval: (id: string, allow: boolean) => call<{ ok: true }>("POST", `/v1/ext/studio/remote/approvals/${encodeURIComponent(id)}`, { allow }),
  revokeRemoteBrowser: (id: string) => call<void>("DELETE", `/v1/ext/studio/remote/browsers/${encodeURIComponent(id)}`),
  /** The PIN lock, on the computer only. */
  remoteLock: () => call<RemoteLockSettings>("GET", "/v1/ext/studio/remote/lock"),
  setRemotePin: (pin: string) => call<RemoteLockSettings>("PUT", "/v1/ext/studio/remote/lock/pin", { pin }),
  removeRemotePin: () => call<RemoteLockSettings>("DELETE", "/v1/ext/studio/remote/lock/pin"),
  setRemoteLock: (c: Partial<Pick<RemoteLockSettings, "whole" | "sensitive" | "idleMinutes">>) => call<RemoteLockSettings>("PUT", "/v1/ext/studio/remote/lock", c),
  /** The lock as this paired browser sees it, answered by the computer. */
  lockState: () => call<RemoteLockState>("GET", "/v1/ext/studio/lock"),
  saveConfig: (text: string) => call<StudioConfigFile>("PUT", "/v1/ext/studio/config", { text }),
  flows: () => call<{ flows: FlowSummary[] }>("GET", "/v1/flows"),
  planFlow: (name: string) => call<unknown>("GET", `/v1/flows/${encodeURIComponent(name)}/plan`),
  runFlow: (name: string) => call<unknown>("POST", `/v1/flows/${encodeURIComponent(name)}/run`, {}),
  editor: (op: "start" | "stop" | "restart" | "rebuild") => call<Record<string, unknown>>("POST", `/v1/editor/${op}`),
  settings: () => call<unknown>("GET", "/v1/ext/studio/settings").then(settingsOf),
  saveSettings: (u: StudioSettingsUpdate) => call<unknown>("PUT", "/v1/ext/studio/settings", u).then(settingsOf),
  models: () => call<unknown>("GET", "/v1/ext/studio/models").then(catalogOf),
  endpoints: () => call<CustomEndpointList>("GET", "/v1/ext/studio/endpoints"),
  addEndpoint: (e: CustomEndpointInput) => call<CustomEndpoint>("POST", "/v1/ext/studio/endpoints", e),
  saveEndpoint: (id: string, e: CustomEndpointInput) => call<CustomEndpoint>("PUT", `/v1/ext/studio/endpoints/${encodeURIComponent(id)}`, e),
  removeEndpoint: (id: string) => call<void>("DELETE", `/v1/ext/studio/endpoints/${encodeURIComponent(id)}`),
  listEndpointModels: (id: string) => call<CustomEndpoint>("POST", `/v1/ext/studio/endpoints/${encodeURIComponent(id)}/models`),
  signIn: (id: SignInId) => call<StudioSignIn>("GET", `/v1/ext/studio/signin/${id}`),
  startSignIn: (id: SignInId) => call<StudioSignIn>("POST", `/v1/ext/studio/signin/${id}`),
  cancelSignIn: (id: SignInId) => call<void>("DELETE", `/v1/ext/studio/signin/${id}`),
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
  /** The session as what changed since the hashes held (see SessionSync); whole without them. */
  sessionSync: (id: string, have?: string) =>
    call<SessionSync | SessionDetail>("GET", `/v1/ext/studio/sessions/${encodeURIComponent(id)}?sync=1${have !== undefined ? `&have=${have}` : ""}`),
  /** A tool call's full result, when the session left a long one out. */
  callResult: (id: string, callId: string) =>
    call<{ result: string }>("GET", `/v1/ext/studio/sessions/${encodeURIComponent(id)}/calls/${encodeURIComponent(callId)}/result`),
  updateSession: (id: string, u: SessionUpdate) => call<SessionSummary>("PUT", `/v1/ext/studio/sessions/${encodeURIComponent(id)}`, u),
  deleteSession: (id: string) => call<void>("DELETE", `/v1/ext/studio/sessions/${encodeURIComponent(id)}`),
  markSeen: (id: string, threadId: string) => call<void>("POST", `/v1/ext/studio/sessions/${encodeURIComponent(id)}/seen`, { id: threadId }),
  dismissAgents: (id: string, ids: string[]) => call<{ dismissed: string[] }>("POST", `/v1/ext/studio/sessions/${encodeURIComponent(id)}/dismissed`, { ids }),
  saveDraft: (id: string, draft: string) => call<void>("PUT", `/v1/ext/studio/sessions/${encodeURIComponent(id)}/draft`, { draft }),
  send: (id: string, text: string, attachments: string[] = [], now = false) =>
    call<{ sessionId: string }>("POST", `/v1/ext/studio/sessions/${encodeURIComponent(id)}/messages`, now ? { text, attachments, now } : { text, attachments }),
  flow: (id: string, request: FlowRunRequest) =>
    call<{ sessionId: string }>("POST", `/v1/ext/studio/sessions/${encodeURIComponent(id)}/flow`, request),
  action: (id: string, request: ActionRunRequest) =>
    call<{ sessionId: string }>("POST", `/v1/ext/studio/sessions/${encodeURIComponent(id)}/action`, request),
  actions: () => call<{ actions: ActionListing[] }>("GET", "/v1/ext/studio/actions"),
  describeAction: (name: string) => call<ActionDescription>("GET", `/v1/ext/studio/actions/${encodeURIComponent(name)}`),
  playtest: (id: string, request: PlaytestRequest) =>
    call<{ sessionId: string }>("POST", `/v1/ext/studio/sessions/${encodeURIComponent(id)}/playtest`, request),
  queue: (id: string, text: string, attachments: string[] = []) =>
    call<QueuedMessage>("POST", `/v1/ext/studio/sessions/${encodeURIComponent(id)}/queue`, { text, attachments }),
  editQueued: (id: string, qid: string, text: string) => call<void>("PUT", `/v1/ext/studio/sessions/${encodeURIComponent(id)}/queue/${encodeURIComponent(qid)}`, { text }),
  removeQueued: (id: string, qid: string) => call<void>("DELETE", `/v1/ext/studio/sessions/${encodeURIComponent(id)}/queue/${encodeURIComponent(qid)}`),
  sendQueued: (id: string) => call<void>("POST", `/v1/ext/studio/sessions/${encodeURIComponent(id)}/queue/next`),
  editMessage: (id: string, index: number, text: string, mode: "rewind" | "fork" = "rewind") =>
    call<{ sessionId: string }>("POST", `/v1/ext/studio/sessions/${encodeURIComponent(id)}/transcript/${index}/edit`, { text, mode }),
  uploadAttachment: (id: string, upload: AttachmentUpload) =>
    call<Attachment>("POST", `/v1/ext/studio/sessions/${encodeURIComponent(id)}/attachments`, upload),
  stopSubagent: (id: string, callId: string) =>
    call<void>("POST", `/v1/ext/studio/sessions/${encodeURIComponent(id)}/agents/${encodeURIComponent(callId)}/stop`),
  stop: (id: string) => call<void>("POST", `/v1/ext/studio/sessions/${encodeURIComponent(id)}/stop`),
  /** Summarise the conversation to free context; the transcript stays whole. */
  compact: (id: string, instructions?: string) => call<{ sessionId: string }>("POST", `/v1/ext/studio/sessions/${encodeURIComponent(id)}/compact`, instructions ? { instructions } : {}),
  approve: (id: string, approvalId: string, decision: ApprovalDecision) =>
    call<void>("POST", `/v1/ext/studio/sessions/${encodeURIComponent(id)}/approvals/${encodeURIComponent(approvalId)}`, { decision }),
  busy: () => call<BusyState>("GET", "/v1/ext/studio/busy"),
  agentSettings: () => call<unknown>("GET", "/v1/ext/studio/agent-settings").then(agentSettingsOf),
  saveAgentSettings: (u: Partial<{ feedbackTool: boolean; feedbackMode: FeedbackMode; dialogMode: DialogMode; playtestRuns: PlaytestRunsMode }>) => call<unknown>("PUT", "/v1/ext/studio/agent-settings", u).then(agentSettingsOf),
  forms: (sessionId: string) => call<{ forms: PendingForm[] }>("GET", `/v1/ext/studio/forms?session=${encodeURIComponent(sessionId)}`),
  answerForm: (id: string, answer: { action: "accept"; content: Record<string, unknown> } | { action: "decline" | "cancel" }) =>
    call<void>("POST", `/v1/ext/studio/forms/${encodeURIComponent(id)}`, answer),
  qaRuns: () => call<{ runs: QaRun[] }>("GET", "/v1/ext/studio/qa/runs"),
  qaPlaytests: (fresh = false) => call<PlaytestIndexAnswer>("GET", `/v1/ext/studio/qa/playtests${fresh ? "?fresh=1" : ""}`),
  qaPlaytestCard: (script: string) => call<{ run: QaRun }>("POST", "/v1/ext/studio/qa/playtests/card", { script }),
  qaPlaytestScript: (script: string) => call<{ run: QaRun }>("GET", `/v1/ext/studio/qa/playtests/script?script=${encodeURIComponent(script)}`),
  qaPlaytestSave: (script: string, steps: QaScriptStep[], map?: string) => call<{ script: string }>("PUT", "/v1/ext/studio/qa/playtests/script", { script, steps, ...(map !== undefined ? { map } : {}) }),
  qaPlaytestDelete: (script: string) => call<{ script: string }>("DELETE", `/v1/ext/studio/qa/playtests/script?script=${encodeURIComponent(script)}`),
  qaStatus: (runId: string, sinceSeq?: number) =>
    call<{ answer: Record<string, unknown>; run: QaRun | null }>("GET", `/v1/ext/studio/qa/runs/${encodeURIComponent(runId)}/status${sinceSeq === undefined ? "" : `?since_seq=${sinceSeq}`}`),
  qaVerdict: (runId: string, step: number, verdict: QaVerdict, note?: string) =>
    call<{ run: QaRun }>("POST", `/v1/ext/studio/qa/runs/${encodeURIComponent(runId)}/verdict`, note ? { step, verdict, note } : { step, verdict }),
  qaAssign: (runId: string, sessionId?: string | null) =>
    call<{ run: QaRun }>("POST", `/v1/ext/studio/qa/runs/${encodeURIComponent(runId)}/assign`, sessionId ? { sessionId } : {}),
  qaCancelAssign: (runId: string) => call<{ run: QaRun }>("DELETE", `/v1/ext/studio/qa/runs/${encodeURIComponent(runId)}/assign`),
  qaRevertLoop: (runId: string, attempt?: number) =>
    call<{ run: QaRun; outcome: RestoreOutcome }>("POST", `/v1/ext/studio/qa/runs/${encodeURIComponent(runId)}/loop/revert`, attempt === undefined ? {} : { attempt }),
  qaStop: (runId: string) => call<{ run: QaRun }>("POST", `/v1/ext/studio/qa/runs/${encodeURIComponent(runId)}/stop`),
  qaRun: (runId: string, options: { startPie: boolean; players: number; listen: boolean; record: boolean }) =>
    call<{ run: QaRun }>("POST", `/v1/ext/studio/qa/runs/${encodeURIComponent(runId)}/run`, options),
  qaSaveScript: (runId: string, steps: QaScriptStep[], map?: string) => call<{ run: QaRun }>("PUT", `/v1/ext/studio/qa/runs/${encodeURIComponent(runId)}/script`, { steps, ...(map !== undefined ? { map } : {}) }),
  qaDeleteScript: (runId: string) => call<{ run: QaRun }>("DELETE", `/v1/ext/studio/qa/runs/${encodeURIComponent(runId)}/script`),
  qaDismiss: (runId: string) => call<void>("DELETE", `/v1/ext/studio/qa/runs/${encodeURIComponent(runId)}`),
  qaResultsUrl: (runId: string) => `/v1/ext/studio/qa/runs/${encodeURIComponent(runId)}/results`,
  reviewStatus: () => call<ReviewStatus>("GET", "/v1/ext/studio/review/status"),
  setSessionReview: (sessionId: string, on: boolean | null) => call<{ review: boolean | null }>("PUT", `/v1/ext/studio/sessions/${encodeURIComponent(sessionId)}/review`, { on }),
  reviewDiff: (sessionId: string, reviewId: string, path: string) =>
    call<{ change: CheckpointChange; before?: string; after?: string }>("GET", `${reviewBase(sessionId, reviewId)}/diff?path=${encodeURIComponent(path)}`),
  reviewKeep: (sessionId: string, reviewId: string, paths: string[]) => call<{ review: TurnReview }>("POST", `${reviewBase(sessionId, reviewId)}/keep`, { paths }),
  reviewRevert: (sessionId: string, reviewId: string, paths: string[], force = false) =>
    call<{ review: TurnReview; outcome: RestoreOutcome }>("POST", `${reviewBase(sessionId, reviewId)}/revert`, force ? { paths, force } : { paths }),
  reviewUndo: (sessionId: string, reviewId: string, path: string) => call<{ review: TurnReview; outcome: RestoreOutcome }>("POST", `${reviewBase(sessionId, reviewId)}/undo`, { path }),
  timelineRestore: (sessionId: string, checkpoint: string, force = false) =>
    call<{ timeline: TimelineMark[]; outcome: RestoreOutcome }>("POST", `/v1/ext/studio/sessions/${encodeURIComponent(sessionId)}/timeline/restore`, force ? { checkpoint, force } : { checkpoint }),
  timelineUndo: (sessionId: string, checkpoint: string) =>
    call<{ timeline: TimelineMark[]; outcome: RestoreOutcome }>("POST", `/v1/ext/studio/sessions/${encodeURIComponent(sessionId)}/timeline/undo`, { checkpoint }),
  qaCaptureUrl: (runId: string, step: number, n: number) =>
    `/v1/ext/studio/qa/runs/${encodeURIComponent(runId)}/steps/${step}/captures/${n}`,
  reviewImageUrl: (name: string) => `/v1/ext/studio/review/images/${encodeURIComponent(name)}`,
  reviewThumbnailUrl: (id: string) => `/v1/ext/studio/review/thumbnails/${encodeURIComponent(id)}`,
  reviewNativeDiff: (sessionId: string, reviewId: string, path: string) =>
    call<{ opened: string; windowTitle?: string }>("POST", `${reviewBase(sessionId, reviewId)}/native-diff`, { path }),
  dialogs: () => call<DialogsState>("GET", "/v1/ext/studio/dialogs"),
  answerDialog: (id: string, answer: DialogAnswer) => call<void>("POST", `/v1/ext/studio/dialogs/${encodeURIComponent(id)}`, answer),
  resolveAssets: (refs: AssetRef[], sessionId: string | null) =>
    call<AssetResolveResponse>("POST", "/v1/ext/studio/assets/resolve", sessionId ? { refs, sessionId } : { refs }),
  reportAssetMiss: (name: string, candidates: number) => call<void>("POST", "/v1/ext/studio/assets/missed", { name, candidates }),
  /** Names for an @-mention; `signal` drops a search the composer no longer wants. */
  searchMentions: (request: MentionSearchRequest, signal?: AbortSignal) => call<MentionSearchResponse>("POST", "/v1/ext/studio/mentions/search", request, signal),
  openAsset: (path: string) => call<AssetOpenResponse>("POST", "/v1/ext/studio/assets/open", { path }),
  stopBusy: () => call<{ stopped: string[] }>("POST", "/v1/ext/studio/busy/stop"),
  native: () => call<unknown>("GET", "/v1/ext/studio/native").then(nativeOf),
  nativePreview: (convention: Convention) => call<NativePreview>("GET", `/v1/ext/studio/native/preview?convention=${encodeURIComponent(convention)}`),
  openFile: (path: string) => call<void>("POST", "/v1/ext/studio/files/open", { path }),
  contextStrategy: () => call<unknown>("GET", "/v1/ext/studio/context-strategy").then(contextOf),
  saveContextStrategy: (strategy: ContextStrategy) => call<unknown>("PUT", "/v1/ext/studio/context-strategy", { strategy }).then(contextOf),
  feedbackEnvironment: () => call<{ body: string }>("GET", "/v1/ext/studio/feedback/environment"),
  sendFeedback: (report: FeedbackReport) => call<FeedbackResult>("POST", "/v1/ext/studio/feedback", report),
};

/** A stream whose response head has not come back this long is stalled: abort and ask again. */
export const EVENTS_HEAD_TIMEOUT_MS = 6000;

/** The daemon's identity check before a resume gives up after this long, so one lost request cannot hold the stream down. */
export const IDENTITY_TIMEOUT_MS = 5000;

/** Through the relay a quiet stream carries a keepalive every 20 seconds; this long with no bytes means the stream died silently. */
export const STREAM_IDLE_MS = 50_000;

/**
 * Through the relay, the service worker gives up on a request when the page
 * does, named by this header (it never leaves the browser). Without it, a
 * request the page abandoned stays parked on a dead connection in the worker.
 */
const HEAD_TIMEOUT_HEADER = "x-uemcp-head-timeout";

/** A page hidden this long gets a fresh stream when it comes back, rather than trusting one that may have died while it slept. */
export const WAKE_REFRESH_MS = 30_000;

/** Asked of the stream's owner: drop a stalled or waiting attempt and connect again now. */
let wakeEvents: (() => void) | null = null;

/** Reconnect the event stream at once, as Retry and a page coming back into view do. */
export function reconnectEvents(): void {
  wakeEvents?.();
}

interface DaemonIdentity {
  startedAt: string;
  lastEventId: number;
}

/** Who the daemon is now. Bounded by IDENTITY_TIMEOUT_MS and by `signal`, so a request lost on the way never stalls the caller. */
async function daemonIdentity(signal?: AbortSignal): Promise<DaemonIdentity | null> {
  const c = new AbortController();
  const timer = setTimeout(() => c.abort(), IDENTITY_TIMEOUT_MS);
  const stop = (): void => c.abort();
  signal?.addEventListener("abort", stop, { once: true });
  const t0 = Date.now();
  try {
    const res = await fetch("/v1/health", { credentials: "same-origin", signal: c.signal, headers: { [HEAD_TIMEOUT_HEADER]: String(IDENTITY_TIMEOUT_MS) } });
    if (fromUeMcp(res.status)) alive();
    if (!res.ok) {
      recordDiag("check", { result: `HTTP ${res.status}`, ms: Date.now() - t0 });
      return null;
    }
    const h = (await res.json()) as { startedAt?: unknown; lastEventId?: unknown };
    if (Date.now() - t0 > 2000) recordDiag("check", { result: "slow", ms: Date.now() - t0 });
    return { startedAt: String(h.startedAt ?? ""), lastEventId: Number(h.lastEventId ?? 0) || 0 };
  } catch {
    if (!signal?.aborted) recordDiag("check", { result: c.signal.aborted ? `no answer within ${IDENTITY_TIMEOUT_MS / 1000}s` : "network error", ms: Date.now() - t0 });
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
  }
}

/** The hashed entry script an index page loads, e.g. /ui/assets/index-AbC123.js. */
export function entryScript(html: string): string | null {
  return /\/assets\/index-[A-Za-z0-9_-]+\.js/.exec(html)?.[0] ?? null;
}

/**
 * Whether ue-mcp now serves a different UI build than the one this page runs:
 * an update installed while the page slept. Asked after a daemon restart.
 */
async function servedBuildDiffers(): Promise<string | null> {
  if (typeof document === "undefined") return null;
  const mine = entryScript(Array.from(document.scripts, (s) => s.getAttribute("src") ?? "").join(" "));
  if (!mine) return null;
  const c = new AbortController();
  const timer = setTimeout(() => c.abort(), IDENTITY_TIMEOUT_MS);
  try {
    const res = await fetch("/ui/", { credentials: "same-origin", cache: "no-store", signal: c.signal, headers: { [HEAD_TIMEOUT_HEADER]: String(IDENTITY_TIMEOUT_MS) } });
    if (!res.ok) return null;
    const served = entryScript(await res.text());
    return served && served !== mine ? served : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Load the newer build once; a build that keeps differing (a page served from elsewhere) is not reloaded again. */
function reloadInto(served: string): void {
  try {
    if (sessionStorage.getItem("studio.reloadedFor") === served) return;
    sessionStorage.setItem("studio.reloadedFor", served);
  } catch {
    return;
  }
  window.location.reload();
}

export interface EventStreamOptions {
  /** Drop a stream that carries no bytes for this long. Set for a paired browser, whose stream carries relay keepalives. */
  idleMs?: number;
}

/**
 * Follow the daemon's event stream, every event type, resuming from the last
 * id after a drop. Read with fetch rather than EventSource, which only delivers
 * named events to listeners registered for each exact name.
 *
 * A restarted daemon numbers its events from 1 again, and asked to resume
 * past its newest id it sends nothing, not even its response head, until its
 * next event. So before resuming the stream asks the daemon who it is: a new
 * daemon (another start time, or fewer events than the last id seen) is
 * followed from its start. Every step of an attempt is bounded: the identity
 * check by IDENTITY_TIMEOUT_MS, the head by EVENTS_HEAD_TIMEOUT_MS, and with
 * `idleMs` an open stream that goes silent. The page coming back into view,
 * being restored or unfrozen, regaining focus or going back online retries at
 * once; one hidden past WAKE_REFRESH_MS opens a fresh stream even if the old
 * one looks open. After a daemon restart, a page whose UI build is no longer
 * the one served reloads into the new one.
 */
export function subscribeEvents(
  onEvent: (e: DaemonEvent) => void,
  onStatus?: (connected: boolean) => void,
  options: EventStreamOptions = {},
): () => void {
  let stopped = false;
  let lastId = 0;
  let daemonStarted = "";
  let controller: AbortController | null = null;
  let wake: (() => void) | null = null;
  let connected = false;
  let skipWait = false;
  let hiddenAt: number | null = null;

  /** Reconnect now. `force` drops a stream that looks open too, for a page that slept long enough for it to have died unseen. */
  const kick = (force = false): void => {
    if (connected && !force) return;
    skipWait = true;
    controller?.abort();
    wake?.();
  };

  const run = async (): Promise<void> => {
    for (let attempt = 0; !stopped; attempt++) {
      controller = new AbortController();
      const signal = controller.signal;
      /** Why this attempt ended, for Diagnostics. */
      let cause = "";
      let openedAt = 0;
      const t0 = Date.now();
      try {
        // Resume only when the daemon has events this page has not seen. Asked to resume at its newest id, ue-mcp
        // sends nothing, not even its response head, until its next event, so a quiet daemon would look offline.
        let resumeFrom = 0;
        if (lastId > 0) {
          const who = await daemonIdentity(signal);
          if (signal.aborted) throw new Error("woken");
          const sameDaemon = !!who && (!daemonStarted || who.startedAt === daemonStarted);
          if (who && sameDaemon && who.lastEventId > lastId) resumeFrom = lastId;
          if (!sameDaemon || (who && who.lastEventId < lastId)) lastId = 0;
        }
        const headTimer = setTimeout(() => {
          cause = `no response head within ${EVENTS_HEAD_TIMEOUT_MS / 1000}s`;
          controller?.abort();
        }, EVENTS_HEAD_TIMEOUT_MS);
        let res: Response;
        try {
          res = await fetch("/v1/events", {
            headers: { [HEAD_TIMEOUT_HEADER]: String(EVENTS_HEAD_TIMEOUT_MS), ...(resumeFrom > 0 ? { "last-event-id": String(resumeFrom) } : {}) },
            credentials: "same-origin",
            signal,
          });
        } finally {
          clearTimeout(headTimer);
        }
        if (fromUeMcp(res.status)) alive();
        if (!res.ok || !res.body) {
          cause = `HTTP ${res.status}`;
          throw new Error(`events: ${res.status}`);
        }
        connected = true;
        openedAt = Date.now();
        onStatus?.(true);
        attempt = 0;
        void daemonIdentity(signal).then(async (who) => {
          if (!who || signal.aborted) return;
          const restarted = daemonStarted !== "" && who.startedAt !== daemonStarted;
          daemonStarted = who.startedAt;
          if (!restarted) return;
          const served = await servedBuildDiffers();
          if (served && !signal.aborted) reloadInto(served);
        });
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let idle: ReturnType<typeof setTimeout> | null = null;
        const quiet = (): void => {
          if (!options.idleMs) return;
          if (idle) clearTimeout(idle);
          idle = setTimeout(() => {
            cause = `no bytes for ${Math.round((options.idleMs ?? 0) / 1000)}s`;
            controller?.abort();
          }, options.idleMs);
        };
        quiet();
        for (;;) {
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try {
            chunk = await reader.read();
          } finally {
            if (idle) clearTimeout(idle);
          }
          const { done, value } = chunk;
          if (done) {
            cause ||= "ended by ue-mcp or the relay";
            break;
          }
          alive();
          quiet();
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
      } catch (e) {
        // Dropped, refused or stalled; reconnect below.
        if (!cause) cause = skipWait || stopped ? "reconnect asked (woken, focus or retry)" : e instanceof Error && e.name !== "AbortError" ? `network error: ${e.message}` : "aborted";
      }
      if (!stopped) recordDiag("drop", { cause, ...(openedAt ? { openFor: Date.now() - openedAt } : { tookMs: Date.now() - t0 }), attempt });
      connected = false;
      onStatus?.(false);
      if (stopped) return;
      if (skipWait) {
        skipWait = false;
        continue;
      }
      await new Promise<void>((r) => {
        const t = setTimeout(done, Math.min(5000, 250 * 2 ** attempt));
        function done(): void {
          clearTimeout(t);
          wake = null;
          skipWait = false;
          r();
        }
        wake = done;
      });
    }
  };

  const retry = (): void => kick();
  /** Back in view, restored from the back/forward cache, or unfrozen: reconnect, and refresh a stream that may have died while the page slept. */
  const onWake = (): void => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      hiddenAt ??= Date.now();
      return;
    }
    const slept = hiddenAt !== null && Date.now() - hiddenAt >= WAKE_REFRESH_MS;
    hiddenAt = null;
    kick(slept);
  };
  const onPageShow = (e: Event): void => kick((e as PageTransitionEvent).persisted === true);
  const onResume = (): void => kick(true);
  if (typeof window !== "undefined") {
    if (document.visibilityState === "hidden") hiddenAt = Date.now();
    window.addEventListener("focus", retry);
    window.addEventListener("online", retry);
    window.addEventListener("pageshow", onPageShow);
    document.addEventListener("visibilitychange", onWake);
    document.addEventListener("resume", onResume);
  }
  wakeEvents = retry;
  void run();
  return () => {
    stopped = true;
    controller?.abort();
    wake?.();
    if (wakeEvents === retry) wakeEvents = null;
    if (typeof window !== "undefined") {
      window.removeEventListener("focus", retry);
      window.removeEventListener("online", retry);
      window.removeEventListener("pageshow", onPageShow);
      document.removeEventListener("visibilitychange", onWake);
      document.removeEventListener("resume", onResume);
    }
  };
}
