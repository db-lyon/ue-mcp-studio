/**
 * Studio's HTTP API over a Transport: the routes a client calls, typed, in one
 * place. The mobile app calls these; the web client's api.ts names the same
 * routes over fetch and moves onto this as its views move.
 */
import type {
  ApprovalDecision,
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
import { requestJson, type Transport } from "./transport.js";

const enc = encodeURIComponent;
const S = "/v1/ext/studio";
const session = (id: string) => `${S}/sessions/${enc(id)}`;
const review = (sessionId: string, reviewId: string) => `${session(sessionId)}/reviews/${enc(reviewId)}`;

export interface ReviewDiff {
  change: CheckpointChange;
  before?: string;
  after?: string;
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
    send: (id: string, text: string, now = false) => send<{ sessionId: string }>("POST", `${session(id)}/messages`, now ? { text, attachments: [], now } : { text, attachments: [] }),
    queue: (id: string, text: string) => send<QueuedMessage>("POST", `${session(id)}/queue`, { text, attachments: [] }),
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
