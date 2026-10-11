/**
 * The daemon API, same origin. In the editor and the browser fallback the page
 * authenticates by the cookie the daemon set; under `npm run dev` the proxy
 * adds the token.
 */
import type { DaemonEvent, DaemonHealth, StatusReport } from "ue-mcp/daemon";
import type {
  ModelCatalog,
  SessionDetail,
  SessionSummary,
  SessionUpdate,
  SignInId,
  StudioAbout,
  StudioConfigFile,
  StudioSettings,
  StudioSettingsUpdate,
  StudioSignIn,
} from "@ue-mcp-studio/shared";

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
  sessions: () => call<{ sessions: SessionSummary[] }>("GET", "/v1/ext/studio/sessions"),
  newSession: () => call<SessionDetail>("POST", "/v1/ext/studio/sessions"),
  session: (id: string) => call<SessionDetail>("GET", `/v1/ext/studio/sessions/${encodeURIComponent(id)}`),
  updateSession: (id: string, u: SessionUpdate) => call<SessionSummary>("PUT", `/v1/ext/studio/sessions/${encodeURIComponent(id)}`, u),
  deleteSession: (id: string) => call<void>("DELETE", `/v1/ext/studio/sessions/${encodeURIComponent(id)}`),
  saveDraft: (id: string, draft: string) => call<void>("PUT", `/v1/ext/studio/sessions/${encodeURIComponent(id)}/draft`, { draft }),
  send: (id: string, text: string) => call<{ sessionId: string }>("POST", `/v1/ext/studio/sessions/${encodeURIComponent(id)}/messages`, { text }),
  stopSubagent: (id: string, callId: string) =>
    call<void>("POST", `/v1/ext/studio/sessions/${encodeURIComponent(id)}/agents/${encodeURIComponent(callId)}/stop`),
  stop: (id: string) => call<void>("POST", `/v1/ext/studio/sessions/${encodeURIComponent(id)}/stop`),
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
