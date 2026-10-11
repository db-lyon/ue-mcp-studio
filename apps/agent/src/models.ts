/**
 * The models the picker offers, each once, under its vendor. A vendor with a
 * saved key is asked for its own list, so new models appear without a Studio
 * release; until then, and when it cannot be reached, a short starting list
 * stands in. Each model names the sign-ins that can run it.
 */
import { KEY_PROVIDER_IDS, PROVIDERS, type KeyProviderId, type ModelCatalog, type ModelOption, type SignInId } from "@ue-mcp-studio/shared";
import { OPENAI_BASE_URLS } from "./openai-compat.js";

/**
 * The Studio plan's models until the signed-in plan says otherwise. The gateway
 * runs Anthropic models only.
 */
export const DEFAULT_PLAN_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1"];

/** Whether the Studio plan can run a model. */
export const inPlan = (vendor: KeyProviderId, model: string, planModels: readonly string[]): boolean =>
  vendor === "anthropic" && planModels.includes(model);

type Listed = Omit<ModelOption, "signIns">;

export const DEFAULT_MODELS: Record<KeyProviderId, Listed[]> = {
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

export function chatModels(provider: KeyProviderId, ids: Array<{ id: string; name?: string }>): Listed[] {
  const keep = (id: string) =>
    !NOT_CHAT.test(id) && !(provider === "openai" && DATED.test(id)) && (provider === "anthropic" ? id.startsWith("claude-") : provider === "openai" ? /^(gpt-|o\d)/.test(id) : id.startsWith("gemini-"));
  return ids
    .map((m) => ({ id: m.id.replace(/^models\//, ""), name: m.name }))
    .filter((m) => keep(m.id))
    .map((m) => ({ id: m.id, name: m.name && m.name !== m.id ? m.name : m.id }))
    .sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
}

async function listLive(provider: KeyProviderId, key: string): Promise<Listed[]> {
  const res = provider === "anthropic"
    ? await fetch("https://api.anthropic.com/v1/models?limit=100", { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } })
    : await fetch(`${OPENAI_BASE_URLS[provider]}/models`, { headers: { authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`${PROVIDERS[provider].name} models: ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ id: string; display_name?: string }> };
  return chatModels(provider, (body.data ?? []).map((m) => ({ id: m.id, name: m.display_name })));
}

const TTL_MS = 10 * 60_000;

/** What can run models besides a vendor key: the Studio plan's models. */
export interface SignInCoverage {
  planModels: readonly string[];
}

/** The sign-ins that can run a model, in the order they are preferred. */
export function signInsFor(vendor: KeyProviderId, model: string, c: SignInCoverage): SignInId[] {
  const out: SignInId[] = [];
  if (vendor === "anthropic") out.push("claude");
  if (inPlan(vendor, model, c.planModels)) out.push("studio");
  return out;
}

export class ModelCatalogSource {
  private readonly cache = new Map<string, { at: number; models: Listed[] }>();

  constructor(private readonly keyOf: (p: KeyProviderId) => string | null) {}

  async catalog(signedIn: Record<SignInId, boolean>, coverage: SignInCoverage): Promise<ModelCatalog> {
    const providers: ModelCatalog["providers"] = [];
    for (const p of KEY_PROVIDER_IDS) {
      const key = this.keyOf(p);
      let models: Listed[] | null = null;
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
      const list = live ? models! : DEFAULT_MODELS[p];
      // A plan model the vendor's list does not name still belongs in the picker.
      const extra = live && p === "anthropic"
        ? DEFAULT_MODELS.anthropic.filter((m) => coverage.planModels.includes(m.id) && !list.some((x) => x.id === m.id))
        : [];
      providers.push({
        id: p,
        name: PROVIDERS[p].name,
        connected: !!key,
        source: live ? "live" : "default",
        models: [...list, ...extra].map((m) => ({ ...m, signIns: signInsFor(p, m.id, coverage) })),
      });
    }
    return { signedIn, providers };
  }
}
