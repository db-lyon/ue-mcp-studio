/**
 * ue-mcp's editor consent gate on the phone: the requests from other sessions
 * waiting for a person, with Approve behind the PIN, and an Update the
 * computer is holding for the sessions using the editor.
 */
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { createLock, studioApi, type EditorDisruptionRequest, type Reply, type StreamEvent, type Transport } from "@ue-mcp-studio/client-core";
import { PendingDisruptions } from "../src/views/PendingDisruptions";
import { UpdateRunner, resetRunForTests } from "../src/views/UpdateOverlay";
import { ProjectContext } from "../src/nav";
import { fakeApi, fakeProject, renderInProject, settle } from "./helpers";

const request = (state: EditorDisruptionRequest["state"], id = "r-c0de"): EditorDisruptionRequest => ({
  id,
  op: "restart",
  action: "editor.restart_editor",
  reason: "load the new DoorComponent C++ class",
  requester: { id: "mcp-7f2a", label: "Claude Code" },
  state,
  createdAt: "2026-11-23T10:00:00Z",
  expiresAt: "2099-11-23T10:15:00Z",
  answers: [
    { session: "studio:s-4", label: "Studio: Dress the courtyard", answer: "wait_until_released", reason: "busy (a Studio reply)", auto: true },
    { session: "cursor", label: "Cursor", answer: "go", reason: "idle for 412s", auto: true },
  ],
  self: { attestationRequired: true, attested: "none", inflight: [] },
});

const health = (features: string[]) => ({ version: "1.4.12", editors: [], features });

/** Render the view again inside the same project. */
const again = (view: ReturnType<typeof renderInProject>, ui: ReactNode) => view.rerender(<ProjectContext.Provider value={view.nav}>{ui}</ProjectContext.Provider>);
let nextId = 1;
const ev = (type: string, data: unknown): StreamEvent => ({ id: nextId++, type, at: new Date().toISOString(), data: data as Record<string, unknown> });

describe("requests waiting for a person, on the phone", () => {
  it("shows who asks, what for, and every session's answer, without taking focus", async () => {
    const api = fakeApi();
    api.disruptions.mockResolvedValue({ requests: [request("pending"), request("approved", "r-done")] });
    renderInProject(<PendingDisruptions daemon={{ health: health(["editor.consent"]), streaming: true, events: [] }} />, api);
    await settle();
    expect(screen.getAllByTestId("disruption-card")).toHaveLength(1);
    expect(screen.getByText("Claude Code asks to restart the editor")).toBeTruthy();
    const card = screen.getByTestId("disruption-card").textContent ?? "";
    expect(card).toContain("load the new DoorComponent C++ class");
    expect(card).toContain("Studio: Dress the courtyard: Waiting, busy (a Studio reply)");
    expect(card).toContain("Cursor: Agreed, idle for 412s");
    expect(document.activeElement).toBe(document.body);
  });

  it("follows the event stream, and a decided request goes", async () => {
    const api = fakeApi();
    api.disruptions.mockResolvedValue({ requests: [] });
    const daemon = { health: health(["editor.consent"]), streaming: true, events: [] as StreamEvent[] };
    const view = renderInProject(<PendingDisruptions daemon={daemon} />, api);
    await settle();
    const opened = [ev("disruption.requested", request("pending"))];
    again(view, <PendingDisruptions daemon={{ ...daemon, events: opened }} />);
    expect(screen.getByText("Claude Code asks to restart the editor")).toBeTruthy();
    again(view, <PendingDisruptions daemon={{ ...daemon, events: [...opened, ev("disruption.updated", request("approved"))] }} />);
    expect(screen.queryByTestId("pending-disruptions")).toBeNull();
  });

  it("Deny is the person's override route", async () => {
    const api = fakeApi();
    api.disruptions.mockResolvedValue({ requests: [request("blocked")] });
    api.denyDisruption.mockResolvedValue({});
    renderInProject(<PendingDisruptions daemon={{ health: health(["editor.consent"]), streaming: true, events: [] }} />, api);
    await settle();
    fireEvent.click(screen.getByText("Deny"));
    await settle();
    expect(api.denyDisruption).toHaveBeenCalledWith("r-c0de", "the user in Studio");
  });

  it("asks for the PIN before approving, then sends it", async () => {
    const enc = new TextEncoder();
    const reply = (status: number, body: unknown): Reply => ({ status, headers: { "content-type": "application/json" }, body: (async function* () { yield enc.encode(JSON.stringify(body)); })() });
    const sent: string[] = [];
    let unlocked = false;
    const raw: Transport = async (method, path) => {
      sent.push(`${method} ${path}`);
      if (path === "/v1/disruptions") return reply(200, { requests: [request("pending")] });
      if (path === "/v1/disruptions/r-c0de/approve") return unlocked ? reply(200, request("approved")) : reply(423, { code: "pin-required", error: "Enter your PIN." });
      if (path === "/v1/ext/studio/lock/unlock") return (unlocked = true), reply(200, { whole: false, sensitive: true, locked: false, sensitiveOpen: true, idleMinutes: 15 });
      if (path === "/v1/ext/studio/lock") return reply(200, { whole: false, sensitive: true, locked: false, sensitiveOpen: false, idleMinutes: 15 });
      return reply(404, {});
    };
    const lock = createLock(raw);
    const guarded = lock.guard(raw);
    const project = { ...fakeProject(guarded).project, lock };
    renderInProject(<PendingDisruptions daemon={{ health: health(["editor.consent"]), streaming: true, events: [] }} />, studioApi(guarded) as never, project);
    await settle();
    fireEvent.click(screen.getByText("Approve"));
    await settle();
    expect(lock.view().prompt).toBe(true);
    await act(async () => void (await lock.unlock("1234")));
    await settle();
    expect(sent.filter((s) => s === "POST /v1/disruptions/r-c0de/approve")).toHaveLength(2);
  });

  it("reads nothing from a daemon without the gate", async () => {
    const api = fakeApi();
    renderInProject(<PendingDisruptions daemon={{ health: health([]), streaming: true, events: [ev("disruption.requested", request("pending"))] }} />, api);
    await settle();
    expect(api.disruptions).not.toHaveBeenCalled();
    expect(screen.queryByTestId("pending-disruptions")).toBeNull();
  });
});

