import { describe, expect, it } from "vitest";
import { UPDATE_REQUESTER, UpdateHold, consentOf, refusalOf, updateOp, type HoldDecision, type HoldSource } from "../src/update-hold.js";
import { HOLD_EXPIRED } from "../src/update-queue.js";
// The agent does not depend on client-core; these are read here only to keep the two sides' words the same.
import { HOLD_EXPIRED as CORE_HOLD_EXPIRED } from "../../../packages/client-core/src/update-run.js";
import { STUDIO_REQUESTER } from "../../../packages/client-core/src/editor-consent.js";
import type { DisruptionView } from "../src/consent.js";

const view = (state: DisruptionView["state"], id = "r-1a"): DisruptionView => ({
  id,
  op: "stop",
  action: "POST /v1/editor/stop",
  requester: { id: "http:the user in Studio", label: "the user in Studio" },
  state,
  createdAt: "2026-11-23T10:00:00Z",
  expiresAt: "2026-11-23T10:15:00Z",
  answers: [{ session: "cc", label: "Claude Code", answer: "wait_until_released", reason: "busy (blueprint.add_variable)", auto: true }],
  self: { attestationRequired: false, attested: null, inflight: [] },
});

describe("an Update against the editor consent gate", () => {
  it("reads the gate's refusal off an editor operation's result, and nothing else", () => {
    const r = view("pending");
    expect(refusalOf({ op: "stop", steps: [{ step: "consent", ok: false, reason: "Claude Code is busy" }], request: r })).toEqual({ reason: "Claude Code is busy", request: r });
    expect(refusalOf({ op: "stop", steps: [{ step: "editor.stop_editor", ok: false, result: "a dialog is open" }] })).toBeNull();
    expect(refusalOf({ op: "stop", steps: [{ step: "consent", ok: false }] })).toBeNull();
    expect(refusalOf({})).toBeNull();
  });

  it("asks for the operation the first step that closes the editor performs", () => {
    expect(updateOp(["ueMcp", "plugin", "studio"], true)).toBe("rebuild");
    expect(updateOp(["ueMcp", "plugin", "studio"], false)).toBe("stop");
    expect(updateOp(["ueMcp", "studio"], false)).toBeNull();
    expect(updateOp(["studio", "restart"], true)).toBeNull();
  });

  it("takes only a literal true as the person's override", () => {
    expect(consentOf({ force: true })).toEqual({ force: true });
    expect(consentOf({ force: "yes" })).toEqual({});
    expect(consentOf(undefined)).toEqual({});
  });

  it("names the person and the expiry the same way the clients do", () => {
    expect(UPDATE_REQUESTER).toBe(STUDIO_REQUESTER);
    expect(HOLD_EXPIRED).toBe(CORE_HOLD_EXPIRED);
  });
});

describe("UpdateHold", () => {
  const make = () => {
    const published: Array<{ type: string; data: Record<string, unknown> }> = [];
    const decided: Array<[HoldSource, HoldDecision]> = [];
    const hold = new UpdateHold({ publish: (type, data) => published.push({ type, data }), decided: (s, d) => decided.push([s, d]) });
    return { hold, published, decided };
  };

  it("publishes the hold for every client, and the sessions' answers as they change", () => {
    const { hold, published } = make();
    hold.set(view("pending"), "queue");
    expect(published.at(-1)).toEqual({ type: "update.consent", data: { hold: { request: view("pending"), source: "queue" } } });
    const changed = { ...view("pending"), answers: [] };
    hold.onEvent({ type: "disruption.updated", data: changed });
    expect(hold.current()).toEqual({ request: changed, source: "queue" });
    expect(published).toHaveLength(2);
  });

  it.each([
    ["approved", "approve"],
    ["done", "approve"],
    ["denied", "deny"],
    ["expired", "expired"],
  ] as const)("ends the hold when the request is %s, and says how", (state, decision) => {
    const { hold, published, decided } = make();
    hold.set(view("pending"), "panel");
    hold.onEvent({ type: "disruption.updated", data: view(state) });
    expect(hold.current()).toBeNull();
    expect(published.at(-1)).toEqual({ type: "update.consent", data: { hold: null, decided: decision } });
    expect(decided).toEqual([["panel", decision]]);
  });

  it("ignores other requests and other events", () => {
    const { hold, published, decided } = make();
    hold.onEvent({ type: "disruption.updated", data: view("approved") });
    hold.set(view("pending"), "panel");
    hold.onEvent({ type: "disruption.updated", data: view("approved", "r-other") });
    hold.onEvent({ type: "editor.connected", data: view("approved") });
    expect(hold.current()?.request.id).toBe("r-1a");
    expect(published).toHaveLength(1);
    expect(decided).toEqual([]);
  });
});
