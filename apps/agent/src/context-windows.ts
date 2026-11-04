/**
 * Context windows the vendors' own model lists gave, by model id: Anthropic's
 * max_input_tokens, the ChatGPT account's context_window, and the fields
 * OpenAI-compatible servers use (context_length, max_model_len and the like).
 * What a list does not say falls back to contextWindowOf in the shared package.
 */
const windows = new Map<string, number>();

/** The fields a model list entry may carry its window in, most specific first. */
const FIELDS = ["max_input_tokens", "context_window", "context_length", "max_context_length", "max_model_len", "inputTokenLimit", "input_token_limit"] as const;

/** The window a model list entry states, or null. */
export function listedWindow(entry: unknown): number | null {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;
  for (const f of FIELDS) {
    const v = e[f];
    if (typeof v === "number" && Number.isFinite(v) && v >= 1024) return Math.floor(v);
  }
  // Some servers nest it: top_provider.context_length, or meta.n_ctx_train.
  const nested = (e.top_provider as Record<string, unknown> | undefined)?.context_length ?? (e.meta as Record<string, unknown> | undefined)?.n_ctx_train;
  return typeof nested === "number" && nested >= 1024 ? Math.floor(nested) : null;
}

/** Keep the window a list stated for a model. */
export function rememberWindow(model: string, entry: unknown): number | null {
  const w = listedWindow(entry);
  if (w) windows.set(model.replace(/^models\//, ""), w);
  return w;
}

/** The window a model list stated for this model, when one did. */
export const knownWindow = (model: string): number | undefined => windows.get(model);
