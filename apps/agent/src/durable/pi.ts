/**
 * The one Studio module that touches Pi Durable and pi-ai, at the exact
 * versions apps/agent/package.json pins (pi-durable 1.5.2, pi-ai 1.5.2, and
 * pi-claude-code at commit d5b5e04). An API change upstream lands here and
 * nowhere else: the harness process (harness-main.ts) drives conversations
 * only through DurableEngine, and Studio's extension (extension.ts) only
 * through the Kit it is handed.
 *
 * Conversations: one per Studio session (its main agent), and one per
 * subagent, made by the agent tool and kept ownerless so a subagent that goes
 * on in the background outlives its agent call. A Session-scoped document maps
 * sessions to their conversations, written in the same commit that creates
 * one, so a rerun after a crash finds what an earlier run made.
 */
import { createModels, createProvider } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { createRegistry, defineDoc, defineExtension, defineTool, Harness, LiveDoc } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NOOP_TELEMETRY_CONTEXT } from "@earendil-works/pi-telemetry";
import { createClaudeCodeProvider } from "studio-pi-claude-code";
import type { AgentSpec, AgentStart, EntryEvent, HarnessMessage, HarnessRequest, RouteSpec, ToolDef, UserContent } from "./protocol.js";

/** Pi Durable's call context. Studio never cancels through it: a wait it gives up on is raced instead. */
type Ctx = Parameters<typeof Harness.open>[2];
const CTX = {
  get abortSignal() {
    return undefined;
  },
  get telemetry() {
    return NOOP_TELEMETRY_CONTEXT;
  },
  value: () => undefined,
  toString: () => "studio",
} as unknown as Ctx;

type AnyHarness = Awaited<ReturnType<typeof Harness.open>>;
type AnyConversation = NonNullable<Awaited<ReturnType<AnyHarness["conversation"]>>>;

/** A subagent's conversation, by its agent call. */
interface ChildRecord {
  conv: string;
  /** Its agent call was answered with the background note: its report goes to the main agent as a message. */
  background: boolean;
  /** Its report was handed over (the call's result, or the message to the main agent). */
  reported: boolean;
  description: string;
  /** Its prompt's submission, which its report answers. */
  submission?: string;
  /** The user started it from the chat (a playtest card), not the main agent: its report goes to Studio, and a stop of the main agent leaves it running. */
  assigned?: boolean;
}
interface SessionRecord {
  conv: string;
  children: Record<string, ChildRecord>;
  /** The user's messages to subagents, by request id, until each is read or goes to the main agent. */
  told: Record<string, { callId: string; submission: string }>;
}
interface SessionsDoc {
  sessions: Record<string, SessionRecord>;
}

const Sessions: unknown = (defineDoc as unknown as (d: unknown) => unknown)({
  kind: "studio.sessions",
  version: 1,
  scope: "session",
  initial: () => ({ sessions: {} }),
  checkpointWhen: () => true,
});

/** What Studio's extension is handed: Pi Durable's builders, and the harness's services. */
export interface Kit {
  defineTool: typeof defineTool;
  defineExtension: typeof defineExtension;
  /** Which session and agent a conversation belongs to. */
  whereIs(conv: string): { sessionId: string; parent: string | null } | null;
  /** Ask the daemon to do something; resolves with its answer, from whichever daemon is connected. `onStarted` runs before the daemon may run a tool. */
  request(req: HarnessRequest, onStarted?: () => Promise<void>, signal?: AbortSignal): Promise<unknown>;
  /** Run an agent call's subagent and wait for its report, or for it to go to the background. */
  runSubagent(sessionId: string, callId: string, start: Extract<AgentStart, { ok: true }>, signal: AbortSignal | undefined): Promise<{ text: string; isError: boolean }>;
}

/** Studio's extension: built from the daemon's tool definitions on every change, and replaced in place by registry.install(). */
export type ExtensionFactory = (kit: Kit, tools: ToolDef[]) => ReturnType<typeof defineExtension>;

