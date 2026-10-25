/** What a model turn cost in tokens, from each provider's usage block. */
import type { TokenKinds } from "@ue-mcp-studio/shared";

/**
 * Tokens one model turn cost: input (prompt cache writes included, cache reads
 * left out, since they are billed at a fraction) and output, which budgets
 * count; and every kind the vendor reported, for the usage ledger.
 */
export interface TokenUsage {
  input: number;
  output: number;
  kinds?: TokenKinds;
}

const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
/** A number the vendor reported, or null when it did not report that field. */
const reported = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/** A Messages API usage block as TokenUsage. Anthropic reports all four kinds. */
export function messagesUsage(u: unknown): TokenUsage | undefined {
  if (!u || typeof u !== "object") return undefined;
  const x = u as Record<string, unknown>;
  return {
    input: count(x.input_tokens) + count(x.cache_creation_input_tokens),
    output: count(x.output_tokens),
    kinds: {
      input: reported(x.input_tokens),
      cacheRead: reported(x.cache_read_input_tokens) ?? 0,
      cacheWrite: reported(x.cache_creation_input_tokens) ?? 0,
      output: reported(x.output_tokens),
    },
  };
}

/**
 * A Chat Completions or Responses usage block as TokenUsage: the prompt
 * without its cached part. These APIs report cached reads inside the prompt
 * and have no separate cache write, so that kind is not reported.
 */
export function openaiUsage(u: unknown): TokenUsage | undefined {
  if (!u || typeof u !== "object") return undefined;
  const x = u as Record<string, unknown>;
  const details = (x.prompt_tokens_details ?? x.input_tokens_details) as Record<string, unknown> | undefined;
  const prompt = count(x.prompt_tokens ?? x.input_tokens);
  const cached = reported(details?.cached_tokens);
  return {
    input: Math.max(0, prompt - (cached ?? 0)),
    output: count(x.completion_tokens ?? x.output_tokens),
    kinds: {
      input: Math.max(0, prompt - (cached ?? 0)),
      cacheRead: cached,
      cacheWrite: null,
      output: reported(x.completion_tokens ?? x.output_tokens),
    },
  };
}

/** The tokens a budget counts for a turn. */
export const usageTokens = (u: TokenUsage | undefined): number => (u ? u.input + u.output : 0);

/** The kinds of a usage, from its budget figures when the vendor gave no detail. */
export const kindsOf = (u: TokenUsage): TokenKinds => u.kinds ?? { input: u.input, cacheRead: null, cacheWrite: null, output: u.output };
