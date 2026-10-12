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
  constructor(private readonly apiKey: string, private readonly client = new Anthropic({ apiKey })) {}

  async run(req: ModelRequest, onText: (text: string) => void, signal: AbortSignal): Promise<ModelTurn> {
    let message: Anthropic.Beta.BetaMessage;
    try {
      message = await this.stream(req, onText, signal);
    } catch (e) {
      // A model without the chosen level refuses it before writing anything: run at high.
      if (!isEffortRefusal(e) || (req.effort ?? "high") === "high") throw e;
      message = await this.stream({ ...req, effort: "high" }, onText, signal);
    }
    return {
      content: message.content,
      stopReason: message.stop_reason,
      refusal: refusalOf(message.stop_reason, (message as { stop_details?: unknown }).stop_details),
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