export interface EngineHost {
  request(req: HarnessRequest, onStarted?: () => Promise<void>, signal?: AbortSignal): Promise<unknown>;
  emit(msg: HarnessMessage): void;
  log(text: string): void;
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** A pi-ai model for a route: the catalog's own entry when it has one, moved to the route's address. */
function modelFor(spec: RouteSpec): Record<string, unknown> {
  const catalog = spec.api === "anthropic-messages" ? "anthropic" : spec.api === "google-generative-ai" ? "google" : spec.api.startsWith("openai") ? "openai" : null;
  let known: Record<string, unknown> | undefined;
  try {
    known = catalog ? (getBuiltinModels(catalog as never) as unknown as Array<Record<string, unknown>>).find((m) => m.id === spec.model) : undefined;
  } catch {
    known = undefined;
  }
  const api = spec.api === "openai-responses" ? "openai-responses" : spec.api;
  return {
    reasoning: true,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: spec.contextWindow ?? 200_000,
    maxTokens: spec.maxTokens ?? 64_000,
    ...(known ?? {}),
    id: spec.model,
    name: (known?.name as string | undefined) ?? spec.model,
    api,
    provider: spec.provider,
    ...(spec.baseUrl ? { baseUrl: spec.baseUrl } : {}),
    ...(spec.maxTokens ? { maxTokens: Math.min(spec.maxTokens, Number(known?.maxTokens ?? spec.maxTokens)) } : {}),
    ...(spec.api === "openai-completions" ? { compat: { supportsDeveloperRole: false, supportsReasoningEffort: false } } : {}),
  };
}

type Streams = { stream: (...a: unknown[]) => unknown; streamSimple: (...a: unknown[]) => unknown };

/** The route's extra headers on every request, and the conversation's session id in the session header. */
function withHeaders(streams: Streams, spec: RouteSpec): Streams {
  if (!spec.headers && !spec.sessionHeader) return streams;
  const wrap = (fn: (...a: unknown[]) => unknown) => (model: unknown, context: unknown, opts?: unknown) => {
    const options = (opts ?? {}) as Record<string, unknown>;
    return fn(model, context, {
      ...options,
      headers: {
        ...(options.headers as Record<string, string> | undefined),
        ...spec.headers,
        ...(spec.sessionHeader ? { [spec.sessionHeader]: String(options.sessionId ?? "") } : {}),
      },
    });
  };
  return { stream: wrap(streams.stream) as Streams["stream"], streamSimple: wrap(streams.streamSimple) as Streams["streamSimple"] };
}

function apiFor(spec: RouteSpec): Streams {
  const api = spec.api === "anthropic-messages" ? anthropicMessagesApi()
    : spec.api === "openai-responses" ? openAIResponsesApi()
    : spec.api === "openai-completions" ? openAICompletionsApi()
    : googleGenerativeAIApi();
  return withHeaders(api as unknown as Streams, spec);
}

/**
 * The model catalog: one provider per route, each holding the models
 * conversations ran on, and the Claude sign-in through pi-claude-code. Its
 * credentials come from the daemon at each request; the last one is kept for
 * while no daemon is connected.
 */
class RouteModels {
  readonly models: ReturnType<typeof createModels> = createModels();
  private readonly specs = new Map<string, Map<string, RouteSpec>>();
  private readonly creds = new Map<string, string>();
  private claude = false;

  constructor(private readonly host: EngineHost) {}

  private async credential(route: string): Promise<string> {
    try {
      const c = (await Promise.race([
        this.host.request({ kind: "credential", route }),
        new Promise((resolve) => setTimeout(() => resolve(undefined), this.creds.has(route) ? 3000 : 60 * 60_000)),
      ])) as string | null | undefined;
      if (typeof c === "string" && c) this.creds.set(route, c);
    } catch {
      // The last one, if any.
    }
    const c = this.creds.get(route);
    if (!c) throw new Error(`No credential for ${route}: connect it in Studio's settings.`);
    return c;
  }

  /** The model reference a conversation runs with, registering its route first. */
  async ref(spec: RouteSpec): Promise<{ provider: string; modelId: string }> {
    if (spec.api === "claude-code") return this.claudeRef(spec);
    let byModel = this.specs.get(spec.provider);
    if (!byModel) this.specs.set(spec.provider, (byModel = new Map()));
    const known = byModel.get(spec.model);
    if (!known || JSON.stringify(known) !== JSON.stringify(spec)) {
      byModel.set(spec.model, spec);
      const all = [...byModel.values()];
      const route = spec.route;
      this.models.setProvider(createProvider({
        id: spec.provider,
        name: spec.provider,
        ...(spec.baseUrl ? { baseUrl: spec.baseUrl } : {}),
        auth: {
          apiKey: {
            name: route,
            resolve: async () => {
              if (spec.auth === "none") return { auth: { apiKey: "none" } };
              const c = await this.credential(route);
              return spec.auth === "bearer" ? { auth: { headers: { authorization: `Bearer ${c}` } } } : { auth: { apiKey: c } };
            },
          },
        },
        models: all.map(modelFor),
        api: apiFor(spec),
      } as never));
    }
    return { provider: spec.provider, modelId: spec.model };
  }

