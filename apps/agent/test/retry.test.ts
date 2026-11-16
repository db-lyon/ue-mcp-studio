/** A passing fault does not end a turn: the retrying fetch the model routes send through, and caps that no longer stop the user. */
import { describe, expect, it } from "vitest";
import { fetchRetrying, retryWait } from "../src/retry.js";
import { parseQuickRequest } from "../src/quick.js";
import { SHELL_TIMEOUT_MAX_S } from "../src/local-tools.js";

const answer = (status: number, headers: Record<string, string> = {}) => new Response(status === 200 ? "{}" : "busy", { status, headers });
const noWait = async () => {};

describe("fetchRetrying", () => {
  it("tries again on 429, 5xx, 529 and a dropped connection, and hands back the answer that came through", async () => {
    const seq: Array<number | "drop"> = [529, "drop", 503, 200];
    let calls = 0;
    const f = (async () => {
      const next = seq[calls++];
      if (next === "drop") throw new TypeError("fetch failed");
      return answer(next);
    }) as typeof fetch;
    const res = await fetchRetrying(f, "http://x", { method: "POST", body: "{}" }, { wait: noWait });
    expect(res.status).toBe(200);
    expect(calls).toBe(4);
  });

  it("gives up after four tries with the last answer, and never retries a 400 or a stopped turn", async () => {
    let calls = 0;
    const always = (s: number) => (async () => (calls++, answer(s))) as typeof fetch;
    expect((await fetchRetrying(always(500), "http://x", {}, { wait: noWait })).status).toBe(500);
    expect(calls).toBe(4);
    calls = 0;
    expect((await fetchRetrying(always(400), "http://x", {}, { wait: noWait })).status).toBe(400);
    expect(calls).toBe(1);
    const stop = new AbortController();
    stop.abort();
    const dropped = (async () => {
      calls++;
      throw new Error("aborted");
    }) as typeof fetch;
    calls = 0;
    await expect(fetchRetrying(dropped, "http://x", { signal: stop.signal }, { wait: noWait })).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("waits as retry-after asks, at most 30 s, else 1, 2, 4 s", () => {
    expect(retryWait(1, "3")).toBe(3000);
    expect(retryWait(1, "900")).toBe(30_000);
    expect(retryWait(1, null)).toBe(1000);
    expect(retryWait(3, null)).toBe(4000);
  });
});

describe("caps that no longer stop the user", () => {
  it("a quick ask over a large selection keeps the first 100 items and counts the rest", () => {
    const context = Array.from({ length: 130 }, (_, i) => ({ kind: "actor", label: `A${i}`, path: `/Game/M.M:PersistentLevel.A${i}` }));
    const r = parseQuickRequest({ text: "What are these?", context });
    expect(typeof r).toBe("object");
    if (typeof r === "string") return;
    expect(r.context).toHaveLength(100);
    expect(r.text).toContain("30 more items");
  });

  it("a shell command may run for two hours", () => {
    expect(SHELL_TIMEOUT_MAX_S).toBe(7200);
  });
});
