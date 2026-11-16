/**
 * Studio's own web search, for a route whose provider runs none on its side
 * (the UE-MCP gateway, a custom endpoint). Where the provider has one (an
 * Anthropic, OpenAI or Google key, the ChatGPT sign-in, the Claude sign-in),
 * that search goes with the request instead (durable/extension.ts) and is paid
 * by the user's own key or subscription; this tool is not offered there.
 *
 * It reads a public HTML results page: no key, no account, nothing to set up.
 */
import type Anthropic from "@anthropic-ai/sdk";

export const WEB_SEARCH_NAME = "web_search";

const SEARCH_URL = "https://html.duckduckgo.com/html/";
const TIMEOUT_MS = 20_000;
const RESULTS_DEFAULT = 8;
const RESULTS_MAX = 20;

export const WEB_SEARCH_TOOL: Anthropic.Beta.BetaTool = {
  name: WEB_SEARCH_NAME,
  description:
    "Search the web and get back the top results, each with its title, URL and a short snippet. "
    + "Use it for current information, documentation, release notes and error messages; then read a page with web_fetch.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to search for" },
      max_results: { type: "number", description: `How many results, ${RESULTS_DEFAULT} by default, at most ${RESULTS_MAX}` },
    },
    required: ["query"],
  },
};

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

const decode = (s: string): string =>
  s.replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** A result link as the page writes it: direct, or through its redirect with the target in `uddg`. */
function target(href: string): string {
  const h = decode(href);
  try {
    const u = new URL(h, "https://duckduckgo.com");
    const real = u.searchParams.get("uddg");
    return real ?? u.href;
  } catch {
    return h;
  }
}

/** The hits on one results page, in order. Ads are left out. */
export function parseResults(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const blocks = html.split(/(?=<div[^>]+class="[^"]*\bresult\b[^"]*")/).slice(1);
  for (const b of blocks) {
    if (/^<div[^>]+class="[^"]*result--ad\b/.test(b)) continue;
    const a = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(b) ?? /<a[^>]+href="([^"]+)"[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/.exec(b);
    if (!a) continue;
    const snip = /class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/.exec(b);
    const url = target(a[1]);
    if (!/^https?:\/\//i.test(url) || /duckduckgo\.com\/y\.js/.test(url)) continue;
    hits.push({ title: decode(a[2]), url, snippet: snip ? decode(snip[1]) : "" });
  }
  return hits;
}

export function validateSearch(i: Record<string, unknown>): string | null {
  if (typeof i.query !== "string" || !i.query.trim()) return "web_search needs query";
  return i.max_results === undefined || (typeof i.max_results === "number" && Number.isFinite(i.max_results)) ? null : "max_results must be a number";
}

export async function webSearch(input: { query: string; max_results?: number }, signal?: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<{ text: string; isError: boolean }> {
  const n = Math.min(Math.max(1, Math.floor(input.max_results ?? RESULTS_DEFAULT)), RESULTS_MAX);
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let html: string;
  try {
    const res = await fetchImpl(SEARCH_URL, {
      method: "POST",
      signal: sig,
      headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) UE-MCP-Studio", accept: "text/html" },
      body: new URLSearchParams({ q: input.query }).toString(),
    });
    if (!res.ok) return { text: `The search failed: the search page answered ${res.status}. Try again shortly, or read a known page with web_fetch.`, isError: true };
    html = await res.text();
  } catch (e) {
    return { text: `The search failed: ${timeout.aborted ? `no answer in ${TIMEOUT_MS / 1000} s` : e instanceof Error ? e.message : String(e)}`, isError: true };
  }
  const hits = parseResults(html).slice(0, n);
  if (!hits.length) {
    const blocked = /anomaly|captcha|unusual traffic/i.test(html);
    return { text: blocked ? "The search page refused this search for now. Try again shortly, or read a known page with web_fetch." : `No results for "${input.query}".`, isError: blocked };
  }
  return { text: hits.map((h, k) => `${k + 1}. ${h.title}\n${h.url}${h.snippet ? `\n${h.snippet}` : ""}`).join("\n\n"), isError: false };
}
