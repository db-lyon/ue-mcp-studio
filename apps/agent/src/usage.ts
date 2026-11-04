/** What a model turn cost in tokens, from each provider's usage block. */

/**
 * Tokens one model request used. `input` is the prompt without cache reads
 * (cache writes included, as they are billed at full price or more); the
 * cache reads are `cacheRead`. `cacheWrite` and `reasoning` are parts of
 * input and output, where the provider reports them.
 */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
}

const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/** A Messages API usage block as TokenUsage. */
export function messagesUsage(u: unknown): TokenUsage | undefined {
  if (!u || typeof u !== "object") return undefined;
  const x = u as Record<string, unknown>;
  const write = count(x.cache_creation_input_tokens);
  return { input: count(x.input_tokens) + write, output: count(x.output_tokens), cacheRead: count(x.cache_read_input_tokens), cacheWrite: write };
}

/**
 * A Chat Completions or Responses usage block as TokenUsage: these APIs
 * report the cached part inside the prompt, and reasoning inside the output.
 */
export function openaiUsage(u: unknown): TokenUsage | undefined {
  if (!u || typeof u !== "object") return undefined;
  const x = u as Record<string, unknown>;
  const details = (x.prompt_tokens_details ?? x.input_tokens_details) as Record<string, unknown> | undefined;
  const out = (x.completion_tokens_details ?? x.output_tokens_details) as Record<string, unknown> | undefined;
  const prompt = count(x.prompt_tokens ?? x.input_tokens);
  const cached = Math.min(prompt, count(details?.cached_tokens));
  return { input: prompt - cached, output: count(x.completion_tokens ?? x.output_tokens), cacheRead: cached, reasoning: count(out?.reasoning_tokens) };
}

/** The tokens a turn counts toward an agent's spend: input and output, cache reads left out. */
export const usageTokens = (u: TokenUsage | undefined): number => (u ? u.input + u.output : 0);

/** The whole prompt a request sent: what the next request starts from, with the answer. */
export const promptTokens = (u: TokenUsage): number => u.input + (u.cacheRead ?? 0);

/** The difference between two reports of the same message's usage, field by field, never negative. */
export function usageGrowth(now: TokenUsage, before: TokenUsage | undefined): TokenUsage {
  const d = (a: number | undefined, b: number | undefined) => Math.max(0, (a ?? 0) - (b ?? 0));
  return { input: d(now.input, before?.input), output: d(now.output, before?.output), cacheRead: d(now.cacheRead, before?.cacheRead), cacheWrite: d(now.cacheWrite, before?.cacheWrite), reasoning: d(now.reasoning, before?.reasoning) };
}
