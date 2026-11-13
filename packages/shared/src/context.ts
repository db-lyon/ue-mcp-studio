/**
 * The context window: how much of it a conversation fills now, how big it is
 * for each model, and when Studio compacts the conversation to make room.
 *
 * "Current context" is what the next request starts from: the last request's
 * whole prompt (uncached, cache writes and cache reads alike) plus the answer
 * it produced. It is never a running sum; the session's spend is kept apart,
 * as totals.
 */

/** One agent's context as its latest model request measured it. */
export interface ContextUsage {
  /** The prompt the request sent, every part: uncached, written to the cache and read from it. */
  input: number;
  /** Of input, the part read from the prompt cache. */
  cached: number;
  /** The answer, reasoning included where the provider counts it there. */
  output: number;
  /** The model that answered. */
  model: string;
  at: string;
  /** Counted from the conversation's text, not reported by a provider: an older session, or one just compacted. */
  estimated?: boolean;
  /** The window the runtime reported for this model, when it reported one (the Claude sign-in does). */
  window?: number;
  /** Where that runtime compacts on its own, when it says. */
  compactAt?: number;
}

/** What a session spent, every agent and request together, since it started. */
export interface SessionSpend {
  /** Prompt tokens not read from the cache, cache writes included. */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /** Of output, reasoning, where the provider reports it. */
  reasoning: number;
  requests: number;
  /** What the requests would cost at the vendor's API prices, when Studio knows them. */
  costUsd?: number;
}

export const EMPTY_TOTALS: SessionSpend = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, requests: 0 };

/** A compaction in the transcript: where it happened and what the agent works from after it. */
export interface CompactionRecord {
  /** auto: the conversation neared the window; manual: Compact now or /compact; overflow: a request was refused as too long. */
  trigger: "auto" | "manual" | "overflow";
  /** running while the summary is written. */
  state: "running" | "done" | "failed";
  /** Context tokens before and after. */
  before: number;
  after?: number;
  /** The summary the agent continues from. */
  summary?: string;
  /** summary: the model summarised; truncated: the summary failed and the oldest part was cut; runtime: the Claude sign-in's runtime compacted. */
  method?: "summary" | "truncated" | "runtime";
  /** The model that wrote the summary. */
  model?: string;
  /** What the user asked the summary to keep, from /compact <text>. */
  instructions?: string;
  error?: string;
  /** How long it took, in milliseconds. */
  ms?: number;
}

/** The first words of the message a compacted conversation starts from. */
export const COMPACTED_PREFIX = "[Studio] This conversation was compacted";

/** Studio compacts a conversation on its own once its context reaches this share of the window. */
export const AUTO_COMPACT_FRACTION = 0.85;
/** The meter warns from this share of the compaction point. */
export const CONTEXT_WARN_FRACTION = 0.75;

/** The window assumed for a model Studio knows nothing about. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * A model's context window in tokens: from the vendor's own list when it gave
 * one, else from what Studio knows of the model's family. `known` is false for
 * the assumed fallback.
 */
