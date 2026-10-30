/**
 * A queue route that throws answers 500 with the error, logged, rather than
 * leaving the exception to the daemon (#165).
 */
import { describe, expect, it } from "vitest";
import type { ExtensionRequest } from "ue-mcp/daemon";
import { guardedRoute } from "../src/guarded-route.js";

const req = { method: "PUT", path: "/sessions/s1/queue/q1", params: { id: "s1", qid: "q1" }, query: {}, headers: {}, body: { text: "x" } } as unknown as ExtensionRequest;

describe("a guarded route", () => {
  it("answers 500 with the error when the handler throws", async () => {
    const warned: string[] = [];
    const route = guardedRoute({ warn: (m) => void warned.push(m) }, "changing a queued message", () => {
      throw new Error("EPERM: operation not permitted, rename");
    });
    expect(await route(req)).toEqual({ status: 500, body: { error: "changing a queued message failed: EPERM: operation not permitted, rename" } });
    expect(warned).toEqual(["changing a queued message failed"]);
  });

  it("answers 500 when an async handler rejects", async () => {
    const route = guardedRoute({ warn() {} }, "queueing a message", async () => {
      throw new Error("disk full");
    });
    expect(await route(req)).toMatchObject({ status: 500 });
  });

  it("passes a handler's own answer through", async () => {
    const route = guardedRoute({ warn() {} }, "removing a queued message", () => ({ status: 204 }));
    expect(await route(req)).toEqual({ status: 204 });
  });
});
