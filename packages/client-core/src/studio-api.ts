/**
 * Studio's HTTP API over a Transport: the routes a client calls, typed, in one
 * place. The mobile app calls these; the web client's api.ts names the same
 * routes over fetch and moves onto this as its views move.
 */
import type {
  ActionDescription,
  ActionListing,
  ActionRunRequest,
  Attachment,
  AttachmentUpload,
  FlowListing,
  FlowRunRequest,
  MentionSearchRequest,
  MentionSearchResponse,
  PendingForm,
  PlaytestRequest,
  SessionUpdate,
  ApprovalDecision,
  BusyState,
  StudioRefusal,
  CheckpointChange,
  DialogAnswer,
  DialogsState,
  ModelCatalog,
  QueuedMessage,
  RestoreOutcome,
  ReviewStatus,
  SessionDetail,
  SessionSummary,
  SessionSync,
  StudioSettings,
  StudioSettingsUpdate,
  TimelineMark,
  TurnReview,
  VcsChange,
  VcsStatus,
} from "@ue-mcp-studio/shared";
import { HttpError, readAll, requestJson, type Transport } from "./transport.js";
import type { UpdateRun } from "./update-run.js";

const enc = encodeURIComponent;
const S = "/v1/ext/studio";
const session = (id: string) => `${S}/sessions/${enc(id)}`;
const review = (sessionId: string, reviewId: string) => `${session(sessionId)}/reviews/${enc(reviewId)}`;

export interface ReviewDiff {
  change: CheckpointChange;
  before?: string;
  after?: string;
}

/** Another project installed a newer Studio than this one uses. */
export interface StudioVersionNotice {
  installed: string;
  current: string;
}

