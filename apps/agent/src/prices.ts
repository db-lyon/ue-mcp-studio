/**
 * The price table Usage estimates cost from: dated and sourced, shipped with
 * Studio and never fetched. A user's own price wins over a shipped one. A
 * model without a price gets no cost: the dashboard says so instead of zero.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { CacheExplainer, Price, PriceTable, TokenKinds } from "@ue-mcp-studio/shared";

export const PRICES_AS_OF = "2026-10-06";
const ANTHROPIC = "https://platform.claude.com/docs/en/about-claude/pricing";

/**
 * Per million tokens. Anthropic's cache write is the five-minute write Studio
 * sends, 1.25 times input. Haiku 5.5's cached read is not in the published
 * table Studio ships, so it stays unpriced rather than guessed.
 */
export const SHIPPED_PRICES: Price[] = [
  { vendor: "anthropic", model: "claude-opus-5-5", perMTok: { input: 4, cacheRead: 0.2, cacheWrite: 5, output: 20 }, asOf: PRICES_AS_OF, source: ANTHROPIC },
  { vendor: "anthropic", model: "claude-sonnet-5-5", perMTok: { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10 }, asOf: PRICES_AS_OF, source: ANTHROPIC },
  { vendor: "anthropic", model: "claude-haiku-5-5", perMTok: { input: 0.1, cacheRead: null, cacheWrite: 0.125, output: 0.5 }, asOf: PRICES_AS_OF, source: ANTHROPIC },
  { vendor: "anthropic", model: "claude-fable-5-1", perMTok: { input: 10, cacheRead: 0.25, cacheWrite: 12.5, output: 50 }, asOf: PRICES_AS_OF, source: ANTHROPIC },
];

/** How each vendor caches, under the same four headings. Shown for the vendors a connected route reaches. */
export const CACHE_EXPLAINERS: CacheExplainer[] = [
  {
    vendor: "anthropic",
    name: "Anthropic",
    what: "The request up to the cache marks: tools, system prompt and the conversation so far. Studio marks every request; on the Claude sign-in the Agent SDK marks them.",
    whoDecides: "The client, by where it places the marks.",
    cachedReadCost: "About a twentieth to a tenth of the input price, by model; writing the cache costs 1.25 times input.",
    howLong: "Five minutes from the last use, renewed by each hit.",
    asOf: PRICES_AS_OF,
    source: "https://platform.claude.com/docs/en/build-with-claude/prompt-caching",
  },
  {
    vendor: "openai",
    name: "OpenAI",
    what: "Any repeated prefix of a long enough prompt, found by the vendor without marks.",
    whoDecides: "The vendor; the client keeps the prefix stable.",
    cachedReadCost: "A fraction of the input price, with no separate charge to write.",
    howLong: "Minutes when idle, kept longer off peak, as the vendor decides.",
    asOf: PRICES_AS_OF,
    source: "https://platform.openai.com/docs/guides/prompt-caching",
  },
  {
    vendor: "google",
    name: "Google",
    what: "Repeated prefixes, cached implicitly by the vendor on current Gemini models.",
    whoDecides: "The vendor, for implicit caching.",
    cachedReadCost: "A fraction of the input price, discounted automatically.",
    howLong: "As the vendor keeps it; implicit caches carry no stated lifetime.",
    asOf: PRICES_AS_OF,
    source: "https://ai.google.dev/gemini-api/docs/caching",
  },
];

/** The price for a model: the user's own first, then the shipped one; a family price ends in *. */
export function priceFor(prices: Price[], vendor: string, model: string): Price | null {
  const match = (p: Price) => p.vendor === vendor && (p.model === model || (p.model.endsWith("*") && model.startsWith(p.model.slice(0, -1))));
  return prices.find((p) => p.user && match(p)) ?? prices.find((p) => !p.user && match(p)) ?? null;
}

/**
 * The cost of a call's tokens, in USD, or null when it cannot be priced: no
 * price, or a kind the call used that the price leaves unpriced.
 */
export function costOf(price: Price | null, t: TokenKinds): number | null {
  if (!price) return null;
  let usd = 0;
  for (const k of ["input", "cacheRead", "cacheWrite", "output"] as const) {
    const n = t[k] ?? 0;
    if (n === 0) continue;
    const per = price.perMTok[k];
    if (per === null) return null;
    usd += (n / 1_000_000) * per;
  }
  return usd;
}

/** The shipped table and the user's own prices, kept in the extension's data dir. */
export class PriceStore {
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "prices.json");
  }

  private own(): Price[] {
    try {
      const v = JSON.parse(fs.readFileSync(this.file, "utf-8")) as { prices?: unknown };
      return Array.isArray(v.prices) ? (v.prices as Price[]).map((p) => ({ ...p, user: true })) : [];
    } catch {
      return [];
    }
  }

  table(): PriceTable {
    return { prices: [...this.own(), ...SHIPPED_PRICES], shippedAsOf: PRICES_AS_OF };
  }

  all(): Price[] {
    return this.table().prices;
  }

  /** Replace the user's own prices; each must name a vendor, a model and at least one rate. */
  setOwn(prices: unknown): PriceTable {
    if (!Array.isArray(prices)) throw new Error("prices must be a list");
    const rate = (v: unknown) => (v === null || v === undefined ? null : typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : NaN);
    const clean: Price[] = prices.map((p, i) => {
      const x = (p ?? {}) as Record<string, unknown>;
      const t = (x.perMTok ?? {}) as Record<string, unknown>;
      const perMTok = { input: rate(t.input), cacheRead: rate(t.cacheRead), cacheWrite: rate(t.cacheWrite), output: rate(t.output) };
      if (typeof x.vendor !== "string" || !x.vendor || typeof x.model !== "string" || !x.model) throw new Error(`price ${i + 1} needs a vendor and a model`);
      if (Object.values(perMTok).some((v) => Number.isNaN(v))) throw new Error(`price ${i + 1}: rates are dollars per million tokens, zero or more`);
      if (Object.values(perMTok).every((v) => v === null)) throw new Error(`price ${i + 1} sets no rate`);
      return { vendor: x.vendor, model: x.model, perMTok, asOf: new Date().toISOString().slice(0, 10), source: "your own" };
    });
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ prices: clean }, null, 2));
    return this.table();
  }
}