describe("an Update the computer holds, on the phone", () => {
  const held = { ...request("pending", "r-4d5e"), op: "stop" as const, action: "POST /v1/editor/stop", reason: "installing an update", requester: { id: "http:the user in Studio", label: "the user in Studio" } };

  it("shows who holds the editor and why, and answers through the override routes", async () => {
    resetRunForTests();
    const api = fakeApi();
    api.updateHold.mockResolvedValue({ request: held, source: "queue" });
    api.approveDisruption.mockResolvedValue({});
    api.denyDisruption.mockResolvedValue({});
    renderInProject(<UpdateRunner streaming events={[]} />, api);
    await settle();
    expect(screen.getByTestId("update-held")).toBeTruthy();
    expect(screen.getByText("Updating now closes the editor and interrupts those sessions' work in it.")).toBeTruthy();
    expect(screen.getByTestId("update-held").textContent).toContain("Studio: Dress the courtyard: Waiting, busy (a Studio reply)");
    fireEvent.click(screen.getByText("Update anyway"));
    await settle();
    expect(api.approveDisruption).toHaveBeenCalledWith("r-4d5e", "the user in Studio");
    fireEvent.click(screen.getByText("Cancel"));
    await settle();
    expect(api.denyDisruption).toHaveBeenCalledWith("r-4d5e", "the user in Studio");
  });

  it("follows the hold from the computer's events, and lets go once it is decided", async () => {
    resetRunForTests();
    const api = fakeApi();
    api.updateHold.mockResolvedValue(null);
    const view = renderInProject(<UpdateRunner streaming events={[]} />, api);
    await settle();
    expect(screen.queryByTestId("update-held")).toBeNull();
    const first = ev("studio.update.consent", { hold: { request: held, source: "panel" } });
    again(view, <UpdateRunner streaming events={[first]} />);
    expect(screen.getByTestId("update-held")).toBeTruthy();
    again(view, <UpdateRunner streaming events={[first, ev("studio.update.consent", { hold: null, decided: "approve" })]} />);
    expect(screen.queryByTestId("update-held")).toBeNull();
  });
});