export function studioApi(t: Transport) {
  const get = <T>(path: string) => requestJson<T>(t, "GET", path);
  const send = <T>(method: string, path: string, json?: unknown) => requestJson<T>(t, method, path, json !== undefined ? { json } : {});
  return {
    health: () => get<{ version?: string; startedAt?: string; lastEventId?: number }>("/v1/health"),
    sessions: () => get<{ sessions: SessionSummary[] }>(`${S}/sessions`),
    newSession: () => send<SessionDetail>("POST", `${S}/sessions`),
    sessionSync: (id: string, have?: string) => get<SessionSync | SessionDetail>(`${session(id)}?sync=1${have !== undefined ? `&have=${have}` : ""}`),
    callResult: (id: string, callId: string) => get<{ result: string }>(`${session(id)}/calls/${enc(callId)}/result`),
    send: (id: string, text: string, attachments: string[] = [], now = false) =>
      send<{ sessionId: string }>("POST", `${session(id)}/messages`, now ? { text, attachments, now } : { text, attachments }),
    queue: (id: string, text: string, attachments: string[] = []) => send<QueuedMessage>("POST", `${session(id)}/queue`, { text, attachments }),
    editQueued: (id: string, qid: string, text: string) => send<void>("PUT", `${session(id)}/queue/${enc(qid)}`, { text }),
    updateSession: (id: string, u: SessionUpdate) => send<SessionSummary>("PUT", session(id), u),
    deleteSession: (id: string) => send<void>("DELETE", session(id)),
    markSeen: (id: string, threadId: string) => send<void>("POST", `${session(id)}/seen`, { id: threadId }),
    dismissAgents: (id: string, ids: string[]) => send<{ dismissed: string[] }>("POST", `${session(id)}/dismissed`, { ids }),
    editMessage: (id: string, index: number, text: string, mode: "rewind" | "fork" = "rewind") => send<{ sessionId: string }>("POST", `${session(id)}/transcript/${index}/edit`, { text, mode }),
    stopSubagent: (id: string, callId: string) => send<void>("POST", `${session(id)}/agents/${enc(callId)}/stop`),
    compact: (id: string, instructions?: string) => send<{ sessionId: string }>("POST", `${session(id)}/compact`, instructions ? { instructions } : {}),
    playtest: (id: string, request: PlaytestRequest) => send<{ sessionId: string }>("POST", `${session(id)}/playtest`, request),
    forms: (sessionId: string) => get<{ forms: PendingForm[] }>(`${S}/forms?session=${enc(sessionId)}`),
    answerForm: (id: string, answer: { action: "accept"; content: Record<string, unknown> } | { action: "decline" | "cancel" }) => send<void>("POST", `${S}/forms/${enc(id)}`, answer),
    /** Bytes the daemon serves (a review picture), read through the transport, since a relayed client has no URL to load. */
    bytes: async (path: string): Promise<{ type: string; data: Uint8Array }> => {
      const reply = await t("GET", path);
      const data = await readAll(reply);
      if (reply.status < 200 || reply.status >= 300) throw new HttpError(reply.status, `GET ${path} answered ${reply.status}.`);
      return { type: reply.headers["content-type"] ?? "application/octet-stream", data };
    },
    reviewImageUrl: (name: string) => `${S}/review/images/${enc(name)}`,
    reviewThumbnailUrl: (thumbId: string) => `${S}/review/thumbnails/${enc(thumbId)}`,
    reviewNativeDiff: (id: string, reviewId: string, path: string) => send<{ opened: string; windowTitle?: string }>("POST", `${review(id, reviewId)}/native-diff`, { path }),
    removeQueued: (id: string, qid: string) => send<void>("DELETE", `${session(id)}/queue/${enc(qid)}`),
    sendQueued: (id: string) => send<void>("POST", `${session(id)}/queue/next`),
    stop: (id: string) => send<void>("POST", `${session(id)}/stop`),
    saveDraft: (id: string, draft: string) => send<void>("PUT", `${session(id)}/draft`, { draft }),
    approve: (id: string, approvalId: string, decision: ApprovalDecision) => send<void>("POST", `${session(id)}/approvals/${enc(approvalId)}`, { decision }),
    dialogs: () => get<DialogsState>(`${S}/dialogs`),
    answerDialog: (id: string, answer: DialogAnswer) => send<void>("POST", `${S}/dialogs/${enc(id)}`, answer),
    settings: () => get<StudioSettings>(`${S}/settings`),
    saveSettings: (u: StudioSettingsUpdate) => send<StudioSettings>("PUT", `${S}/settings`, u),
    models: () => get<ModelCatalog>(`${S}/models`),
    reviewStatus: () => get<ReviewStatus>(`${S}/review/status`),
    setSessionReview: (id: string, on: boolean | null) => send<{ review: boolean | null }>("PUT", `${session(id)}/review`, { on }),
    reviewDiff: (id: string, reviewId: string, path: string) => get<ReviewDiff>(`${review(id, reviewId)}/diff?path=${enc(path)}`),
    reviewKeep: (id: string, reviewId: string, paths: string[]) => send<{ review: TurnReview }>("POST", `${review(id, reviewId)}/keep`, { paths }),
    reviewRevert: (id: string, reviewId: string, paths: string[], force = false) =>
      send<{ review: TurnReview; outcome: RestoreOutcome }>("POST", `${review(id, reviewId)}/revert`, force ? { paths, force } : { paths }),
    reviewUndo: (id: string, reviewId: string, path: string) => send<{ review: TurnReview; outcome: RestoreOutcome }>("POST", `${review(id, reviewId)}/undo`, { path }),
    timelineRestore: (id: string, checkpoint: string, force = false) =>
      send<{ timeline: TimelineMark[]; outcome: RestoreOutcome }>("POST", `${session(id)}/timeline/restore`, force ? { checkpoint, force } : { checkpoint }),
    timelineUndo: (id: string, checkpoint: string) => send<{ timeline: TimelineMark[]; outcome: RestoreOutcome }>("POST", `${session(id)}/timeline/undo`, { checkpoint }),
    vcs: () => get<{ vcs: VcsStatus | null }>(`${S}/vcs`),
    vcsChanges: () => get<{ changes: VcsChange[]; truncated: boolean }>(`${S}/vcs/changes`),
    vcsDiff: (path: string) => get<{ diff: string | null; reason?: string }>(`${S}/vcs/diff?path=${enc(path)}`),
    versionNotice: () => get<{ notice: StudioVersionNotice | null }>(`${S}/version-notice`),
    keepStudio: (version: string) => send<{ notice: StudioVersionNotice | null }>("POST", `${S}/version-notice/keep`, { version }),
    useInstalledStudio: (version: string) => send<unknown>("POST", `${S}/version-notice/update`, { version }),
    busy: () => get<BusyState>(`${S}/busy`),
    stopBusy: () => send<{ stopped: string[] }>("POST", `${S}/busy/stop`),
    editor: (op: "start" | "stop" | "restart" | "rebuild") => send<Record<string, unknown>>("POST", `/v1/editor/${op}`),
    refusal: () => get<StudioRefusal>(`${S}/refusal`),
    saveUpdateRun: (run: UpdateRun | null) => send<unknown>("PUT", `${S}/updates/run`, { run }),
    updatesDeferredNow: () => send<{ ok?: boolean; error?: string }>("POST", `${S}/updates/deferred/now`),
    // The composer: attachments, @-mentions, and the /flow and /action launchers.
    uploadAttachment: (id: string, upload: AttachmentUpload) => send<Attachment>("POST", `${session(id)}/attachments`, upload),
    searchMentions: (request: MentionSearchRequest, signal?: AbortSignal) => requestJson<MentionSearchResponse>(t, "POST", `${S}/mentions/search`, { json: request, ...(signal ? { signal } : {}) }),
    flows: () => get<{ flows: FlowListing[] }>("/v1/flows"),
    planFlow: (name: string) => get<unknown>(`/v1/flows/${enc(name)}/plan`),
    flow: (id: string, request: FlowRunRequest) => send<{ sessionId: string }>("POST", `${session(id)}/flow`, request),
    actions: () => get<{ actions: ActionListing[] }>(`${S}/actions`),
    describeAction: (name: string) => get<ActionDescription>(`${S}/actions/${enc(name)}`),
    action: (id: string, request: ActionRunRequest) => send<{ sessionId: string }>("POST", `${session(id)}/action`, request),
  };
}

export type StudioApi = ReturnType<typeof studioApi>;

/** What a revert or restore left alone, in words. */
export function outcomeNote(o: RestoreOutcome): string | null {
  const parts: string[] = [];
  if (o.conflicts.length) parts.push(`${o.conflicts.length === 1 ? "1 file was" : `${o.conflicts.length} files were`} edited after the agent and left as they are`);
  if (o.missing.length) parts.push(`${o.missing.length === 1 ? "1 file has" : `${o.missing.length} files have`} no earlier version to put back`);
  return parts.length ? `${parts.join("; ")}.` : null;
}
