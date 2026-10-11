/**
 * The models the picker offers. A connected provider is asked for its own list,
 * so new models appear without a Studio release; until then, and when the
 * provider cannot be reached, a short starting list stands in.
 */
import { KEY_PROVIDER_IDS, PROVIDERS, type KeyProviderId, type ModelCatalog, type ModelOption, type ProviderId } from "@ue-mcp-studio/shared";
import { OPENAI_BASE_URLS } from "./openai-compat.js";

export const DEFAULT_MODELS: Record<ProviderId, ModelOption[]> = {
  studio: [
    { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
    { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
    { id: "claude-fable-5-1", name: "Claude Fable 5.1" },
  ],
  anthropic: [
    { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
    { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
    { id: "claude-fable-5-1", name: "Claude Fable 5.1" },
    { id: "claude-haiku-5-5", name: "Claude Haiku 5.5" },
  ],
  openai: [
    { id: "gpt-6-astra", name: "GPT-6 Astra" },
    { id: "gpt-6-sol", name: "GPT-6 Sol" },
    { id: "gpt-6-luna", name: "GPT-6 Luna" },
  ],
  google: [
    { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro" },
    { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
  ],
};

/** Chat models only: the lists also carry image, audio, embedding and moderation models the agent cannot drive. */
const NOT_CHAT = /(embed|image|audio|realtime|live|tts|transcribe|whisper|dall-e|moderation|search|computer-use|banana|veo|imagen|aqa)/i;

/** OpenAI lists a dated snapshot beside each model it already names. */
const DATED = /-\d{4}-\d{2}-\d{2}$|-\d{8}$/;

export function chatModels(provider: KeyProviderId, ids: Array<{ id: string; name?: string }>): ModelOption[] {
  const keep = (id: string) =>
    !NOT_CHAT.test(id) && !(provider === "openai" && DATED.test(id)) && (provider === "anthropic" ? id.startsWith("claude-") : provider === "openai" ? /^(gpt-|o\d)/.test(id) : id.startsWith("gemini-"));
  return ids
    .map((m) => ({ id: m.id.replace(/^models\//, ""), name: m.name }))
    .filter((m) => keep(m.id))
    .map((m) => ({ id: m.id, name: m.name && m.name !== m.id ? m.name : m.id }))
    .sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
}

async function listLive(provider: KeyProviderId, key: string): Promise<ModelOption[]> {
  const res = provider === "anthropic"
    ? await fetch("https://api.anthropic.com/v1/models?limit=100", { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } })
    : await fetch(`${OPENAI_BASE_URLS[provider]}/models`, { headers: { authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`${PROVIDERS[provider].name} models: ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ id: string; display_name?: string }> };
  return chatModels(provider, (body.data ?? []).map((m) => ({ id: m.id, name: m.display_name })));
}

const TTL_MS = 10 * 60_000;

export class ModelCatalogSource {
  private readonly cache = new Map<string, { at: number; models: ModelOption[] }>();

  constructor(
    private readonly keyOf: (p: KeyProviderId) => string | null,
    /** The models the signed-in plan may run, or null when not signed in or not known. */
    private readonly planModels: () => Promise<string[] | null>,
  ) {}

  async catalog(connected: Record<ProviderId, boolean>): Promise<ModelCatalog> {
    const providers: ModelCatalog["providers"] = [];

    const plan = connected.studio ? await this.planModels().catch(() => null) : null;
    providers.push({
      id: "studio",
      name: PROVIDERS.studio.name,
      connected: connected.studio,
      source: plan ? "live" : "default",
      models: plan ? plan.map((id) => DEFAULT_MODELS.studio.find((m) => m.id === id) ?? { id, name: id }) : DEFAULT_MODELS.studio,
    });

    for (const p of KEY_PROVIDER_IDS) {
      const key = this.keyOf(p);
      let models: ModelOption[] | null = null;
      if (key) {
        // Keyed on the key's tail, so a changed key is asked again.
        const id = `${p}:${key.slice(-6)}`;
        const hit = this.cache.get(id);
        if (hit && Date.now() - hit.at < TTL_MS) models = hit.models;
        else {
          models = await listLive(p, key).catch(() => null);
          if (models && models.length) this.cache.set(id, { at: Date.now(), models });
        }
      }
      const live = !!models && models.length > 0;
      providers.push({ id: p, name: PROVIDERS[p].name, connected: !!key, source: live ? "live" : "default", models: live ? models! : DEFAULT_MODELS[p] });
    }
    return { providers };
  }
}
