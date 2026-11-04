/**
 * The routes Settings, Plugins, Diagnostics, Feedback and the update notices
 * read and write, over a Transport, each answer normalized the way client-web
 * reads it. A paired client reaches these through the relay; the computer
 * refuses the ones a paired client may not use (packages/remote remotePath and
 * remoteBodyAllowed), and those come back as an HttpError with status 403.
 */
import type { DaemonHealth, StatusReport } from "ue-mcp/daemon";
import type {
  AgentSettings,
  ClientContextStrategy,
  Convention,
  CustomEndpointList,
  DialogMode,
  FeedbackMode,
  FeedbackReport,
  FeedbackResult,
  ModelCatalog,
  NativeOverview,
  NativePreview,
  PlaytestRunsMode,
  RemoteAvailability,
  StudioAccountResponse,
  StudioConfigFile,
  StudioSettings,
  StudioSettingsUpdate,
  StudioSignIn,
} from "@ue-mcp-studio/shared";
import { HttpError, readJson, requestJson, type Transport } from "./transport.js";
import { agentSettingsOf, catalogOf, contextOf, healthOf, installOf, nativeOf, settingsOf } from "./normalize.js";
import type { CatalogPlugin, InstalledPlugin } from "./plugins.js";

const S = "/v1/ext/studio";
const enc = encodeURIComponent;

/** Another project installed a newer Studio than this one uses. */
export interface StudioVersionNotice {
  installed: string;
  current: string;
}

/** 404: the route is from a newer agent or daemon than the one answering. */
export const notThere = (e: unknown): boolean => e instanceof HttpError && e.status === 404;
/** 403: the computer refuses this to a paired client. */
export const refused = (e: unknown): boolean => e instanceof HttpError && e.status === 403;

export function settingsApi(t: Transport) {
  const get = <T>(path: string) => requestJson<T>(t, "GET", path);
  const send = <T>(method: string, path: string, json?: unknown) => requestJson<T>(t, method, path, json !== undefined ? { json } : {});
  return {
    health: () => get<unknown>("/v1/health").then(healthOf) as Promise<DaemonHealth>,
    install: () => get<unknown>("/v1/install").then(installOf) as Promise<StatusReport>,
    settings: () => get<unknown>(`${S}/settings`).then(settingsOf) as Promise<StudioSettings>,
    saveSettings: (u: StudioSettingsUpdate) => send<unknown>("PUT", `${S}/settings`, u).then(settingsOf) as Promise<StudioSettings>,
    models: () => get<unknown>(`${S}/models`).then(catalogOf) as Promise<ModelCatalog>,
    agentSettings: () => get<unknown>(`${S}/agent-settings`).then(agentSettingsOf) as Promise<AgentSettings>,
    saveAgentSettings: (u: Partial<{ feedbackTool: boolean; feedbackMode: FeedbackMode; dialogMode: DialogMode; playtestRuns: PlaytestRunsMode }>) =>
      send<unknown>("PUT", `${S}/agent-settings`, u).then(agentSettingsOf) as Promise<AgentSettings>,
    native: () => get<unknown>(`${S}/native`).then(nativeOf) as Promise<NativeOverview>,
    nativePreview: (convention: Convention) => get<NativePreview>(`${S}/native/preview?convention=${enc(convention)}`),
    openFile: (path: string) => send<void>("POST", `${S}/files/open`, { path }),
    contextStrategy: () => get<unknown>(`${S}/context-strategy`).then(contextOf) as Promise<ClientContextStrategy>,
    config: () => get<StudioConfigFile>(`${S}/config`),
    endpoints: () => get<CustomEndpointList>(`${S}/endpoints`),
    signIn: (id: "claude" | "chatgpt" | "studio") => get<StudioSignIn>(`${S}/signin/${id}`),
    account: () => get<StudioAccountResponse>(`${S}/account`),
    billingPortal: () => get<{ url: string }>(`${S}/billing/portal`),
    remoteStatus: () => get<unknown>(`${S}/remote/status`),
    updates: () => get<unknown>(`${S}/updates`),
    remoteAvailable: (refresh = false) => get<RemoteAvailability>(`${S}/remote/available${refresh ? "?refresh=1" : ""}`),
    editor: (op: "start" | "stop" | "restart" | "rebuild") => send<Record<string, unknown>>("POST", `/v1/editor/${op}`),
    plugins: () => get<{ plugins: InstalledPlugin[] }>("/v1/plugins"),
    pluginCatalog: () => get<{ plugins: CatalogPlugin[] }>("/v1/plugins/catalog"),
    feedbackEnvironment: () => get<{ body: string }>(`${S}/feedback/environment`),
    sendFeedback: (report: FeedbackReport) => send<FeedbackResult>("POST", `${S}/feedback`, report),
    versionNotice: () => get<{ notice: StudioVersionNotice | null }>(`${S}/version-notice`),
    refusal: () => get<unknown>(`${S}/refusal`),
    /** GET a route's JSON, null on any error status: the update checks read this way. */
    maybe: async <T>(path: string): Promise<T | null> => {
      try {
        const r = await t("GET", path);
        const body = await readJson<T>(r);
        return r.status >= 200 && r.status < 300 ? body : null;
      } catch {
        return null;
      }
    },
  };
}

export type SettingsApi = ReturnType<typeof settingsApi>;
