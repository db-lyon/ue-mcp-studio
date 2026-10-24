/** What a model turn cost in tokens, from each provider's usage block. */

/**
 * Tokens one model turn cost: input (prompt cache writes included, cache reads
 * left out, since they are billed at a fraction) and output. A playtest loop's
 * budget counts their sum.
 */
export interface TokenUsage {
  input: number;
  output: number;
}

const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/** A Messages API usage block as TokenUsage. */
export function messagesUsage(u: unknown): TokenUsage | undefined {
  if (!u || typeof u !== "object") return undefined;
  const x = u as Record<string, unknown>;
  return { input: count(x.input_tokens) + count(x.cache_creation_input_tokens), output: count(x.output_tokens) };
}

/** A Chat Completions or Responses usage block as TokenUsage: the prompt without its cached part. */
export function openaiUsage(u: unknown): TokenUsage | undefined {
  if (!u || typeof u !== "object") return undefined;
  const x = u as Record<string, unknown>;
  const details = (x.prompt_tokens_details ?? x.input_tokens_details) as Record<string, unknown> | undefined;
  const prompt = count(x.prompt_tokens ?? x.input_tokens);
  return { input: Math.max(0, prompt - count(details?.cached_tokens)), output: count(x.completion_tokens ?? x.output_tokens) };
}

/** The tokens a budget counts for a turn. */
export const usageTokens = (u: TokenUsage | undefined): number => (u ? u.input + u.output : 0);
