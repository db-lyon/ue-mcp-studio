/**
 * Web search on the durable runtime: the provider's own search in each API's
 * request format, pi-claude-code's request body reaching it, and Studio's own
 * search for routes whose provider has none.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { isSearchRefusal, withProviderSearch } from "../../src/durable/extension.js";
import { parseResults, webSearch } from "../../src/web-search.js";
// @ts-expect-error a build script without types
import { patchClaudeCodeStream } from "../../../../scripts/pi-claude-code-patch.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

describe("the provider's own web search", () => {
  it("goes into each API's request body in its own format, once", () => {
    const fn = { name: "ue_mcp", input_schema: {} };
    expect(withProviderSearch("anthropic-messages", { tools: [fn] })).toMatchObject({ tools: [fn, { type: "web_search_20250305", name: "web_search" }] });
    expect(withProviderSearch("claude-code-stream-json", { tools: [fn], max_tokens: 10 })).toMatchObject({ max_tokens: 10, tools: [fn, { type: "web_search_20250305" }] });
    expect(withProviderSearch("openai-responses", { tools: [{ type: "function", name: "x" }] })).toMatchObject({ tools: [{ type: "function" }, { type: "web_search" }] });
    expect(withProviderSearch("google-generative-ai", { config: { tools: [{ functionDeclarations: [] }] } })).toMatchObject({ config: { tools: [{ functionDeclarations: [] }, { googleSearch: {} }] } });
    const twice = withProviderSearch("anthropic-messages", withProviderSearch("anthropic-messages", { tools: [] })) as { tools: unknown[] };
    expect(twice.tools).toHaveLength(1);
    expect(withProviderSearch("openai-completions", { tools: [] })).toBeUndefined();
  });

  it("recognizes a provider refusing its search tool", () => {
    expect(isSearchRefusal("400 invalid_request_error: web_search is not enabled for this organization")).toBe(true);
    expect(isSearchRefusal("Tool use with function calling is unsupported")).toBe(true);
    expect(isSearchRefusal("overloaded")).toBe(false);
  });

  it("reaches the Claude sign-in's request body: the pinned pi-claude-code calls onPayload with it", () => {
    const file = path.join(root, "node_modules", "@earendil-works", "pi-claude-code", "src", "stream.ts");
    const patched = patchClaudeCodeStream(fs.readFileSync(file, "utf-8")) as string;
    expect(patched).toContain("await options?.onPayload?.(extraBody, model)");
    expect(patched.indexOf("onPayload")).toBeLessThan(patched.indexOf("await runClaudeRequest("));
    expect(() => patchClaudeCodeStream("export {}")).toThrow(/update scripts\/pi-claude-code-patch/);
  });
});

describe("Studio's own web search", () => {
  const page = `
    <div class="result results_links results_links_deep web-result "><div class="links_main links_deep result__body">
      <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdev.epicgames.com%2Fdocs%3Fa%3D1&amp;rut=x">Unreal &amp; <b>5.9</b></a></h2>
      <a class="result__snippet" href="x">What is <b>new</b> in 5.9.</a>
    </div></div>
    <div class="result result--ad"><a class="result__a" href="https://ads.example">Ad</a></div>
    <div class="result results_links"><a rel="nofollow" class="result__a" href="https://forums.example/t/1">Forum</a></div>`;

  it("reads the results page: titles, real URLs and snippets, without ads", () => {
    expect(parseResults(page)).toEqual([
      { title: "Unreal & 5.9", url: "https://dev.epicgames.com/docs?a=1", snippet: "What is new in 5.9." },
      { title: "Forum", url: "https://forums.example/t/1", snippet: "" },
    ]);
  });

  it("answers the model with numbered results, and says so when the page refuses", async () => {
    const ok = await webSearch({ query: "ue 5.9" }, undefined, (async () => new Response(page, { status: 200 })) as typeof fetch);
    expect(ok).toMatchObject({ isError: false });
    expect(ok.text).toMatch(/^1\. Unreal & 5\.9\nhttps:\/\/dev\.epicgames\.com\/docs\?a=1\nWhat is new/);
    const blocked = await webSearch({ query: "ue 5.9" }, undefined, (async () => new Response("<p>anomaly detected</p>", { status: 200 })) as typeof fetch);
    expect(blocked.isError).toBe(true);
  });
});
