/**
 * Model access behind one interface: the Studio subscription through the
 * UE-MCP gateway, or the user's own Anthropic, OpenAI or Google key. The agent
 * loop speaks the Messages format; other providers are translated at this edge.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { SettingsStore } from "./settings.js";
import { GATEWAY_CLIENT_HEADER, GATEWAY_CLIENT_PREFIX, GATEWAY_SESSION_HEADER, type ModelRoute } from "@ue-mcp-studio/shared";
import { OpenAICompatibleProvider, OPENAI_BASE_URLS, PROVIDER_EXTRA } from "./openai-compat.js";
import { ResponsesProvider } from "./responses.js";
import type { Effort } from "@ue-mcp-studio/shared";

export type MessageParam = Anthropic.Beta.BetaMessageParam;
export type ContentBlock = Anthropic.Beta.BetaContentBlock;

export interface ModelRequest {
  sessionId: string;
  model: string;
  system: Anthropic.Beta.BetaTextBlockParam[];
  tools: Anthropic.Beta.BetaToolUnion[];
  messages: MessageParam[];
  /** How long the model reasons; high when not given. */
  effort?: Effort;
}

export interface ModelTurn {
  content: ContentBlock[];
  stopReason: string | null;
  /** Set when stop_reason is refusal. */
  refusal?: string;
  /** Web searches the provider ran on its side during the turn, for the transcript. */
  searches?: WebSearchRecord[];
}

export interface WebSearchRecord {
  id: string;
  query: string;
  /** The pages found. */
  results: Array<{ title: string; url: string }>;
  /** Why the search failed, when it did. */
  error?: string;
}

/** The Messages API's own web search, which runs on Anthropic's side. */
export const ANTHROPIC_WEB_SEARCH = { type: "web_search_20250305", name: "web_search", max_uses: 8 } as const;

/** A request refused because of the native search tool, which some accounts and models do not have. */
export const isSearchRefusal = (e: unknown): boolean =>
  (e as { status?: number })?.status === 400 && /web.?search/i.test(e instanceof Error ? e.message : String(e));

/** The searches a Messages response ran: each server_tool_use with its result block. */
export function searchesIn(content: ContentBlock[]): WebSearchRecord[] {
  const blocks = content as unknown as Array<Record<string, unknown>>;
  const out: WebSearchRecord[] = [];
  for (const b of blocks) {
    if (b.type !== "server_tool_use" || b.name !== "web_search") continue;
    const res = blocks.find((r) => r.type === "web_search_tool_result" && r.tool_use_id === b.id);
    const c = res?.content;
    const query = String((b.input as { query?: unknown } | undefined)?.query ?? "");
    if (Array.isArray(c)) out.push({ id: String(b.id), query, results: c.map((r: { title?: string; url?: string }) => ({ title: r.title ?? "", url: r.url ?? "" })) });
    else out.push({ id: String(b.id), query, results: [], error: (c as { error_code?: string } | undefined)?.error_code ?? "no result" });
  }
  return out;
}

export interface ModelProvider {
  /** Stream one model turn, reporting text as it arrives. Rejects with the API's error. */
  run(req: ModelRequest, onText: (text: string) => void, signal: AbortSignal): Promise<ModelTurn>;
}

const MAX_TOKENS = 64000;

/** Models the server-side refusal fallback accepts in its default form on the Claude API. */
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

/**
 * The request body both providers send. The chosen effort, the conversation
 * prefix cached, and the refusal fallback on where the model has one.
 */
export function requestBody(req: ModelRequest): Anthropic.Beta.MessageCreateParamsNonStreaming {
  const body: Anthropic.Beta.MessageCreateParamsNonStreaming = {
    model: req.model,
    max_tokens: MAX_TOKENS,
    system: req.system,
    tools: req.tools,
    messages: withoutProviderExtra(req.messages),
    output_config: { effort: req.effort ?? "high" },
    cache_control: { type: "ephemeral" },
  };
  if (FALLBACK_MODELS.has(req.model)) {
    body.betas = ["server-side-fallback-2026-07-01"];
    body.fallbacks = "default";
  }
  return body;
}

/** The messages without what another provider stored on its tool calls, which the Messages API refuses. */
function withoutProviderExtra(messages: MessageParam[]): MessageParam[] {
  return messages.map((m) => {
    if (typeof m.content === "string" || !m.content.some((b) => PROVIDER_EXTRA in b)) return m;
    return { ...m, content: m.content.map((b) => {
      if (!(PROVIDER_EXTRA in b)) return b;
      const { [PROVIDER_EXTRA]: _, ...rest } = b as unknown as Record<string, unknown>;
      return rest as unknown as typeof b;
    }) };
  });
}

