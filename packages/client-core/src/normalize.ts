/**
 * Answers from the agent and the daemon, each field that is missing or not
 * valid at its default, so a view never reads through an undefined. The
 * daemon serves the newest UI bundle on the machine whatever agent or ue-mcp
 * runs, so this panel reads answers written by older versions (#151).
 */
import type { DaemonHealth, StatusReport } from "ue-mcp/daemon";
import {
  CONTEXT_STRATEGIES,
  CONVENTIONS,
  DEFAULT_DIALOG_POLICY,
  DEFAULT_ROUTE_ORDER,
  EFFORTS,
  PROVIDER_IDS,
  ROUTE_ORDERS,
  SIGN_IN_IDS,
  STUDIO_THEMES,
  SUBAGENT_MODES,
  approvalsOf,
  dialogPolicyOf,
  isVendorId,
  usageOf,
  type AgentSettings,
  type ClientContextStrategy,
  type ContextStrategy,
  type Convention,
  type DialogMode,
  type Effort,
  type FeedbackMode,
  type ModelCatalog,
  type ModelRoute,
  type NativeOverview,
  type NativeView,
  type ProviderId,
  type RouteOrder,
  type SignInId,
  type StudioSettings,
  type StudioTheme,
  type SubagentMode,
} from "@ue-mcp-studio/shared";

type Raw = Record<string, unknown>;

export const obj = (v: unknown): Raw => (v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : {});
const arr = <T = unknown>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const str = (v: unknown, fallback: string): string => (typeof v === "string" ? v : fallback);
const num = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const strings = (v: unknown): string[] => arr(v).filter((x): x is string => typeof x === "string");
const oneOf = <T extends string>(v: unknown, all: readonly T[], fallback: T): T => (all.includes(v as T) ? (v as T) : fallback);

const ROUTES: readonly NonNullable<ModelRoute>[] = [...SIGN_IN_IDS, "key", "endpoint"];

/** GET /settings, from any agent. */
export function settingsOf(raw: unknown): StudioSettings {
  const s = obj(raw);
  const connected = obj(s.connected);
  const account = obj(s.account);
  return {
    provider: isVendorId(s.provider) ? s.provider : "anthropic",
    model: str(s.model, ""),
    route: ROUTES.includes(s.route as NonNullable<ModelRoute>) ? (s.route as ModelRoute) : null,
    routeOrder: oneOf<RouteOrder>(s.routeOrder, ROUTE_ORDERS, DEFAULT_ROUTE_ORDER),
    effort: oneOf<Effort>(s.effort, EFFORTS, "high"),
    gatewayUrl: str(s.gatewayUrl, ""),
    theme: oneOf<StudioTheme>(s.theme, STUDIO_THEMES, "ue-mcp"),
    askBeforeChanges: s.askBeforeChanges !== false,
    approvals: approvalsOf(s),
    reviewTurns: s.reviewTurns !== false,
    composerHeight: typeof s.composerHeight === "number" ? s.composerHeight : null,
    dialogPolicy: dialogPolicyOf(s.dialogPolicy) ?? DEFAULT_DIALOG_POLICY,
    usage: usageOf(s.usage),
    connected: Object.fromEntries(PROVIDER_IDS.map((p) => [p, connected[p] === true])) as Record<ProviderId, boolean>,
    ...(typeof s.endpoints === "number" ? { endpoints: s.endpoints } : {}),
    account: typeof account.login === "string" ? { login: account.login, via: account.via === "ue-mcp-login" ? "ue-mcp-login" : "studio" } : null,
  };
}

/** GET /models: every provider with a list of models, every model with its sign-ins. */
export function catalogOf(raw: unknown): ModelCatalog {
  const c = obj(raw);
  const signedIn = obj(c.signedIn);
  return {
    signedIn: Object.fromEntries(SIGN_IN_IDS.map((s) => [s, signedIn[s] === true])) as Record<SignInId, boolean>,
    ...(ROUTE_ORDERS.includes(c.routeOrder as RouteOrder) ? { routeOrder: c.routeOrder as RouteOrder } : {}),
    providers: arr(c.providers).map(obj).filter((p) => isVendorId(p.id)).map((p) => {
      const endpoint = obj(p.endpoint);
      return {
        id: p.id as ModelCatalog["providers"][number]["id"],
        name: str(p.name, String(p.id)),
        connected: p.connected === true,
        source: oneOf(p.source, ["live", "default", "typed"] as const, "default"),
        ...(typeof endpoint.id === "string" ? { endpoint: { id: endpoint.id, ...(typeof endpoint.listError === "string" ? { listError: endpoint.listError } : {}) } } : {}),
        models: arr(p.models).map(obj).filter((m) => typeof m.id === "string").map((m) => ({
          ...m,
          id: m.id as string,
          name: str(m.name, m.id as string),
          signIns: strings(m.signIns).filter((s): s is SignInId => SIGN_IN_IDS.includes(s as SignInId)),
        })),
      };
    }),
  };
}

const FEEDBACK_MODES: readonly FeedbackMode[] = ["interactive", "auto-approve", "defer"];
const DIALOG_MODES: readonly DialogMode[] = ["interactive", "auto", "defer"];

