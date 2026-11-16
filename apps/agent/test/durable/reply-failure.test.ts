/** A reply that ends without an answer never leaves the user at a dead end: it says the way on. */
import { describe, expect, it } from "vitest";
import { replyFailure } from "../../src/durable/runtime.js";

describe("a reply that ended without an answer", () => {
  it("offers Compact and a new session when the conversation is too long", () => {
    const t = replyFailure("error", "prompt is too long: 230000 tokens > 200000 maximum");
    expect(t).toMatch(/^The reply ended without an answer \(error\): prompt is too long/);
    expect(t).toMatch(/Use Compact now \(or send \/compact\)/);
    expect(t).toMatch(/start a new session/);
  });

  it("offers a retry for any other failure, picking up where it stopped", () => {
    const t = replyFailure("turn_limit", "200 turns");
    expect(t).toMatch(/send a message \(or "continue"\) to retry/);
    expect(t).not.toMatch(/Compact/);
  });
});