function refusalOf(stopReason: string | null, details: unknown): string | undefined {
  if (stopReason !== "refusal") return undefined;
  const d = details as { category?: string | null; explanation?: string | null } | null | undefined;
  return d?.explanation ?? d?.category ?? "declined";
}

const isEffortRefusal = (e: unknown): boolean =>
  (e as { status?: number })?.status === 400 && /effort/i.test(e instanceof Error ? e.message : String(e));

/** The user's own Anthropic key. */
export class AnthropicProvider implements ModelProvider {
  /** Off once the API refused the native search for this key; turns go on without it. */
  private search = true;

  constructor(private readonly apiKey: string, private readonly client = new Anthropic({ apiKey })) {}

  async run(req: ModelRequest, onText: (text: string) => void, signal: AbortSignal): Promise<ModelTurn> {
    const attempt = async (r: ModelRequest): Promise<Anthropic.Beta.BetaMessage> => {
      if (!this.search) return this.stream(r, onText, signal);
      try {
        return await this.stream({ ...r, tools: [...r.tools, ANTHROPIC_WEB_SEARCH] }, onText, signal);
      } catch (e) {
        if (!isSearchRefusal(e)) throw e;
        this.search = false;
        return this.stream(r, onText, signal);
      }
    };
    let message: Anthropic.Beta.BetaMessage;
    try {
      message = await attempt(req);
    } catch (e) {
      // A model without the chosen level refuses it before writing anything: run at high.
      if (!isEffortRefusal(e) || (req.effort ?? "high") === "high") throw e;
      message = await attempt({ ...req, effort: "high" });
    }
    return {
      content: message.content,
      stopReason: message.stop_reason,
      refusal: refusalOf(message.stop_reason, (message as { stop_details?: unknown }).stop_details),
      searches: searchesIn(message.content),
    };
  }

  private stream(req: ModelRequest, onText: (text: string) => void, signal: AbortSignal): Promise<Anthropic.Beta.BetaMessage> {
    const stream = this.client.beta.messages.stream(requestBody(req), { signal });
    stream.on("text", (delta) => onText(delta));
    return stream.finalMessage();
  }
}

/**
 * The UE-MCP gateway: the same Messages body, sent to the gateway with the
 * account token and the session id. The gateway answers with a Messages
 * response; it streams nothing back yet, so text arrives when the turn ends.
 */
export class GatewayProvider implements ModelProvider {
  constructor(
    private readonly gatewayUrl: string,
    private readonly accountToken: string,
    private readonly agentVersion: string = "0.0.0",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async run(req: ModelRequest, onText: (text: string) => void, signal: AbortSignal): Promise<ModelTurn> {
    const { betas, ...body } = requestBody(req);
    const res = await this.fetchImpl(`${this.gatewayUrl}/v1/messages`, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.accountToken}`,
        [GATEWAY_SESSION_HEADER]: req.sessionId,
        [GATEWAY_CLIENT_HEADER]: `${GATEWAY_CLIENT_PREFIX}${this.agentVersion}`,
        ...(betas ? { "anthropic-beta": betas.join(",") } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`gateway ${res.status}: ${text.slice(0, 300)}`);
    }
    const message = (await res.json()) as Anthropic.Beta.BetaMessage;
    for (const block of message.content) if (block.type === "text") onText(block.text);
    return {
      content: message.content,
      stopReason: message.stop_reason,
      refusal: refusalOf(message.stop_reason, (message as { stop_details?: unknown }).stop_details),
    };
  }
}

/** The provider that runs the selected model on its route, or an error saying how to connect one. */
export function providerFor(
  settings: SettingsStore,
  route: ModelRoute,
  context: { accountToken?: string | null; agentVersion?: string; chatgptToken?: () => Promise<string> } = {},
): ModelProvider {
  const vendor = settings.provider();
  if (route === "chatgpt" && context.chatgptToken) return new ResponsesProvider(context.chatgptToken);
  if (route === "studio" && context.accountToken) {
    return new GatewayProvider(settings.gatewayUrl(), context.accountToken, context.agentVersion);
  }
  if (route === "key") {
    const key = settings.key(vendor)!;
    return vendor === "anthropic" ? new AnthropicProvider(key) : new OpenAICompatibleProvider(OPENAI_BASE_URLS[vendor], key);
  }
  throw new Error(`Sign in to run ${settings.model()}: open the model picker.`);
}