/** GET /agent-settings: an agent before playtest runs, or a daemon before dialog modes. */
export function agentSettingsOf(raw: unknown): AgentSettings {
  const a = obj(raw);
  const feedback = obj(a.feedbackMode);
  const dialog = obj(a.dialogMode);
  return {
    feedbackTool: a.feedbackTool !== false,
    feedbackMode: { mode: oneOf(feedback.mode, FEEDBACK_MODES, "interactive"), project: feedback.project === true },
    dialogMode: { mode: DIALOG_MODES.includes(dialog.mode as DialogMode) ? (dialog.mode as DialogMode) : null, project: dialog.project === true },
    playtestRuns: a.playtestRuns === "automatic" ? "automatic" : "manual",
    ...(a.restarting === true ? { restarting: true } : {}),
  };
}

const strategyOf = (v: unknown): ContextStrategy | null => {
  const s = typeof v === "string" ? v.toLowerCase() : "";
  return CONTEXT_STRATEGIES.includes(s as ContextStrategy) ? (s as ContextStrategy) : null;
};

/** GET /context-strategy. A seed ue-mcp did not measure is left out rather than shown as 0. */
export function contextOf(raw: unknown): ClientContextStrategy {
  const c = obj(raw);
  const seeds = obj(c.seeds);
  return {
    strategy: strategyOf(c.strategy) ?? "micro",
    fromFile: c.fromFile === true,
    envOverride: strategyOf(c.envOverride),
    seeds: Object.fromEntries(CONTEXT_STRATEGIES.filter((s) => typeof seeds[s] === "number").map((s) => [s, seeds[s]])),
    ...(c.restarting === true ? { restarting: true } : {}),
  };
}

/** GET /v1/install from any ue-mcp. */
export function installOf(raw: unknown): StatusReport {
  const r = obj(raw);
  const project = obj(r.project);
  const toolchain = obj(r.toolchain);
  const node = obj(r.node);
  return {
    ...r,
    ok: r.ok === true,
    problems: arr(r.problems).map(obj).filter((p) => typeof p.code === "string").map((p) => ({ ...p, what: str(p.what, String(p.code)) })),
    clients: arr(r.clients).map(obj).filter((c) => typeof c.id === "string").map((c) => ({ ...c, name: str(c.name, c.id as string) })),
    project: { ...project, name: str(project.name, ""), engine: typeof project.engine === "string" ? project.engine : null, engineAssociation: typeof project.engineAssociation === "string" ? project.engineAssociation : null },
    plugin: obj(r.plugin),
    toolchain: { ...toolchain, present: toolchain.present === true, name: str(toolchain.name, "") },
    node: { ...node, version: str(node.version, "?") },
  } as unknown as StatusReport;
}

/** GET /v1/health from any ue-mcp. */
export function healthOf(raw: unknown): DaemonHealth {
  const h = obj(raw);
  return {
    ...h,
    version: str(h.version, "?"),
    editors: arr(h.editors).map(obj).filter((e) => typeof e.name === "string"),
    extensions: arr(h.extensions).map(obj).filter((x) => typeof x.name === "string").map((x) => ({ name: x.name as string, version: str(x.version, "?") })),
  } as unknown as DaemonHealth;
}

function nativeViewOf(raw: Raw): NativeView {
  return {
    convention: raw.convention as Convention,
    routes: strings(raw.routes),
    instructions: arr(raw.instructions).map(obj).filter((f) => typeof f.path === "string").map((f) => {
      const scope = obj(f.scope);
      return {
        ...f,
        path: f.path as string,
        tokens: num(f.tokens, 0),
        scope: scope.kind === "globs" ? { kind: "globs", globs: strings(scope.globs) } : scope.kind === "folder" && typeof scope.folder === "string" ? { kind: "folder", folder: scope.folder } : { kind: "always" },
      };
    }) as NativeView["instructions"],
    instructionTokens: num(raw.instructionTokens, 0),
    subagents: arr(raw.subagents).map(obj).filter((a) => typeof a.path === "string").map((a) => {
      const runs = obj(a.runs);
      return {
        ...a,
        name: str(a.name, a.path as string),
        description: str(a.description, ""),
        tokens: num(a.tokens, 0),
        tools: str(a.tools, ""),
        runs: { model: str(runs.model, str(a.model, "the main agent's")), ...(typeof runs.note === "string" ? { note: runs.note } : {}) },
        problems: strings(a.problems),
      };
    }) as NativeView["subagents"],
    skills: arr(raw.skills).map(obj).filter((s) => typeof s.path === "string").map((s) => ({
      ...s,
      name: str(s.name, s.path as string),
      description: str(s.description, ""),
      tokens: num(s.tokens, 0),
      implicit: s.implicit !== false,
      problems: strings(s.problems),
    })) as NativeView["skills"],
    notes: strings(raw.notes),
    skipped: arr(raw.skipped).map(obj).filter((f) => typeof f.path === "string").map((f) => ({ path: f.path as string, why: str(f.why, "") })),
  };
}

/** GET /native: each convention this panel knows, each with its lists. */
export function nativeOf(raw: unknown): NativeOverview {
  const n = obj(raw);
  const worker = obj(n.worker);
  return {
    enabled: n.enabled !== false,
    main: CONVENTIONS.includes(n.main as Convention) ? (n.main as Convention) : null,
    conventions: arr(n.conventions).map(obj).filter((c) => CONVENTIONS.includes(c.convention as Convention)).map(nativeViewOf),
    worker: {
      model: typeof worker.model === "string" ? worker.model : null,
      effort: typeof worker.effort === "string" ? worker.effort : null,
      starts: SUBAGENT_MODES.includes(worker.starts as SubagentMode) ? (worker.starts as SubagentMode) : "asked",
    },
  };
}