  /** The Claude sign-in: Claude Code as a model with no tools of its own, through pi-claude-code. */
  private async claudeRef(spec: RouteSpec): Promise<{ provider: string; modelId: string }> {
    if (!this.claude) {
      this.models.setProvider(createClaudeCodeProvider() as never);
      this.claude = true;
      try {
        await (this.models as unknown as { refresh(o: unknown): Promise<unknown> }).refresh({ providers: ["claude-code"] });
      } catch (e) {
        this.host.log(`claude-code model refresh failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const ids = (this.models as unknown as { getModels(p: string): Array<{ id: string }> }).getModels("claude-code").map((m) => m.id);
    const bare = (x: string) => x.replace(/\[1m\]$/, "");
    const base = bare(spec.model);
    const family = /opus|sonnet|haiku|fable/.exec(base)?.[0];
    // Studio's name, then Claude Code's own name for the same model, then the newest of its family Claude Code offers.
    const id = ids.find((x) => x === spec.model)
      ?? ids.find((x) => bare(x) === base)
      ?? ids.find((x) => bare(x).startsWith(base) || base.startsWith(bare(x)))
      ?? (family ? ids.find((x) => x.includes(family)) : undefined)
      ?? spec.model;
    return { provider: "claude-code", modelId: id };
  }
}

/** A pi-ai message as the daemon sees it. */
function summarize(e: { id: string; kind: string; conversationId: string; model?: readonly unknown[]; data?: unknown }, sessionId: string, parent: string | null): EntryEvent {
  const base = { t: "entry" as const, sessionId, conv: String(e.conversationId), parent, id: String(e.id), kind: e.kind };
  const m = (e.model?.[0] ?? null) as Record<string, unknown> | null;
  if (e.kind === "pi.compaction") return { ...base, role: "compaction", summary: String((e.data as { summary?: unknown } | undefined)?.summary ?? "") };
  if (!m) return { ...base, role: "other" };
  const content = typeof m.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>) : [];
  const text = content.filter((c) => c.type === "text").map((c) => String(c.text ?? "")).join("");
  if (m.role === "assistant") {
    const u = m.usage as Record<string, number> | undefined;
    return {
      ...base,
      role: "assistant",
      text,
      toolCalls: content.filter((c) => c.type === "toolCall").map((c) => ({ id: String(c.id), name: String(c.name), args: (c.arguments ?? {}) as Record<string, unknown> })),
      ...(u ? { usage: { input: u.input ?? 0, output: u.output ?? 0, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0, ...(u.reasoning !== undefined ? { reasoning: u.reasoning } : {}) } } : {}),
      model: String(m.model ?? ""),
      stopReason: String(m.stopReason ?? ""),
      ...(m.errorMessage ? { errorMessage: String(m.errorMessage) } : {}),
    };
  }
  if (m.role === "toolResult") return { ...base, role: "toolResult", text, callId: String(m.toolCallId), toolName: String(m.toolName ?? ""), isError: !!m.isError };
  return { ...base, role: "user", text };
}

/** Studio's effort as pi-ai's thinking level: the same five names. */
const thinkingOf = (effort: string): string => (["low", "medium", "high", "xhigh", "max"].includes(effort) ? effort : "high");

export class DurableEngine {
  private constructor(
    private readonly harness: AnyHarness,
    private readonly registry: ReturnType<typeof createRegistry>,
    private readonly routes: RouteModels,
    private readonly host: EngineHost,
  ) {}

  /** The last tool definitions per agent kind, so a newer extension can be installed over them. */
  private tools = new Map<string, ToolDef>();
  private factory: ExtensionFactory | null = null;
  /** In memory: sessions and children by conversation, read from the sessions document. */
  private readonly byConv = new Map<string, { sessionId: string; parent: string | null }>();
  /** Conversations watched, with the last entry sent and the live text sent. */
  private readonly watched = new Map<string, { stop: () => Promise<unknown>; last: string | null; text: string; running: boolean; pumping: Promise<void> | null; again: boolean }>();
  /** Foreground agent calls waiting on their subagent, by call id: how to send each to the background. */
  private readonly waiting = new Map<string, () => void>();
  /** Reporters of background subagents running in this process, by call id. */
  private readonly reporters = new Set<string>();

  static async open(file: string, host: EngineHost): Promise<DurableEngine> {
    const routes = new RouteModels(host);
    const registry = createRegistry();
    const storage = await openNodeSqliteStorage(file);
    const harness = await Harness.open(storage, {
      models: () => routes.models,
      registry,
      identity: { attribution: null },
      settings: {
        retry: { maxRetries: 3 },
        progress: { partialIntervalMs: 100, outputIntervalMs: 100, persistWithinMs: 1000 },
        toolExecution: "parallel",
        // A failed run leaves what was queued behind it to the next input, as Studio's loop does.
        afterFailedRun: "continue",
      },
      onReport: (r: { kind: string; error?: unknown }) => host.log(`report ${r.kind}: ${r.error instanceof Error ? r.error.message : String(r.error ?? "")}`),
    } as never, CTX);
    const engine = new DurableEngine(harness, registry, routes, host);
    await engine.load();
    return engine;
  }

  /** Studio's extension, from this process's own code or a newer Studio's. Running calls keep the code they started with. */
  install(factory: ExtensionFactory): void {
    this.factory = factory;
    this.reinstall();
  }

  private reinstall(): void {
    if (!this.factory) return;
    this.registry.install(this.factory(this.kit(), [...this.tools.values()]));
  }

  private kit(): Kit {
    return {
      defineTool,
      defineExtension,
      whereIs: (conv) => this.byConv.get(conv) ?? null,
      request: (req, onStarted, signal) => this.request(req, onStarted, signal),
      runSubagent: (sessionId, callId, start, signal) => this.runSubagent(sessionId, callId, start, signal),
    };
  }

  /** A request to the daemon, sent once every entry before it is: a tool call's entry must reach the daemon first. */
  private async request(req: HarnessRequest, onStarted?: () => Promise<void>, signal?: AbortSignal): Promise<unknown> {
    if (req.kind === "tool") await this.pump(req.conv);
    return this.host.request(req, onStarted, signal);
  }

  private async sessions(): Promise<SessionsDoc> {
    const v = await this.harness.commit(async (tx) => JSON.parse(JSON.stringify(await (tx as unknown as { doc(t: unknown): Promise<unknown> }).doc(Sessions))) as SessionsDoc, CTX);
    return v;
  }

  private async load(): Promise<void> {
    const doc = await this.sessions();
    for (const [sessionId, rec] of Object.entries(doc.sessions)) {
      this.byConv.set(rec.conv, { sessionId, parent: null });
      for (const [callId, c] of Object.entries(rec.children)) this.byConv.set(c.conv, { sessionId, parent: callId });
    }
  }

  /** Start running what the last process left, and the reporters of background subagents. */
  async resume(): Promise<void> {
    this.harness.resume();
    const doc = await this.sessions();
    for (const [sessionId, rec] of Object.entries(doc.sessions)) {
      await this.watch(rec.conv);
      for (const [callId, c] of Object.entries(rec.children)) {
        await this.watch(c.conv);
        if (c.background && !c.reported) this.report(sessionId, callId);
      }
    }
  }

  /** Some task can run now or is running: a run, a tool call, a subagent, a compaction, a sleep due. */
  active(): boolean {
    return this.harness.wake().active || this.reporters.size > 0;
  }

  async close(): Promise<void> {
    for (const w of this.watched.values()) await w.stop().catch(() => undefined);
    await this.harness.close(CTX);
  }

  /** The session's main conversation, made on first use. */
  private async mainConversation(sessionId: string): Promise<AnyConversation> {
    const doc = await this.sessions();
    const existing = doc.sessions[sessionId];
    if (existing) {
      const c = await this.harness.conversation(existing.conv as never, CTX);
      if (c) return c;
    }
    const id = await this.harness.commit(async (tx) => {
      const d = (await (tx as unknown as { doc(t: unknown): Promise<SessionsDoc> }).doc(Sessions));
      const had = d.sessions[sessionId];
      if (had) return had.conv;
      const created = await (tx as unknown as { createConversation(o: unknown): Promise<{ id: string }> }).createConversation({ ownership: { kind: "ownerless" } });
      d.sessions[sessionId] = { conv: String(created.id), children: {}, told: {} };
      return String(created.id);
    }, CTX);
    this.byConv.set(id, { sessionId, parent: null });
    await this.watch(id);
    return (await this.harness.conversation(id as never, CTX))!;
  }

  /** A conversation's model, instructions and tools, from the daemon's spec. */
  private async configure(conv: AnyConversation, spec: AgentSpec, kind: "main" | "child"): Promise<void> {
    for (const t of spec.tools) this.tools.set(t.name, t);
    // Every tool a conversation names is registered before it is selected.
    this.reinstall();
    const model = await this.routes.ref(spec.route);
    const registered = new Map<string, unknown>();
    for (const { tool } of this.registry.snapshot().tools()) registered.set((tool as { name: string }).name, tool);
    const tools = spec.tools.map((t) => registered.get(t.name)).filter(Boolean);
    await conv.configure({
      model,
      thinkingLevel: thinkingOf(spec.effort),
      instructions: spec.system,
      tools,
      maxTurns: spec.maxTurns ?? (kind === "child" ? 200 : null),
    } as never, CTX);
  }

  /** Run the main agent on the user's message: a new run when idle, else steered into the running one or queued after it. */
  async submit(sessionId: string, requestId: string, content: UserContent, agent: AgentSpec, whenBusy: "steer" | "followUp"): Promise<void> {
    const conv = await this.mainConversation(sessionId);
    await this.configure(conv, agent, "main");
    await conv.submit({ type: "input", content, requestId, whenBusy } as never, CTX);
  }

  /** A migrated session's earlier conversation, before its first run. */
  async seed(sessionId: string, messages: Array<{ role: "user" | "assistant"; text: string }>): Promise<void> {
    const conv = await this.mainConversation(sessionId);
    const page = await conv.entries({ order: "ascending" } as never, 1, undefined, CTX);
    if ((page as unknown as { items: unknown[] }).items.length > 0) return;
    const now = Date.now();
    const model = messages.map((m) => m.role === "user"
      ? { role: "user", content: m.text, timestamp: now }
      : { role: "assistant", content: [{ type: "text", text: m.text }], api: "anthropic-messages", provider: "studio", model: "earlier", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: now });
    if (!model.length) return;
    await conv.submit({ type: "write", entry: { kind: "studio.migrated", data: { messages: messages.length }, model } } as never, CTX);
  }

  async abort(sessionId: string, children: boolean): Promise<void> {
    const doc = await this.sessions();
    const rec = doc.sessions[sessionId];
    if (!rec) return;
    const main = await this.harness.conversation(rec.conv as never, CTX);
    const jobs: Array<Promise<unknown>> = [];
    if (children) {
      for (const [callId, c] of Object.entries(rec.children)) {
        // One the user assigned runs beside the main agent's runs: only stopping it stops it.
        if (c.assigned) continue;
        this.waiting.delete(callId);
        const conv = await this.harness.conversation(c.conv as never, CTX);
        if (conv) jobs.push(conv.abort(CTX));
      }
    }
    if (main) jobs.push(main.abort(CTX));
    await Promise.all(jobs);
  }

  async stopChild(sessionId: string, callId: string): Promise<boolean> {
    const doc = await this.sessions();
    const c = doc.sessions[sessionId]?.children[callId];
    if (!c) return false;
    const conv = await this.harness.conversation(c.conv as never, CTX);
    if (!conv) return false;
    await conv.abort(CTX);
    return true;
  }

  /** Every foreground agent call of the session stops waiting: its subagent goes on in the background. */
  async background(sessionId: string): Promise<number> {
    const doc = await this.sessions();
    let n = 0;
    for (const callId of Object.keys(doc.sessions[sessionId]?.children ?? {})) {
      const go = this.waiting.get(callId);
      if (!go) continue;
      go();
      n++;
    }
    return n;
  }

  /** The user's message to a running subagent: steered into its run, read at its next step. False when it is not running. */
  async tell(sessionId: string, callId: string, text: string, requestId: string): Promise<boolean> {
    const doc = await this.sessions();
    const c = doc.sessions[sessionId]?.children[callId];
    if (!c || c.reported) return false;
    const conv = await this.harness.conversation(c.conv as never, CTX);
    if (!conv) return false;
    let submission: { id: string };
    try {
      submission = (await conv.submit({ type: "input", content: text, requestId, whenBusy: "steer", whenIdle: "reject", entry: { kind: "studio.told", data: { requestId } } } as never, CTX)) as unknown as { id: string };
    } catch {
      return false;
    }
    await this.harness.commit(async (tx) => {
      const d = await (tx as unknown as { doc(t: unknown): Promise<SessionsDoc> }).doc(Sessions);
      const rec = d.sessions[sessionId];
      if (rec) rec.told[requestId] = { callId, submission: String(submission.id) };
    }, CTX);
    return true;
  }

  async compact(sessionId: string, instructions: string): Promise<void> {
    const conv = await this.mainConversation(sessionId);
    await conv.compact(instructions || undefined, CTX);
  }

  /** Send the session's entries after the given ones, then its live state. */
  async sync(sessionId: string, after: Record<string, string>): Promise<void> {
    const doc = await this.sessions();
    const rec = doc.sessions[sessionId];
    if (!rec) return;
    const convs = [rec.conv, ...Object.values(rec.children).map((c) => c.conv)];
    for (const conv of convs) {
      const w = this.watched.get(conv);
      if (w) w.last = after[conv] ?? null;
      if (!w) await this.watch(conv);
      const again = this.watched.get(conv);
      if (again) again.last = after[conv] ?? null;
      await this.pump(conv, true);
    }
    for (const [callId, c] of Object.entries(rec.children)) this.host.emit({ t: "child", sessionId, callId, conv: c.conv });
    // Where each run stands now: a run that ended while no daemon was connected ends on this one.
    for (const conv of convs) {
      const w = this.watched.get(conv);
      const where = this.byConv.get(conv);
      if (w && where) this.host.emit({ t: "run", sessionId: where.sessionId, parent: where.parent, running: w.running });
    }
  }

  /** Watch a conversation: its committed entries go out in order, its partial answer as deltas, its runs as they start and end. */
  private async watch(conv: string): Promise<void> {
    if (this.watched.has(conv)) return;
    const c = await this.harness.conversation(conv as never, CTX);
    if (!c) return;
    const w = { stop: async () => undefined as unknown, last: null as string | null, text: "", running: false, pumping: null as Promise<void> | null, again: false };
    this.watched.set(conv, w);
    // Entries already there were sent to an earlier daemon or come with its sync.
    const newest = await c.entries({} as never, 1, undefined, CTX);
    const top = (newest as unknown as { items: Array<{ id: string }> }).items[0];
    w.last = top ? String(top.id) : null;
    const handle = await c.watch(CTX, { min: 1, max: 4 } as never);
    w.stop = () => handle.stop();
    handle.start(async (call: { kind: string; value?: { docs?: Record<string, unknown> } }) => {
      if (call.kind !== "value") return;
      const where = this.byConv.get(conv);
      if (!where) return;
      const live = (call.value?.docs?.[(LiveDoc as unknown as { definition: { kind: string } }).definition.kind] ?? call.value?.docs?.["pi.live"]) as Record<string, unknown> | undefined;
      const running = !!live?.run;
      // A run's end goes out after its last entry.
      if (running !== w.running) await this.pump(conv);
      else void this.pump(conv);
      if (running !== w.running) {
        w.running = running;
        const failure = live?.runFailure as { reason?: string; detail?: string } | undefined;
        this.host.emit({ t: "run", sessionId: where.sessionId, parent: where.parent, running, ...(!running && failure?.reason ? { failure: { reason: failure.reason, ...(failure.detail ? { detail: failure.detail } : {}) } } : {}) });
      }
      const msg = (live?.generation as { message?: Record<string, unknown> } | undefined)?.message;
      const content = Array.isArray(msg?.content) ? (msg!.content as Array<Record<string, unknown>>) : [];
      const text = content.filter((x) => x.type === "text").map((x) => String(x.text ?? "")).join("");
      if (text && text !== w.text) {
        w.text = text;
        this.host.emit({ t: "delta", sessionId: where.sessionId, parent: where.parent, text });
      } else if (!msg) w.text = "";
    });
  }

  /** Send a conversation's entries committed since the last one sent, in order. */
  private pump(conv: string, force = false): Promise<void> {
    const w = this.watched.get(conv);
    if (!w) return Promise.resolve();
    if (w.pumping) {
      w.again = true;
      return force ? w.pumping.then(() => this.pump(conv)) : w.pumping;
    }
    w.pumping = (async () => {
      try {
        do {
          w.again = false;
          const where = this.byConv.get(conv);
          const c = await this.harness.conversation(conv as never, CTX);
          if (!c || !where) return;
          for (;;) {
            const q = { order: "ascending", ...(w.last ? { minEntryId: w.last } : {}) };
            const page = (await c.entries(q as never, 100, undefined, CTX)) as unknown as { items: Array<{ id: string; kind: string; conversationId: string; model?: unknown[]; data?: unknown }> };
            const items = page.items.filter((e) => !w.last || this.later(String(e.id), w.last));
            if (!items.length) break;
            for (const e of items) {
              this.host.emit(summarize(e, where.sessionId, where.parent));
              w.last = String(e.id);
              if (e.kind === "studio.told") void this.toldPlaced(where.sessionId, (e.data as { requestId?: string } | undefined)?.requestId);
            }
            if (items.length < 100) break;
          }
        } while (w.again);
      } catch (e) {
        this.host.log(`pump ${conv}: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        w.pumping = null;
      }
    })();
    return w.pumping;
  }

