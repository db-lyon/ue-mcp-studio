/**
 * Model access behind one interface: BYOK (the user's Anthropic API key) or
 * the UE-MCP gateway (the account token). The agent loop never knows which.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { SettingsStore } from "./settings.js";
import { GATEWAY_CLIENT_HEADER, GATEWAY_CLIENT_PREFIX, GATEWAY_SESSION_HEADER } from "@ue-mcp-studio/shared";

export type MessageParam = Anthropic.Beta.BetaMessageParam;
export type ContentBlock = Anthropic.Beta.BetaContentBlock;

export interface ModelRequest {
  sessionId: string;
  model: string;
  system: Anthropic.Beta.BetaTextBlockParam[];
  tools: Anthropic.Beta.BetaToolUnion[];
  messages: MessageParam[];
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
 * The request body both providers send. Agentic work at high effort, the
 * conversation prefix cached, and the refusal fallback on where the model has one.
 */
export function requestBody(req: ModelRequest): Anthropic.Beta.MessageCreateParamsNonStreaming {
  const body: Anthropic.Beta.MessageCreateParamsNonStreaming = {
    model: req.model,
    max_tokens: MAX_TOKENS,
    system: req.system,
    tools: req.tools,
    messages: req.messages,
    output_config: { effort: "high" },
    cache_control: { type: "ephemeral" },
  };
  if (FALLBACK_MODELS.has(req.model)) {
    body.betas = ["server-side-fallback-2026-07-01"];
    body.fallbacks = "default";
  }
  return body;
}

function refusalOf(stopReason: string | null, details: unknown): string | undefined {
  if (stopReason !== "refusal") return undefined;
  const d = details as { category?: string | null; explanation?: string | null } | null | undefined;
  return d?.explanation ?? d?.category ?? "declined";
}

export class ByokProvider implements ModelProvider {
  constructor(private readonly apiKey: string, private readonly client = new Anthropic({ apiKey })) {}

  async run(req: ModelRequest, onText: (text: string) => void, signal: AbortSignal): Promise<ModelTurn> {
    const stream = this.client.beta.messages.stream(requestBody(req), { signal });
    stream.on("text", (delta) => onText(delta));
    const message = await stream.finalMessage();
    return {
      content: message.content,
      stopReason: message.stop_reason,
      refusal: refusalOf(message.stop_reason, (message as { stop_details?: unknown }).stop_details),
    };
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

/** The provider the settings name, or an error saying what is missing. */
export function providerFor(
  settings: SettingsStore,
  context: { registryToken?: string | null; agentVersion?: string } = {},
): ModelProvider {
  if (settings.provider() === "gateway") {
    // A token saved in Settings wins; otherwise the account from `ue-mcp login`.
    const token = settings.accountToken() ?? context.registryToken ?? null;
    if (!token) throw new Error("Sign in with `npx ue-mcp login` (or paste a token in Settings) to use the hosted model, or switch to your own API key.");
    return new GatewayProvider(settings.gatewayUrl(), token, context.agentVersion);
  }
  const key = settings.apiKey();
  if (!key) throw new Error("Add an Anthropic API key in Settings, or sign in to use the hosted model.");
  return new ByokProvider(key);
}
