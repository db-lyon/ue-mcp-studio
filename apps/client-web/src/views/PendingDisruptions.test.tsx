// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DaemonEvent } from "ue-mcp/daemon";
import type { EditorDisruptionRequest } from "@ue-mcp-studio/client-core";
import { PendingDisruptions, type PendingApi } from "./PendingDisruptions";

const request = (state: EditorDisruptionRequest["state"], id = "r-c0de"): EditorDisruptionRequest => ({
  id,
  op: "rebuild",
  action: "editor.build_project",
  reason: "compile the new door actor",
  requester: { id: "mcp:1", label: "Claude Code" },
  state,
  createdAt: "2026-11-23T10:00:00Z",
  expiresAt: "2099-11-23T10:15:00Z",
  answers: [
    { session: "studio:s1", label: "Studio: Lights", answer: "wait_until_released", reason: "busy (a Studio reply)", auto: true },
    { session: "cursor", label: "Cursor", answer: "go", reason: "idle for 400s", auto: true },
  ],
  self: { attestationRequired: true, attested: "none", inflight: [] },
});

let nextId = 1;
const event = (type: string, data: unknown) => ({ id: nextId++, type, data, time: new Date().toISOString() }) as unknown as DaemonEvent;
const health = (features: string[]) => ({ version: "1.4.11", editors: [], features }) as never;

function client(list: EditorDisruptionRequest[] = []): PendingApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    disruptions: vi.fn(async () => ({ enforcing: true, requests: list })),
    approveDisruption: vi.fn(async (id: string, by: string) => void calls.push(`approve ${id} by ${by}`)),
    denyDisruption: vi.fn(async (id: string, by: string) => void calls.push(`deny ${id} by ${by}`)),
  };
}

afterEach(cleanup);

describe("requests waiting for a person", () => {
  it("shows each open request with who asks, what for, and every session's answer", async () => {
    const c = client([request("pending"), request("approved", "r-done")]);
    render(<PendingDisruptions daemon={{ health: health(["editor.consent"]), streaming: true, events: [] }} client={c} />);
    await waitFor(() => expect(screen.getByText("Claude Code asks to rebuild the editor")).toBeTruthy());
    expect(screen.getAllByTestId("disruption-card")).toHaveLength(1);
    expect(screen.getByText(/compile the new door actor/)).toBeTruthy();
    expect(screen.getByText("Studio: Lights")).toBeTruthy();
    expect(screen.getByText("Waiting")).toBeTruthy();
    expect(screen.getByText("Cursor")).toBeTruthy();
    expect(screen.getByText("Agreed")).toBeTruthy();
    // It is a region above the views, and takes no focus.
    expect(screen.getByRole("region", { name: "Editor requests needing your answer" })).toBeTruthy();
    expect(document.activeElement).toBe(document.body);
  });

  it("follows the event stream: a new request appears, and a decided one goes", async () => {
    const c = client();
    const daemon = { health: health(["editor.consent"]), streaming: true, events: [] as DaemonEvent[] };
    const { rerender } = render(<PendingDisruptions daemon={daemon} client={c} />);
    await waitFor(() => expect(c.disruptions).toHaveBeenCalled());
    expect(screen.queryByTestId("pending-disruptions")).toBeNull();
    const opened = [event("disruption.requested", request("pending"))];
    rerender(<PendingDisruptions daemon={{ ...daemon, events: opened }} client={c} />);
    expect(screen.getByText("Claude Code asks to rebuild the editor")).toBeTruthy();
    rerender(<PendingDisruptions daemon={{ ...daemon, events: [...opened, event("disruption.updated", request("denied"))] }} client={c} />);
    expect(screen.queryByTestId("pending-disruptions")).toBeNull();
  });

  it("Approve and Deny are the person's override routes", async () => {
    const c = client([request("blocked")]);
    render(<PendingDisruptions daemon={{ health: health(["editor.consent"]), streaming: true, events: [] }} client={c} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy());
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Approve" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Deny" })));
    expect(c.calls).toEqual(["approve r-c0de by the user in Studio", "deny r-c0de by the user in Studio"]);
  });

  it("keeps the card and says why when an answer is refused", async () => {
    const c = client([request("pending")]);
    c.approveDisruption = vi.fn(async () => {
      throw new Error("Enter the PIN to approve.");
    });
    render(<PendingDisruptions daemon={{ health: health(["editor.consent"]), streaming: true, events: [] }} client={c} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy());
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Approve" })));
    expect(screen.getByText("Enter the PIN to approve.")).toBeTruthy();
    expect(screen.getByTestId("disruption-card")).toBeTruthy();
  });

  it("leaves out the person's own requests, which their button is already asking about", async () => {
    const own = { ...request("pending"), requester: { id: "http:the user in Studio", label: "the user in Studio" } };
    const c = client([own]);
    render(<PendingDisruptions daemon={{ health: health(["editor.consent"]), streaming: true, events: [] }} client={c} />);
    await waitFor(() => expect(c.disruptions).toHaveBeenCalled());
    expect(screen.queryByTestId("pending-disruptions")).toBeNull();
  });

  it("reads nothing from a daemon without the gate", async () => {
    const c = client([request("pending")]);
    render(<PendingDisruptions daemon={{ health: health([]), streaming: true, events: [event("disruption.requested", request("pending"))] }} client={c} />);
    expect(c.disruptions).not.toHaveBeenCalled();
    expect(screen.queryByTestId("pending-disruptions")).toBeNull();
  });
});
