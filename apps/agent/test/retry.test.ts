/**
 * A passing fault does not end a turn, and caps no longer stop the user. The
 * model requests' retries are pi-ai's, set by the durable harness
 * (MODEL_RETRIES); test/durable/retry.test.ts runs one through a 529.
 */
import { describe, expect, it } from "vitest";
import { parseQuickRequest } from "../src/quick.js";
import { SHELL_TIMEOUT_MAX_S } from "../src/local-tools.js";
import { MODEL_RETRIES } from "../src/durable/pi.js";

describe("model request retries", () => {
  it("try a passing fault three more times, waiting as retry-after asks for at most 30 s", () => {
    expect(MODEL_RETRIES).toEqual({ maxRetries: 3, maxRetryDelayMs: 30_000 });
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