  /** Entry ids are opaque but ordered; a query's bound is inclusive, so the one sent last is filtered out. */
  private later(a: string, b: string): boolean {
    if (/^\d+$/.test(a) && /^\d+$/.test(b)) return BigInt(a) > BigInt(b);
    return a.length !== b.length ? a.length > b.length : a > b;
  }

  /** A message to a subagent was placed in its conversation: it reads it with its next step. */
  private async toldPlaced(sessionId: string, requestId: string | undefined): Promise<void> {
    if (!requestId) return;
    const doc = await this.sessions();
    const t = doc.sessions[sessionId]?.told[requestId];
    if (!t) return;
    await this.harness.commit(async (tx) => {
      const d = await (tx as unknown as { doc(t: unknown): Promise<SessionsDoc> }).doc(Sessions);
      delete d.sessions[sessionId]?.told[requestId];
    }, CTX);
    this.host.emit({ t: "told", sessionId, callId: t.callId, requestId, delivery: "read" });
  }

  /** The subagent's conversation for an agent call: the one an earlier run made, or a new one. */
  private async childConversation(sessionId: string, callId: string, description: string): Promise<AnyConversation> {
    const id = await this.harness.commit(async (tx) => {
      const d = await (tx as unknown as { doc(t: unknown): Promise<SessionsDoc> }).doc(Sessions);
      const rec = d.sessions[sessionId];
      if (!rec) throw new Error(`no conversation for session ${sessionId}`);
      const had = rec.children[callId];
      if (had) return had.conv;
      const created = await (tx as unknown as { createConversation(o: unknown): Promise<{ id: string }> }).createConversation({ ownership: { kind: "ownerless" } });
      rec.children[callId] = { conv: String(created.id), background: false, reported: false, description };
      return String(created.id);
    }, CTX);
    this.byConv.set(id, { sessionId, parent: callId });
    await this.watch(id);
    this.host.emit({ t: "child", sessionId, callId, conv: id });
    return (await this.harness.conversation(id as never, CTX))!;
  }

