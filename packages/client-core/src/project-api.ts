/**
 * The project-wide routes beside the chat: the editor's busy state and start,
 * stop, restart and rebuild, the project's flows, forms, the hub's hold on the
 * editor, and asset links. studioApi includes them.
 */
import type { AssetOpenResponse, AssetRef, AssetResolveResponse, BusyState, FlowListing, FlowRunRequest, PendingForm } from "@ue-mcp-studio/shared";
import type { HubLeaseEvent } from "ue-mcp/daemon";
import { requestJson, type Transport } from "./transport.js";
import type { EditorOp } from "./editor.js";
import type { EditorOpBody } from "./editor-consent.js";

const enc = encodeURIComponent;
const S = "/v1/ext/studio";

/** A form's answer: its fields, or declined. */
export type FormAnswer = { action: "accept"; content: Record<string, unknown> } | { action: "decline" | "cancel" };

export function projectApi(t: Transport) {
  const get = <T>(path: string) => requestJson<T>(t, "GET", path);
  const send = <T>(method: string, path: string, json?: unknown) => requestJson<T>(t, method, path, json !== undefined ? { json } : {});
  return {
    /** The daemon's health with its editors, as GET /v1/health answers it. */
    daemonHealth: () => get<Record<string, unknown>>("/v1/health"),
    busy: () => get<BusyState>(`${S}/busy`),
    stopBusy: () => send<{ stopped: string[] }>("POST", `${S}/busy/stop`),
    editor: (op: EditorOp, body?: EditorOpBody) => send<Record<string, unknown>>("POST", `/v1/editor/${op}`, body),
    /** A person cancels a held editor operation: the sessions it was put to stop waiting on it (feature "editor.consent"). */
    denyDisruption: (id: string, by: string) => send<unknown>("POST", `/v1/disruptions/${enc(id)}/deny`, { by }),
    /** A person approves a pending request, whatever the sessions answered. On a paired phone it takes the PIN. */
    approveDisruption: (id: string, by: string) => send<unknown>("POST", `/v1/disruptions/${enc(id)}/approve`, { by }),
    /** A person agrees to stop Studio's own running subagents that hold a request: they are stopped and the request confirmed paused. */
    stopHeldSubagents: (requestId: string) => send<unknown>("POST", `${S}/updates/consent/subagents`, { requestId }),
    /** The requests to stop, restart, rebuild or patch the editor, and what each session answered (feature "editor.consent"). */
    disruptions: () => get<unknown>("/v1/disruptions"),
    flows: () => get<{ flows: FlowListing[] }>("/v1/flows"),
    planFlow: (name: string) => get<unknown>(`/v1/flows/${enc(name)}/plan`),
    flow: (sessionId: string, request: FlowRunRequest) => send<{ sessionId: string }>("POST", `${S}/sessions/${enc(sessionId)}/flow`, request),
    forms: (sessionId: string) => get<{ forms: PendingForm[] }>(`${S}/forms?session=${enc(sessionId)}`),
    answerForm: (id: string, answer: FormAnswer) => send<void>("POST", `${S}/forms/${enc(id)}`, answer),
    /** The Playtest Hub's hold on the editor, for the app's bar. */
    hubLease: () => get<HubLeaseEvent>("/v1/hub/lease"),
    /** Release the editor: what the hub holds stops, and its queue pauses. */
    hubRelease: () => send<unknown>("POST", "/v1/hub/release", {}),
    resolveAssets: (refs: AssetRef[], sessionId: string | null) => send<AssetResolveResponse>("POST", `${S}/assets/resolve`, sessionId ? { refs, sessionId } : { refs }),
    reportAssetMiss: (name: string, candidates: number) => send<void>("POST", `${S}/assets/missed`, { name, candidates }),
    openAsset: (path: string) => send<AssetOpenResponse>("POST", `${S}/assets/open`, { path }),
  };
}
