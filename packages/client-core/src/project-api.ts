/**
 * The project-wide routes beside the chat: playtests and their runs, the
 * editor's busy state and start, stop, restart and rebuild, the project's
 * flows, and the verdict forms a playtest raises. studioApi includes them.
 */
import type { BusyState, FlowListing, FlowRunRequest, PendingForm, PlaytestIndexAnswer, QaRun, QaScriptStep, QaVerdict, RestoreOutcome } from "@ue-mcp-studio/shared";
import { requestJson, type Transport } from "./transport.js";
import type { EditorOp } from "./editor.js";
import type { RunOptions } from "./qa.js";

const enc = encodeURIComponent;
const S = "/v1/ext/studio";
const runPath = (runId: string) => `${S}/qa/runs/${enc(runId)}`;

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
    editor: (op: EditorOp) => send<Record<string, unknown>>("POST", `/v1/editor/${op}`),
    flows: () => get<{ flows: FlowListing[] }>("/v1/flows"),
    planFlow: (name: string) => get<unknown>(`/v1/flows/${enc(name)}/plan`),
    flow: (sessionId: string, request: FlowRunRequest) => send<{ sessionId: string }>("POST", `${S}/sessions/${enc(sessionId)}/flow`, request),
    forms: (sessionId: string) => get<{ forms: PendingForm[] }>(`${S}/forms?session=${enc(sessionId)}`),
    answerForm: (id: string, answer: FormAnswer) => send<void>("POST", `${S}/forms/${enc(id)}`, answer),
    qaRuns: () => get<{ runs: QaRun[] }>(`${S}/qa/runs`),
    qaPlaytests: (fresh = false) => get<PlaytestIndexAnswer>(`${S}/qa/playtests${fresh ? "?fresh=1" : ""}`),
    qaPlaytestCard: (script: string) => send<{ run: QaRun }>("POST", `${S}/qa/playtests/card`, { script }),
    qaPlaytestScript: (script: string) => get<{ run: QaRun }>(`${S}/qa/playtests/script?script=${enc(script)}`),
    qaPlaytestSave: (script: string, steps: QaScriptStep[], map?: string) => send<{ script: string }>("PUT", `${S}/qa/playtests/script`, { script, steps, ...(map !== undefined ? { map } : {}) }),
    qaPlaytestDelete: (script: string) => send<{ script: string }>("DELETE", `${S}/qa/playtests/script?script=${enc(script)}`),
    qaStatus: (runId: string, sinceSeq?: number) => get<{ answer: Record<string, unknown>; run: QaRun | null }>(`${runPath(runId)}/status${sinceSeq === undefined ? "" : `?since_seq=${sinceSeq}`}`),
    qaVerdict: (runId: string, step: number, verdict: QaVerdict, note?: string) => send<{ run: QaRun }>("POST", `${runPath(runId)}/verdict`, note ? { step, verdict, note } : { step, verdict }),
    qaAssign: (runId: string, sessionId?: string | null) => send<{ run: QaRun }>("POST", `${runPath(runId)}/assign`, sessionId ? { sessionId } : {}),
    qaCancelAssign: (runId: string) => send<{ run: QaRun }>("DELETE", `${runPath(runId)}/assign`),
    qaRevertLoop: (runId: string, attempt?: number) => send<{ run: QaRun; outcome: RestoreOutcome }>("POST", `${runPath(runId)}/loop/revert`, attempt === undefined ? {} : { attempt }),
    qaStop: (runId: string) => send<{ run: QaRun }>("POST", `${runPath(runId)}/stop`),
    qaRun: (runId: string, options: RunOptions) => send<{ run: QaRun }>("POST", `${runPath(runId)}/run`, options),
    qaSaveScript: (runId: string, steps: QaScriptStep[], map?: string) => send<{ run: QaRun }>("PUT", `${runPath(runId)}/script`, { steps, ...(map !== undefined ? { map } : {}) }),
    qaDeleteScript: (runId: string) => send<{ run: QaRun }>("DELETE", `${runPath(runId)}/script`),
    qaDismiss: (runId: string) => send<void>("DELETE", runPath(runId)),
  };
}

/** Paths a client fetches itself, as bytes: a run's results and a step's captures. */
export const qaResultsPath = (runId: string) => `${runPath(runId)}/results`;
export const qaCapturePath = (runId: string, step: number, n: number) => `${runPath(runId)}/steps/${step}/captures/${n}`;