  private async markChild(sessionId: string, callId: string, change: Partial<ChildRecord>): Promise<void> {
    await this.harness.commit(async (tx) => {
      const d = await (tx as unknown as { doc(t: unknown): Promise<SessionsDoc> }).doc(Sessions);
      const c = d.sessions[sessionId]?.children[callId];
      if (c) Object.assign(c, change);
    }, CTX);
  }

  /** The report a subagent's run ended with: its last answer, or why it ended without one. */
  private async reportOf(conv: AnyConversation, settled: { status: string; reason?: string; detail?: string }): Promise<{ text: string; isError: boolean; stopped: boolean }> {
    if (settled.status === "unanswered") {
      const stopped = settled.reason === "aborted";
      return {
        text: stopped ? "The user stopped this subagent before it finished. Do not redo its task unless the user asks." : `The subagent failed: ${settled.reason ?? "no answer"}${settled.detail ? ` (${settled.detail})` : ""}`,
        isError: true,
        stopped,
      };
    }
    const page = (await conv.entries({} as never, 20, undefined, CTX)) as unknown as { items: Array<{ model?: Array<Record<string, unknown>> }> };
    for (const e of page.items) {
      const m = e.model?.[0];
      if (m?.role !== "assistant") continue;
      const text = (Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>) : []).filter((c) => c.type === "text").map((c) => String(c.text ?? "")).join("");
      if (text.trim()) return { text, isError: false, stopped: false };
    }
    return { text: "The subagent finished without a report.", isError: false, stopped: false };
  }

