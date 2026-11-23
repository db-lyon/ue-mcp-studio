import { describe, expect, it } from "vitest";
import { HttpError, consentAskOf, consentCopy, consentHolders, consentRequestOf, holderLine, isConsentOp, type EditorDisruptionRequest } from "../src/index.js";

const request = (answers: EditorDisruptionRequest["answers"]): EditorDisruptionRequest => ({
  id: "r-1a2b3c",
  op: "rebuild",
  action: "POST /v1/editor/rebuild",
  requester: { id: "http:the user in Studio", label: "the user in Studio" },
  state: "pending",
  createdAt: "2026-11-23T10:00:00Z",
  expiresAt: "2026-11-23T10:15:00Z",
  answers,
  self: { attestationRequired: false, attested: null, inflight: [] },
});

const answer = (label: string, a: EditorDisruptionRequest["answers"][number]["answer"], reason: string) => ({ session: label.toLowerCase(), label, answer: a, reason, auto: true });

describe("consentRequestOf", () => {
  it("reads the request off a 409 the daemon answered", () => {
    const r = request([answer("Claude Code", "wait_until_released", "busy (blueprint.add_variable)")]);
    expect(consentRequestOf(new HttpError(409, "Not run yet.", { error: "Not run yet.", request: r }))).toEqual(r);
    expect(consentAskOf("rebuild", new HttpError(409, "x", { request: r }))).toEqual({ op: "rebuild", request: r });
  });

  it("reads the web client's error the same way", () => {
    const r = request([]);
    const e = Object.assign(new Error("x"), { status: 409, body: { request: r } });
    expect(consentRequestOf(e)?.id).toBe("r-1a2b3c");
  });

  it("is null for every other error, so an older daemon behaves as before", () => {
    expect(consentRequestOf(new HttpError(409, "Busy."))).toBeNull();
    expect(consentRequestOf(new HttpError(500, "x", { request: request([]) }))).toBeNull();
    expect(consentRequestOf(new HttpError(409, "x", { request: { id: "" } }))).toBeNull();
    expect(consentRequestOf(new Error("network"))).toBeNull();
    expect(consentRequestOf(null)).toBeNull();
  });
});

describe("consentHolders", () => {
  it("lists every session that has not agreed, blocks first, with its reason", () => {
    const holders = consentHolders(request([
      answer("Claude Code", "wait_until_released", "busy (blueprint.add_variable)"),
      answer("Cursor", "go", "idle for 400s"),
      answer("Codex", "unanswered", "active 20s ago and has not answered"),
      answer("Studio: Lights", "block", "saving a level"),
    ]));
    expect(holders.map(holderLine)).toEqual([
      "Studio: Lights: Blocked, saving a level",
      "Claude Code: Waiting, busy (blueprint.add_variable)",
      "Codex: No answer yet, active 20s ago and has not answered",
    ]);
    expect(holders[0].blocked).toBe(true);
  });

  it("names a session by its id when it has no label", () => {
    expect(consentHolders(request([{ session: "abc", label: "", answer: "block", reason: "", auto: false }])).map(holderLine)).toEqual(["abc: Blocked"]);
  });
});

describe("consentCopy", () => {
  it("names the operation on its override and says what it ends", () => {
    expect(consentCopy("rebuild")).toEqual({
      title: "Other sessions are using the editor",
      lead: "Rebuilding now closes the editor and interrupts those sessions' work in it.",
      approve: "Rebuild anyway",
      cancel: "Cancel",
    });
    expect(consentCopy("stop").approve).toBe("Stop anyway");
    expect(consentCopy("restart").lead).toBe("Restarting the editor now interrupts those sessions' work in it.");
  });

  it("holds only stop, restart and rebuild; start takes nothing from anyone", () => {
    expect(["start", "stop", "restart", "rebuild"].filter(isConsentOp)).toEqual(["stop", "restart", "rebuild"]);
  });

  it("has no em dashes", () => {
    const dash = String.fromCharCode(0x2014);
    for (const op of ["stop", "restart", "rebuild"] as const) expect(JSON.stringify(consentCopy(op))).not.toContain(dash);
  });
});