export function contextWindowOf(model: string, listed?: number | null): { tokens: number; known: boolean } {
  if (listed && listed > 0) return { tokens: listed, known: true };
  const id = model.toLowerCase().replace(/^models\//, "").replace(/^(anthropic|openai|google)[./]/, "");
  const known = (tokens: number) => ({ tokens, known: true });
  if (id.startsWith("claude-")) {
    // Claude 3, Haiku 4.5 and the 4.x models before 4.6 have 200K; Opus and Sonnet 4.6 and every later model 1M.
    if (/^claude-(3|instant|2)/.test(id) || /^claude-haiku-4/.test(id) || /^claude-(opus|sonnet)-4(-[0-5])?($|-\d{8})/.test(id)) return known(200_000);
    return known(1_000_000);
  }
  if (/^gemini-/.test(id)) return known(1_048_576);
  if (/^gpt-4\.1/.test(id)) return known(1_047_576);
  if (/^gpt-4o|^gpt-4-turbo/.test(id)) return known(128_000);
  if (/^gpt-[5-9]/.test(id) || /codex/.test(id)) return known(400_000);
  if (/^o[1-9]/.test(id)) return known(200_000);
  return { tokens: DEFAULT_CONTEXT_WINDOW, known: false };
}

/** Tokens a context holds now: the last prompt and its answer. */
export const contextTokens = (c: Pick<ContextUsage, "input" | "output">): number => c.input + c.output;

/** A rough token count for text Studio has not had measured: four characters a token. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

/**
 * API prices, US dollars per million tokens, from each vendor's published
 * price page, at the standard tier for prompts under the vendor's long-context
 * threshold. `cacheWrite` is what writing the cache costs as a multiple of
 * input (Anthropic charges 1.25; OpenAI and Google charge input). `from`: the
 * date a price starts, with the earlier price listed after it.
 */
const PRICES: Array<{ match: RegExp; input: number; output: number; cacheRead: number; cacheWrite?: number; from?: string }> = [
  // OpenAI (developers.openai.com/api/docs/pricing, November 2026).
  { match: /^gpt-6-astra/, input: 10, output: 50, cacheRead: 1, cacheWrite: 1 },
  { match: /^gpt-6-sol/, input: 2, output: 10, cacheRead: 0.2, cacheWrite: 1 },
  { match: /^gpt-6-luna/, input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 1 },
  // Google (aistudio.google.com/docs/pricing, November 2026). Output includes thinking tokens.
  { match: /^gemini-3\.1-pro/, input: 2, output: 12, cacheRead: 0.2, cacheWrite: 1 },
  { match: /^gemini-3\.8-flash/, input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 1, from: "2027-01-01" },
  { match: /^gemini-3\.8-flash/, input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 1 },
  // Anthropic.
  { match: /^claude-fable-5/, input: 10, output: 50, cacheRead: 0.25 },
  { match: /^claude-mythos-5/, input: 10, output: 50, cacheRead: 0.25 },
  { match: /^claude-opus-5-5/, input: 4, output: 20, cacheRead: 0.2 },
  { match: /^claude-opus-(5|4-[5-9])/, input: 5, output: 25, cacheRead: 0.5 },
  { match: /^claude-sonnet-5-5/, input: 2, output: 10, cacheRead: 0.2 },
  { match: /^claude-sonnet-5/, input: 2, output: 10, cacheRead: 0.2 },
  { match: /^claude-sonnet-4/, input: 3, output: 15, cacheRead: 0.3 },
  { match: /^claude-haiku-5-5/, input: 0.1, output: 0.5, cacheRead: 0.01 },
  { match: /^claude-haiku-4/, input: 1, output: 5, cacheRead: 0.1 },
];

/** What one request cost at the vendor's API prices, or null for a model Studio has no prices for. */
export function requestCost(model: string, u: { input: number; output: number; cacheRead?: number; cacheWrite?: number }, at: number = Date.now()): number | null {
  const id = model.toLowerCase().replace(/^models\//, "");
  const p = PRICES.find((x) => x.match.test(id) && (!x.from || at >= Date.parse(x.from)));
  if (!p) return null;
  const write = u.cacheWrite ?? 0;
  return ((u.input - write) * p.input + write * p.input * (p.cacheWrite ?? 1.25) + (u.cacheRead ?? 0) * p.cacheRead + u.output * p.output) / 1_000_000;
}

/** One model under two spellings: a dated snapshot, a provider prefix or a window tag such as [1m]. */
export function sameModel(a: string, b: string): boolean {
  const base = (m: string) => m.toLowerCase().replace(/^models\//, "").replace(/^(anthropic|openai|google)[./]/, "").replace(/\[[^\]]*\]$/, "").replace(/-\d{8}$/, "").replace(/@.*$/, "");
  return base(a) === base(b);
}

/** How full a context is, for the meter. */
export type ContextLevel = "ok" | "warn" | "high";

export interface ContextView {
  used: number;
  window: number;
  /** used / window, 0 to 1 and past it when over. */
  fraction: number;
  /** Where compaction happens, as a share of the window. */
  compactAt: number;
  level: ContextLevel;
  /** The window is the fallback, not one Studio knows for this model. */
  windowAssumed: boolean;
  estimated: boolean;
  /** Measured on another model than the one the next turn runs on. */
  measuredOn: string | null;
}

/**
 * The meter's numbers: a measured context against the window of the model the
 * next turn runs on. The window the runtime reported is used only while it is
 * still that model.
 */
export function contextView(c: ContextUsage | undefined, model: string, listed?: number | null): ContextView | null {
  if (!c) return null;
  // An estimate from before Studio kept the model, or the runtime's own spelling of the same model, is that model.
  const same = !c.model || sameModel(c.model, model);
  const runtime = same && c.window ? c.window : null;
  const w = runtime ? { tokens: runtime, known: true } : contextWindowOf(model, listed);
  const used = contextTokens(c);
  const compactAt = runtime && c.compactAt ? Math.min(1, c.compactAt / runtime) : AUTO_COMPACT_FRACTION;
  const fraction = used / w.tokens;
  const level: ContextLevel = fraction >= compactAt * 0.94 ? "high" : fraction >= compactAt * CONTEXT_WARN_FRACTION ? "warn" : "ok";
  return { used, window: w.tokens, fraction, compactAt, level, windowAssumed: !w.known, estimated: !!c.estimated, measuredOn: same ? null : c.model };
}