  /** Messages the user sent a subagent that it never read: withdrawn, and named in its report to the main agent. */
  private async unread(sessionId: string, callId: string): Promise<string[]> {
    const doc = await this.sessions();
    const told = Object.entries(doc.sessions[sessionId]?.told ?? {}).filter(([, t]) => t.callId === callId);
    const texts: string[] = [];
    for (const [requestId, t] of told) {
      const sub = await this.harness.submission(t.submission as never, CTX);
      const rec = sub ? ((await sub.status(CTX)) as unknown as { status: string; content?: unknown }) : null;
      if (sub && rec?.status === "queued") {
        await sub.abort(CTX).catch(() => undefined);
        texts.push(typeof rec.content === "string" ? rec.content : "");
        this.host.emit({ t: "told", sessionId, callId, requestId, delivery: "main" });
      }
    }
    if (told.length) {
      await this.harness.commit(async (tx) => {
        const d = await (tx as unknown as { doc(t: unknown): Promise<SessionsDoc> }).doc(Sessions);
        for (const [requestId] of told) delete d.sessions[sessionId]?.told[requestId];
      }, CTX);
    }
    return texts;
  }

  /**
   * One agent call's subagent: its conversation (found again on a rerun), its
   * prompt submitted once by request id, and its report. The call waits for
   * it, unless the daemon sends the session's subagents to the background:
   * then the call answers at once and a reporter hands the report to the main
   * agent as a message when the subagent ends. An aborted call stops it.
   */
  private async runSubagent(sessionId: string, callId: string, start: Extract<AgentStart, { ok: true }>, signal: AbortSignal | undefined): Promise<{ text: string; isError: boolean }> {
    const conv = await this.childConversation(sessionId, callId, start.description);
    const doc = await this.sessions();
    const rec = doc.sessions[sessionId]?.children[callId];
    if (rec?.background) return { text: backgroundText(start.description), isError: false };
    await this.configure(conv, start.spec, "child");
    const submission = await conv.submit({ type: "input", content: start.prompt, requestId: `agent:${callId}` } as never, CTX);
    if (rec?.submission !== String(submission.id)) await this.markChild(sessionId, callId, { submission: String(submission.id) });
    let toBackground!: () => void;
    const backgrounded = new Promise<"background">((resolve) => (toBackground = () => resolve("background")));
    this.waiting.set(callId, toBackground);
    const aborted = new Promise<"aborted">((resolve) => {
      if (signal?.aborted) resolve("aborted");
      signal?.addEventListener("abort", () => resolve("aborted"), { once: true });
    });
    try {
      const first = await Promise.race([submission.wait(CTX), backgrounded, aborted]);
      if (first === "background") {
        await this.markChild(sessionId, callId, { background: true });
        this.report(sessionId, callId);
        return { text: backgroundText(start.description), isError: false };
      }
      if (first === "aborted") {
        await conv.abort(CTX).catch(() => undefined);
        await this.markChild(sessionId, callId, { reported: true });
        return { text: "Stopped by the user.", isError: true };
      }
      const r = await this.reportOf(conv, first as unknown as { status: string; reason?: string; detail?: string });
      const unread = await this.unread(sessionId, callId);
      await this.markChild(sessionId, callId, { reported: true });
      const text = unread.length ? `${r.text}\n\n[Studio] The user wrote to this subagent and it ended before reading it:\n${unread.map((t) => `- ${t}`).join("\n")}` : r.text;
      return { text, isError: r.isError };
    } finally {
      this.waiting.delete(callId);
    }
  }

