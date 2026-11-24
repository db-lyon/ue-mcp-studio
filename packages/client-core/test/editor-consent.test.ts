import { describe, expect, it } from "vitest";
import {
  HOLD_EXPIRED, HttpError, PENDING_COPY, STUDIO_REQUESTER, answerLines, applyDisruptionEvent, consentAskOf, consentCopy, consentHolders, consentRequestOf, holdOf, holderLine,
  isConsentOp, isOpenRequest, isPendingForPerson, requestTitle, requestsOf, type EditorDisruptionRequest,
} from "../src/index.js";

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

  it("asks about an Update that closes the editor the same way", () => {
    expect(consentCopy("update")).toEqual({
      title: "Other sessions are using the editor",
      lead: "Updating now closes the editor and interrupts those sessions' work in it.",
      approve: "Update anyway",
      cancel: "Cancel",
    });
  });

  it("has no em dashes", () => {
    const dash = String.fromCharCode(0x2014);
    for (const op of ["stop", "restart", "rebuild", "update"] as const) expect(JSON.stringify(consentCopy(op))).not.toContain(dash);
    expect(JSON.stringify(PENDING_COPY) + HOLD_EXPIRED).not.toContain(dash);
  });
});

describe("the requests waiting for a person", () => {
  const agent = (state: EditorDisruptionRequest["state"], id = "r-a1"): EditorDisruptionRequest => ({
    ...request([answer("Claude Code", "go", "idle for 400s"), answer("Studio: Lights", "wait_until_released", "busy (a Studio reply)"), answer("Codex", "block", "saving a level")]),
    id,
    op: "restart",
    action: "editor.restart_editor",
    reason: "load the new C++ class",
    requester: { id: "mcp:cursor", label: "Cursor" },
    state,
  });

  it("lists the open requests GET /v1/disruptions answers, leaving out the person's own", () => {
    const own = { ...agent("pending", "r-own"), requester: { id: "http:the user in Studio", label: STUDIO_REQUESTER } };
    const body = { enforcing: true, requests: [agent("pending"), agent("approved", "r-b2"), own, { id: "" }] };
    expect(requestsOf(body).filter(isPendingForPerson).map((r) => r.id)).toEqual(["r-a1"]);
    expect(requestsOf(null)).toEqual([]);
    expect(isOpenRequest(agent("blocked"))).toBe(true);
    expect(isOpenRequest(agent("confirm"))).toBe(true);
    expect(isOpenRequest(agent("done"))).toBe(false);
  });

  it("follows the event stream: a request opened goes in, a change replaces it, a decision takes it out", () => {
    let list: EditorDisruptionRequest[] = [];
    list = applyDisruptionEvent(list, { type: "disruption.requested", data: agent("pending") });
    expect(list.map((r) => r.state)).toEqual(["pending"]);
    list = applyDisruptionEvent(list, { type: "disruption.updated", data: agent("blocked") });
    expect(list.map((r) => r.state)).toEqual(["blocked"]);
    const same = applyDisruptionEvent(list, { type: "editor.connected", data: agent("approved") });
    expect(same).toBe(list);
    expect(applyDisruptionEvent(list, { type: "disruption.updated", data: agent("approved", "r-other") })).toBe(list);
    list = applyDisruptionEvent(list, { type: "disruption.updated", data: agent("denied") });
    expect(list).toEqual([]);
  });

  it("says who asks for what, and every session's answer, blocks first and agreements last", () => {
    expect(requestTitle(agent("pending"))).toBe("Cursor asks to restart the editor");
    expect(requestTitle({ ...agent("pending"), op: "live_coding" })).toBe("Cursor asks to patch the running editor with Live Coding");
    expect(answerLines(agent("pending")).map((a) => `${a.label}: ${a.state} (${a.tone}), ${a.reason}`)).toEqual([
      "Codex: Blocked (bad), saving a level",
      "Studio: Lights: Waiting (warn), busy (a Studio reply)",
      "Claude Code: Agreed (ok), idle for 400s",
    ]);
  });

  it("reads an Update the agent holds off its event and its route", () => {
    const r = agent("pending");
    expect(holdOf({ hold: { request: r, source: "queue" } })).toEqual({ request: r, source: "queue" });
    expect(holdOf({ hold: null, decided: "approve" })).toBeNull();
    expect(holdOf({ hold: { request: r, source: "elsewhere" } })).toBeNull();
    expect(holdOf(null)).toBeNull();
  });
});
