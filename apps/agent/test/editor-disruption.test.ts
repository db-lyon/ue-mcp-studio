import { describe, expect, it, vi } from "vitest";
import { runPersonOperation, stopOwnSubagents, type DisruptionDeps, type OwnSubagent } from "../src/editor-disruption.js";
import type { DisruptionView } from "../src/consent.js";

const view = (state: DisruptionView["state"], over: Partial<DisruptionView> = {}): DisruptionView => ({
  id: "r-4e3171",
  op: "rebuild",
  action: "POST /v1/editor/rebuild",
  requester: { id: "http:the user in Studio", label: "the user in Studio" },
  state,
  createdAt: "2026-01-01T00:00:00Z",
  expiresAt: "2026-01-01T00:10:00Z",
  answers: [],
  self: { attestationRequired: state === "confirm", attested: null, inflight: [] },
  ...over,
});

const refused = (request: DisruptionView) => ({ op: "rebuild", steps: [{ step: "consent", ok: false, result: "held", reason: "held" }], request });
const ran = { op: "rebuild", steps: [{ step: "stop", ok: true }, { step: "build", ok: true }] };

function deps(o: { results: Array<Record<string, unknown>>; subagents?: OwnSubagent[]; consent?: boolean }) {
  const queue = [...o.results];
  const editorOperation = vi.fn(async () => queue.shift() ?? ran);
  const confirm = vi.fn(async () => view("pending"));
  const stop = vi.fn(() => true);
  const api = vi.fn(async () => queue.shift() ?? ran);
  const d: DisruptionDeps = {
    consentOn: () => o.consent !== false,
    ledger: { editorOperation, confirm, find: async () => null },
    api,
    subagents: () => o.subagents ?? [],
    stop,
  };
  return { d, editorOperation, confirm, stop, api };
}

describe("runPersonOperation", () => {
  it("confirms none and goes on when a request asks for attestation and no subagent runs", async () => {
    const { d, editorOperation, confirm } = deps({ results: [refused(view("confirm")), ran] });
    const r = await runPersonOperation(d, "rebuild");
    expect(confirm).toHaveBeenCalledWith("r-4e3171", "http:the user in Studio", "none");
    expect(editorOperation).toHaveBeenLastCalledWith("rebuild", expect.objectContaining({ requestId: "r-4e3171" }));
    expect(r).toBe(ran);
  });

  it("passes none up front on the extension API when no subagent runs", async () => {
    const { d, api } = deps({ results: [ran], consent: false });
    await runPersonOperation(d, "stop");
    expect(api).toHaveBeenCalledWith("stop", expect.objectContaining({ person: true, subagents: "none" }));
  });

  it("holds on running subagents until the person agrees, then stops them and confirms paused", async () => {
    const running = [{ sessionId: "s1", callId: "c1", description: "scan assets" }];
    const { d, confirm, stop } = deps({ results: [refused(view("confirm"))], subagents: running });
    const r = await runPersonOperation(d, "rebuild");
    expect(confirm).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(r.subagents).toEqual(running);
    await stopOwnSubagents(d, view("confirm"));
    expect(stop).toHaveBeenCalledWith(running[0]);
    expect(confirm).toHaveBeenCalledWith("r-4e3171", "http:the user in Studio", "paused");
  });

  it("returns another session's block as the refusal, with its request, and does not confirm", async () => {
    const waiting = view("pending", { answers: [{ session: "claude", label: "Claude Code", answer: "wait_until_released", reason: "editing a level", auto: false }] });
    const { d, confirm } = deps({ results: [refused(waiting)] });
    const r = await runPersonOperation(d, "rebuild");
    expect(confirm).not.toHaveBeenCalled();
    expect((r.request as DisruptionView).answers[0].label).toBe("Claude Code");
    expect(r.subagents).toBeUndefined();
  });

  it("finds the request by the id its refusal text names when the result carries none", async () => {
    const find = vi.fn(async () => view("confirm"));
    const first = { op: "rebuild", steps: [{ step: "consent", ok: false, result: "Not run yet: request r-4e3171 to rebuild the editor needs you" }] };
    const { d, confirm } = deps({ results: [first, ran] });
    d.ledger = { ...d.ledger, find };
    const r = await runPersonOperation(d, "rebuild");
    expect(find).toHaveBeenCalledWith("r-4e3171");
    expect(confirm).toHaveBeenCalled();
    expect(r).toBe(ran);
  });
});