  /**
   * A subagent the user assigned from the chat: the same subagent conversation
   * an agent call makes, under its own call id, but no agent call waits on it.
   * It runs beside the main agent's runs, whether one is running or not, and
   * its reporter hands its report to the daemon only. Sent again after a
   * restart, it finds the same conversation and the same submission.
   */
  async assign(sessionId: string, callId: string, start: Extract<AgentStart, { ok: true }>): Promise<void> {
    await this.mainConversation(sessionId);
    const conv = await this.childConversation(sessionId, callId, start.description);
    const rec = (await this.sessions()).sessions[sessionId]?.children[callId];
    if (rec?.reported) return;
    await this.configure(conv, start.spec, "child");
    const submission = await conv.submit({ type: "input", content: start.prompt, requestId: `agent:${callId}` } as never, CTX);
    await this.markChild(sessionId, callId, { submission: String(submission.id), background: true, assigned: true });
    this.report(sessionId, callId);
  }

  /** A background subagent's reporter: when it ends, its report goes to the main agent as a message, once (to the daemon only, for one the user assigned). */
  private report(sessionId: string, callId: string): void {
    if (this.reporters.has(callId)) return;
    this.reporters.add(callId);
    void (async () => {
      try {
        const doc = await this.sessions();
        const rec = doc.sessions[sessionId];
        const c = rec?.children[callId];
        if (!rec || !c || c.reported) return;
        const conv = await this.harness.conversation(c.conv as never, CTX);
        const sub = c.submission ? await this.harness.submission(c.submission as never, CTX) : undefined;
        if (!conv || !sub) return;
        const settled = await sub.wait(CTX);
        const r = await this.reportOf(conv, settled as unknown as { status: string; reason?: string; detail?: string });
        const unread = await this.unread(sessionId, callId);
        const text = unread.length ? `${r.text}\n\n[Studio] The user wrote to this subagent and it ended before reading it:\n${unread.map((t) => `- ${t}`).join("\n")}` : r.text;
        this.host.emit({ t: "agentEnd", sessionId, callId, text, isError: r.isError, stopped: r.stopped, background: true, ...(c.assigned ? { assigned: true } : {}) });
        // One the user stopped wakes nobody: the daemon keeps its note for the next message. One the user assigned reports to the daemon alone.
        if (!r.stopped && !c.assigned) {
          const main = await this.harness.conversation(rec.conv as never, CTX);
          const note = `[Studio] The subagent "${c.description}" (agent call ${callId}), which kept working in the background, has ended. ${r.isError ? "It failed." : "It finished."} Its report:\n${text}`;
          await main?.submit({ type: "input", content: note, requestId: `report:${callId}`, whenBusy: "steer" } as never, CTX);
        }
        await this.markChild(sessionId, callId, { reported: true });
      } catch (e) {
        this.host.log(`reporter ${callId}: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        this.reporters.delete(callId);
      }
    })();
  }
}

const backgroundText = (description: string): string =>
  `The subagent "${description}" keeps working in the background: the user wrote to you, or stopped only your reply, while it worked. `
  + "Its report comes to you in a later message when it ends. Do not redo its task meanwhile.";
